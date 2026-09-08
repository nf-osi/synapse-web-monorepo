#!/usr/bin/env python3
"""Emit the unified infrastructure graph as Turtle.

Joins three extractions into one RDF graph:
  1. Portal lineage JSON  (tools/lineage/extract.ts output)   — who reads what
  2. job.yml sidecars     (nf-osi/jobs)                        — who writes what
  3. Synapse entity meta  (tools/graph/fetch-synapse-meta.ts)  — how entities derive

IRI conventions (deterministic, no hashes — re-emission is idempotent):
  syn:synX                    Synapse entity (resolvable synapse.org URL)
  syn:synX.V                  version-pinned entity, nfo:versionOf syn:synX
  syn:synX/wiki[/W]           wiki page; bare /wiki is the root wiki
  nfg:column/synX/NAME        column, percent-encoded name, scoped to its table
  nfg:usage/PORTAL/FILE/COMPONENT/N   call site; N = ordinal of that component
                              in the file (stable across line churn)
  nfg:set/JOB/KIND/SLUG       job resource declared as id '*' + selector
  nfg:service/SLUG            external service alias (slack:nf-osi, crossref-api)
  https://github.com/OWNER/REPO[/tree/main/JOB]   jobs and repos

Vocabulary: nfo:reads/nfo:writes are subproperties of prov:used /
prov:wasGeneratedBy-inverse; nfo:derivesFrom of prov:wasDerivedFrom. Detail
(columns, effect, on-missing) lives on nfo:Access nodes; direct
nfo:reads/nfo:writes shortcut edges are also emitted so SPARQL property paths
stay one-liners.

on_missing values are unified across sources ('columns' likewise unifies
job.yml 'fields' and lineage 'columns'):
  job.yml fail|skip|warn   -> fails|skips|warns
  capability throws|degrades|silently-malformed -> fails|degrades|silently-malformed

Usage:
  python3 tools/graph/emit_graph.py \
    --lineage tmp/lineage-out/nf-lineage.json \
    --jobs ~/sage/nf/jobs \
    --synapse-meta tmp/graph/synapse-meta.json \
    --out tmp/graph/infra.ttl
"""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

import yaml
from rdflib import Graph, Literal, Namespace, RDF, RDFS, URIRef, XSD

SYN = Namespace('https://www.synapse.org/Synapse:')
NFG = Namespace('https://nf-osi.github.io/graph/id/')
NFO = Namespace('https://nf-osi.github.io/graph/ns#')
PROV = Namespace('http://www.w3.org/ns/prov#')
DCAT = Namespace('http://www.w3.org/ns/dcat#')

ON_MISSING = {
    'fail': 'fails', 'skip': 'skips', 'warn': 'warns',
    'throws': 'fails', 'degrades': 'degrades',
    'silently-malformed': 'silently-malformed',
}

KIND_CLASS = {
    'table': NFO.Table,
    'entityview': NFO.EntityView,
    'materializedview': NFO.MaterializedView,
    'searchindex': NFO.SearchIndex,
    'dataset': NFO.Dataset,
    'datasetcollection': NFO.DatasetCollection,
    'submissionview': NFO.SubmissionView,
    'virtualtable': NFO.VirtualTable,
    'project': NFO.Project,
    'folder': NFO.Folder,
    'file': NFO.File,
}


def slug(text):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]', '-', str(text).lower())).strip('-')


def column_iri(entity_id, name):
    return NFG[f'column/{entity_id}/{quote(str(name), safe="")}']


def ontology(g):
    for prop, parent in [
        (NFO.reads, PROV.used),
        (NFO.derivesFrom, PROV.wasDerivedFrom),
        (NFO.versionOf, PROV.specializationOf),
    ]:
        g.add((prop, RDFS.subPropertyOf, parent))
    g.add((NFO.Job, RDFS.subClassOf, PROV.Activity))
    g.add((NFO.Usage, RDFS.subClassOf, PROV.Activity))
    for cls in KIND_CLASS.values():
        g.add((cls, RDFS.subClassOf, DCAT.Dataset))


def add_synapse_meta(g, meta_path):
    entities = json.loads(Path(meta_path).read_text())['entities']
    for eid, e in entities.items():
        node = SYN[eid]
        if e.get('error'):
            g.add((node, NFO.fetchError, Literal(e['error'])))
            continue
        g.add((node, RDF.type, KIND_CLASS.get(e.get('kind'), NFO.SynapseEntity)))
        if e.get('name'):
            g.add((node, RDFS.label, Literal(e['name'])))
        if e.get('versionOf'):
            g.add((node, NFO.versionOf, SYN[e['versionOf']]))
        if e.get('definingSql'):
            g.add((node, NFO.definingSql, Literal(e['definingSql'])))
        for up in e.get('derivesFrom', []):
            g.add((node, NFO.derivesFrom, SYN[up]))
        for s in e.get('scopeIds', []):
            g.add((node, NFO.hasScope, SYN[s]))
        if e.get('isSearchEnabled') is not None:
            g.add((node, NFO.isSearchEnabled, Literal(e['isSearchEnabled'])))
        if e.get('modifiedOn'):
            g.add((node, NFO.modifiedOn, Literal(e['modifiedOn'], datatype=XSD.dateTime)))
        for c in e.get('columns', []):
            col = column_iri(eid, c['name'])
            g.add((col, RDF.type, NFO.Column))
            g.add((col, NFO.columnOf, node))
            g.add((col, RDFS.label, Literal(c['name'])))
            g.add((col, NFO.columnType, Literal(c['columnType'])))
            g.add((col, NFO.columnModelId, Literal(c['id'])))
        items = e.get('items')
        if items:
            g.add((node, NFO.itemCount, Literal(items['count'])))
            for i in items['ids']:
                g.add((node, NFO.hasItem, SYN[i]))


def resource_iri(job_name, res):
    rid = str(res.get('id', ''))
    if rid == '*':
        return NFG[f'set/{job_name}/{slug(res.get("kind", "any"))}/{slug(res.get("selector", ""))[:60]}']
    if re.fullmatch(r'syn\d+(\.\d+)?', rid, re.I):
        return SYN[rid.lower()]
    if res.get('kind') == 'github-repo' and '/' in rid:
        return URIRef(f'https://github.com/{rid}')
    if res.get('kind') == 'local-file':
        return NFG[f'local/{job_name}/{slug(rid)}']
    return NFG[f'service/{slug(rid)}']


def add_jobs(g, jobs_dir):
    jobs_dir = Path(jobs_dir)
    for yml in sorted(jobs_dir.glob('*/job.yml')):
        job = yaml.safe_load(yml.read_text())
        name = job['name']
        jnode = URIRef(f'https://github.com/nf-osi/jobs/tree/main/{name}')
        g.add((jnode, RDF.type, NFO.Job))
        g.add((jnode, RDFS.label, Literal(name)))
        g.add((jnode, RDFS.comment, Literal(job['description'])))
        for key, prop in [('schedule', NFO.schedule), ('language', NFO.language),
                          ('image', NFO.image), ('workflow', NFO.workflow)]:
            if job.get(key):
                g.add((jnode, prop, Literal(job[key])))
        core = job.get('core', {})
        for key, prop in [('business_criticality', NFO.businessCriticality),
                          ('data_classification', NFO.dataClassification),
                          ('environment', NFO.environment),
                          ('deployed_infra', NFO.deployedInfra)]:
            if core.get(key):
                g.add((jnode, prop, Literal(core[key])))

        for i, res in enumerate(job.get('resources', [])):
            target = resource_iri(name, res)
            is_write = res['role'] == 'output'
            access = NFG[f'access/{name}/{i}']
            g.add((access, RDF.type, NFO.Write if is_write else NFO.Read))
            g.add((access, NFO.byJob, jnode))
            g.add((access, NFO.ofResource, target))
            g.add((jnode, NFO.writes if is_write else NFO.reads, target))
            if str(res.get('id', '')) == '*':
                g.add((target, RDF.type, NFO.ResourceSet))
                g.add((target, NFO.memberKind, Literal(res.get('kind', ''))))
                g.add((target, NFO.selector, Literal(res.get('selector', ''))))
            syn_id = re.fullmatch(r'syn\d+', str(res.get('id', '')), re.I)
            # Synapse entities get their authoritative label from synapse-meta;
            # job.yml names are per-entry aliases and would multiply labels.
            if res.get('name') and not syn_id:
                g.add((target, RDFS.label, Literal(res['name'])))
            if res.get('name'):
                g.add((access, NFO.resourceAlias, Literal(res['name'])))
            for f in res.get('fields', []) or []:
                g.add((access, NFO.columnName, Literal(f)))
                if syn_id:
                    g.add((access, NFO.column, column_iri(str(res['id']).lower(), f)))
            for key, prop in [('effect', NFO.effect), ('selector', NFO.selector),
                              ('recipients', NFO.recipients), ('freshness', NFO.freshness)]:
                if res.get(key):
                    g.add((access, prop, Literal(res[key])))
            if res.get('on_missing'):
                g.add((access, NFO.onMissing, Literal(ON_MISSING[res['on_missing']])))
            if res.get('idempotent') is not None:
                g.add((access, NFO.idempotent, Literal(res['idempotent'])))
            for key, prop in [('produced_by', NFO.producedBy), ('consumed_by', NFO.consumedBy)]:
                if res.get(key):
                    g.add((target, prop, URIRef(f'https://github.com/{res[key]}')))
            for p in res.get('profiles', []) or []:
                g.add((access, NFO.profile, Literal(p)))


def ref_targets(ref):
    """Yield (IRI, is_tabular) for one lineage ref."""
    if 'table' in ref:
        tid = ref['table'].lower()
        if ref.get('tableVersion'):
            yield SYN[f'{tid}.{ref["tableVersion"]}'], True
        else:
            yield SYN[tid], True
    elif 'searchIndexId' in ref:
        yield SYN[ref['searchIndexId'].lower()], True
    elif 'entityId' in ref:
        yield SYN[ref['entityId'].lower()], ref.get('entityRole') == 'table'
    elif 'wikiOwnerId' in ref:
        wiki = f'{ref["wikiOwnerId"].lower()}/wiki'
        if ref.get('wikiId'):
            wiki += f'/{ref["wikiId"]}'
        yield SYN[wiki], False
    elif 'formGroupId' in ref:
        yield NFG[f'formgroup/{ref["formGroupId"]}'], False
    elif 'url' in ref:
        yield URIRef(ref['url']), False


def add_lineage(g, lineage_path):
    lineage_path = Path(lineage_path)
    files = sorted(lineage_path.glob('*-lineage.json')) if lineage_path.is_dir() else [lineage_path]
    for f in files:
        portal = f.name.replace('-lineage.json', '')
        pnode = NFG[f'portal/{portal}']
        g.add((pnode, RDF.type, NFO.Portal))
        g.add((pnode, RDFS.label, Literal(portal)))
        ordinals = {}
        for u in json.loads(f.read_text()):
            key = (u['file'], u['component'])
            ordinals[key] = ordinals.get(key, -1) + 1
            unode = NFG[f'usage/{portal}/{quote(u["file"], safe="/")}/{u["component"]}/{ordinals[key]}']
            g.add((unode, RDF.type, NFO.Usage))
            g.add((unode, NFO.inPortal, pnode))
            g.add((unode, NFO.file, Literal(u['file'])))
            g.add((unode, NFO.line, Literal(u['line'])))
            g.add((unode, NFO.component, Literal(u['component'])))
            g.add((unode, NFO.usageKind, Literal(u['kind'])))
            if u.get('section'):
                g.add((unode, NFO.section, Literal(u['section'])))

            targets = [t for ref in u.get('refs', []) for t in ref_targets(ref)]
            for iri, _ in targets:
                g.add((unode, NFO.reads, iri))
            # Column IRIs are only unambiguous when a single tabular ref is read;
            # the name literal is always kept (lineage 'columns' == graph columns).
            tabular = [iri for iri, is_tab in targets if is_tab]
            for c in u.get('columns', []):
                g.add((unode, NFO.columnName, Literal(c)))
                if len(tabular) == 1:
                    eid = str(tabular[0]).rsplit(':', 1)[-1]
                    g.add((unode, NFO.column, column_iri(eid, c)))
            for di, d in enumerate(u.get('derived', [])):
                for ri, req in enumerate(d.get('requires', [])):
                    rnode = NFG[f'usage/{portal}/{quote(u["file"], safe="/")}/{u["component"]}/{ordinals[key]}/derived/{di}/{ri}']
                    g.add((rnode, RDF.type, NFO.DerivedRequirement))
                    g.add((unode, NFO.derivedRequirement, rnode))
                    g.add((rnode, NFO.capability, Literal(d['capability'])))
                    g.add((rnode, NFO.active, Literal(d['active'])))
                    g.add((rnode, NFO.boundBy, Literal(req['boundBy'])))
                    g.add((rnode, NFO.role, Literal(req['role'])))
                    if d.get('onMissing'):
                        g.add((rnode, NFO.onMissing, Literal(ON_MISSING[d['onMissing']])))
                    if req.get('column'):
                        for c in str(req['column']).split(','):
                            g.add((rnode, NFO.columnName, Literal(c)))
                            if len(tabular) == 1:
                                eid = str(tabular[0]).rsplit(':', 1)[-1]
                                g.add((rnode, NFO.column, column_iri(eid, c)))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--lineage', required=True, help='lineage JSON file or directory')
    ap.add_argument('--jobs', required=True, help='nf-osi/jobs checkout')
    ap.add_argument('--synapse-meta', required=True, help='fetch-synapse-meta.ts output')
    ap.add_argument('--out', help='output .ttl (default stdout)')
    args = ap.parse_args()

    g = Graph()
    for prefix, ns in [('syn', SYN), ('nfg', NFG), ('nfo', NFO), ('prov', PROV), ('dcat', DCAT)]:
        g.bind(prefix, ns)
    ontology(g)
    add_synapse_meta(g, args.synapse_meta)
    add_jobs(g, args.jobs)
    add_lineage(g, args.lineage)

    data = g.serialize(format='turtle')
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(data)
        print(f'Wrote {args.out} ({len(g)} triples)', file=sys.stderr)
    else:
        print(data)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Consistency checks over the infrastructure graph (emit_graph.py output).

Each check produces actionable findings, printed as a report. Exit code 0
always — these are review findings, not build gates.

Column-name policy: the Synapse column model name is canonical, byte-exact
and case-sensitive. Nothing is normalized at any stage — a reference either
matches the model or it is a finding. Where a drift finding has exactly one
plausible intended column (alias prefix added/stripped, or case-folded), the
report says "did you mean" — a hint for the human fix, never an auto-accept,
because qualified-and-correct (f.n_downloads) and qualified-and-wrong
(f.egress_size_in_gb) are indistinguishable by shape (nf-osi/synapse-web-monorepo#2).

  column-drift        A column referenced by a job or portal call site does not
                      exist in the entity's fetched column model.
  qualified-columns   A column model contains alias-qualified names
                      (s.studyName) — the defining SQL projects without AS.
                      The footgun behind most drift; fix is renaming at the
                      source, coordinated with every reader the graph shows.
  stale-pin           A portal read reaches a job-written table only across a
                      version pin (syn:X.V). The write is invisible to the
                      portal until a new snapshot is taken and the downstream
                      view is repointed — deploy-ordering information.
  maintained-elsewhere  A table the portal depends on (transitively) with no
                      declared writer in the jobs collection — maintained
                      manually, by automation in another repo, or static.
                      The finding is the absence of a declared writer here,
                      not a claim that nobody maintains it.
  unread-by-portal    A Synapse entity a job writes from which no portal read
                      is reachable. The portal is the most important consumer
                      but not the only one — side dashboards and other
                      consumers live outside the graph — so this marks "not
                      feeding the portal", never "unused".
  default-coupling    A capability column bound by a library default
                      (boundBy=default) — undeclared coupling, per
                      tools/lineage DEFINITIONS.md.

Usage: python3 tools/graph/check_graph.py tmp/graph/infra.ttl [--check NAME]
"""

import argparse
import re
import sys
from collections import defaultdict
from urllib.parse import unquote

from rdflib import Graph, Namespace

SYN = Namespace('https://www.synapse.org/Synapse:')
NFO = Namespace('https://nf-osi.github.io/graph/ns#')

PREFIXES = """
PREFIX nfo:  <https://nf-osi.github.io/graph/ns#>
PREFIX nfg:  <https://nf-osi.github.io/graph/id/>
PREFIX syn:  <https://www.synapse.org/Synapse:>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
"""

# A read reaches its ultimate sources over derivation edges and version pins.
CLOSURE = '(nfo:derivesFrom|nfo:versionOf)*'

SPARQL_CHECKS = {
    'stale-pin': f"""
        SELECT DISTINCT ?job ?live ?pin ?view ?file WHERE {{
          ?j a nfo:Job ; rdfs:label ?job ; nfo:writes ?liveIri .
          ?pinIri nfo:versionOf ?liveIri .
          ?viewIri {CLOSURE} ?pinIri .
          ?usage a nfo:Usage ; nfo:reads ?viewIri ; nfo:file ?file .
          BIND(REPLACE(STR(?liveIri), '^.*:', '') AS ?live)
          BIND(REPLACE(STR(?pinIri),  '^.*:', '') AS ?pin)
          BIND(REPLACE(STR(?viewIri), '^.*:', '') AS ?view)
        }} ORDER BY ?job ?file
    """,
    'maintained-elsewhere': f"""
        SELECT DISTINCT ?table ?label (COUNT(DISTINCT ?usage) AS ?readers) WHERE {{
          ?usage a nfo:Usage ; nfo:reads ?viewIri .
          ?viewIri {CLOSURE} ?tIri .
          ?tIri a nfo:Table .
          FILTER NOT EXISTS {{ ?j a nfo:Job ; nfo:writes ?tIri }}
          OPTIONAL {{ ?tIri rdfs:label ?label }}
          BIND(REPLACE(STR(?tIri), '^.*:', '') AS ?table)
        }} GROUP BY ?table ?label ORDER BY DESC(?readers)
    """,
    'unread-by-portal': f"""
        SELECT DISTINCT ?job ?target ?label ?effect WHERE {{
          ?j a nfo:Job ; rdfs:label ?job .
          ?acc a nfo:Write ; nfo:byJob ?j ; nfo:ofResource ?tIri .
          OPTIONAL {{ ?acc nfo:effect ?effect }}
          FILTER(STRSTARTS(STR(?tIri), STR(syn:)))
          FILTER NOT EXISTS {{
            ?viewIri {CLOSURE} ?anyVersion .
            ?anyVersion nfo:versionOf? ?tIri .
            ?u a nfo:Usage ; nfo:reads ?viewIri .
          }}
          OPTIONAL {{ ?tIri rdfs:label ?label }}
          BIND(REPLACE(STR(?tIri), '^.*:', '') AS ?target)
        }} ORDER BY ?job ?target
    """,
    'default-coupling': """
        SELECT ?file ?line ?capability ?role ?colName ?onMissing WHERE {
          ?u a nfo:Usage ; nfo:file ?file ; nfo:line ?line ;
             nfo:derivedRequirement ?r .
          ?r nfo:boundBy "default" ; nfo:capability ?capability ; nfo:role ?role .
          OPTIONAL { ?r nfo:columnName ?colName }
          OPTIONAL { ?r nfo:onMissing ?onMissing }
        } ORDER BY ?file ?line
    """,
}

COLUMN_IRI_RE = re.compile(r'/column/(syn[0-9.]+)/(.*)$')
ALIAS_RE = re.compile(r'^([A-Za-z][A-Za-z0-9_]{0,2})\.(.+)$')


def column_models(g):
    """entity id -> set of column names actually in its fetched model."""
    models = defaultdict(set)
    for row in g.query(PREFIXES + """
        SELECT ?col ?name WHERE { ?col nfo:columnOf ?e ; rdfs:label ?name }
    """):
        m = COLUMN_IRI_RE.search(str(row.col))
        if m:
            models[m.group(1)].add(str(row.name))
    return models


def suggest(name, model):
    """The unique plausible intended column, or None. Hint only — exact match
    is the sole success criterion, so a suggestion never clears a finding."""
    candidates = set()
    stripped = ALIAS_RE.match(name)
    if stripped and stripped.group(2) in model:
        candidates.add(stripped.group(2))
    for actual in model:
        qualified = ALIAS_RE.match(actual)
        if qualified and qualified.group(2) == name:
            candidates.add(actual)
        elif actual.lower() == name.lower() and actual != name:
            candidates.add(actual)
    return candidates.pop() if len(candidates) == 1 else None


def check_column_drift(g, models):
    """Referenced columns absent from a fetched column model, byte-exact."""
    findings = []
    for row in g.query(PREFIXES + 'SELECT ?who ?col WHERE { ?who nfo:column ?col }'):
        m = COLUMN_IRI_RE.search(str(row.col))
        if not m:
            continue
        entity, name = m.group(1), unquote(m.group(2))
        # Absent model means "not fetched", not "does not exist".
        if entity not in models or name in models[entity]:
            continue
        hint = suggest(name, models[entity])
        detail = f'{entity}  {name}' + (f'  → did you mean "{hint}"?' if hint else '')
        findings.append((str(row.who), detail))
    return findings


def check_qualified_columns(g, models):
    """Column models carrying alias-qualified names verbatim."""
    findings = []
    for entity, names in sorted(models.items()):
        dotted = sorted(n for n in names if ALIAS_RE.match(n))
        if dotted:
            findings.append((f'syn-prefix names in {entity} model',
                             f'{", ".join(dotted)}  (alias projections without AS in defining SQL)'))
    return findings


def print_findings(name, findings):
    print(f'== {name}: {len(findings)} finding(s)')
    grouped = defaultdict(list)
    for head, detail in findings:
        grouped[head].append(detail)
    for head, details in grouped.items():
        print(f'  {head}')
        for d in sorted(set(details))[:8]:
            print(f'      {d}')
        if len(set(details)) > 8:
            print(f'      … {len(set(details)) - 8} more')
    print()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('graph', help='Turtle file from emit_graph.py')
    all_checks = ['column-drift', 'qualified-columns', *SPARQL_CHECKS]
    ap.add_argument('--check', choices=all_checks, help='run one check only')
    args = ap.parse_args()

    g = Graph()
    g.parse(args.graph)
    print(f'{len(g)} triples loaded from {args.graph}\n', file=sys.stderr)

    models = column_models(g)
    python_checks = {
        'column-drift': lambda: check_column_drift(g, models),
        'qualified-columns': lambda: check_qualified_columns(g, models),
    }
    for name in all_checks:
        if args.check and name != args.check:
            continue
        if name in python_checks:
            findings = python_checks[name]()
        else:
            findings = []
            for r in g.query(PREFIXES + SPARQL_CHECKS[name]):
                vals = [str(v) if v is not None else '-' for v in r]
                findings.append((vals[0], '  '.join(vals[1:])))
        print_findings(name, findings)


if __name__ == '__main__':
    main()

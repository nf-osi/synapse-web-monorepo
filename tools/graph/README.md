# Infrastructure graph

Joins three metadata sources into one queryable RDF graph, connecting **what
jobs write** (nf-osi/jobs `job.yml`) to **what portals read** (`tools/lineage`)
through **how Synapse entities derive from each other** (fetched live).

```
tools/lineage/extract.ts ──► *-lineage.json ─┐
nf-osi/jobs */job.yml ───────────────────────┼─► emit_graph.py ─► infra.ttl ─► check_graph.py
fetch-synapse-meta.ts ──► synapse-meta.json ─┘                        │
                                                                 SPARQL / rdflib
```

## Pipeline

```bash
# 1. Portal lineage (see tools/lineage/README.md)
npx tsx tools/lineage/extract.ts --all --out tmp/lineage-out

# 2. Synapse derivation layer: entity kinds, defining SQL, column models.
#    Seeds from lineage refs + job.yml syn ids; recurses upstream through
#    defining SQL. Anonymous works for public entities; set SYNAPSE_AUTH_TOKEN
#    for private ones (403s are recorded, not dropped).
npx tsx tools/graph/fetch-synapse-meta.ts \
  --lineage tmp/lineage-out/nf-lineage.json \
  --jobs ~/sage/nf/jobs \
  --out tmp/graph/synapse-meta.json

# 3. Emit Turtle
python3 tools/graph/emit_graph.py \
  --lineage tmp/lineage-out/nf-lineage.json \
  --jobs ~/sage/nf/jobs \
  --synapse-meta tmp/graph/synapse-meta.json \
  --out tmp/graph/infra.ttl

# 4. Consistency checks (column drift, stale pins, undeclared writers, …)
python3 tools/graph/check_graph.py tmp/graph/infra.ttl
```

Requires `rdflib` and `PyYAML` (both preinstalled here); no reasoner — every
"inference" is a SPARQL property path over `nfo:derivesFrom`/`nfo:versionOf`.

## IRI conventions

Deterministic, no hashes: re-emission over unchanged inputs is byte-identical,
so `infra.ttl` diffs cleanly in git.

| Node               | IRI pattern                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Synapse entity     | `syn:synX` = `https://www.synapse.org/Synapse:synX` (resolvable)                                                                                       |
| Version pin        | `syn:synX.V`, plus `nfo:versionOf syn:synX`                                                                                                            |
| Wiki page          | `syn:synX/wiki/W`; bare `/wiki` = root wiki                                                                                                            |
| Column             | `nfg:column/synX/NAME` (percent-encoded; table-scoped)                                                                                                 |
| Job                | `https://github.com/nf-osi/jobs/tree/main/NAME`                                                                                                        |
| Call site          | `nfg:usage/PORTAL/FILE/COMPONENT/N` — N is the ordinal of that component within the file, so identity survives line churn (`nfo:line` is display-only) |
| `id: "*"` resource | `nfg:set/JOB/KIND/SLUG(selector)`, typed `nfo:ResourceSet`                                                                                             |
| External service   | `nfg:service/SLUG` (`slack-nf-osi`, `crossref-api`)                                                                                                    |

Prefixes: `nfg:` instances, `nfo:` vocabulary, plus `prov:`/`dcat:` —
`nfo:reads ⊑ prov:used`, `nfo:derivesFrom ⊑ prov:wasDerivedFrom`,
`nfo:versionOf ⊑ prov:specializationOf`.

## Vocabulary decisions

- **`columns` wins**: job.yml `fields` and lineage `columns` both emit
  `nfo:column` (IRI, when the target table is unambiguous) and
  `nfo:columnName` (literal, always).
- **Column names are never normalized.** The Synapse column model name is
  canonical, byte-exact and case-sensitive; emitters store what each source
  actually said, and the drift check succeeds only on exact match. Rationale:
  qualified-and-correct (`f.n_downloads`) and qualified-and-wrong
  (`f.egress_size_in_gb`) are indistinguishable by shape, so any auto-rewrite
  hides real bugs (see nf-osi/synapse-web-monorepo#2). Where exactly one
  plausible intended column exists, `check_graph.py` prints a
  "did you mean" hint — advice for the human fix, never an auto-accept.
- **Unified `nfo:onMissing` enum**: `fails | skips | warns | degrades |
silently-malformed`. Mapping: job.yml `fail/skip/warn` →
  `fails/skips/warns`; capability `throws` → `fails`, others pass through.
  The source schemas still use their own enums; correcting them to the unified
  set is tracked as follow-up.
- Read/write **detail** (columns, effect, profiles, on-missing) lives on
  `nfo:Read`/`nfo:Write` access nodes; direct `nfo:reads`/`nfo:writes`
  shortcut edges from job to resource keep SPARQL paths one-liners.

## The flagship query

"Which portal surfaces does this job's write reach?"

```sparql
SELECT DISTINCT ?job ?file ?section WHERE {
  ?j a nfo:Job ; rdfs:label ?job ; nfo:writes ?t .
  ?v (nfo:derivesFrom|nfo:versionOf)* ?t .
  ?u a nfo:Usage ; nfo:reads ?v ; nfo:file ?file .
  OPTIONAL { ?u nfo:section ?section }
}
```

## Checks (`check_graph.py`)

| Check                  | Finding                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `column-drift`         | Column referenced by a job or call site absent from the entity's fetched column model (exact match; unique candidates reported as "did you mean")                                                     |
| `qualified-columns`    | Column model carrying alias-qualified names verbatim (`s.studyName`) — defining SQL projects without `AS`; the footgun behind most drift                                                              |
| `stale-pin`            | Portal read reaches a job-written table only across a version pin — the write is invisible until snapshot + repoint                                                                                   |
| `maintained-elsewhere` | Table the portal transitively depends on with no declared writer in the jobs collection (maintained manually, by another repo, or static — the finding is only the absence of a declared writer here) |
| `unread-by-portal`     | Job-written Synapse entity with no reachable portal read (side dashboards and other consumers are outside the graph — this means "not feeding the portal", not "unused")                              |
| `default-coupling`     | Capability column bound by a library default (`boundBy: default`)                                                                                                                                     |

Findings are review items, not gates — several current ones are metadata
defects rather than production bugs (see caveats).

## Known caveats

- **job.yml `fields` sometimes names entity properties, not columns**
  (`definingSQL` on the snapshot job) — flagged by `column-drift`; wants a
  separate key or a `property:` prefix in the job schema.
- Lineage attributes a usage's columns to its single tabular ref; multi-ref
  usages get `nfo:columnName` literals only.
- 403 entities carry `nfo:fetchError` instead of metadata; rerun the fetch
  with `SYNAPSE_AUTH_TOKEN` to fill them.
- Dataset items are capped at 50 ids (`truncated: true` marks the cut).

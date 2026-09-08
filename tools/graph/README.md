# Synapse derivation layer

`fetch-synapse-meta.ts` supplies the third of the three metadata sources that
make up the infrastructure graph: what Synapse itself knows about the entities
the other two sources mention (entity kinds, defining SQL, view scopes, column
models), plus the `derivesFrom` edges parsed out of defining SQL.

```
tools/lineage/extract.ts ──► *-lineage.json ─┐
nf-osi/jobs */job.yml ───────────────────────┼─► emit_graph.py ─► infra.ttl ─► check_graph.py
fetch-synapse-meta.ts ──► synapse-meta.json ─┘                        │
                                                                 SPARQL / rdflib
```

**Graph assembly and the consistency checks now live in
[nf-osi/jobs](https://github.com/nf-osi/jobs/tree/main/infra-graph), under
`infra-graph/graph/`.** They read that repo's `job.yml` schema, so keeping them
beside it means a schema change and its reader land in one commit and are tested
together; `infra-graph/test_graph_tools.py` asserts that every declared field and
property still reaches the graph. This directory keeps only what needs a portal
monorepo checkout to run.

That is also where the IRI conventions, the vocabulary decisions, the check
descriptions, and the emitter's own caveats are documented: see
`infra-graph/graph/emit_graph.py`, `infra-graph/graph/check_graph.py`, and
`infra-graph/README.md`.

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

# 3. Emit Turtle (in a nf-osi/jobs checkout)
python3 infra-graph/graph/emit_graph.py \
  --lineage tmp/lineage-out/nf-lineage.json \
  --jobs . \
  --synapse-meta tmp/graph/synapse-meta.json \
  --out tmp/graph/infra.ttl

# 4. Consistency checks (column drift, stale pins, undeclared writers, …)
python3 infra-graph/graph/check_graph.py tmp/graph/infra.ttl --json tmp/graph/findings.json
```

Steps 1 and 2 run here, steps 3 and 4 in a nf-osi/jobs checkout (they need
`rdflib` and `PyYAML`). The `infra-graph` job runs all four unattended: it
clones the portal monorepo and overlays `tools/` from this branch, so the branch
never needs rebasing against upstream to keep the analysis current.

## Known caveats

- Entities that cannot be read carry an `error` field instead of metadata (403
  without a token); rerun with `SYNAPSE_AUTH_TOKEN` to fill them. Absence of a
  field then means "unreadable", never "does not exist".
- Dataset items are capped at 50 ids (`truncated: true` marks the cut).
- View scopes are recorded but not recursed into; only defining SQL is followed
  upstream.

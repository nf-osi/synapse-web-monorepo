/**
 * Synapse derivation-layer extractor.
 *
 * The third metadata source for the lineage graph: for every Synapse entity
 * mentioned by portal lineage output (tools/lineage) or by job.yml sidecars
 * (nf-osi/jobs), fetch what Synapse itself knows — entity kind, defining SQL,
 * view scope, column models — and record the derivation edges (`derivesFrom`)
 * parsed from defining SQL. Upstream entities discovered this way are fetched
 * transitively, so the output closes the gap between the tables jobs write and
 * the derived views/search indexes portals read.
 *
 * Usage:
 *   npx tsx tools/graph/fetch-synapse-meta.ts \
 *     --lineage tmp/lineage-out            # file or directory of *-lineage.json
 *     --jobs /path/to/nf/jobs              # scanned for [*]job.yml syn ids
 *     --ids syn123,syn456.7                # extra seeds
 *     --out tmp/graph/synapse-meta.json    # default: stdout
 *
 * Data goes to stdout (or --out), diagnostics to stderr. Anonymous access
 * works for public entities; set SYNAPSE_AUTH_TOKEN to read private ones.
 * Entities that cannot be fetched are recorded with an `error` field rather
 * than dropped — absence of fields is then "unreadable", never silent.
 */
import * as fs from 'fs'
import * as path from 'path'

const REPO = 'https://repo-prod.prod.sagebase.org/repo/v1'
const SYN_ID_RE = /\bsyn\d+(?:\.\d+)?\b/gi
const CONCURRENCY = 4
const DATASET_ITEM_CAP = 50

interface ColumnModel {
  id: string
  name: string
  columnType: string
  facetType?: string
}

interface EntityMeta {
  id: string
  name?: string
  kind?: string
  concreteType?: string
  parentId?: string
  createdBy?: string
  modifiedOn?: string
  isLatestVersion?: boolean
  /** Present only for version-pinned ids (syn123.4). */
  versionOf?: string
  definingSql?: string
  /** syn ids parsed from definingSql — the derivation edges. */
  derivesFrom?: string[]
  /** Entity views: container ids in scope. Recorded, not recursed into. */
  scopeIds?: string[]
  viewTypeMask?: number
  /** Datasets: item count, with ids capped at DATASET_ITEM_CAP. */
  items?: { count: number; ids: string[]; truncated: boolean }
  columns?: ColumnModel[]
  isSearchEnabled?: boolean
  error?: string
}

function kindOf(concreteType: string | undefined): string | undefined {
  if (!concreteType) return undefined
  const short = concreteType.split('.').pop() ?? concreteType
  return short.replace(/Entity$/, '').toLowerCase()
}

function parseDerivesFrom(sql: string, selfId: string): string[] {
  const ids = new Set<string>()
  for (const m of sql.match(SYN_ID_RE) ?? []) {
    const id = m.toLowerCase()
    if (id !== selfId) ids.add(id)
  }
  return [...ids]
}

/** Kinds whose column models are meaningful to fetch. */
const TABULAR_KINDS = new Set([
  'tableentity',
  'table',
  'entityview',
  'materializedview',
  'dataset',
  'datasetcollection',
  'submissionview',
  'virtualtable',
  'searchindex',
])

const authToken = process.env.SYNAPSE_AUTH_TOKEN
async function synGet(pathname: string): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (authToken) headers.Authorization = `Bearer ${authToken}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${REPO}${pathname}`, { headers })
    if (res.status === 429 && attempt < 4) {
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json()
  }
}

async function fetchEntity(ref: string): Promise<EntityMeta> {
  // A version-pinned ref (syn123.4) is its own node, linked to the
  // unversioned entity via versionOf — mirroring the IRI convention.
  const [id, version] = ref.split('.')
  const meta: EntityMeta = { id: ref }
  if (version) meta.versionOf = id
  let e: any
  try {
    e = version
      ? await synGet(`/entity/${id}/version/${version}`)
      : await synGet(`/entity/${id}`)
  } catch (err) {
    meta.error = String(err instanceof Error ? err.message : err)
    return meta
  }
  meta.name = e.name
  meta.concreteType = e.concreteType
  meta.kind = kindOf(e.concreteType)
  meta.parentId = e.parentId
  meta.createdBy = e.createdBy
  meta.modifiedOn = e.modifiedOn
  if (e.isLatestVersion !== undefined) meta.isLatestVersion = e.isLatestVersion
  if (e.isSearchEnabled !== undefined) meta.isSearchEnabled = e.isSearchEnabled
  if (e.definingSQL) {
    meta.definingSql = e.definingSQL
    meta.derivesFrom = parseDerivesFrom(e.definingSQL, id.toLowerCase())
  }
  if (e.scopeIds)
    meta.scopeIds = e.scopeIds.map((s: string) =>
      s.startsWith('syn') ? s : `syn${s}`,
    )
  if (e.viewTypeMask !== undefined) meta.viewTypeMask = e.viewTypeMask
  if (e.items) {
    const ids = e.items.map(
      (it: any) => `syn${String(it.entityId).replace(/^syn/, '')}`,
    )
    meta.items = {
      count: ids.length,
      ids: ids.slice(0, DATASET_ITEM_CAP),
      truncated: ids.length > DATASET_ITEM_CAP,
    }
    // Dataset items are file-level derivation; edges belong in the graph but
    // the files themselves are too granular to fetch transitively.
  }
  if (meta.kind && TABULAR_KINDS.has(meta.kind)) {
    try {
      const cols = await synGet(`/entity/${id}/column`)
      meta.columns = (cols.results ?? []).map((c: any) => {
        const col: ColumnModel = {
          id: c.id,
          name: c.name,
          columnType: c.columnType,
        }
        if (c.facetType) col.facetType = c.facetType
        return col
      })
    } catch (err) {
      meta.error = `columns: ${err instanceof Error ? err.message : err}`
    }
  }
  return meta
}

function collectLineageSeeds(target: string): Set<string> {
  const seeds = new Set<string>()
  const files = fs.statSync(target).isDirectory()
    ? fs
        .readdirSync(target)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(target, f))
    : [target]
  for (const file of files) {
    const usages = JSON.parse(fs.readFileSync(file, 'utf8'))
    const flat = Array.isArray(usages) ? usages : Object.values(usages).flat()
    for (const u of flat) {
      for (const r of u.refs ?? []) {
        for (const key of [
          'table',
          'entityId',
          'searchIndexId',
          'wikiOwnerId',
        ] as const) {
          if (r[key]) seeds.add(String(r[key]).toLowerCase())
        }
        if (r.table && r.tableVersion)
          seeds.add(`${r.table}.${r.tableVersion}`.toLowerCase())
      }
    }
  }
  return seeds
}

function collectJobSeeds(jobsDir: string): Set<string> {
  const seeds = new Set<string>()
  for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const yml = path.join(jobsDir, entry.name, 'job.yml')
    if (!fs.existsSync(yml)) continue
    for (const m of fs.readFileSync(yml, 'utf8').match(SYN_ID_RE) ?? []) {
      seeds.add(m.toLowerCase())
    }
  }
  return seeds
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (flag: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  if (args.includes('--help') || args.length === 0) {
    console.error(
      'Usage: fetch-synapse-meta.ts [--lineage <file|dir>] [--jobs <dir>] [--ids syn1,syn2] [--out <file>]',
    )
    process.exit(args.length === 0 ? 1 : 0)
  }

  const seeds = new Set<string>()
  const seedCounts: Record<string, number> = {}
  const lineage = opt('--lineage')
  if (lineage) {
    const s = collectLineageSeeds(lineage)
    s.forEach(id => seeds.add(id))
    seedCounts.lineage = s.size
  }
  const jobs = opt('--jobs')
  if (jobs) {
    const s = collectJobSeeds(jobs)
    s.forEach(id => seeds.add(id))
    seedCounts.jobs = s.size
  }
  for (const id of (opt('--ids') ?? '').split(',').filter(Boolean)) {
    seeds.add(id.trim().toLowerCase())
  }
  if (seeds.size === 0) {
    console.error('No seed ids. Provide --lineage, --jobs, or --ids.')
    process.exit(1)
  }
  console.error(`Seeds: ${seeds.size} (${JSON.stringify(seedCounts)})`)

  const entities: Record<string, EntityMeta> = {}
  const queue = [...seeds]
  const seen = new Set(queue)
  let fetched = 0
  // BFS with a small worker pool: derivesFrom edges enqueue upstream
  // entities, closing the derivation chain jobs → tables → views → portals.
  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift()!
      const meta = await fetchEntity(id)
      entities[id] = meta
      fetched++
      if (fetched % 10 === 0)
        console.error(`  fetched ${fetched} (${queue.length} queued)`)
      for (const up of meta.derivesFrom ?? []) {
        if (!seen.has(up)) {
          seen.add(up)
          queue.push(up)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const errors = Object.values(entities).filter(e => e.error).length
  console.error(`Fetched ${fetched} entities (${errors} with errors)`)

  const output = {
    source: 'synapse-repo-prod',
    seeds: seedCounts,
    entities,
  }
  const out = opt('--out')
  const json = JSON.stringify(output, null, 2)
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, json)
    console.error(`Wrote ${out}`)
  } else {
    console.log(json)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

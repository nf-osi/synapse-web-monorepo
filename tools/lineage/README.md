# Portal data-lineage extractor

Static analysis that answers: **for a given portal page, which Synapse tables and
columns does it read?**

Nothing off-the-shelf does this. Component-inventory tools (`react-scanner`,
Importy, Omlet) stop at prop _names_; data-lineage tools (dbt column lineage,
SQL lineage analyzers) start at the warehouse and never cross into JSX. This
bridges the two by constant-folding prop _values_ across files.

## Running it

```bash
# one portal, JSON array on stdout
npx tsx tools/lineage/extract.ts --portal nf

# every portal, one file each
npx tsx tools/lineage/extract.ts --all --out tmp/lineage-out

npx tsx tools/lineage/extract.ts --help
```

| Flag              | Meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `--portal <name>` | A portal under `apps/portals` (`nf`), or a path to a portal root. |
| `--all`           | Every portal under `apps/portals`.                                |
| `--out <dir>`     | Write `<portal>-lineage.json` per portal instead of printing.     |
| `--help`          | Usage.                                                            |

Without `--out`, a single portal prints a JSON array and `--all` prints a JSON
object keyed by portal name. Data goes to stdout, progress and diagnostics to
stderr, so redirecting stdout always yields valid JSON. A portal with no `src/`
yields `[]` and exit code 0.

The monorepo root is found by walking up from the script, so the tool runs from
any working directory. Portal paths are resolved to absolute before analysis —
this matters, because a relative `baseUrl` silently fails to resolve the `@/*`
alias and drops call sites.

No new dependencies — `typescript` and `tsx` are already in the monorepo.

## Files

| File              | Role                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `extract.ts`      | CLI plus the analyzer. `analyzePortal(root)` does the work; the rest is argument handling. |
| `capabilities.ts` | Declarative registry of behavior-implied column dependencies.                              |
| `DEFINITIONS.md`  | Field-by-field semantics of the output.                                                    |

Output is generated, not checked in — write it somewhere scratch (`tmp/`) or
consume it from stdout.

## How it works

### 1. Program construction

`analyzePortal` builds a `ts.createProgram` over every `.ts`/`.tsx` under
`<portal>/src`, with
`paths: { '@/*': ['./src/*'] }` so the portal's own alias resolves. A
`TypeChecker` is required — not just a parser — because the interesting values
live in other files:

```
sql={newStudiesSql}                              // pages/HomePage.tsx
  → `${studiesSql} order by ROW_ID desc limit 3` // config/synapseConfigs/studies.ts
  → 'SELECT * FROM syn52694652'                  // config/resources.ts
```

### 2. Constant folding

Four folders walk identifiers back to their initializers via
`checker.getSymbolAtLocation` → `getAliasedSymbol` → declaration:

- `foldString` — string literals, template expressions (recursing into spans),
  identifiers, property accesses, `as`/parenthesized expressions

A property access into an annotated config (`const x: SomeProps = {...}` read as
`x.props`) resolves to the _type's_ `PropertySignature`, which holds no value, so
`resolveInitializer` falls back to reading the property off the object literal.

- `foldObject` — resolves an identifier to its `ObjectLiteralExpression`
- `foldStringList` — array literals of strings, for column-list props
- `foldBoolean` — `true`/`false` keywords, for capability triggers

All are depth-capped at 12 to stop cycles.

### 3. Harvesting a call site

For every JSX element whose tag resolves to an import from
`synapse-react-client` or `@sage-bionetworks/synapse-portal-framework`:

- **Backend refs** come from:
  - any prop named `sql` or ending in `Sql` (`countSql`, `facetSql`,
    `studyAcknowledgementSql`) — matched by suffix, not a fixed list, so a new
    query prop is picked up without a code change
  - `searchIndexId`, `url`, `formGroupId`
  - entity props in `ENTITY_PROPS`, which also record what the entity is for:
    `entityId`, `tableEntityId`, `formSchemaEntityId`, `formUiSchemaEntityId`,
    `formNavSchemaEntityId`
  - the `ownerId` / `wikiId` pair addressing a wiki page, as sibling JSX props or
    sibling config keys

  A `FROM syn123.4` also records `tableVersion`. Refs are de-duplicated, since a
  spread config is read by two paths.

- **Columns** come from several channels, because a portal names columns in more
  places than you would guess:

| Channel                                                     | Example                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `COLUMN_KEYS` — always a column                             | `URLColumnName`, `matchColumnName`, `fileIdColumnName`, `columnName`, `linkColumnName`                |
| `CARD_SCHEMA_COLUMN_KEYS` — only inside `genericCardSchema` | `title`, `description`, `subTitle`, `icon`                                                            |
| `COLUMN_LIST_KEYS` — arrays                                 | `secondaryLabels`, `searchable`, `rowSelectionPrimaryKey`                                             |
| `columnAliases`                                             | object _keys_ are columns; values are display labels                                                  |
| `searchParams`                                              | keys become `QueryFilter` columns via `getAdditionalFilters`, minus reserved `qw*` / `__*`            |
| `columnIconOptions`                                         | only the keys under `.columns`; the nested values are icon names                                      |
| SELECT list                                                 | explicit projections, aliases resolved to their source; expressions contribute every column they read |
| WHERE / ORDER BY                                            | filter and sort columns — real dependencies even under `SELECT *`                                     |

`{...spread}` config objects are folded and harvested identically, and
shorthand properties (`columnAliases,`) resolve through
`getShorthandAssignmentValueSymbol`.

### 4. Alias resolution

`sqlAliasMap` builds alias→source from each query's SELECT list, then every
harvested column is mapped through it. This matters because props reference the
query's _output_ names:

```
SELECT vendorName as "Vendor" FROM syn51735470
columnLink={{ matchColumnName: 'Vendor' }}   →  vendorName
```

The SELECT list is split on commas at paren depth zero and outside quotes, so
expressions survive intact; each one then contributes every column it reads,
with function names, SQL keywords, and string literals filtered out:

```
concat('[', acronym, '](/Explore/...', id, ')') as acronym   →  acronym, id
CASE WHEN URL = formalSpec THEN '' ELSE formalSpec END       →  URL, formalSpec
count(source)                                                →  source
```

### 5. Capability evaluation

See `capabilities.ts`. Some columns are bound by _enabling a feature_ rather than
by naming them — the CAVATICA export rewrites the query through `addDrsUriToSql`
and splices in column names that default to `id` / `name` / `currentVersion`
when the portal leaves the props unset. `deriveDependencies` evaluates each
registry entry against the props actually set at a call site and records whether
each column was declared or inherited from a default.

### 6. Labelling

A usage is labelled by the nearest enclosing `SectionLayout title`, else the
`title` of the enclosing `DetailsPageContent` content item (`{ id, title,
element }` — the sibling `element` key distinguishes it from config objects
where `title` is a column name), falling back to the page's
`createStaticMeta({ title })`. A content item's `id` is an anchor, not
user-visible, and is never used as a label, so `id`-only items and bare tab
bodies remain unlabelled — the tab name would have to come from the route
config.

## Known limits

- **Runtime SQL is opaque.** `sql={`SELECT \* FROM ${id}`}` from a route param
  folds to nothing; the entry carries columns but no `refs`.
- **Table views are floors, not complete lists.** For a `QueryWrapperPlotNav`
  with no card config, displayed columns come from the Synapse view's column
  model at runtime. Only what the SQL and props name is visible here.
- **Search index → table is a naming heuristic.** Pairing `studiesSearchIndexId`
  with `studiesSql` is a convention in `resources.ts`, not a fact in the code.
  The extractor does not emit that link; consumers infer it.
- **Context reads resolve by file, then directory.** A tab's table is taken from
  the `DetailsPage` in the same file, or in the same directory when that
  directory holds exactly one. `src/pages` is flat and holds several detail
  pages, so tabs living directly in it resolve only via same-file lookup.
- **Only two packages are traced.** Components from elsewhere are skipped.
- **Dynamic lookups are opaque.** `tableInfo[tableName].id` cannot be resolved
  statically; b2ai.standards reaches several tables only this way.
- **Synapse ids inside URL strings are not parsed.** A link to
  `https://www.synapse.org/Synapse:syn123/wiki/456` is captured as a `url` ref,
  not decomposed into a wiki ref.

## Extending it

Adding a column channel means adding a key to one of the three sets at the top
of `extract.ts`. Adding a behavior-implied dependency means appending to
`CAPABILITIES` in `capabilities.ts` — a data edit, not a code change.

Before adding a filter that _removes_ values, check them against the portals
first. Two apparent defects were legitimate data: `"Grant Number"` and
`"Full Name"` are real AD Knowledge columns (Synapse views permit spaces), and
`Lead(s)` is a real GENIE column. An "identifiers only" filter would have
silently deleted dozens of true dependencies.

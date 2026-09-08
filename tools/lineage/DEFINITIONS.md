# Output semantics

Field-by-field meaning of the JSON emitted by `tools/lineage/extract.ts`. These terms are invented for
this tool — none of them are Synapse or SRC concepts — so this file is the
authority on what they claim.

The output is a flat JSON array of **usage** records. One record = one place a
component reads backend data.

---

## Usage

```jsonc
{
  "file": "src/pages/HomePage.tsx", // portal-root-relative
  "line": 120, // 1-indexed, the JSX opening element
  "section": "New Studies", // optional; see below
  "component": "CardContainerLogic",
  "kind": "render",
  "refs": [
    /* Ref */
  ],
  "columns": ["studyName", "summary"],
  "derived": [
    /* DerivedDependency */
  ], // optional
}
```

### `section`

The user-visible label for this element: the nearest enclosing
`SectionLayout title`, else the `title` of the enclosing `DetailsPageContent`
content item (`{ id, title, element }`), else the page's
`createStaticMeta({ title })`. A content item's `id` alone is an anchor, not
a rendered label, and is never used — such entries stay unlabelled. Absence
means "not labelled", never "not user-visible".

### `kind`

Why this record exists. The distinction exists because a page's data surface is
counted differently depending on the question asked.

| Value          | Meaning                                                                                                                                                       | Counting guidance                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `render`       | A component renders data at this call site.                                                                                                                   | The default unit. Count these for "how many places read table X".                                                                       |
| `page-query`   | The framework `DetailsPage` shell wrapping a detail page. Its `sql` is the page's own row lookup and is normally duplicated by a child card on the same page. | **Exclude from site counts** to avoid double-counting; include when you want the page-level query itself. `columns` is typically empty. |
| `context-read` | A `useDetailsPageContext('<column>')` call. The tab reads one row field by column name straight out of DetailsPage context — no prop, no SQL.                 | Include when computing a table's true column surface. Excluding these hid `hosting` and `relatedStudies` entirely.                      |

A `context-read` carries exactly one entry in `columns`, and its `refs` are
**inherited** from the DetailsPage that mounts it (same file, else same directory
when unambiguous). Empty `refs` means the owning page could not be determined,
not that there is no dependency.

### `refs`

What backend resource this call site reads. An array because one element may
read more than one. Each `Ref` carries exactly one shape:

| Shape                           | Meaning                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ sql, table, tableVersion? }` | A Synapse table query. `table` is parsed from the `FROM` clause; `sql` is the fully constant-folded text. `tableVersion` is present only when the query pins a version (`FROM syn123.4`).                                         |
| `{ searchIndexId }`             | A search index entity. **No `table`** — the index's backing table is not stated in code.                                                                                                                                          |
| `{ entityId, entityRole? }`     | An entity read directly by id. `entityRole` says what it is for when the prop name states it (`formSchema`, `formUiSchema`, `formNavSchema`, `table`); absent for a bare `entityId`, where the component name is the only signal. |
| `{ formGroupId }`               | A Synapse form group. Addressed by a small numeric id, not a syn id.                                                                                                                                                              |
| `{ wikiOwnerId, wikiId }`       | A Synapse wiki page. `wikiOwnerId` is the entity that owns the wiki; `wikiId` is the page. **`wikiId` absent means the owner's root wiki**, not an unknown page.                                                                  |
| `{ url }`                       | A non-Synapse HTTP source (e.g. the RSS feed).                                                                                                                                                                                    |

SQL refs are recognized by prop-name suffix — `sql` itself and anything ending
in `Sql` (`countSql`, `facetSql`, `studyAcknowledgementSql`) — rather than a
fixed list, so a component adding a new query prop is picked up automatically.

Wiki refs come from `ownerId` / `wikiId`, whether written as sibling JSX props
(`<MarkdownSynapse ownerId="syn26338068" wikiId="629946" />`) or as sibling keys
in a config object spread into one. Duplicates are collapsed, since a spread
config is read by two paths.

`refs: []` on a `render` entry means the query is built at runtime — typically
`SELECT * FROM ${id}` from a route param. The dependency is real but its target
is only known when the route resolves.

### `columns`

Table columns this call site depends on. Always source column names, never
display labels: SQL aliases are resolved back through the query's own SELECT
list, and aggregates are unwrapped to the column they read.

Includes columns that are _filtered or sorted on_, not just projected — these
are genuine dependencies even under `SELECT *`.

**A column name is not necessarily an identifier.** `"Grant Number"`,
`"Full Name"`, and `Lead(s)` are real columns in AD Knowledge and GENIE. Do not
filter this list on shape.

**Treat `columns` as a floor, not a complete list.** For a table view with no
card configuration, the displayed columns come from the Synapse view's column
model at runtime and are invisible to static analysis.

---

## DerivedDependency

Columns bound by a component's **behavior** rather than named in its config.
Enabling a feature can bind columns the portal never mentions — the CAVATICA
export rewrites the query through `addDrsUriToSql` and splices in column names
that fall back to library defaults when the props are unset.

Kept **separate from `columns`** on purpose: `columns` is the surface a portal
declares, `derived` is the surface its behavior additionally requires. Union
them for the effective surface; keep them apart to see undeclared coupling.

```jsonc
{
  "capability": "export-to-analysis-platform",
  "active": "always",
  "trigger": {
    "prop": "enabledExternalAnalysisPlatforms",
    "value": ["cavatica", "pluto", "terra"],
  },
  "requires": [
    {
      "role": "fileId",
      "prop": "fileIdColumnName",
      "column": "id",
      "boundBy": "prop",
    },
  ],
  "definedBy": "synapse-react-client/synapse-queries/entity/useExportToCavatica.ts#addDrsUriToSql",
  "onMissing": "silently-malformed",
  "note": "...",
  "undeclaredRoles": [],
}
```

### `active`

Whether the behavior is on.

| Value         | Meaning                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `always`      | The trigger prop folded to a constant that enables it, or the capability has no trigger.                                        |
| `conditional` | The trigger is a runtime value (e.g. `isRowSelectionVisible={isDownloadable}`), so it is on for some states and off for others. |

A capability whose trigger folded to _disabled_ emits no record at all.

### `requires[].boundBy`

**The load-bearing field.** How this column got its name.

| Value        | Meaning                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prop`       | The call site named the column explicitly. Safe: the coupling is visible in the portal's own source.                                                                                                           |
| `default`    | The name comes from a library default in the consuming hook's signature. **An undeclared coupling** — it works only while the view happens to use that name, and nothing in the portal records the assumption. |
| `unresolved` | The prop is set to a value that cannot be folded statically.                                                                                                                                                   |

`column` is absent when `boundBy` is `unresolved`. For a list-valued prop
(`rowSelectionPrimaryKey`), `column` is comma-joined.

### `undeclaredRoles`

Convenience: the `role` values whose `boundBy` is `default`. Non-empty means
this call site is riding on library defaults — the primary thing to review.

### `onMissing`

What a missing or wrongly-named column does at runtime. This is the severity
axis; it is **not** derived from code and is asserted by the registry author.

| Value                | Meaning                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `throws`             | Raises at runtime.                                                                                                       |
| `silently-malformed` | Produces wrong output with no error. The CAVATICA case: a bad DRS URI that only fails once CAVATICA tries to resolve it. |
| `degrades`           | Falls back to a working alternative path.                                                                                |

`note` qualifies `onMissing` where the bare value would mislead — e.g.
`row-selection` degrades rather than throws, because
`useComputeRowSelectionPrimaryKey` derives a key from the entity's column models
when the prop is absent; `getPrimaryKeyINFilter` throws only if the _resolved_
key is absent or composite.

### `definedBy`

Path to the function that actually consumes the column, so a reader can trace
the claim back to source. Written by hand in the registry; a `#name` suffix
names the specific function within the file.

---

## Cross-cutting cautions

- **Absence is not proof of absence.** Every empty field above has an "unknown"
  reading as well as a "none" reading; the tables state which applies where.
- **Search index → table is not in this output.** Pairing
  `<name>SearchIndexId` with `<name>Sql` is a `resources.ts` naming convention.
  Any consumer that draws that arrow is inferring it.
- **`onMissing` and `definedBy` are hand-authored** in `capabilities.ts`. They
  are the only fields not extracted from source, and the only ones that can go
  stale without the extractor noticing.

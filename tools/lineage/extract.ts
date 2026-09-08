/**
 * UI -> backend data lineage extractor for a Synapse portal app.
 *
 * Walks every JSX element rendered from `synapse-react-client`, constant-folds
 * the props that carry backend references (sql, searchIndexId, entityId, card
 * column mappings), and reports which Synapse table each UI section reads.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'
import { CAPABILITIES, type Binding } from './capabilities'

// Reassigned per portal by analyzePortal(); the helpers below read them at call time.
let portalRoot = ''
let srcRoot = ''
let program: ts.Program
let checker: ts.TypeChecker

// Props whose value is a Synapse entity id, mapped to the role that entity plays.
// A bare `entityId` has no role -- the component's own name says what it reads.
const ENTITY_PROPS = new Map<string, string | undefined>([
  ['entityId', undefined],
  ['tableEntityId', 'table'],
  ['formSchemaEntityId', 'formSchema'],
  ['formUiSchemaEntityId', 'formUiSchema'],
  ['formNavSchemaEntityId', 'formNavSchema'],
])
// Components accept many query props beyond `sql` -- countSql, facetSql,
// studyAcknowledgementSql -- so match the suffix rather than listing them.
function isSqlProp(key: string): boolean {
  return key === 'sql' || /[a-z]Sql$/.test(key)
}

const OTHER_REF_PROPS = new Set([
  'searchIndexId',
  'url',
  'formGroupId',
  ...ENTITY_PROPS.keys(),
])

/** True if this prop's value points at a backend resource. */
function isRefProp(key: string): boolean {
  return isSqlProp(key) || OTHER_REF_PROPS.has(key)
}
// Keys that name a table column wherever they appear.
const COLUMN_KEYS = new Set([
  'dataTypeIconNames',
  'imageFileHandleColumnName',
  'URLColumnName',
  'matchColumnName',
  'link',
  'autocompleteFieldName',
  'fileIdColumnName',
  'fileNameColumnName',
  'fileVersionColumnName',
  'columnName',
  'linkColumnName',
])
// Keys that name a column only inside a genericCardSchema -- elsewhere ('title'
// on a plot, for instance) they hold display strings.
const CARD_SCHEMA_COLUMN_KEYS = new Set([
  'title',
  'description',
  'subTitle',
  'icon',
])
const COLUMN_LIST_KEYS = new Set([
  'secondaryLabels',
  'searchable',
  'rowSelectionPrimaryKey',
])

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return listFiles(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** Follows an identifier/property-access back to the declaration that initializes it. */
function resolveInitializer(node: ts.Node, depth = 0): ts.Node | undefined {
  let sym = checker.getSymbolAtLocation(node)
  if (sym && sym.flags & ts.SymbolFlags.Alias)
    sym = checker.getAliasedSymbol(sym)
  const decl = sym?.declarations?.[0]
  if (decl) {
    if (ts.isVariableDeclaration(decl) && decl.initializer)
      return decl.initializer
    if (ts.isPropertyAssignment(decl)) return decl.initializer
  }
  // An explicit type annotation (`const x: SomeProps = {...}`) makes the checker
  // resolve `x.prop` to the *type's* PropertySignature, which carries no value.
  // Fall back to reading the property off the object literal itself.
  if (ts.isPropertyAccessExpression(node) && depth < 12) {
    const base = foldObject(node.expression, depth + 1)
    const name = node.name.getText()
    const match = base?.properties.find(
      x =>
        (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) &&
        x.name.getText().replace(/['"]/g, '') === name,
    )
    if (match)
      return ts.isPropertyAssignment(match) ? match.initializer : match.name
  }
  return undefined
}

/** Constant-folds a node to a string, following identifiers and template literals. */
function foldString(node: ts.Node | undefined, depth = 0): string | undefined {
  if (!node || depth > 12) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text
    for (const span of node.templateSpans) {
      const v = foldString(span.expression, depth + 1)
      if (v === undefined) return undefined
      out += v + span.literal.text
    }
    return out
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return foldString(resolveInitializer(node, depth), depth + 1)
  }
  if (ts.isJsxExpression(node)) return foldString(node.expression, depth + 1)
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return foldString(node.expression, depth + 1)
  }
  return undefined
}

/** Resolves a node to an object literal, following identifiers. */
function foldObject(
  node: ts.Node | undefined,
  depth = 0,
): ts.ObjectLiteralExpression | undefined {
  if (!node || depth > 12) return undefined
  if (ts.isObjectLiteralExpression(node)) return node
  if (ts.isJsxExpression(node)) return foldObject(node.expression, depth + 1)
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return foldObject(resolveInitializer(node, depth), depth + 1)
  }
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return foldObject(node.expression, depth + 1)
  }
  return undefined
}

type Ref = {
  sql?: string
  table?: string
  searchIndexId?: string
  entityId?: string
  url?: string
  /** What the entity is used for, when the prop says so (e.g. a form schema). */
  entityRole?: string
  /** Version the query pins the table to, when it names one (`syn123.4`). */
  tableVersion?: string
  /** A Synapse form group, addressed by a numeric id rather than a syn id. */
  formGroupId?: string
  /** Entity owning a wiki page; `wikiId` absent means the entity's root wiki. */
  wikiOwnerId?: string
  wikiId?: string
}

// A wiki page is addressed by its owning entity plus a page id. In portal code
// these only ever appear on MarkdownSynapse, as sibling props or as sibling keys
// in a config object.
const WIKI_PROPS = new Set(['ownerId', 'wikiId'])

/** Builds a wiki Ref from a prop lookup, if the call site addresses a wiki. */
function wikiRef(get: (name: string) => ts.Node | undefined): Ref | undefined {
  const owner = foldString(get('ownerId'))
  const wiki = foldString(get('wikiId'))
  if (!owner && !wiki) return undefined
  return {
    ...(owner ? { wikiOwnerId: owner } : {}),
    ...(wiki ? { wikiId: wiki } : {}),
  }
}

/** Recursively harvests column names and backend refs out of a config object literal. */
function harvestConfig(
  obj: ts.ObjectLiteralExpression,
  cols: Set<string>,
  refs: Ref[],
  depth = 0,
  inCardSchema = false,
) {
  if (depth > 8) return

  const own = (name: string) => {
    const match = obj.properties.find(
      x =>
        (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) &&
        x.name.getText().replace(/['"]/g, '') === name,
    )
    if (!match) return undefined
    return ts.isPropertyAssignment(match) ? match.initializer : match.name
  }
  const wiki = wikiRef(own)
  if (wiki) refs.push(wiki)

  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const spread = foldObject(p.expression, depth + 1)
      if (spread) harvestConfig(spread, cols, refs, depth + 1, inCardSchema)
      continue
    }
    let key: string
    let val: ts.Node
    if (ts.isPropertyAssignment(p)) {
      key = p.name.getText().replace(/['"]/g, '')
      val = p.initializer
    } else if (ts.isShorthandPropertyAssignment(p)) {
      key = p.name.getText()
      const target =
        checker.getShorthandAssignmentValueSymbol(p)?.declarations?.[0]
      if (!target || !ts.isVariableDeclaration(target) || !target.initializer)
        continue
      val = target.initializer
    } else {
      continue
    }

    if (WIKI_PROPS.has(key)) continue

    // columnIconOptions maps column name -> value -> icon; only its keys are columns.
    if (key === 'columnIconOptions') {
      const iconCfg = foldObject(val, depth + 1)
      const columnsProp = iconCfg?.properties.find(
        x => ts.isPropertyAssignment(x) && x.name.getText() === 'columns',
      ) as ts.PropertyAssignment | undefined
      const columnsObj =
        columnsProp && foldObject(columnsProp.initializer, depth + 1)
      for (const c of columnsObj?.properties ?? []) {
        if (ts.isPropertyAssignment(c))
          cols.add(c.name.getText().replace(/['"]/g, ''))
      }
      continue
    }

    if (
      COLUMN_KEYS.has(key) ||
      (inCardSchema && CARD_SCHEMA_COLUMN_KEYS.has(key))
    ) {
      const s = foldString(val, depth + 1)
      // A generic-card `type` is a SynapseConstants enum, not a column.
      const isEnum =
        s && /^(GENERIC_CARD|STUDY|DATASET|PUBLICATION|TOOL)$/.test(s)
      if (s && !isEnum && !(key === 'link' && looksLikeRoute(s))) cols.add(s)
    } else if (COLUMN_LIST_KEYS.has(key) && ts.isArrayLiteralExpression(val)) {
      for (const el of val.elements) {
        const s = foldString(el, depth + 1)
        if (s) cols.add(s)
      }
    } else if (key === 'searchParams') {
      const params = foldObject(val, depth + 1)
      for (const a of params?.properties ?? []) {
        if (!ts.isPropertyAssignment(a) && !ts.isShorthandPropertyAssignment(a))
          continue
        const name = a.name.getText().replace(/['"]/g, '')
        if (!name.startsWith('qw') && !name.startsWith('__')) cols.add(name)
      }
    } else if (key === 'columnAliases') {
      const aliases = foldObject(val, depth + 1)
      if (aliases) {
        for (const a of aliases.properties) {
          if (
            ts.isPropertyAssignment(a) ||
            ts.isShorthandPropertyAssignment(a)
          ) {
            cols.add(a.name.getText().replace(/['"]/g, ''))
          }
        }
      }
    } else if (isRefProp(key)) {
      const s = foldString(val, depth + 1)
      if (s) refs.push(classify(key, s))
    } else if (ts.isObjectLiteralExpression(val) || ts.isIdentifier(val)) {
      const nested = foldObject(val, depth + 1)
      if (nested && nested !== obj) {
        harvestConfig(
          nested,
          cols,
          refs,
          depth + 1,
          inCardSchema || key === 'genericCardSchema',
        )
      }
    } else if (ts.isArrayLiteralExpression(val)) {
      for (const el of val.elements) {
        const nested = foldObject(el, depth + 1)
        if (nested) harvestConfig(nested, cols, refs, depth + 1, inCardSchema)
      }
    }
  }
}

function classify(key: string, value: string): Ref {
  if (isSqlProp(key)) return { sql: value, ...tableOf(value) }
  if (key === 'searchIndexId') return { searchIndexId: value }
  if (key === 'formGroupId') return { formGroupId: value }
  if (ENTITY_PROPS.has(key)) {
    const role = ENTITY_PROPS.get(key)
    return { entityId: value, ...(role ? { entityRole: role } : {}) }
  }
  return { url: value }
}

function looksLikeRoute(value: string): boolean {
  return (
    value.startsWith('/') || value.startsWith('#') || /^[a-z]+:/i.test(value)
  )
}

/** The queried table, and its pinned version when the query names one. */
function tableOf(sql: string): { table?: string; tableVersion?: string } {
  const m = /\bfrom\s+(syn\d+)(?:\.(\d+))?/i.exec(sql)
  if (!m) return {}
  return { table: m[1], ...(m[2] ? { tableVersion: m[2] } : {}) }
}

/** SQL words that appear bare inside expressions but never name a column. */
const SQL_KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'null',
  'like',
  'case',
  'when',
  'then',
  'else',
  'end',
  'distinct',
  'true',
  'false',
  'as',
  'between',
  'asc',
  'desc',
])

/** Splits a SELECT list on commas that are not inside parentheses or quotes. */
function splitTopLevel(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | undefined
  let current = ''
  for (const ch of list) {
    if (quote) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current)
  return out
}

/** Every column an expression reads, ignoring function names and literals. */
function expressionColumns(expr: string): string[] {
  // Blank out string literals so their contents cannot look like identifiers.
  const bare = expr.replace(/'(?:[^']|'')*'/g, "''")
  const out: string[] = []
  for (const m of bare.matchAll(/"([^"]+)"|([A-Za-z_][\w.]*)\s*(\()?/g)) {
    if (m[1]) {
      out.push(m[1])
      continue
    }
    if (m[3]) continue // a function name, not a column
    if (!SQL_KEYWORDS.has(m[2].toLowerCase())) out.push(m[2])
  }
  return out
}

/** Alias -> source column, for every `col AS "alias"` in a SELECT list. */
function sqlAliasMap(sql: string): Map<string, string> {
  const out = new Map<string, string>()
  const m = /select\s+([\s\S]+?)\s+from\s/i.exec(sql)
  if (!m || m[1].trim() === '*') return out
  for (const item of splitTopLevel(m[1])) {
    const parts = item.trim().split(/\s+as\s+/i)
    if (parts.length !== 2) continue
    const source = parts[0].trim().replace(/^["']|["']$/g, '')
    const alias = parts[1].trim().replace(/^["']|["']$/g, '')
    // `' ' as "lastName"` aliases a literal, not a column -- nothing to trace back to.
    if (/^[A-Za-z_][\w.]*$/.test(source) && alias) out.set(alias, source)
  }
  return out
}

/** Columns a query filters or sorts on -- real dependencies even under SELECT *. */
function sqlPredicateColumns(sql: string): string[] {
  const out: string[] = []
  const tail = /\bwhere\b([\s\S]*)$/i.exec(sql)?.[1] ?? ''
  for (const m of tail.matchAll(
    /"?([A-Za-z_][\w.]*)"?\s*(?:=|!=|<>|>=|<=|>|<|\bin\b|\bis\b|\blike\b)/gi,
  )) {
    out.push(m[1])
  }
  for (const m of sql.matchAll(/\border\s+by\s+"?([A-Za-z_][\w.]*)"?/gi)) {
    if (m[1].toUpperCase() !== 'ROW_ID') out.push(m[1])
  }
  return out
}

/** Columns explicitly named in a SELECT list (ignores `SELECT *`). */
function sqlColumns(sql: string): string[] {
  const m = /select\s+([\s\S]+?)\s+from\s/i.exec(sql)
  if (!m || m[1].trim() === '*') return []
  return splitTopLevel(m[1])
    .flatMap(item => {
      // `col AS "Display Label"` -- the backend dependency is the left-hand side.
      const source = item
        .trim()
        .split(/\s+as\s+/i)[0]
        .trim()
      // A bare identifier is the column; anything else is an expression that may
      // read several (`concat('[', acronym, '](...', id, ')')`).
      if (/^"?[A-Za-z_][\w.]*"?$/.test(source))
        return [source.replace(/^["']|["']$/g, '')]
      return expressionColumns(source)
    })
    .filter(c => c && c !== '*' && /^[A-Za-z_]/.test(c))
}

/**
 * The label a user sees on the page: the nearest enclosing SectionLayout
 * title, or the `title` of the enclosing DetailsPageContent content item
 * (`{ id, title, element }` — DetailsPageSectionLayout renders `title` as the
 * section heading; `id` alone is an anchor, not user-visible, so it is never
 * used as a label).
 */
function sectionTitle(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n
      const tag = open.tagName.getText()
      if (/SectionLayout|Section$/.test(tag)) {
        const attr = open.attributes.properties.find(
          a => ts.isJsxAttribute(a) && a.name.getText() === 'title',
        ) as ts.JsxAttribute | undefined
        const t = attr && foldString(attr.initializer)
        if (t) return t
      }
    }
    // The sibling `element` property distinguishes a content-item object from
    // config objects where `title` names a column (genericCardSchema).
    if (ts.isObjectLiteralExpression(n)) {
      const prop = (name: string) =>
        n.properties.find(
          p => ts.isPropertyAssignment(p) && p.name.getText() === name,
        ) as ts.PropertyAssignment | undefined
      if (prop('element')) {
        const t = prop('title') && foldString(prop('title')!.initializer)
        if (t) return t
      }
    }
  }
  return undefined
}

/** `createStaticMeta({ title })` at module scope -- the page's own name. */
function pageTitle(sf: ts.SourceFile): string | undefined {
  let found: string | undefined
  const visit = (n: ts.Node) => {
    if (found) return
    if (
      ts.isCallExpression(n) &&
      /createStaticMeta$/.test(n.expression.getText())
    ) {
      const arg = foldObject(n.arguments[0])
      const t = arg?.properties.find(
        x => ts.isPropertyAssignment(x) && x.name.getText() === 'title',
      ) as ts.PropertyAssignment | undefined
      found = t && foldString(t.initializer)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

/** True if the JSX tag came from synapse-react-client or the portal framework. */
function isSrcComponent(tagName: ts.JsxTagNameExpression): boolean {
  const sym = checker.getSymbolAtLocation(tagName)
  if (!sym) return false
  if (sym.flags & ts.SymbolFlags.Alias) {
    const decl = sym.declarations?.[0]
    const spec =
      decl && ts.isImportSpecifier(decl)
        ? decl.parent.parent.parent.moduleSpecifier
        : decl && ts.isImportClause(decl)
          ? decl.parent.moduleSpecifier
          : undefined
    if (spec && ts.isStringLiteral(spec)) {
      return /^(synapse-react-client|@sage-bionetworks\/synapse-portal-framework)/.test(
        spec.text,
      )
    }
  }
  return false
}

/** Props set on a JSX element, merging spread objects in source order. */
function collectProps(node: ts.JsxOpeningLikeElement): Map<string, ts.Node> {
  const props = new Map<string, ts.Node>()
  for (const attr of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      const obj = foldObject(attr.expression)
      for (const p of obj?.properties ?? []) {
        if (ts.isPropertyAssignment(p))
          props.set(p.name.getText().replace(/['"]/g, ''), p.initializer)
        else if (ts.isShorthandPropertyAssignment(p))
          props.set(p.name.getText(), p.name)
      }
    } else if (ts.isJsxAttribute(attr)) {
      props.set(attr.name.getText(), attr.initializer ?? attr.name)
    }
  }
  return props
}

/** Folds a node to a list of strings, for props holding column-name arrays. */
function foldStringList(
  node: ts.Node | undefined,
  depth = 0,
): string[] | undefined {
  if (!node || depth > 12) return undefined
  if (ts.isJsxExpression(node))
    return foldStringList(node.expression, depth + 1)
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return foldStringList(resolveInitializer(node, depth), depth + 1)
  }
  if (!ts.isArrayLiteralExpression(node)) return undefined
  const out = node.elements.map(e => foldString(e))
  return out.every(v => v !== undefined) ? out : undefined
}

/** Constant-folds a node to a boolean, following identifiers. */
function foldBoolean(
  node: ts.Node | undefined,
  depth = 0,
): boolean | undefined {
  if (!node || depth > 12) return undefined
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isJsxExpression(node)) return foldBoolean(node.expression, depth + 1)
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return foldBoolean(resolveInitializer(node, depth), depth + 1)
  }
  return undefined
}

type DerivedDependency = {
  capability: string
  /** 'always' when unconditional, 'conditional' when the trigger is a runtime value. */
  active: 'always' | 'conditional'
  trigger?: { prop: string; value?: unknown }
  requires: {
    role: string
    column?: string
    boundBy: Binding | 'unresolved'
    prop: string
  }[]
  definedBy: string
  onMissing: string
  note?: string
  /** Roles the call site leaves to a library default -- undeclared coupling. */
  undeclaredRoles: string[]
}

/** Evaluates the capability registry against one call site's props. */
function deriveDependencies(
  component: string,
  props: Map<string, ts.Node>,
): DerivedDependency[] {
  const out: DerivedDependency[] = []
  for (const cap of CAPABILITIES) {
    if (!cap.components.includes(component)) continue

    let active: 'always' | 'conditional' = 'always'
    let triggerValue: unknown
    if (cap.triggerProp) {
      const raw = props.get(cap.triggerProp)
      if (!raw) continue
      if (cap.triggerWhen === 'nonEmptyArray') {
        const list = foldStringList(raw)
        if (list === undefined) active = 'conditional'
        else if (list.length === 0) continue
        else triggerValue = list
      } else {
        const bool = foldBoolean(raw)
        if (bool === false) continue
        // `isRowSelectionVisible={isDownloadable}` -- a runtime value, so the
        // behavior is on for some rows and off for others.
        if (bool === undefined) active = 'conditional'
        else triggerValue = true
      }
    }

    const requires = cap.requires.map(r => {
      const raw = props.get(r.prop)
      if (r.isList) {
        const list = raw && foldStringList(raw)
        return {
          role: r.role,
          prop: r.prop,
          column: list?.join(','),
          boundBy: (list ? 'prop' : raw ? 'unresolved' : 'default') as
            | Binding
            | 'unresolved',
        }
      }
      const value = raw && foldString(raw)
      if (value)
        return {
          role: r.role,
          prop: r.prop,
          column: value,
          boundBy: 'prop' as const,
        }
      if (raw)
        return { role: r.role, prop: r.prop, boundBy: 'unresolved' as const }
      return {
        role: r.role,
        prop: r.prop,
        column: r.fallback,
        boundBy: 'default' as const,
      }
    })

    // All-or-nothing props with none set means the feature is simply not configured.
    if (
      cap.skipWhenFullyDefaulted &&
      requires.every(r => r.boundBy === 'default')
    )
      continue

    out.push({
      capability: cap.id,
      active,
      ...(cap.triggerProp
        ? { trigger: { prop: cap.triggerProp, value: triggerValue } }
        : {}),
      requires,
      definedBy: cap.definedBy,
      onMissing: cap.onMissing,
      ...(cap.note ? { note: cap.note } : {}),
      undeclaredRoles: requires
        .filter(r => r.boundBy === 'default')
        .map(r => r.role),
    })
  }
  return out
}

type Usage = {
  file: string
  line: number
  section?: string
  component: string
  kind: 'page-query' | 'render' | 'context-read'
  refs: Ref[]
  columns: string[]
  derived?: DerivedDependency[]
}
/** Extracts every backend data dependency in one portal. `[]` if it has no src/. */
function analyzePortal(root: string): Usage[] {
  portalRoot = root
  srcRoot = path.join(root, 'src')
  if (!fs.existsSync(srcRoot)) return []

  program = ts.createProgram(listFiles(srcRoot), {
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: root,
    paths: { '@/*': ['./src/*'] },
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
  })
  checker = program.getTypeChecker()

  const usages: Usage[] = []

  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(srcRoot) || sf.isDeclarationFile) continue
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        if (isSrcComponent(node.tagName)) {
          const cols = new Set<string>()
          const refs: Ref[] = []
          for (const attr of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attr)) {
              const spread = foldObject(attr.expression)
              if (spread) harvestConfig(spread, cols, refs, 0)
              continue
            }
            if (!ts.isJsxAttribute(attr)) continue
            const key = attr.name.getText()
            if (isRefProp(key)) {
              const s = foldString(attr.initializer)
              if (s) refs.push(classify(key, s))
            } else {
              const obj = foldObject(attr.initializer)
              if (obj) harvestConfig(obj, cols, refs, 0)
              else if (COLUMN_KEYS.has(key)) {
                const s = foldString(attr.initializer)
                if (s && !(key === 'link' && looksLikeRoute(s))) cols.add(s)
              }
            }
          }
          const props = collectProps(node)
          const wiki = wikiRef(name => props.get(name))
          if (wiki) refs.push(wiki)

          const derived = deriveDependencies(node.tagName.getText(), props)
          if (refs.length || cols.size || derived.length) {
            const aliases = new Map<string, string>()
            for (const r of refs) {
              if (!r.sql) continue
              sqlColumns(r.sql).forEach(c => cols.add(c))
              sqlPredicateColumns(r.sql).forEach(c => cols.add(c))
              sqlAliasMap(r.sql).forEach((source, alias) =>
                aliases.set(alias, source),
              )
            }
            const resolved = new Set([...cols].map(c => aliases.get(c) ?? c))
            // A spread config is harvested and also read through collectProps, so
            // the same reference can arrive by two paths.
            const seen = new Set<string>()
            const uniqueRefs = refs.filter(r => {
              const key = JSON.stringify(r)
              return seen.has(key) ? false : (seen.add(key), true)
            })
            usages.push({
              file: path.relative(portalRoot, sf.fileName),
              line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              section: sectionTitle(node) ?? pageTitle(sf),
              component: node.tagName.getText(),
              kind:
                node.tagName.getText() === 'DetailsPage'
                  ? 'page-query'
                  : 'render',
              refs: uniqueRefs,
              columns: [...resolved].sort(),
              ...(derived.length ? { derived } : {}),
            })
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        /useDetailsPageContext$/.test(node.expression.getText()) &&
        node.arguments.length > 0
      ) {
        const column = foldString(node.arguments[0])
        if (column) {
          usages.push({
            file: path.relative(portalRoot, sf.fileName),
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            component: 'useDetailsPageContext',
            kind: 'context-read',
            refs: [],
            columns: [column],
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  // A context-read resolves against whichever DetailsPage mounts the tab. That is
  // the DetailsPage in the same file, or -- for a page split into tab files -- the
  // one in the same directory, but only when that directory holds exactly one.
  const pageQueryByFile = new Map<string, Ref[]>()
  const pageQueriesByDir = new Map<string, Set<string>>()
  const refsByDir = new Map<string, Ref[]>()
  for (const u of usages) {
    if (u.kind !== 'page-query' || !u.refs.length) continue
    pageQueryByFile.set(u.file, u.refs)
    const dir = path.dirname(u.file)
    const tables = pageQueriesByDir.get(dir) ?? new Set<string>()
    u.refs.forEach(r => r.table && tables.add(r.table))
    pageQueriesByDir.set(dir, tables)
    refsByDir.set(dir, u.refs)
  }
  for (const u of usages) {
    if (u.kind !== 'context-read') continue
    const dir = path.dirname(u.file)
    const dirIsUnambiguous = (pageQueriesByDir.get(dir)?.size ?? 0) === 1
    u.refs =
      pageQueryByFile.get(u.file) ??
      (dirIsUnambiguous ? refsByDir.get(dir)! : [])
  }

  return usages
}

/** Walks up from this file until the monorepo root (the one holding apps/portals). */
function findRepoRoot(): string {
  let dir = __dirname
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'apps', 'portals'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error(`could not locate the monorepo root above ${__dirname}`)
}

function listPortals(repoRoot: string): string[] {
  return fs
    .readdirSync(path.join(repoRoot, 'apps', 'portals'), {
      withFileTypes: true,
    })
    .filter(e => e.isDirectory() && e.name !== 'node_modules')
    .map(e => e.name)
    .sort()
}

const USAGE = `Extract UI -> backend data lineage from a Synapse portal app.

Usage:
  tsx tools/lineage/extract.ts --portal <name|path> [--out <dir>]
  tsx tools/lineage/extract.ts --all [--out <dir>]

Options:
  --portal <name>   Portal under apps/portals (e.g. nf), or a path to a portal root.
  --all             Every portal under apps/portals.
  --out <dir>       Write <portal>-lineage.json per portal instead of stdout.
  --help            Show this message.

Without --out, a single portal prints a JSON array and --all prints a JSON
object keyed by portal name. See README.md and DEFINITIONS.md.`

function parseArgs(argv: string[]) {
  const opts: { portal?: string; out?: string; all?: boolean; help?: boolean } =
    {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--all') opts.all = true
    else if (arg === '--portal' || arg === '--out') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) fail(`${arg} requires a value`)
      opts[arg === '--portal' ? 'portal' : 'out'] = value
    } else if (arg.startsWith('--portal='))
      opts.portal = arg.slice('--portal='.length)
    else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length)
    else fail(`unknown argument: ${arg}`)
  }
  return opts
}

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`)
  process.exit(2)
}

/** A --portal value is a portal name, or a path when it looks like one. */
function resolvePortal(
  value: string,
  repoRoot: string,
): { name: string; root: string } {
  const asPath = value.includes(path.sep) || value.startsWith('.')
  const root = asPath
    ? path.resolve(value)
    : path.join(repoRoot, 'apps', 'portals', value)
  if (!fs.existsSync(root)) {
    fail(
      `no portal at ${root}\n\navailable: ${listPortals(repoRoot).join(', ')}`,
    )
  }
  return { name: path.basename(root), root }
}

function writeResult(
  outDir: string | undefined,
  name: string,
  usages: Usage[],
): void {
  if (!outDir) return
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${name}-lineage.json`)
  fs.writeFileSync(file, JSON.stringify(usages, null, 2) + '\n')
  console.error(`${name}: ${usages.length} entries -> ${file}`)
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    return
  }
  if (opts.all && opts.portal) fail('pass either --portal or --all, not both')
  if (!opts.all && !opts.portal) fail('one of --portal or --all is required')

  const repoRoot = findRepoRoot()

  if (opts.portal) {
    const { name, root } = resolvePortal(opts.portal, repoRoot)
    const usages = analyzePortal(root)
    if (!usages.length)
      console.error(`${name}: no source directory at ${path.join(root, 'src')}`)
    if (opts.out) writeResult(opts.out, name, usages)
    else console.log(JSON.stringify(usages, null, 2))
    return
  }

  const all: Record<string, Usage[]> = {}
  for (const name of listPortals(repoRoot)) {
    all[name] = analyzePortal(path.join(repoRoot, 'apps', 'portals', name))
    writeResult(opts.out, name, all[name])
  }
  if (!opts.out) console.log(JSON.stringify(all, null, 2))
  else {
    const portals = Object.keys(all).length
    const entries = Object.values(all).reduce((n, u) => n + u.length, 0)
    console.error(`\n${portals} portals, ${entries} entries`)
  }
}

main()

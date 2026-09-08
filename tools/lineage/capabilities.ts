/**
 * Column dependencies that a component's *behavior* implies, rather than its
 * config naming outright.
 *
 * Enabling a feature can bind columns the portal never mentions: the CAVATICA
 * export rewrites the query through `addDrsUriToSql`, and the columns it splices
 * in come from library defaults whenever the portal leaves the props unset. Those
 * couplings are invisible to config-level analysis and break silently, so they
 * are declared here and evaluated against whatever props a call site sets.
 */

/** How a required column got its name -- an explicit prop, or a library default. */
export type Binding = 'prop' | 'default'

export type RequiredColumn = {
  role: string
  /** Prop that names the column at a call site. */
  prop: string
  /** Name used when the prop is absent, from the consuming hook's signature. */
  fallback?: string
  /** The prop holds a list of column names rather than one. */
  isList?: boolean
  /** Number of columns the consumer requires, when it is not one-per-role. */
  exactly?: number
}

export type Capability = {
  id: string
  /** Components whose render enables this behavior. */
  components: string[]
  /** Prop whose value turns the behavior on; absent means always active. */
  triggerProp?: string
  /** How to read the trigger prop's value. */
  triggerWhen?: 'nonEmptyArray' | 'truthy'
  requires: RequiredColumn[]
  /** Where the dependency is actually consumed, for someone tracing it back. */
  definedBy: string
  /** What a missing or wrong column does at runtime. */
  onMissing: 'throws' | 'silently-malformed' | 'degrades'
  /** Detail on the failure mode, where 'onMissing' alone would mislead. */
  note?: string
  /** Report nothing when the call site declares none of the props. */
  skipWhenFullyDefaulted?: boolean
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'export-to-analysis-platform',
    components: ['QueryWrapperPlotNav', 'SearchQueryWrapperPlotNav'],
    triggerProp: 'enabledExternalAnalysisPlatforms',
    triggerWhen: 'nonEmptyArray',
    requires: [
      { role: 'fileId', prop: 'fileIdColumnName', fallback: 'id' },
      { role: 'fileName', prop: 'fileNameColumnName', fallback: 'name' },
      {
        role: 'fileVersion',
        prop: 'fileVersionColumnName',
        fallback: 'currentVersion',
      },
    ],
    definedBy:
      'synapse-react-client/synapse-queries/entity/useExportToCavatica.ts#addDrsUriToSql',
    // The rewritten SQL CONCATs the column names in; a wrong name yields a bad
    // DRS URI that only fails once CAVATICA tries to resolve it.
    onMissing: 'silently-malformed',
  },
  {
    id: 'add-to-download-list',
    components: ['QueryWrapperPlotNav', 'StandaloneQueryWrapper'],
    requires: [
      { role: 'fileId', prop: 'fileIdColumnName' },
      { role: 'fileVersion', prop: 'fileVersionColumnName' },
    ],
    definedBy:
      'synapse-react-client/components/QueryWrapper/useGetAddToDownloadListRequestForCurrentQuery.ts',
    // Needs both props or neither: with neither it falls back to the entity's
    // own file column model, which still works.
    onMissing: 'degrades',
    skipWhenFullyDefaulted: true,
  },
  {
    id: 'row-selection',
    components: ['QueryWrapperPlotNav', 'StandaloneQueryWrapper'],
    triggerProp: 'isRowSelectionVisible',
    triggerWhen: 'truthy',
    requires: [
      {
        role: 'primaryKey',
        prop: 'rowSelectionPrimaryKey',
        isList: true,
        exactly: 1,
      },
    ],
    definedBy:
      'synapse-react-client/utils/functions/QueryFilterUtils.ts#getPrimaryKeyINFilter',
    onMissing: 'degrades',
    note:
      'Without the prop, useComputeRowSelectionPrimaryKey derives the key from the ' +
      "entity's column models. getPrimaryKeyINFilter throws only if the resolved key " +
      'is absent or composite, so an undeclared key is a coupling to the entity schema, ' +
      'not a guaranteed failure.',
  },
]

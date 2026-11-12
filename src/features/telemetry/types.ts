// Canonical v1 telemetry wire contracts. Unsigned counters stay decimal strings.
export type TargetId = string;
export type WorkspaceId = string;
export type Revision = string;
export type Generation = number;
export type TemplateId = string;
export type Platform = 'ios' | 'iosxe';
export type ConfigScope = 'local' | { profile: Platform } | { device: string };
export type CollectionState = 'stopped' | 'collecting' | 'fresh' | 'stale' | 'unsupported' | 'not_configured' | 'failed';
export type ObservationSeverity = 'info' | 'ok' | 'warn' | 'alert';
export type MetricValue = { kind: 'unsigned'; value: string } | { kind: 'number'; value: number } | { kind: 'text'; value: string } | { kind: 'bool'; value: boolean } | { kind: 'missing'; reason: string };
export interface Diagnostic {
  code: string;
  message: string;
  path: string;
  line: number | null;
  column: number | null;
}
export interface TargetRef {
  connection_id: string;
  platform: Platform;
}
export interface Capture {
  capture_id: string;
  target_id: TargetId;
  platform: Platform;
  command: string;
  parser_id: TemplateId;
  revision: Revision;
  observed_at_ms: number;
  monotonic_ms: number;
  raw: string;
}
export interface MetricRow {
  key: string;
  fields: Record<string, MetricValue>;
}
export interface WidgetFrame {
  workspace_id: WorkspaceId;
  target_id: TargetId;
  widget_id: string;
  revision: Revision;
  generation: Generation;
  observed_at_ms: number;
  last_success_at_ms: number | null;
  state: CollectionState;
  severity: ObservationSeverity;
  units: Record<string, string>;
  rows: Array<MetricRow>;
  diagnostics: Array<Diagnostic>;
}
export interface TargetStatus {
  target_id: TargetId;
  display_name: string;
  platform: Platform | null;
  state: CollectionState;
  last_success_at_ms: number | null;
  diagnostics: Array<Diagnostic>;
}
export interface WidgetSummary {
  workspace_id: WorkspaceId;
  target_id: TargetId;
  widget_id: string;
  revision: Revision;
  generation: Generation;
  observed_at_ms: number;
  last_success_at_ms: number | null;
  state: CollectionState;
  severity: ObservationSeverity;
  units: Record<string, string>;
  row_count: number;
  diagnostics: Array<Diagnostic>;
}
export interface SeriesSummary {
  target_id: TargetId;
  widget_id: string;
  row_key: string;
  field: string;
  unit: string | null;
  point_count: number;
}
export interface TelemetrySnapshot {
  workspace_id: WorkspaceId;
  generation: Generation;
  sequence: number;
  running: boolean;
  targets: Array<TargetStatus>;
  widgets: Array<WidgetSummary>;
  series: Array<SeriesSummary>;
  diagnostics: Array<Diagnostic>;
}
export interface TemplateAsset {
  id: TemplateId;
  platform: Platform;
  command: string;
  text: string;
  sha256: string;
}
export interface EffectiveConfig {
  /** Content revision of these effective assets, independent of the global bundle. */
  revision: Revision;
  widgets: Array<WidgetDefinition>;
  layouts: Array<LayoutDefinition>;
  templates: Record<TemplateId, TemplateAsset>;
}
export interface SeriesQuery {
  workspace_id: WorkspaceId;
  target_id: TargetId;
  widget_id: string;
  row_key: string;
  field: string;
  after_ms: number | null;
  limit: number;
}
export interface SeriesPage {
  points: Array<SeriesPoint>;
  next_after_ms: number | null;
}
export interface SeriesPoint {
  at_ms: number;
  value: number | null;
  reason: string | null;
}
export interface WidgetQuery {
  workspace_id: WorkspaceId;
  target_id: TargetId;
  widget_id: string;
  offset: number;
  limit: number;
}
export interface WidgetPage {
  metadata: WidgetSummary;
  rows: Array<MetricRow>;
  next_offset: number | null;
}
export interface ConfigDraft {
  scope: ConfigScope;
  widgets_yaml: string;
  layouts_yaml: string;
  templates: Record<TemplateId, string>;
  /** Global bundle authority, supplied separately from EffectiveConfig.revision. */
  expected_revision: Revision;
  reset_assets?: ResetAsset[];
}
export type ResetAsset = { widget: string } | { layout: string } | { template: string };
export interface ValidationReport {
  valid: boolean;
  draft_hash: string;
  diagnostics: Array<Diagnostic>;
  affected_targets: Array<TargetId>;
  masked_device_overrides: Array<TargetId>;
}
export interface PreviewToken {
  id: string;
  draft_hash: string;
  /** Global bundle authority; captures and frames use effective source revisions. */
  base_revision: Revision;
  sample_hashes: Record<string, string>;
  expires_at_ms: number;
}
export interface PreviewReport {
  token: PreviewToken | null;
  frames: Array<WidgetFrame>;
  diagnostics: Array<Diagnostic>;
}
export interface ApplyResult {
  /** Global published bundle authority, not an effective target revision. */
  revision: Revision;
  affected_targets: Array<TargetId>;
  masked_device_overrides: Array<TargetId>;
}
export interface StartRequest {
  workspace_id: WorkspaceId;
  targets: Array<TargetRef>;
  local_enabled?: boolean;
  monitored_interfaces: Record<TargetId, Array<string>>;
}
export interface FrameContext {
  workspace_id: WorkspaceId;
  target_id: TargetId;
  revision: Revision;
  generation: Generation;
}
export interface LocalSample {
  observed_at_ms: number;
  monotonic_ms: number;
  sources: Record<string, Array<MetricRow>>;
  diagnostics: Array<Diagnostic>;
}

export type LocalCollector = 'local.cpu' | 'local.memory' | 'local.filesystems' | 'local.network' | 'local.processes';
export type WidgetSource = { kind: 'local'; collector: LocalCollector } | { kind: 'ssh'; commands: Partial<Record<Platform, string>>; templates: Partial<Record<Platform, TemplateId>> };
export interface NumericTransform { field: string; multiplier?: number; unit?: string | null }
export interface ViewField { field: string; label: string; unit?: string | null }
export type Aggregation = 'first' | 'sum' | 'mean' | 'min' | 'max' | 'count';
export type WidgetView = { type: 'table' | 'kv'; columns: ViewField[] } | { type: 'stat'; field?: string | null; label: string; aggregation: Aggregation } | { type: 'chart'; series: ViewField[] };
export interface AlertPredicate { field: string; op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le'; value: number | boolean | string; severity: ObservationSeverity; message: string }
export interface HistoryDefinition { fields: string[] }
export interface WidgetDefinition {
  widget: string; title: string; source: WidgetSource; interval: number; key: string[];
  fields: Record<string, string[]>; view: WidgetView;
  rates?: Record<string, NumericTransform>; deltas?: Record<string, NumericTransform>;
  computes?: Record<string, string>; alerts?: AlertPredicate[]; history?: HistoryDefinition | null;
}
export interface LayoutEntry { widget: string; span: number }
export interface LayoutSection { id: string; title: string; rows: LayoutEntry[][] }
export interface LayoutDefinition { layout: string; platforms: Platform[]; sections: LayoutSection[] }
export interface WidgetDocument { schema_version: 1; widgets: WidgetDefinition[] }
export interface LayoutDocument { schema_version: 1; layouts: LayoutDefinition[] }
export interface Catalog { widgets: Record<string, WidgetDefinition>; layouts: Record<string, LayoutDefinition>; templates: Record<TemplateId, TemplateAsset> }

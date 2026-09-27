import { invoke } from "@tauri-apps/api/core";

export type IntentKind = "golden" | "jinja";

export interface IntentSelector {
  /** Target a saved fan-out group by id (runs against every member). */
  group_id?: string | null;
  /** Target a single saved SSH connection by id. */
  ssh_connection_id?: string | null;
  /** Legacy explicit device list (`ssh:<uuid>` / `netconf:<id>`). */
  device_ids: string[];
  /** Legacy block-tag selection — no longer resolved by the backend. */
  tags: string[];
}

export interface IntentTemplate {
  id: string;
  name: string;
  vendor: string;
  platform: string;
  kind: IntentKind;
  body: string;
  vars_yaml: string;
  selector: IntentSelector;
  match_mode: "baseline" | "partial";
  created_at: number;
  updated_at: number;
}

export const intentCreate = (tpl: Omit<IntentTemplate, "id" | "created_at" | "updated_at">) =>
  invoke<string>("intent_create", {
    tpl: { ...tpl, id: "", created_at: 0, updated_at: 0 } as IntentTemplate,
  });

export const intentGet = (id: string) =>
  invoke<IntentTemplate | null>("intent_get", { id });

export const intentList = (vendor?: string | null, platform?: string | null) =>
  invoke<IntentTemplate[]>("intent_list", {
    vendor: vendor ?? null,
    platform: platform ?? null,
  });

export const intentUpdateBody = (id: string, body: string) =>
  invoke<void>("intent_update_body", { id, body });

export const intentUpdateVars = (id: string, varsYaml: string) =>
  invoke<void>("intent_update_vars", { id, varsYaml });

export const intentUpdateSelector = (id: string, selector: IntentSelector) =>
  invoke<void>("intent_update_selector", { id, selector });

export const intentUpdateMatchMode = (id: string, matchMode: "baseline" | "partial") =>
  invoke<void>("intent_update_match_mode", { id, matchMode });

export const intentRename = (id: string, name: string) =>
  invoke<void>("intent_rename", { id, name });

export const intentDelete = (id: string) =>
  invoke<void>("intent_delete", { id });

export const intentRender = (id: string, overrideVarsYaml?: string | null) =>
  invoke<string>("intent_render", {
    id,
    overrideVarsYaml: overrideVarsYaml ?? null,
  });

export const configNormalize = (vendor: string, platform: string, raw: string) =>
  invoke<string>("config_normalize", { vendor, platform, raw });

// ---- Phase 3 diff types ----

export type DriftSeverity = "none" | "additive" | "destructive" | "error";

export type LineChange =
  | { tag: "equal"; line: string }
  | { tag: "insert"; line: string }
  | { tag: "delete"; line: string };

export interface DriftBlock {
  block_path: string;
  changes: LineChange[];
  severity: DriftSeverity;
}

export interface DriftStats {
  additions: number;
  deletions: number;
  blocks_changed: number;
}

export interface DriftPatch {
  status: "in_sync" | "drift";
  severity: DriftSeverity;
  blocks: DriftBlock[];
  stats: DriftStats;
}

export const driftDiff = (
  intentId: string,
  runningRaw: string,
  overrideVarsYaml?: string | null,
) =>
  invoke<DriftPatch>("drift_diff", {
    intentId,
    runningRaw,
    overrideVarsYaml: overrideVarsYaml ?? null,
  });

// ---- Phase 4 drift reports ----

export interface DriftReport {
  id: string;
  template_id: string;
  device_id: string;
  device_kind: string;
  status: "in_sync" | "drift" | "error";
  severity: DriftSeverity;
  diff_patch: DriftPatch | null;
  error_msg: string | null;
  captured_at: number;
}

export const driftRunOnDemand = (templateId: string) =>
  invoke<DriftReport[]>("drift_run_on_demand", { templateId });

export const driftReportsList = (templateId: string, limit?: number) =>
  invoke<DriftReport[]>("drift_reports_list", {
    templateId,
    limit: limit ?? null,
  });

export const driftReportGet = (id: string) =>
  invoke<DriftReport | null>("drift_report_get", { id });

export const driftReportsByDevice = (
  deviceId: string,
  deviceKind: string,
  limit?: number,
) =>
  invoke<DriftReport[]>("drift_reports_by_device", {
    deviceId,
    deviceKind,
    limit: limit ?? null,
  });

// ---- Phase 5 schedules ----

export interface DriftSchedule {
  id: string;
  template_id: string;
  cron_expr: string;
  enabled: boolean;
  last_run_at: number | null;
  created_at: number;
}

export const driftScheduleCreate = (templateId: string, cronExpr: string) =>
  invoke<DriftSchedule>("drift_schedule_create", { templateId, cronExpr });

export const driftSchedulePause = (id: string) =>
  invoke<void>("drift_schedule_pause", { id });

export const driftScheduleResume = (id: string) =>
  invoke<void>("drift_schedule_resume", { id });

export const driftScheduleDelete = (id: string) =>
  invoke<void>("drift_schedule_delete", { id });

export const driftScheduleList = () =>
  invoke<DriftSchedule[]>("drift_schedule_list");

// ---- Phase 6 config snapshots ----

export interface ConfigSnapshot {
  id: string;
  device_id: string;
  device_kind: string;
  vendor: string | null;
  platform: string | null;
  normalized_config: string;
  label: string | null;
  source: "drift_run" | "manual";
  captured_at: number;
}

export const driftSnapshotDevice = (
  connectionId: string,
  vendor: string,
  platform: string,
  password?: string,
) =>
  invoke<ConfigSnapshot | null>("drift_snapshot_device", {
    connectionId,
    vendor,
    platform,
    password: password ?? null,
  });

export const configSnapshotsList = (
  deviceId: string,
  deviceKind: string,
  limit?: number,
) =>
  invoke<ConfigSnapshot[]>("config_snapshots_list", {
    deviceId,
    deviceKind,
    limit: limit ?? null,
  });

export const configSnapshotGet = (id: string) =>
  invoke<ConfigSnapshot | null>("config_snapshot_get", { id });

export const configSnapshotSetLabel = (id: string, label: string | null) =>
  invoke<void>("config_snapshot_set_label", { id, label });

export const configSnapshotsDiff = (aId: string, bId: string) =>
  invoke<DriftPatch>("config_snapshots_diff", { aId, bId });

// ---- Drift exceptions ----

export interface DriftException {
  id: string;
  template_id: string;
  line: string;
  note: string | null;
  created_at: number;
}

export const driftExceptionAdd = (templateId: string, line: string, note?: string) =>
  invoke<DriftException>("drift_exception_add", { templateId, line, note });

export const driftExceptionsList = (templateId: string) =>
  invoke<DriftException[]>("drift_exceptions_list", { templateId });

export const driftExceptionDelete = (id: string) =>
  invoke<void>("drift_exception_delete", { id });

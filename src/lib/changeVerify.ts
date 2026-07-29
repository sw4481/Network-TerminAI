import { invoke } from "@tauri-apps/api/core";

export interface CheckBundle {
  id: string;
  name: string;
  description: string | null;
  vendor: string;
  platform: string;
  commands: string[];
  created_at: number;
  updated_at: number;
}

export interface NewCheckBundle {
  name: string;
  description: string | null;
  vendor: string;
  platform: string;
  commands: string[];
}

export const bundleCreate = (n: NewCheckBundle) =>
  invoke<CheckBundle>("bundle_create", { new: n });
export const bundleGet = (id: string) => invoke<CheckBundle>("bundle_get", { id });
export const bundleList = (vendor?: string, platform?: string) =>
  invoke<CheckBundle[]>("bundle_list", { vendor: vendor ?? null, platform: platform ?? null });
export const bundleUpdateCommands = (id: string, commands: string[]) =>
  invoke<void>("bundle_update_commands", { id, commands });
export const bundleRename = (id: string, name: string, description: string | null) =>
  invoke<void>("bundle_rename", { id, name, description });
export const bundleDelete = (id: string) => invoke<void>("bundle_delete", { id });

export type SnapshotLabel = "pre" | "post";

export interface ChangeSnapshotResult {
  command: string;
  parsed_output_id: number;
}

export interface ChangeSnapshot {
  id: string;
  tab_id: string;
  bundle_id: string;
  label: SnapshotLabel;
  captured_at: number;
  results: ChangeSnapshotResult[];
}

export const changeRunPre = (
  tabId: string,
  bundleId: string,
  vendor: string,
  platform: string,
) => invoke<ChangeSnapshot>("change_run_pre", { tabId, bundleId, vendor, platform });

export const changeRunPost = (
  tabId: string,
  bundleId: string,
  vendor: string,
  platform: string,
) => invoke<ChangeSnapshot>("change_run_post", { tabId, bundleId, vendor, platform });

/**
 * SSH-direct pre-snapshot for interactive sessions. Runs the bundle's commands
 * over a one-shot SSH session to a saved connection instead of the OSC-133 PTY
 * runner (which times out per command on real network devices).
 */
export const changeRunPreSsh = (
  tabId: string,
  connectionId: string,
  bundleId: string,
  vendor: string,
  platform: string,
  password?: string,
) =>
  invoke<ChangeSnapshot>("change_run_pre_ssh", {
    tabId, connectionId, bundleId, vendor, platform, password,
  });

/** SSH-direct post-snapshot. See {@link changeRunPreSsh}. */
export const changeRunPostSsh = (
  tabId: string,
  connectionId: string,
  bundleId: string,
  vendor: string,
  platform: string,
  password?: string,
) =>
  invoke<ChangeSnapshot>("change_run_post_ssh", {
    tabId, connectionId, bundleId, vendor, platform, password,
  });

export const changeSnapshotGet = (id: string) =>
  invoke<ChangeSnapshot>("change_snapshot_get", { id });

export const changeLatestPreForTab = (tabId: string, bundleId: string) =>
  invoke<string | null>("change_latest_pre_for_tab", { tabId, bundleId });

export type Severity = "red" | "yellow" | "green";

export interface ClassifiedDelta {
  command: string;
  family: string;
  severity: Severity;
  path: string;
  before: unknown;
  after: unknown;
  message: string;
}

export interface SeverityCounts {
  red: number;
  yellow: number;
  green: number;
}

export interface ApprovedMatch {
  delta_path: string;
  command: string;
  note: string;
}

export interface ExpectedDelta {
  command_substring: string;
  path_substring: string;
  note: string;
}

export interface ReportSummary {
  pre_snapshot_id: string;
  post_snapshot_id: string;
  bundle_id: string;
  counts: SeverityCounts;
  deltas: ClassifiedDelta[];
  matched_approved: ApprovedMatch[];
  notes: string | null;
}

export const changeRunPostAndReport = (
  tabId: string,
  bundleId: string,
  vendor: string,
  platform: string,
  preSnapshotId: string,
  approvedDeltas: ExpectedDelta[],
  notes: string | null,
) =>
  invoke<[string, ReportSummary, number]>("change_run_post_and_report", {
    tabId, bundleId, vendor, platform, preSnapshotId, approvedDeltas, notes,
  });

/** SSH-direct post-and-report. See {@link changeRunPreSsh}. */
export const changeRunPostAndReportSsh = (
  tabId: string,
  connectionId: string,
  bundleId: string,
  vendor: string,
  platform: string,
  preSnapshotId: string,
  approvedDeltas: ExpectedDelta[],
  notes: string | null,
  password?: string,
) =>
  invoke<[string, ReportSummary, number]>("change_run_post_and_report_ssh", {
    tabId, connectionId, bundleId, vendor, platform, preSnapshotId, approvedDeltas, notes, password,
  });

export const changeReportGet = (id: string) =>
  invoke<[ReportSummary, ExpectedDelta[], number]>("change_report_get", { id });

export const changeReportList = () =>
  invoke<[string, number, string, string][]>("change_report_list");

export const changeReportAppendApproval = (
  reportId: string,
  approval: ExpectedDelta,
) => invoke<[ReportSummary, ExpectedDelta[]]>("change_report_append_approval", { reportId, approval });

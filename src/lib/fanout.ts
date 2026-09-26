import { invoke } from "@tauri-apps/api/core";

export type DeviceKind = "ssh" | "netconf";

export interface FanoutGroup {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  member_count: number;
}

export interface FanoutMember {
  device_id: string;
  device_kind: DeviceKind;
  display_name: string;
  host: string;
  added_at: number;
}

export interface FanoutRunSummary {
  id: string;
  group_id: string | null;
  command: string;
  status: "pending" | "running" | "success" | "partial" | "failed" | "cancelled";
  started_at: number;
  ended_at: number | null;
  total: number;
  succeeded: number;
  failed: number;
}

export interface DeviceResultRow {
  device_id: string;
  device_kind: DeviceKind;
  display_name: string;
  status: "pending" | "running" | "success" | "failed" | "timeout" | "cancelled";
  error: string | null;
  block_id: string | null;
  parsed_output_id: string | null;
  started_at: number | null;
  ended_at: number | null;
  attempt_number: number;
}

export interface FanoutRunDetail {
  summary: FanoutRunSummary;
  devices: DeviceResultRow[];
}

export interface CsvImportResult {
  added: number;
  warnings: string[];
}

export const fanoutGroupCreate = (name: string, description: string | null) =>
  invoke<FanoutGroup>("fanout_group_create", { name, description });

export const fanoutGroupGet = (id: string) =>
  invoke<FanoutGroup>("fanout_group_get", { id });

export const fanoutGroupUpdate = (
  id: string,
  patch: { name?: string; description?: string | null },
) =>
  invoke<FanoutGroup>("fanout_group_update", {
    id,
    name: patch.name ?? null,
    description:
      patch.description === undefined ? null : [patch.description],
  });

export const fanoutGroupDelete = (id: string) =>
  invoke<void>("fanout_group_delete", { id });

export const fanoutGroupList = () => invoke<FanoutGroup[]>("fanout_group_list");

export const fanoutMemberAdd = (
  groupId: string,
  deviceId: string,
  kind: DeviceKind,
) =>
  invoke<void>("fanout_member_add", {
    groupId,
    deviceId,
    deviceKind: kind,
  });

export const fanoutMemberAddBulk = (
  groupId: string,
  members: Array<{ deviceId: string; kind: DeviceKind }>,
) =>
  invoke<number>("fanout_member_add_bulk", {
    groupId,
    members: members.map((m) => [m.deviceId, m.kind]),
  });

export const fanoutMemberRemove = (
  groupId: string,
  deviceId: string,
  kind: DeviceKind,
) =>
  invoke<void>("fanout_member_remove", {
    groupId,
    deviceId,
    deviceKind: kind,
  });

export const fanoutMemberList = (groupId: string) =>
  invoke<FanoutMember[]>("fanout_member_list", { groupId });

export const fanoutGroupImportCsv = (groupId: string, csvBody: string) =>
  invoke<CsvImportResult>("fanout_group_import_csv", { groupId, csvBody });

export const fanoutRunList = (limit?: number) =>
  invoke<FanoutRunSummary[]>("fanout_run_list", { limit: limit ?? null });

export const fanoutRunGet = (runId: string) =>
  invoke<FanoutRunDetail>("fanout_run_get", { runId });

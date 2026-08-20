import { invoke } from "@tauri-apps/api/core";
import type { Vendor } from "./deviceProfiles";

export type { Vendor } from "./deviceProfiles";
export type ParamType = "string" | "enum" | "ip" | "int" | "interface";

export interface WorkflowStep {
  idx: number;
  command_template: string;
}

export interface WorkflowParam {
  name: string;
  type: ParamType;
  default_value: string | null;
  required: boolean;
  description: string;
  enum_values: string[] | null;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  vendor: Vendor;
  platform: string;
  tags: string[];
  steps: WorkflowStep[];
  params: WorkflowParam[];
  created_at: number;
  updated_at: number;
}

export interface WorkflowRunResult {
  run_id: string;
  workflow_name: string;
  commands: string[];
}

export interface GlobalCommandBarSettingsV1 {
  schema_version: 1;
  workflow_ids: string[];
}

export async function workflowList(
  filter: { vendor?: Vendor; platform?: string; namePrefix?: string } = {},
): Promise<Workflow[]> {
  return invoke<Workflow[]>("workflow_list", {
    vendor: filter.vendor,
    platform: filter.platform,
    namePrefix: filter.namePrefix,
  });
}

export async function workflowGet(id: string): Promise<Workflow | null> {
  return invoke<Workflow | null>("workflow_get", { id });
}

export async function workflowUpsert(workflow: Workflow): Promise<string> {
  return invoke<string>("workflow_upsert", { workflow });
}

export async function workflowDelete(id: string): Promise<void> {
  return invoke<void>("workflow_delete", { id });
}

export async function workflowRun(
  workflowId: string,
  tabId: string,
  values: Record<string, string>,
): Promise<WorkflowRunResult> {
  return invoke<WorkflowRunResult>("workflow_run", { workflowId, tabId, values });
}

export async function workflowRunComplete(runId: string): Promise<void> {
  return invoke<void>("workflow_run_complete", { runId });
}

export async function globalCommandBarGet(): Promise<GlobalCommandBarSettingsV1> {
  return invoke<GlobalCommandBarSettingsV1>("global_command_bar_get");
}

export async function globalCommandBarSet(
  settings: GlobalCommandBarSettingsV1,
): Promise<void> {
  return invoke<void>("global_command_bar_set", { settings });
}

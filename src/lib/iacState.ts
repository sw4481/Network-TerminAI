import { invoke } from "@tauri-apps/api/core";

export interface StateResource {
  resourceType: string;
  resourceName: string;
  address: string;
  resourceId?: string | null;
  attributes: unknown;
}

export interface TerraformState {
  serial: number;
  resources: StateResource[];
  outputs: unknown;
}

export interface DriftedResource {
  resourceType: string;
  resourceName: string;
  address: string;
  detectedChanges: string;
}

export interface DriftAnalysisEntry {
  resource: string;
  explanation: string;
  cause: string;
  recommendation: "import" | "revert" | "exception";
  impact: string;
}

export interface DriftCheckResult {
  hasDrift: boolean;
  drifted: DriftedResource[];
  analysis: { analyses: DriftAnalysisEntry[]; unavailable?: boolean };
}

export const iacLoadState = (projectPath: string) =>
  invoke<TerraformState | null>("iac_load_state", { projectPath });

export const iacQueryState = (projectPath: string, query?: string) =>
  invoke<StateResource[]>("iac_query_state", { projectPath, query: query ?? null });

export const iacCheckDrift = (projectPath: string) =>
  invoke<DriftCheckResult>("iac_check_drift", { projectPath });

export const iacAddDriftException = (projectPath: string, resourceAddress: string) =>
  invoke<void>("iac_add_drift_exception", { projectPath, resourceAddress });

export const iacListDriftExceptions = (projectPath: string) =>
  invoke<string[]>("iac_list_drift_exceptions", { projectPath });

/** Build the terraform import command the modal copies to the clipboard. */
export const buildImportCommand = (address: string, resourceId: string): string =>
  `terraform import ${address} ${resourceId}`;

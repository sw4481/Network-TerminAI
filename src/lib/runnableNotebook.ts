import { invoke } from "@tauri-apps/api/core";

export type AssertionOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "greater_than"
  | "less_than"
  | "exists";

export interface AssertionSpec {
  command: string;
  jsonpath: string;
  op: AssertionOp;
  expected: unknown;
}

export interface ParameterSpec {
  name: string;
  prompt: string;
  default?: string;
}

export interface CommandMeta {
  timeout_s?: number;
  expect_exit?: number;
}

export type NotebookCell =
  | { type: "markdown"; content: string }
  | { type: "command"; content: string; metadata?: CommandMeta }
  | { type: "approval"; content: string }
  | { type: "assertion"; spec: AssertionSpec }
  | { type: "parameter"; params: ParameterSpec[] };

export interface Frontmatter {
  title: string;
  description?: string | null;
  vendor?: string | null;
  platform?: string | null;
  parameters?: ParameterSpec[];
}

export interface RunnableNotebookDto {
  id: string;
  frontmatter: Frontmatter;
  cells: NotebookCell[];
  body_markdown: string;
  created_at: number;
  updated_at: number;
}

export interface RunnableNotebookSummaryDto {
  id: string;
  title: string;
  description: string | null;
  vendor: string | null;
  platform: string | null;
  cell_count: number;
  updated_at: number;
}

export type CellStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "awaiting_approval";

export type RunStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export type RunEvent =
  | { type: "cell_started"; cell_idx: number }
  | {
      type: "cell_finished";
      cell_idx: number;
      status: CellStatus;
      block_id?: string | null;
      error?: string | null;
    }
  | { type: "awaiting_approval"; cell_idx: number; prompt: string }
  | { type: "run_finished"; status: RunStatus };

export async function importRunnableNotebookMarkdown(markdown: string): Promise<string> {
  return invoke<string>("notebook_import_markdown", { markdown });
}

export async function exportRunnableNotebookMarkdown(id: string): Promise<string> {
  return invoke<string>("notebook_export_markdown", { id });
}

export async function listRunnableNotebooks(
  vendor?: string,
  limit?: number,
): Promise<RunnableNotebookSummaryDto[]> {
  return invoke<RunnableNotebookSummaryDto[]>("notebook_list_runnable", {
    vendor: vendor ?? null,
    limit: limit ?? null,
  });
}

export async function getRunnableNotebook(id: string): Promise<RunnableNotebookDto> {
  return invoke<RunnableNotebookDto>("notebook_get_runnable", { id });
}

export async function deleteRunnableNotebook(id: string): Promise<void> {
  return invoke<void>("notebook_delete_runnable", { id });
}

export function downloadRunnableNotebook(filename: string, markdown: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".mop.md") ? filename : `${filename}.mop.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

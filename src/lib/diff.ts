import { invoke } from "@tauri-apps/api/core";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface CellDiff {
  row_key: string;
  column: string;
  status: DiffStatus;
  a: unknown | null;
  b: unknown | null;
}

/**
 * Diff two structured snapshots. Public API — consumed by Plan 06 and Plan 08.
 */
export async function diffSnapshots(aId: number, bId: number): Promise<CellDiff[]> {
  return invoke<CellDiff[]>("structured_snapshot_diff", { a: aId, b: bId });
}

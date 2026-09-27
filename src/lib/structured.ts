import { invoke } from "@tauri-apps/api/core";

export type ParserKind = "genie" | "textfsm";

export interface ParsedOutput {
  blockId: string;
  parser: ParserKind;
  command: string;
  vendor: string;
  platform: string;
  data: unknown; // list-of-dicts or nested dict
  createdAt: number;
}

export interface ParsedSnapshot {
  id: number;
  tabId: string;
  name: string;
  parsedOutputId: number;
  capturedAt: number;
  command: string;
  parser: ParserKind;
  vendor: string;
  platform: string;
}

export async function getStructured(blockId: string): Promise<ParsedOutput | null> {
  return invoke<ParsedOutput | null>("structured_get", { blockId });
}

/** Frontend-driven trigger: call after a `show *` block completes. Idempotent. */
export async function autoParseBlock(
  blockId: string,
  vendor: string,
  platform: string,
): Promise<void> {
  await invoke("structured_auto_parse", { blockId, vendor, platform });
}

/**
 * SSH-direct structured parse for interactive sessions (no command block).
 * SSHes to a saved connection, runs `command`, parses the full output, and
 * returns the synthetic block id whose result `getParsedOutput` can load.
 */
export async function runAndParseOverSsh(
  tabId: string,
  connectionId: string,
  command: string,
  vendor: string,
  platform: string,
  password?: string,
): Promise<string> {
  return invoke<string>("structured_run_and_parse", {
    tabId,
    connectionId,
    command,
    vendor,
    platform,
    password,
  });
}

export async function createSnapshot(blockId: string, name: string): Promise<number> {
  return invoke<number>("structured_snapshot_create", { blockId, name });
}

export async function listSnapshots(tabId: string): Promise<ParsedSnapshot[]> {
  return invoke<ParsedSnapshot[]>("structured_list_snapshots", { tabId });
}

export async function renameSnapshot(id: number, name: string): Promise<void> {
  await invoke("structured_snapshot_rename", { id, name });
}

export async function deleteSnapshot(id: number): Promise<void> {
  await invoke("structured_snapshot_delete", { id });
}

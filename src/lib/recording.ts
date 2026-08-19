import { invoke } from "@tauri-apps/api/core";

export interface RecordingDto {
  id: string;
  tabId: string;
  startedAt: number;
  endedAt: number | null;
  path: string;
  sizeBytes: number;
  durationMs: number;
  sessionKind: string;
}

export interface RedactionRow {
  pattern: string;
  replacement_hash: string;
  matches: number;
}

export const recording = {
  start: (tabId: string, sessionKind = "local", cols = 120, rows = 40) =>
    invoke<RecordingDto>("recording_start", {
      tabId,
      sessionKind,
      cols,
      rows,
    }),
  stop: (tabId: string) =>
    invoke<RecordingDto>("recording_stop", { tabId }),
  status: (tabId: string) =>
    invoke<RecordingDto | null>("recording_status", { tabId }),
  list: (limit = 200) => invoke<RecordingDto[]>("recording_list", { limit }),
  get: (recordingId: string) =>
    invoke<RecordingDto | null>("recording_get", { recordingId }),
  delete: (recordingId: string) =>
    invoke<void>("recording_delete", { recordingId }),
  export: (recordingId: string, targetPath: string) =>
    invoke<void>("recording_export", { recordingId, targetPath }),
  exportText: (recordingId: string, targetPath: string) =>
    invoke<void>("recording_export_text", { recordingId, targetPath }),
  redactionSummary: (recordingId: string) =>
    invoke<RedactionRow[]>("recording_redaction_summary", { recordingId }),
  readCast: (recordingId: string) =>
    invoke<string>("recording_read_cast", { recordingId }),
};

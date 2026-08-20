export type TabType =
  | "terminal"
  | "api"
  | "netconf"
  | "editor"
  | "iac-studio"
  | "topology"
  | "vault"
  | "recordings"
  | "recording-player"
  | "troubleshoot"
  | "troubleshoot-editor"
  | "subnet"
  | "heartbeat";

export type Tab = {
  id: string;
  title: string;
  shell_cmd: string;
  cwd: string;
  created_at: number;
  /** "terminal" = PTY-backed; "api" = API Runner tab; "netconf" = NETCONF workbench. Defaults to "terminal" for pre-V0013 data. */
  tab_type?: TabType;
  /** If true, this tab uses PaneContainer instead of a single Terminal. */
  hasPanes?: boolean;
  /** Vendor scope for workflow filtering (Plan 02). In-memory only — not persisted. */
  vendor?: Vendor;
  /** Platform scope for workflow filtering (e.g. 'iosxe', 'nxos'). In-memory only. */
  platform?: string;
  /** Plan 14 — recording-player tabs carry the recording id they replay. */
  recordingId?: string;
};

export type PtyEvent =
  | { type: "output"; bytes: number[] }
  | { type: "command_start"; cmd: string; block_id?: string | null }
  | { type: "command_end"; exit_code: number | null }
  | { type: "cwd"; path: string }
  | { type: "enter_alt_screen" }
  | { type: "exit_alt_screen" }
  | { type: "exit"; code: number | null };

export type CommandBlockState = {
  id: string;
  cmd: string;
  started_at: number;
  ended_at?: number;
  exit_code?: number | null;
  aiSuggestion?: {
    explanation: string;
    suggested_command: string;
    loading?: boolean;
    error?: string;
  };
};

export type AgentChatEvent =
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type SavedSession = {
  id: string;
  name: string;
  description: string | null;
  tab_count: number;
  created_at: number;
};

export type SessionSnapshot = {
  tabs: Tab[];
  scrollback: Record<string, number[]>;
  ai_history: Record<string, string>;
};
import type { Vendor } from "./deviceProfiles";

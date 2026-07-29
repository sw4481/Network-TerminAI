import { create } from "zustand";
import type { SavedNetconfDevice } from "../lib/tauri";

/** Connection status for a NETCONF session. */
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/** Framing mode negotiated with the server. */
export type NetconfFraming = "1.0" | "1.1";

/** Editor mode: raw XML or CLI. */
export type EditorMode = "xml" | "cli";

/** Target platform for CLI wrapping. */
export type CliPlatform = "iosxe" | "nxos";

/** Mutable per-tab state for a NETCONF tab. */
export type NetconfTabState = {
  /** Session ID from the backend (null when disconnected). */
  session_id: string | null;
  /** Server's session ID (returned in <hello>). */
  server_session_id: number | null;
  /** Server capabilities (returned in <hello>). */
  capabilities: string[];
  /** Negotiated framing mode. */
  framing: NetconfFraming | null;
  /** Connection status. */
  status: ConnectionStatus;
  /** Last connection error message. */
  connection_error: string | null;

  /** Connection form fields. */
  host: string;
  port: number;
  username: string;
  password: string;
  /** If true, save this connection as a device after successful connect. */
  save_as_device: boolean;
  /** Name for saved device (only used if save_as_device is true). */
  device_name: string;
  /** Currently selected saved device ID (null = "new connection"). */
  selected_device_id: number | null;

  /** Editor mode: raw XML or CLI. */
  editor_mode: EditorMode;
  /** Platform for CLI wrapping (only used when editor_mode is "cli"). */
  cli_platform: CliPlatform;

  /** RPC editor content. */
  rpc_xml: string;
  /** Whether an RPC send is in flight. */
  sending: boolean;
  /** Last RPC response (null = never sent). */
  response: string | null;
  /** Last RPC error. */
  rpc_error: string | null;
};

const emptyTabState = (): NetconfTabState => ({
  session_id: null,
  server_session_id: null,
  capabilities: [],
  framing: null,
  status: "disconnected",
  connection_error: null,
  host: "",
  port: 830,
  username: "",
  password: "",
  save_as_device: false,
  device_name: "",
  selected_device_id: null,
  editor_mode: "xml",
  cli_platform: "iosxe",
  rpc_xml: "",
  sending: false,
  response: null,
  rpc_error: null,
});

type Store = {
  /** Keyed by tab_id. Created lazily on first access. */
  tabs: Record<string, NetconfTabState>;
  ensure: (tabId: string) => NetconfTabState;
  patch: (tabId: string, partial: Partial<NetconfTabState>) => void;
  reset: (tabId: string) => void;

  /** Global: saved devices list (loaded on demand). */
  savedDevices: SavedNetconfDevice[];
  setSavedDevices: (devices: SavedNetconfDevice[]) => void;
};

export const useNetconfRunner = create<Store>((set, get) => ({
  tabs: {},
  ensure: (tabId) => {
    const existing = get().tabs[tabId];
    if (existing) return existing;
    const next = emptyTabState();
    set((s) => ({ tabs: { ...s.tabs, [tabId]: next } }));
    return next;
  },
  patch: (tabId, partial) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, ...partial } } };
    }),
  reset: (tabId) =>
    set((s) => {
      const next = { ...s.tabs };
      delete next[tabId];
      return { tabs: next };
    }),
  savedDevices: [],
  setSavedDevices: (savedDevices) => set({ savedDevices }),
}));

/**
 * Format XML with indentation for display.
 * Simple line-based formatter — keeps it lightweight.
 */
export function formatXml(xml: string): string {
  const INDENT = "  ";
  const lines = xml
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let depth = 0;
  const formatted: string[] = [];

  for (const line of lines) {
    // Closing tag: decrease indent before this line
    if (line.startsWith("</")) {
      depth = Math.max(0, depth - 1);
    }
    // Self-closing or content within tags: no depth change
    const isSelfClosing = line.endsWith("/>") || line.endsWith("?>");
    const isOpenAndClose = line.match(/<[^/>]+>.*<\/[^>]+>$/);

    formatted.push(INDENT.repeat(depth) + line);

    // Opening tag: increase indent after this line (unless self-closing or open+close on same line)
    if (line.startsWith("<") && !isSelfClosing && !isOpenAndClose && !line.startsWith("</")) {
      depth++;
    }
  }

  return formatted.join("\n");
}

/**
 * Check if the connection form is valid for submission.
 */
export function isConnectable(s: NetconfTabState): boolean {
  return (
    s.status === "disconnected" &&
    s.host.trim().length > 0 &&
    s.port > 0 &&
    s.port <= 65535 &&
    s.username.trim().length > 0 &&
    s.password.trim().length > 0
  );
}

/**
 * Check if the RPC editor is valid for sending.
 */
export function isSendable(s: NetconfTabState): boolean {
  return s.status === "connected" && !s.sending && s.rpc_xml.trim().length > 0;
}

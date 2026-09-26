import { create } from "zustand";
import type { DeviceAccentColor, SyntaxProfile, Vendor } from "../lib/deviceProfiles";

export type TerminalConnectionLifecycle =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error";

export interface TerminalConnectionState {
  terminal_id: string;
  backend_pty_id: string;
  connection_id: string;
  display_name: string;
  vendor: Vendor;
  platform: string;
  accent_color: DeviceAccentColor | null;
  syntax_highlighting_enabled: boolean;
  syntax_profile: SyntaxProfile;
  lifecycle: TerminalConnectionLifecycle;
  ssh_command: string;
  exit_status: number | null;
  error: string | null;
}

export interface BindTerminalConnection {
  terminalId: string;
  backendPtyId: string;
  connectionId: string;
  displayName: string;
  vendor: Vendor;
  platform: string;
  accentColor: DeviceAccentColor | null;
  syntaxHighlightingEnabled: boolean;
  syntaxProfile: SyntaxProfile;
  sshCommand: string;
  lifecycle?: TerminalConnectionLifecycle;
}

interface TerminalConnectionStore {
  byTerminalId: Record<string, TerminalConnectionState>;
  terminalIdByBackendPtyId: Record<string, string>;
  bind: (binding: BindTerminalConnection) => void;
  setLifecycle: (
    terminalOrBackendId: string,
    lifecycle: TerminalConnectionLifecycle,
    details?: { exitStatus?: number | null; error?: string | null },
  ) => void;
  updateConnectionMetadata: (
    connectionId: string,
    metadata: Pick<
      TerminalConnectionState,
      | "display_name"
      | "vendor"
      | "platform"
      | "accent_color"
      | "syntax_highlighting_enabled"
      | "syntax_profile"
    >,
  ) => void;
  clear: (terminalOrBackendId: string) => void;
  get: (terminalOrBackendId: string) => TerminalConnectionState | null;
}

function resolveTerminalId(
  state: Pick<TerminalConnectionStore, "byTerminalId" | "terminalIdByBackendPtyId">,
  terminalOrBackendId: string,
): string | null {
  if (state.byTerminalId[terminalOrBackendId]) return terminalOrBackendId;
  return state.terminalIdByBackendPtyId[terminalOrBackendId] ?? null;
}

export const useTerminalConnectionStore = create<TerminalConnectionStore>((set, get) => ({
  byTerminalId: {},
  terminalIdByBackendPtyId: {},
  bind: (binding) =>
    set((state) => {
      const connection: TerminalConnectionState = {
        terminal_id: binding.terminalId,
        backend_pty_id: binding.backendPtyId,
        connection_id: binding.connectionId,
        display_name: binding.displayName,
        vendor: binding.vendor,
        platform: binding.platform,
        accent_color: binding.accentColor,
        syntax_highlighting_enabled: binding.syntaxHighlightingEnabled,
        syntax_profile: binding.syntaxProfile,
        lifecycle: binding.lifecycle ?? "connecting",
        ssh_command: binding.sshCommand,
        exit_status: null,
        error: null,
      };
      return {
        byTerminalId: { ...state.byTerminalId, [binding.terminalId]: connection },
        terminalIdByBackendPtyId: {
          ...state.terminalIdByBackendPtyId,
          [binding.backendPtyId]: binding.terminalId,
        },
      };
    }),
  setLifecycle: (terminalOrBackendId, lifecycle, details = {}) =>
    set((state) => {
      const terminalId = resolveTerminalId(state, terminalOrBackendId);
      if (!terminalId) return state;
      const current = state.byTerminalId[terminalId];
      return {
        byTerminalId: {
          ...state.byTerminalId,
          [terminalId]: {
            ...current,
            lifecycle,
            exit_status: details.exitStatus === undefined ? current.exit_status : details.exitStatus,
            error: details.error === undefined ? current.error : details.error,
          },
        },
      };
    }),
  updateConnectionMetadata: (connectionId, metadata) =>
    set((state) => ({
      byTerminalId: Object.fromEntries(
        Object.entries(state.byTerminalId).map(([terminalId, current]) => [
          terminalId,
          current.connection_id === connectionId ? { ...current, ...metadata } : current,
        ]),
      ),
    })),
  clear: (terminalOrBackendId) =>
    set((state) => {
      const terminalId = resolveTerminalId(state, terminalOrBackendId);
      if (!terminalId) return state;
      const current = state.byTerminalId[terminalId];
      const byTerminalId = { ...state.byTerminalId };
      const terminalIdByBackendPtyId = { ...state.terminalIdByBackendPtyId };
      delete byTerminalId[terminalId];
      delete terminalIdByBackendPtyId[current.backend_pty_id];
      return { byTerminalId, terminalIdByBackendPtyId };
    }),
  get: (terminalOrBackendId) => {
    const state = get();
    const terminalId = resolveTerminalId(state, terminalOrBackendId);
    return terminalId ? state.byTerminalId[terminalId] ?? null : null;
  },
}));

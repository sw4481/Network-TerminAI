import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { WorkflowTerminalTarget } from "../lib/workflowDispatcher";

export interface TerminalLogStatus {
  id: string;
  tabId: string;
  path: string;
  active: boolean;
  error: string | null;
}

interface PaneLog extends TerminalLogStatus {
  uiTabId?: string;
  terminalId?: string;
}

type LogMode = "create" | "append" | "overwrite";

interface LoggingStore {
  logs: Record<string, PaneLog>;
  pending: boolean;
  listenerError: string | null;
  receive: (status: TerminalLogStatus) => void;
  refresh: (uiTabId: string, target: WorkflowTerminalTarget) => Promise<void>;
  start: (uiTabId: string, target: WorkflowTerminalTarget, path: string, mode: LogMode) => Promise<void>;
  stop: (ptyId: string) => Promise<void>;
  initListener: () => Promise<() => void>;
}

export const useTerminalLoggingStore = create<LoggingStore>((set, get) => ({
  logs: {},
  pending: false,
  listenerError: null,
  receive: (status) => set((state) => {
    const current = state.logs[status.tabId];
    if (current && current.id !== status.id) return state;
    return { logs: { ...state.logs, [status.tabId]: { ...current, ...status } } };
  }),
  refresh: async (uiTabId, target) => {
    const requestedId = get().logs[target.backendPtyId]?.id;
    const status = await invoke<TerminalLogStatus | null>("terminal_log_status", {
      tabId: target.backendPtyId,
    });
    set((state) => {
      const current = state.logs[target.backendPtyId];
      if (current && current.id !== requestedId && current.id !== status?.id) return state;
      if (!status) {
        return current ? { logs: { ...state.logs, [target.backendPtyId]: { ...current, active: false } } } : state;
      }
      // A terminal status is final for this logfile id, even if an older IPC
      // response arrives after the writer's stopped/error event.
      const finished = current?.id === status.id && !current.active;
      return { logs: { ...state.logs, [status.tabId]: {
        ...status, uiTabId, terminalId: target.terminalId,
        ...(finished ? { active: false, error: current.error ?? status.error } : {}),
      } } };
    });
  },
  start: async (uiTabId, target, path, mode) => {
    const status = await invoke<TerminalLogStatus>("terminal_log_start", {
      tabId: target.backendPtyId, path, mode,
    });
    set((state) => ({ logs: { ...state.logs, [status.tabId]: {
      ...status, uiTabId, terminalId: target.terminalId,
      // A fast writer failure may arrive before the start command returns.
      ...(state.logs[status.tabId]?.id === status.id ? state.logs[status.tabId] : {}),
    } } }));
    await get().refresh(uiTabId, target);
  },
  stop: async (tabId) => {
    const status = await invoke<TerminalLogStatus>("terminal_log_stop", { tabId });
    get().receive(status);
    if (status.error) throw new Error(status.error);
  },
  initListener: async () => {
    try {
      const unlisten = await listen<TerminalLogStatus>("terminal-log://status", ({ payload }) => {
        get().receive(payload);
      });
      set({ listenerError: null });
      return unlisten;
    } catch (error) {
      set({ listenerError: `Terminal logging status unavailable: ${String(error)}` });
      throw error;
    }
  },
}));

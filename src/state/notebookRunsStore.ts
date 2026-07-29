import { create } from "zustand";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { CellStatus, RunStatus, RunEvent } from "../lib/runnableNotebook";

export interface NotebookRunState {
  runId: string;
  notebookId: string;
  status: RunStatus;
  cellStatuses: Record<number, CellStatus>;
  cellErrors: Record<number, string | undefined>;
  cellBlockIds: Record<number, string | undefined>;
  awaitingApprovalIdx: number | null;
  approvalPrompt: string | null;
  currentCellIdx: number | null;
}

interface NotebookRunsStore {
  runs: Record<string, NotebookRunState>;
  start: (
    notebookId: string,
    tabId: string,
    params: Record<string, unknown>,
    // SSH-direct execution (Plan 03 over interactive SSH): pass a saved
    // connection id (and optional prompted password) to run cells over
    // one-shot SSH instead of the OSC-133 PTY runner. Omit for legacy PTY.
    connectionId?: string,
    password?: string,
  ) => Promise<string>;
  approve: (runId: string) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  pause: (runId: string) => Promise<void>;
  resume: (
    runId: string,
    tabId: string,
    connectionId?: string,
    password?: string,
  ) => Promise<void>;
}

function emptyRunState(runId: string, notebookId: string): NotebookRunState {
  return {
    runId,
    notebookId,
    status: "running",
    cellStatuses: {},
    cellErrors: {},
    cellBlockIds: {},
    awaitingApprovalIdx: null,
    approvalPrompt: null,
    currentCellIdx: null,
  };
}

export const useNotebookRuns = create<NotebookRunsStore>((set) => ({
  runs: {},
  async start(notebookId, tabId, params, connectionId, password) {
    const channel = new Channel<RunEvent>();
    let resolvedRunId: string | null = null;
    channel.onmessage = (ev) => {
      if (!resolvedRunId) return;
      set((state) => {
        const cur = state.runs[resolvedRunId!];
        if (!cur) return state;
        const next = { ...cur };
        switch (ev.type) {
          case "cell_started":
            next.cellStatuses = { ...next.cellStatuses, [ev.cell_idx]: "running" };
            next.currentCellIdx = ev.cell_idx;
            break;
          case "cell_finished":
            next.cellStatuses = { ...next.cellStatuses, [ev.cell_idx]: ev.status };
            next.cellErrors = {
              ...next.cellErrors,
              [ev.cell_idx]: ev.error ?? undefined,
            };
            next.cellBlockIds = {
              ...next.cellBlockIds,
              [ev.cell_idx]: ev.block_id ?? undefined,
            };
            if (next.currentCellIdx === ev.cell_idx) next.currentCellIdx = null;
            if (next.awaitingApprovalIdx === ev.cell_idx) {
              next.awaitingApprovalIdx = null;
              next.approvalPrompt = null;
            }
            break;
          case "awaiting_approval":
            next.awaitingApprovalIdx = ev.cell_idx;
            next.approvalPrompt = ev.prompt;
            next.cellStatuses = {
              ...next.cellStatuses,
              [ev.cell_idx]: "awaiting_approval",
            };
            next.status = "paused";
            break;
          case "run_finished":
            next.status = ev.status;
            next.currentCellIdx = null;
            break;
        }
        return { runs: { ...state.runs, [resolvedRunId!]: next } };
      });
    };

    const runId = await invoke<string>("notebook_run_start", {
      notebookId,
      tabId,
      params,
      onEvent: channel,
      connectionId,
      password,
    });
    resolvedRunId = runId;
    set((s) => ({ runs: { ...s.runs, [runId]: emptyRunState(runId, notebookId) } }));
    return runId;
  },
  approve: (runId) => invoke<void>("notebook_run_approve", { runId }),
  cancel: (runId) => invoke<void>("notebook_run_cancel", { runId }),
  pause: (runId) => invoke<void>("notebook_run_pause", { runId }),
  resume: async (runId, tabId, connectionId, password) => {
    const channel = new Channel<RunEvent>();
    channel.onmessage = (ev) => {
      set((state) => {
        const cur = state.runs[runId];
        if (!cur) return state;
        const next = { ...cur };
        switch (ev.type) {
          case "cell_started":
            next.cellStatuses = { ...next.cellStatuses, [ev.cell_idx]: "running" };
            next.currentCellIdx = ev.cell_idx;
            next.status = "running";
            break;
          case "cell_finished":
            next.cellStatuses = { ...next.cellStatuses, [ev.cell_idx]: ev.status };
            next.cellErrors = {
              ...next.cellErrors,
              [ev.cell_idx]: ev.error ?? undefined,
            };
            next.cellBlockIds = {
              ...next.cellBlockIds,
              [ev.cell_idx]: ev.block_id ?? undefined,
            };
            break;
          case "awaiting_approval":
            next.awaitingApprovalIdx = ev.cell_idx;
            next.approvalPrompt = ev.prompt;
            next.status = "paused";
            break;
          case "run_finished":
            next.status = ev.status;
            next.currentCellIdx = null;
            break;
        }
        return { runs: { ...state.runs, [runId]: next } };
      });
    };
    await invoke<void>("notebook_run_resume", {
      runId,
      tabId,
      onEvent: channel,
      connectionId,
      password,
    });
  },
}));

import { create } from "zustand";
import * as api from "../lib/iacState";
import type { StateResource, DriftCheckResult } from "../lib/iacState";

interface IacStateStore {
  open: boolean;
  projectPath: string | null;
  resources: StateResource[];
  query: string;
  loading: boolean;
  error: string | null;

  drift: DriftCheckResult | null;
  exceptions: string[];
  driftLoading: boolean;

  /** Draft path shown in the directory selector input (may differ from the
   *  loaded projectPath until the user submits it). */
  pathDraft: string;

  /** Live cwd per backend terminal/PTY id, fed by the shell's OSC 7. Keyed by
   *  PTY id (NOT tab id) — panes spawn PTYs under their own ids. */
  cwdByTerminal: Record<string, string>;
  /** Record the live cwd reported for a terminal/PTY id. */
  setTerminalCwd: (terminalId: string, path: string) => void;

  openDrawer: (projectPath: string) => Promise<void>;
  closeDrawer: () => void;
  setPathDraft: (p: string) => void;
  /** Load (or reload) state + exceptions + reset drift for a directory. Used by
   *  the directory selector and Browse button. */
  setProjectPath: (projectPath: string) => Promise<void>;
  setQuery: (q: string) => Promise<void>;
  checkDrift: () => Promise<void>;
  addException: (address: string) => Promise<void>;
}

export const useIacStateStore = create<IacStateStore>((set, get) => ({
  open: false,
  projectPath: null,
  resources: [],
  query: "",
  loading: false,
  error: null,
  drift: null,
  exceptions: [],
  driftLoading: false,
  pathDraft: "",
  cwdByTerminal: {},

  setTerminalCwd: (terminalId, path) =>
    set((s) => ({ cwdByTerminal: { ...s.cwdByTerminal, [terminalId]: path } })),

  openDrawer: async (projectPath) => {
    set({ open: true, projectPath, pathDraft: projectPath, loading: true, error: null, drift: null });
    try {
      const [resources, exceptions] = await Promise.all([
        api.iacQueryState(projectPath),
        api.iacListDriftExceptions(projectPath),
      ]);
      set({ resources, exceptions, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  closeDrawer: () => set({ open: false }),

  setPathDraft: (p) => set({ pathDraft: p }),

  setProjectPath: async (projectPath) => {
    const trimmed = projectPath.trim();
    if (!trimmed) return;
    // Reuse openDrawer's load logic for a clean reload of the new directory.
    await get().openDrawer(trimmed);
  },

  setQuery: async (q) => {
    set({ query: q });
    const path = get().projectPath;
    if (!path) return;
    try {
      const resources = await api.iacQueryState(path, q);
      set({ resources });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  checkDrift: async () => {
    const path = get().projectPath;
    if (!path) return;
    set({ driftLoading: true, error: null });
    try {
      const drift = await api.iacCheckDrift(path);
      set({ drift, driftLoading: false });
    } catch (e) {
      // Report inability — never silently treat as clean.
      set({ driftLoading: false, error: String(e) });
    }
  },

  addException: async (address) => {
    const path = get().projectPath;
    if (!path) return;
    await api.iacAddDriftException(path, address);
    set((s) => ({ exceptions: [...s.exceptions, address] }));
  },
}));

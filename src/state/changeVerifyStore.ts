import { create } from "zustand";
import * as api from "../lib/changeVerify";
import type { CheckBundle, NewCheckBundle, ChangeSnapshot, ReportSummary, ExpectedDelta } from "../lib/changeVerify";

interface ChangeVerifyState {
  bundles: CheckBundle[];
  selectedBundleId: string | null;
  loading: boolean;
  error: string | null;
  preSnapshot: ChangeSnapshot | null;
  currentReport: { id: string; summary: ReportSummary; approved: ExpectedDelta[]; createdAt: number } | null;
  reports: [string, number, string, string][];

  loadBundles: (vendor?: string, platform?: string) => Promise<void>;
  selectBundle: (id: string | null) => void;
  createBundle: (n: NewCheckBundle) => Promise<CheckBundle>;
  updateBundleCommands: (id: string, cmds: string[]) => Promise<void>;
  renameBundle: (id: string, name: string, description: string | null) => Promise<void>;
  deleteBundle: (id: string) => Promise<void>;
  runPreCheck: (tabId: string, bundleId: string, vendor: string, platform: string) => Promise<ChangeSnapshot>;
  runPostCheck: (
    tabId: string,
    bundleId: string,
    vendor: string,
    platform: string,
    preSnapshotId: string,
    approved?: ExpectedDelta[],
    notes?: string | null,
  ) => Promise<{ id: string; summary: ReportSummary }>;
  /** SSH-direct pre-check: runs the bundle over a one-shot SSH session to a
   *  saved connection instead of the local PTY. */
  runPreCheckSsh: (
    tabId: string,
    connectionId: string,
    bundleId: string,
    vendor: string,
    platform: string,
    password?: string,
  ) => Promise<ChangeSnapshot>;
  /** SSH-direct post-check + report. See {@link runPreCheckSsh}. */
  runPostCheckSsh: (
    tabId: string,
    connectionId: string,
    bundleId: string,
    vendor: string,
    platform: string,
    preSnapshotId: string,
    approved?: ExpectedDelta[],
    notes?: string | null,
    password?: string,
  ) => Promise<{ id: string; summary: ReportSummary }>;
  loadReport: (id: string) => Promise<void>;
  loadReports: () => Promise<void>;
  clearReport: () => void;
  clearSnapshots: () => void;
  appendApproval: (reportId: string, approval: ExpectedDelta) => Promise<void>;
}

export const useChangeVerifyStore = create<ChangeVerifyState>((set, get) => ({
  bundles: [],
  selectedBundleId: null,
  loading: false,
  error: null,
  preSnapshot: null,
  currentReport: null,
  reports: [],

  loadBundles: async (vendor, platform) => {
    set({ loading: true, error: null });
    try {
      const bundles = await api.bundleList(vendor, platform);
      set({ bundles, loading: false });
    } catch (e) { set({ error: String(e), loading: false }); }
  },
  selectBundle: (id) => set({ selectedBundleId: id }),
  createBundle: async (n) => {
    const b = await api.bundleCreate(n);
    set({ bundles: [b, ...get().bundles] });
    return b;
  },
  updateBundleCommands: async (id, cmds) => {
    await api.bundleUpdateCommands(id, cmds);
    await get().loadBundles();
  },
  renameBundle: async (id, name, description) => {
    await api.bundleRename(id, name, description);
    await get().loadBundles();
  },
  deleteBundle: async (id) => {
    await api.bundleDelete(id);
    set({ bundles: get().bundles.filter(b => b.id !== id) });
  },
  runPreCheck: async (tabId, bundleId, vendor, platform) => {
    const snap = await api.changeRunPre(tabId, bundleId, vendor, platform);
    set({ preSnapshot: snap });
    return snap;
  },
  runPostCheck: async (
    tabId,
    bundleId,
    vendor,
    platform,
    preSnapshotId,
    approved = [],
    notes = null,
  ) => {
    const [id, summary, createdAt] = await api.changeRunPostAndReport(
      tabId, bundleId, vendor, platform, preSnapshotId, approved, notes,
    );
    set({ currentReport: { id, summary, approved, createdAt } });
    return { id, summary };
  },
  runPreCheckSsh: async (tabId, connectionId, bundleId, vendor, platform, password) => {
    const snap = await api.changeRunPreSsh(tabId, connectionId, bundleId, vendor, platform, password);
    set({ preSnapshot: snap });
    return snap;
  },
  runPostCheckSsh: async (
    tabId,
    connectionId,
    bundleId,
    vendor,
    platform,
    preSnapshotId,
    approved = [],
    notes = null,
    password,
  ) => {
    const [id, summary, createdAt] = await api.changeRunPostAndReportSsh(
      tabId, connectionId, bundleId, vendor, platform, preSnapshotId, approved, notes, password,
    );
    set({ currentReport: { id, summary, approved, createdAt } });
    return { id, summary };
  },
  loadReport: async (id) => {
    const [summary, approved, createdAt] = await api.changeReportGet(id);
    set({ currentReport: { id, summary, approved, createdAt } });
  },
  loadReports: async () => {
    set({ reports: await api.changeReportList() });
  },
  clearReport: () => set({ currentReport: null }),
  clearSnapshots: () => set({ preSnapshot: null, currentReport: null }),
  appendApproval: async (reportId, approval) => {
    const [summary, approved] = await api.changeReportAppendApproval(reportId, approval);
    set(state => state.currentReport && state.currentReport.id === reportId
      ? { currentReport: { id: reportId, summary, approved, createdAt: state.currentReport.createdAt } }
      : state);
  },
}));

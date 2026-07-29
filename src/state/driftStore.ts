import { create } from "zustand";
import * as api from "../lib/drift";
import type {
  DriftPatch,
  DriftReport,
  DriftSchedule,
} from "../lib/drift";

interface DriftState {
  reportsByTemplate: Record<string, DriftReport[]>;
  selectedReportId: string | null;
  schedules: DriftSchedule[];
  loading: boolean;
  error: string | null;

  refreshReports: (templateId: string) => Promise<void>;
  selectReport: (id: string | null) => void;
  runOnDemand: (templateId: string) => Promise<DriftReport[]>;
  refreshSchedules: () => Promise<void>;
  createSchedule: (
    templateId: string,
    cronExpr: string,
  ) => Promise<DriftSchedule>;
  pauseSchedule: (id: string) => Promise<void>;
  resumeSchedule: (id: string) => Promise<void>;
  deleteSchedule: (id: string) => Promise<void>;
}

export const useDriftStore = create<DriftState>((set, get) => ({
  reportsByTemplate: {},
  selectedReportId: null,
  schedules: [],
  loading: false,
  error: null,

  refreshReports: async (templateId) => {
    set({ loading: true, error: null });
    try {
      const rs = await api.driftReportsList(templateId);
      set((s) => ({
        reportsByTemplate: { ...s.reportsByTemplate, [templateId]: rs },
        loading: false,
      }));
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  selectReport: (id) => set({ selectedReportId: id }),

  runOnDemand: async (templateId) => {
    set({ loading: true, error: null });
    try {
      const reports = await api.driftRunOnDemand(templateId);
      set((s) => ({
        reportsByTemplate: { ...s.reportsByTemplate, [templateId]: reports },
        loading: false,
      }));
      return reports;
    } catch (e) {
      set({ error: String(e), loading: false });
      throw e;
    }
  },

  refreshSchedules: async () => {
    try {
      const schedules = await api.driftScheduleList();
      set({ schedules });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createSchedule: async (templateId, cronExpr) => {
    const s = await api.driftScheduleCreate(templateId, cronExpr);
    await get().refreshSchedules();
    return s;
  },

  pauseSchedule: async (id) => {
    await api.driftSchedulePause(id);
    await get().refreshSchedules();
  },

  resumeSchedule: async (id) => {
    await api.driftScheduleResume(id);
    await get().refreshSchedules();
  },

  deleteSchedule: async (id) => {
    await api.driftScheduleDelete(id);
    set((s) => ({
      schedules: s.schedules.filter((x) => x.id !== id),
    }));
  },
}));

// re-export DriftPatch so consumers can import from one place
export type { DriftPatch };

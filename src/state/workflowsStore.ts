import { create } from "zustand";
import {
  Workflow,
  Vendor,
  workflowList,
  workflowGet,
  workflowUpsert,
  workflowDelete,
} from "../lib/workflows";

interface WorkflowsState {
  workflows: Workflow[];
  loading: boolean;
  error: string | null;
  loadFor: (vendor?: Vendor, platform?: string) => Promise<void>;
  save: (wf: Workflow) => Promise<string>;
  remove: (id: string) => Promise<void>;
  getById: (id: string) => Promise<Workflow | null>;
}

export const useWorkflowsStore = create<WorkflowsState>((set) => ({
  workflows: [],
  loading: false,
  error: null,
  loadFor: async (vendor, platform) => {
    set({ loading: true, error: null });
    try {
      const wfs = await workflowList({ vendor, platform });
      set({ workflows: wfs, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
  save: async (wf) => {
    const id = await workflowUpsert(wf);
    const fresh = await workflowGet(id);
    set((s) => ({
      workflows: fresh
        ? [...s.workflows.filter((w) => w.id !== id), fresh].sort((a, b) =>
            a.name.localeCompare(b.name),
          )
        : s.workflows,
    }));
    return id;
  },
  remove: async (id) => {
    await workflowDelete(id);
    set((s) => ({ workflows: s.workflows.filter((w) => w.id !== id) }));
  },
  getById: async (id) => workflowGet(id),
}));

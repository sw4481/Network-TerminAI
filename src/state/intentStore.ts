import { create } from "zustand";
import * as api from "../lib/drift";
import type { IntentTemplate, IntentSelector } from "../lib/drift";

interface IntentState {
  templates: IntentTemplate[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;

  refresh: (vendor?: string, platform?: string) => Promise<void>;
  select: (id: string | null) => void;
  create: (
    tpl: Omit<IntentTemplate, "id" | "created_at" | "updated_at">,
  ) => Promise<string>;
  updateBody: (id: string, body: string) => Promise<void>;
  updateVars: (id: string, varsYaml: string) => Promise<void>;
  updateSelector: (id: string, selector: IntentSelector) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useIntentStore = create<IntentState>((set, get) => ({
  templates: [],
  selectedId: null,
  loading: false,
  error: null,

  refresh: async (vendor, platform) => {
    set({ loading: true, error: null });
    try {
      const templates = await api.intentList(vendor, platform);
      set({ templates, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  select: (id) => set({ selectedId: id }),

  create: async (tpl) => {
    const id = await api.intentCreate(tpl);
    await get().refresh();
    set({ selectedId: id });
    return id;
  },

  updateBody: async (id, body) => {
    await api.intentUpdateBody(id, body);
    set((s) => ({
      templates: s.templates.map((t) =>
        t.id === id ? { ...t, body, updated_at: Math.floor(Date.now() / 1000) } : t,
      ),
    }));
  },

  updateVars: async (id, varsYaml) => {
    await api.intentUpdateVars(id, varsYaml);
    set((s) => ({
      templates: s.templates.map((t) =>
        t.id === id ? { ...t, vars_yaml: varsYaml } : t,
      ),
    }));
  },

  updateSelector: async (id, selector) => {
    await api.intentUpdateSelector(id, selector);
    set((s) => ({
      templates: s.templates.map((t) =>
        t.id === id ? { ...t, selector } : t,
      ),
    }));
  },

  rename: async (id, name) => {
    await api.intentRename(id, name);
    set((s) => ({
      templates: s.templates.map((t) => (t.id === id ? { ...t, name } : t)),
    }));
  },

  remove: async (id) => {
    await api.intentDelete(id);
    set((s) => ({
      templates: s.templates.filter((t) => t.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },
}));

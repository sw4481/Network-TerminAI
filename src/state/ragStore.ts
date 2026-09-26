/**
 * Plan 12 + RAG user-tags follow-up — Zustand store for the Settings
 * → RAG tab and the AgentPanel Sources drawer.
 *
 * Holds the document list, in-flight upload progress (keyed by source
 * path), the cached taxonomy (builtin + user split), and per-tab
 * active user-tag selections. Lazily loaded by the tab component on
 * mount; the upload-progress subscription is attached once via
 * `subscribeUploadProgress`.
 */
import { create } from "zustand";
import {
  type DocRow,
  type RagTaxonomy,
  type UploadProgress,
  ragList,
  ragTaxonomy,
  onUploadProgress,
} from "../lib/rag";
import type { UnlistenFn } from "@tauri-apps/api/event";

const EMPTY_TAXONOMY: RagTaxonomy = { builtin: [], user: [] };

type RagStoreState = {
  documents: DocRow[];
  inFlight: Record<string, UploadProgress>;
  taxonomy: RagTaxonomy;
  activeUserTagsByTab: Record<string, string[]>;
  loading: boolean;
  error: string | null;
  unlisten: UnlistenFn | null;

  loadDocuments: () => Promise<void>;
  loadTaxonomy: () => Promise<void>;
  appendDocument: (doc: DocRow) => void;
  optimisticDelete: (docId: number) => void;
  applyProgress: (p: UploadProgress) => void;
  clearInFlight: (path: string) => void;
  subscribeUploadProgress: () => Promise<void>;
  unsubscribeUploadProgress: () => void;
  getActiveUserTags: (tabId: string) => string[];
  setActiveUserTags: (tabId: string, tags: string[]) => void;
  toggleActiveUserTag: (tabId: string, tag: string) => void;
  reset: () => void;
};

export const useRagStore = create<RagStoreState>((set, get) => ({
  documents: [],
  inFlight: {},
  taxonomy: EMPTY_TAXONOMY,
  activeUserTagsByTab: {},
  loading: false,
  error: null,
  unlisten: null,

  loadDocuments: async () => {
    set({ loading: true, error: null });
    try {
      const docs = await ragList();
      set({ documents: docs, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  loadTaxonomy: async () => {
    try {
      const taxonomy = await ragTaxonomy();
      set({ taxonomy });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  appendDocument: (doc) =>
    set((s) => ({ documents: [doc, ...s.documents] })),

  optimisticDelete: (docId) =>
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== docId),
    })),

  applyProgress: (p) =>
    set((s) => ({
      inFlight: { ...s.inFlight, [p.docPath]: p },
    })),

  clearInFlight: (path) =>
    set((s) => {
      const next = { ...s.inFlight };
      delete next[path];
      return { inFlight: next };
    }),

  subscribeUploadProgress: async () => {
    if (get().unlisten) return;
    try {
      const unl = await onUploadProgress((p) => get().applyProgress(p));
      set({ unlisten: unl });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  unsubscribeUploadProgress: () => {
    const unl = get().unlisten;
    if (unl) {
      unl();
      set({ unlisten: null });
    }
  },

  getActiveUserTags: (tabId) => get().activeUserTagsByTab[tabId] ?? [],

  setActiveUserTags: (tabId, tags) =>
    set((s) => ({
      activeUserTagsByTab: { ...s.activeUserTagsByTab, [tabId]: tags },
    })),

  toggleActiveUserTag: (tabId, tag) =>
    set((s) => {
      const current = s.activeUserTagsByTab[tabId] ?? [];
      const next = current.includes(tag)
        ? current.filter((t) => t !== tag)
        : [...current, tag];
      return {
        activeUserTagsByTab: { ...s.activeUserTagsByTab, [tabId]: next },
      };
    }),

  reset: () =>
    set({
      documents: [],
      inFlight: {},
      taxonomy: EMPTY_TAXONOMY,
      activeUserTagsByTab: {},
      loading: false,
      error: null,
    }),
}));

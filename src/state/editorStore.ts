import { create } from "zustand";
import type { GitFileStatus } from "../lib/tauri";

export type FileNodeType = "file" | "directory";

export type FileNode = {
  path: string;
  name: string;
  node_type: FileNodeType;
  children?: FileNode[];
};

export type EditorTabState = {
  file_path: string | null;
  content: string;
  language: string;
  is_dirty: boolean;
  cursor_position: { line: number; column: number };
  scroll_position: number;
  loading: boolean;
  error: string | null;
  explorer_open: boolean;
  root_path: string | null;
  file_tree: FileNode[];
  expanded_dirs: Set<string>;
  git_status: GitFileStatus[];
  is_git_repo: boolean;
};

const emptyTabState = (): EditorTabState => ({
  file_path: null,
  content: "",
  language: "plaintext",
  is_dirty: false,
  cursor_position: { line: 0, column: 0 },
  scroll_position: 0,
  loading: false,
  error: null,
  explorer_open: true,
  root_path: null,
  file_tree: [],
  expanded_dirs: new Set(),
  git_status: [],
  is_git_repo: false,
});

type Store = {
  /** Keyed by tab_id. Created lazily on first access. */
  tabs: Record<string, EditorTabState>;
  ensure: (tabId: string) => EditorTabState;
  patch: (tabId: string, partial: Partial<EditorTabState>) => void;
  setContent: (tabId: string, content: string) => void;
  setDirty: (tabId: string, dirty: boolean) => void;
  setLanguage: (tabId: string, language: string) => void;
  setCursor: (tabId: string, line: number, column: number) => void;
  setFileTree: (tabId: string, tree: FileNode[], rootPath: string) => void;
  toggleExplorer: (tabId: string) => void;
  toggleDirectory: (tabId: string, dirPath: string) => void;
  setGitStatus: (tabId: string, status: GitFileStatus[], isRepo: boolean) => void;
  reset: (tabId: string) => void;
};

export const useEditorStore = create<Store>((set, get) => ({
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

  setContent: (tabId, content) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, content, is_dirty: true } } };
    }),

  setDirty: (tabId, is_dirty) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, is_dirty } } };
    }),

  setLanguage: (tabId, language) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, language } } };
    }),

  setCursor: (tabId, line, column) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, cursor_position: { line, column } } } };
    }),

  setFileTree: (tabId, file_tree, root_path) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, file_tree, root_path } } };
    }),

  toggleExplorer: (tabId) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, explorer_open: !cur.explorer_open } } };
    }),

  toggleDirectory: (tabId, dirPath) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      const expanded_dirs = new Set(cur.expanded_dirs);
      if (expanded_dirs.has(dirPath)) {
        expanded_dirs.delete(dirPath);
      } else {
        expanded_dirs.add(dirPath);
      }
      return { tabs: { ...s.tabs, [tabId]: { ...cur, expanded_dirs } } };
    }),

  setGitStatus: (tabId, git_status, is_git_repo) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, git_status, is_git_repo },
        },
      };
    }),

  reset: (tabId) =>
    set((s) => {
      const next = { ...s.tabs };
      delete next[tabId];
      return { tabs: next };
    }),
}));

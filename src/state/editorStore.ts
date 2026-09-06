import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { GitFileStatus } from "../lib/tauri";
import type { CiscoPlatform } from "../lib/ciscoLint";
import {
  closeEditorPane,
  createEditorPaneLayout,
  deserializeEditorLayout,
  editorBufferIdForFile,
  findEditorPane,
  getAttachedEditorPanes,
  getEditorPaneLeaves,
  markEditorPaneDetached,
  normalizeEditorFilePath,
  reattachEditorPane,
  reconcileDetachedEditorPanes,
  resizeEditorSplit,
  serializeEditorLayout,
  setEditorPaneBuffer,
  splitEditorPane,
  updateEditorPaneView,
  type EditorBufferIdentity,
  type EditorPaneDirection,
  type EditorPaneNode,
  type EditorPaneViewState,
} from "../components/editor/editorPaneLayout";

export type FileNodeType = "file" | "directory";

export type FileNode = {
  path: string;
  name: string;
  node_type: FileNodeType;
  children?: FileNode[];
};

export type EditorBufferSyncStatus =
  | "local"
  | "syncing"
  | "synced"
  | "conflict"
  | "error";

export type EditorBufferState = {
  id: string;
  file_path: string | null;
  content: string;
  language: string;
  cisco_platform: CiscoPlatform | null;
  is_dirty: boolean;
  revision: number;
  sync_status: EditorBufferSyncStatus;
  error: string | null;
};

export type EditorWorkspaceState = {
  tabId: string;
  root_path: string | null;
  file_tree: FileNode[];
  openBufferIds: string[];
  expanded_dirs: Set<string>;
  explorer_open: boolean;
  git_status: GitFileStatus[];
  is_git_repo: boolean;
  layout: EditorPaneNode;
  focusedPaneId: string;
  terminal_open: boolean;
  loading: boolean;
  error: string | null;
};

export type EditorBufferSeed = {
  id?: string;
  file_path?: string | null;
  content?: string;
  language?: string;
  cisco_platform?: CiscoPlatform | null;
  is_dirty?: boolean;
  revision?: number;
  sync_status?: EditorBufferSyncStatus;
  error?: string | null;
};

export type InitializeEditorWorkspaceOptions = {
  bufferId?: string;
  paneId?: string;
  buffer?: EditorBufferSeed;
};

type GeneratedLayoutIds = {
  paneId?: string;
  splitId?: string;
};

type EditorStore = {
  buffers: Record<string, EditorBufferState>;
  workspaces: Record<string, EditorWorkspaceState>;
  initializeWorkspace: (
    tabId: string,
    options?: InitializeEditorWorkspaceOptions,
  ) => EditorWorkspaceState;
  patchWorkspace: (
    tabId: string,
    partial: Partial<Omit<EditorWorkspaceState, "tabId" | "layout">>,
  ) => void;
  openFileInPane: (
    tabId: string,
    paneId: string,
    seed: Required<
      Pick<EditorBufferSeed, "file_path" | "content" | "language">
    >,
  ) => string;
  closeBuffer: (tabId: string, bufferId: string) => void;
  setBufferContent: (bufferId: string, content: string) => void;
  patchBuffer: (
    bufferId: string,
    partial: Partial<Omit<EditorBufferState, "id">>,
  ) => void;
  markBufferSaved: (bufferId: string, revision?: number) => void;
  splitPane: (
    tabId: string,
    paneId: string,
    direction: EditorPaneDirection,
    ids?: GeneratedLayoutIds,
  ) => EditorPaneNode;
  closePane: (tabId: string, paneId: string) => EditorPaneNode;
  resizePane: (tabId: string, splitId: string, sizes: number[]) => void;
  focusPane: (tabId: string, paneId: string) => void;
  updatePaneView: (
    tabId: string,
    paneId: string,
    view: Partial<EditorPaneViewState>,
  ) => void;
  markPaneDetached: (tabId: string, paneId: string, windowId: string) => void;
  reattachPane: (tabId: string, paneId: string) => void;
  reconcileDetachedPanes: (
    tabId: string,
    liveWindowIds: ReadonlySet<string>,
  ) => void;
  setFileTree: (tabId: string, tree: FileNode[], rootPath: string) => void;
  toggleExplorer: (tabId: string) => void;
  toggleDirectory: (tabId: string, dirPath: string) => void;
  setGitStatus: (
    tabId: string,
    status: GitFileStatus[],
    isRepo: boolean,
  ) => void;
  loadWorkspaceLayout: (
    tabId: string,
    liveWindowIds?: ReadonlySet<string>,
  ) => Promise<EditorWorkspaceState>;
  saveWorkspaceLayout: (tabId: string) => Promise<void>;
  resetWorkspace: (tabId: string) => void;
  resetAll: () => void;
};

let fallbackIdCounter = 0;

function generateId(prefix: "pane" | "split" | "buffer"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  fallbackIdCounter += 1;
  return `${prefix}-${fallbackIdCounter}`;
}

export const bufferIdForFile = editorBufferIdForFile;

export function createEditorBuffer(
  seed: EditorBufferSeed = {},
): EditorBufferState {
  const filePath =
    typeof seed.file_path === "string"
      ? normalizeEditorFilePath(seed.file_path)
      : null;
  const id =
    filePath !== null
      ? editorBufferIdForFile(filePath)
      : (seed.id ?? `untitled:${generateId("buffer")}`);
  return {
    id,
    file_path: filePath,
    content: seed.content ?? "",
    language: seed.language ?? "plaintext",
    cisco_platform: seed.cisco_platform ?? null,
    is_dirty: seed.is_dirty ?? false,
    revision: seed.revision ?? 0,
    sync_status: seed.sync_status ?? "local",
    error: seed.error ?? null,
  };
}

function createWorkspace(
  tabId: string,
  bufferId: string,
  paneId: string,
): EditorWorkspaceState {
  return {
    tabId,
    root_path: null,
    file_tree: [],
    openBufferIds: [bufferId],
    expanded_dirs: new Set(),
    explorer_open: true,
    git_status: [],
    is_git_repo: false,
    layout: createEditorPaneLayout(bufferId, paneId),
    focusedPaneId: paneId,
    terminal_open: false,
    loading: false,
    error: null,
  };
}

function identityForBuffer(buffer: EditorBufferState): EditorBufferIdentity {
  if (buffer.file_path) {
    return { kind: "file", path: buffer.file_path };
  }
  return { kind: "untitled", id: buffer.id };
}

function bufferFromIdentity(identity: EditorBufferIdentity): EditorBufferState {
  return identity.kind === "file"
    ? createEditorBuffer({ file_path: identity.path })
    : createEditorBuffer({ id: identity.id });
}

function usedBufferIds(workspaces: Record<string, EditorWorkspaceState>) {
  return new Set(
    Object.values(workspaces).flatMap((workspace) => [
      ...workspace.openBufferIds,
      ...getEditorPaneLeaves(workspace.layout).map((pane) => pane.bufferId),
    ]),
  );
}

export const useEditorStore = create<EditorStore>((set, get) => {
  const persistLater = (tabId: string) => {
    void get().saveWorkspaceLayout(tabId);
  };

  return {
    buffers: {},
    workspaces: {},

    initializeWorkspace: (tabId, options = {}) => {
      const existing = get().workspaces[tabId];
      if (existing) return existing;

      const initialBuffer = createEditorBuffer({
        ...options.buffer,
        id: options.buffer?.id ?? options.bufferId,
      });
      const paneId = options.paneId ?? generateId("pane");
      const workspace = createWorkspace(tabId, initialBuffer.id, paneId);
      set((state) => ({
        buffers: {
          ...state.buffers,
          [initialBuffer.id]: state.buffers[initialBuffer.id] ?? initialBuffer,
        },
        workspaces: { ...state.workspaces, [tabId]: workspace },
      }));
      return workspace;
    },

    patchWorkspace: (tabId, partial) =>
      set((state) => {
        const workspace = state.workspaces[tabId];
        if (!workspace) return state;
        return {
          workspaces: {
            ...state.workspaces,
            [tabId]: { ...workspace, ...partial },
          },
        };
      }),

    openFileInPane: (tabId, paneId, seed) => {
      const candidate = createEditorBuffer({
        file_path: seed.file_path,
        content: seed.content,
        language: seed.language,
      });
      set((state) => {
        const workspace = state.workspaces[tabId];
        if (!workspace || !findEditorPane(workspace.layout, paneId)) {
          return state;
        }
        const existing = state.buffers[candidate.id];
        const layout = setEditorPaneBuffer(
          workspace.layout,
          paneId,
          candidate.id,
        );
        const openBufferIds = workspace.openBufferIds.includes(candidate.id)
          ? workspace.openBufferIds
          : [...workspace.openBufferIds, candidate.id];
        return {
          buffers: {
            ...state.buffers,
            [candidate.id]: existing ?? candidate,
          },
          workspaces: {
            ...state.workspaces,
            [tabId]: {
              ...workspace,
              layout,
              openBufferIds,
              focusedPaneId: paneId,
            },
          },
        };
      });
      persistLater(tabId);
      return candidate.id;
    },

    closeBuffer: (tabId, bufferId) => {
      let changed = false;
      set((state) => {
        const workspace = state.workspaces[tabId];
        const closedIndex = workspace?.openBufferIds.indexOf(bufferId) ?? -1;
        if (!workspace || closedIndex < 0) return state;

        const openBufferIds = workspace.openBufferIds.filter(
          (candidateId) => candidateId !== bufferId,
        );
        const buffers = { ...state.buffers };
        let replacementId =
          openBufferIds[Math.min(closedIndex, openBufferIds.length - 1)];
        if (!replacementId) {
          const replacement = createEditorBuffer();
          replacementId = replacement.id;
          openBufferIds.push(replacementId);
          buffers[replacementId] = replacement;
        }

        let layout = workspace.layout;
        for (const pane of getEditorPaneLeaves(workspace.layout)) {
          if (pane.bufferId === bufferId) {
            layout = setEditorPaneBuffer(layout, pane.id, replacementId);
          }
        }

        const workspaces = {
          ...state.workspaces,
          [tabId]: {
            ...workspace,
            layout,
            openBufferIds,
          },
        };
        if (!usedBufferIds(workspaces).has(bufferId)) {
          delete buffers[bufferId];
        }
        changed = true;
        return { buffers, workspaces };
      });
      if (changed) persistLater(tabId);
    },

    setBufferContent: (bufferId, content) =>
      set((state) => {
        const buffer = state.buffers[bufferId];
        if (!buffer || buffer.content === content) return state;
        return {
          buffers: {
            ...state.buffers,
            [bufferId]: {
              ...buffer,
              content,
              is_dirty: true,
              sync_status: "local",
              error: null,
            },
          },
        };
      }),

    patchBuffer: (bufferId, partial) =>
      set((state) => {
        const buffer = state.buffers[bufferId];
        if (!buffer) return state;
        const next = { ...buffer, ...partial, id: bufferId };
        if (
          Object.entries(partial).every(
            ([key, value]) => buffer[key as keyof EditorBufferState] === value,
          )
        ) {
          return state;
        }
        return {
          buffers: { ...state.buffers, [bufferId]: next },
        };
      }),

    markBufferSaved: (bufferId, revision) =>
      set((state) => {
        const buffer = state.buffers[bufferId];
        if (
          !buffer ||
          (revision !== undefined && buffer.revision !== revision)
        ) {
          return state;
        }
        if (!buffer.is_dirty && buffer.sync_status === "synced") return state;
        return {
          buffers: {
            ...state.buffers,
            [bufferId]: {
              ...buffer,
              is_dirty: false,
              sync_status: "synced",
              error: null,
            },
          },
        };
      }),

    splitPane: (tabId, paneId, direction, ids = {}) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) {
        throw new Error(`Unknown editor workspace: ${tabId}`);
      }
      const newPaneId = ids.paneId ?? generateId("pane");
      const splitId = ids.splitId ?? generateId("split");
      const layout = splitEditorPane(
        workspace.layout,
        paneId,
        direction,
        newPaneId,
        splitId,
      );
      if (layout !== workspace.layout) {
        set((state) => ({
          workspaces: {
            ...state.workspaces,
            [tabId]: {
              ...state.workspaces[tabId],
              layout,
              focusedPaneId: newPaneId,
            },
          },
        }));
        persistLater(tabId);
      }
      return layout;
    },

    closePane: (tabId, paneId) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) {
        throw new Error(`Unknown editor workspace: ${tabId}`);
      }
      const result = closeEditorPane(workspace.layout, paneId);
      if (!result.changed) return workspace.layout;
      const remaining = getAttachedEditorPanes(result.layout);
      const focusedPaneId =
        workspace.focusedPaneId === paneId
          ? (remaining[0] ?? getEditorPaneLeaves(result.layout)[0]).id
          : workspace.focusedPaneId;
      set((state) => ({
        workspaces: {
          ...state.workspaces,
          [tabId]: {
            ...state.workspaces[tabId],
            layout: result.layout,
            focusedPaneId,
          },
        },
      }));
      persistLater(tabId);
      return result.layout;
    },

    resizePane: (tabId, splitId, sizes) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) return;
      const layout = resizeEditorSplit(workspace.layout, splitId, sizes);
      if (layout === workspace.layout) return;
      set((state) => ({
        workspaces: {
          ...state.workspaces,
          [tabId]: { ...state.workspaces[tabId], layout },
        },
      }));
      persistLater(tabId);
    },

    focusPane: (tabId, paneId) => {
      const workspace = get().workspaces[tabId];
      const pane = workspace && findEditorPane(workspace.layout, paneId);
      if (!workspace || pane?.type !== "leaf") return;
      if (workspace.focusedPaneId === paneId) return;
      set((state) => ({
        workspaces: {
          ...state.workspaces,
          [tabId]: { ...state.workspaces[tabId], focusedPaneId: paneId },
        },
      }));
      persistLater(tabId);
    },

    updatePaneView: (tabId, paneId, view) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) return;
      const layout = updateEditorPaneView(workspace.layout, paneId, view);
      if (layout === workspace.layout) return;
      set((state) => ({
        workspaces: {
          ...state.workspaces,
          [tabId]: { ...state.workspaces[tabId], layout },
        },
      }));
    },

    markPaneDetached: (tabId, paneId, windowId) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) return;
      const layout = markEditorPaneDetached(workspace.layout, paneId, windowId);
      if (layout === workspace.layout) return;
      set((state) => ({
        workspaces: {
          ...state.workspaces,
          [tabId]: { ...state.workspaces[tabId], layout },
        },
      }));
      persistLater(tabId);
    },

    reattachPane: (tabId, paneId) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) return;
      const layout = reattachEditorPane(workspace.layout, paneId);
      if (layout === workspace.layout) return;
      set((state) => ({
        workspaces: {
          ...state.workspaces,
          [tabId]: {
            ...state.workspaces[tabId],
            layout,
            focusedPaneId: paneId,
          },
        },
      }));
      persistLater(tabId);
    },

    reconcileDetachedPanes: (tabId, liveWindowIds) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) return;
      const layout = reconcileDetachedEditorPanes(
        workspace.layout,
        liveWindowIds,
      );
      if (layout === workspace.layout) return;
      set((state) => ({
        workspaces: {
          ...state.workspaces,
          [tabId]: { ...state.workspaces[tabId], layout },
        },
      }));
      persistLater(tabId);
    },

    setFileTree: (tabId, file_tree, root_path) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) return;
      const rootChanged = workspace.root_path !== root_path;
      get().patchWorkspace(tabId, {
        file_tree,
        root_path,
        ...(rootChanged
          ? {
              expanded_dirs: new Set<string>(),
              git_status: [],
              is_git_repo: false,
              error: null,
            }
          : {}),
      });
    },

    toggleExplorer: (tabId) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) return;
      get().patchWorkspace(tabId, {
        explorer_open: !workspace.explorer_open,
      });
    },

    toggleDirectory: (tabId, dirPath) => {
      const workspace = get().workspaces[tabId];
      if (!workspace) return;
      const expanded_dirs = new Set(workspace.expanded_dirs);
      if (expanded_dirs.has(dirPath)) expanded_dirs.delete(dirPath);
      else expanded_dirs.add(dirPath);
      get().patchWorkspace(tabId, { expanded_dirs });
    },

    setGitStatus: (tabId, git_status, is_git_repo) =>
      get().patchWorkspace(tabId, { git_status, is_git_repo }),

    loadWorkspaceLayout: async (tabId, liveWindowIds) => {
      try {
        const layoutJson = await invoke<string | null>("panes_get_layout", {
          tabId,
        });
        if (layoutJson) {
          const hydrated = deserializeEditorLayout(layoutJson, (kind) =>
            generateId(
              kind === "buffer"
                ? "buffer"
                : kind === "split"
                  ? "split"
                  : "pane",
            ),
          );
          if (hydrated) {
            const layout = liveWindowIds
              ? reconcileDetachedEditorPanes(hydrated.layout, liveWindowIds)
              : hydrated.layout;
            const existing =
              get().workspaces[tabId] ??
              createWorkspace(
                tabId,
                getEditorPaneLeaves(layout)[0].bufferId,
                getEditorPaneLeaves(layout)[0].id,
              );
            set((state) => {
              const buffers = { ...state.buffers };
              for (const [bufferId, identity] of Object.entries(
                hydrated.bufferIdentities,
              )) {
                buffers[bufferId] ??= bufferFromIdentity(identity);
              }
              return {
                buffers,
                workspaces: {
                  ...state.workspaces,
                  [tabId]: {
                    ...existing,
                    layout,
                    focusedPaneId: hydrated.focusedPaneId,
                    openBufferIds: [
                      ...new Set(
                        getEditorPaneLeaves(layout).map(
                          (pane) => pane.bufferId,
                        ),
                      ),
                    ],
                  },
                },
              };
            });
            if (liveWindowIds && layout !== hydrated.layout) {
              persistLater(tabId);
            }
            return get().workspaces[tabId];
          }
        }
      } catch (error) {
        console.warn("Failed to load editor pane layout:", error);
      }
      return get().initializeWorkspace(tabId);
    },

    saveWorkspaceLayout: async (tabId) => {
      const state = get();
      const workspace = state.workspaces[tabId];
      if (!workspace) return;
      const identities: Record<string, EditorBufferIdentity> = {};
      for (const pane of getEditorPaneLeaves(workspace.layout)) {
        const buffer = state.buffers[pane.bufferId];
        if (buffer) identities[buffer.id] = identityForBuffer(buffer);
      }
      const layoutJson = serializeEditorLayout(
        workspace.layout,
        workspace.focusedPaneId,
        identities,
      );
      try {
        await invoke("panes_save_layout", { tabId, layoutJson });
      } catch (error) {
        console.warn("Failed to save editor pane layout:", error);
      }
    },

    resetWorkspace: (tabId) =>
      set((state) => {
        const workspaces = { ...state.workspaces };
        delete workspaces[tabId];
        const retained = usedBufferIds(workspaces);
        const buffers = Object.fromEntries(
          Object.entries(state.buffers).filter(([id]) => retained.has(id)),
        );
        return { workspaces, buffers };
      }),

    resetAll: () => set({ buffers: {}, workspaces: {} }),
  };
});

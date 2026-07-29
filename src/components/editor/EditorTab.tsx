import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { Tab } from "../../lib/types";
import {
  editorDetachedWindowClose,
  editorDetachedWindowFocus,
  editorDetachedWindowList,
  editorDetachPane,
  editorGetHomeDirectory,
  editorGetState,
  editorOpenFile,
  editorSaveFile,
  gitGetStatus,
  gitIsRepo,
} from "../../lib/tauri";
import {
  bufferIdForFile,
  useEditorStore,
} from "../../state/editorStore";
import {
  findEditorPane,
  getAttachedEditorPanes,
  getEditorPaneLeaves,
  type EditorPaneLeaf,
} from "./editorPaneLayout";
import { EditorPane } from "./EditorPane";
import { EditorSplitTree } from "./EditorSplitTree";
import { FileExplorer } from "./FileExplorer";
import { FindReplace } from "./FindReplace";
import { EditorSettingsPanel } from "./EditorSettings";
import {
  EditorTerminalPanel,
  type EditorTerminalMode,
} from "./EditorTerminalPanel";
import { useEditorSettings } from "../../hooks/useEditorSettings";
import { useZedMode } from "./ZedModeProvider";
import { EditorBufferSyncClient } from "./editorBufferSync";
import "./EditorTab.css";

function leafById(
  layout: ReturnType<typeof useEditorStore.getState>["workspaces"][string]["layout"],
  paneId: string,
): EditorPaneLeaf | null {
  const pane = findEditorPane(layout, paneId);
  return pane?.type === "leaf" ? pane : null;
}

export function EditorTab({ tab }: { tab: Tab }) {
  const initializeWorkspace = useEditorStore((s) => s.initializeWorkspace);
  const existingWorkspace = useEditorStore((s) => s.workspaces[tab.id]);
  const workspace =
    existingWorkspace ?? initializeWorkspace(tab.id);
  const buffers = useEditorStore((s) => s.buffers);
  const patchWorkspace = useEditorStore((s) => s.patchWorkspace);
  const patchBuffer = useEditorStore((s) => s.patchBuffer);
  const openFileInPane = useEditorStore((s) => s.openFileInPane);
  const setBufferContent = useEditorStore((s) => s.setBufferContent);
  const markBufferSaved = useEditorStore((s) => s.markBufferSaved);
  const splitPane = useEditorStore((s) => s.splitPane);
  const closePane = useEditorStore((s) => s.closePane);
  const resizePane = useEditorStore((s) => s.resizePane);
  const focusPane = useEditorStore((s) => s.focusPane);
  const updatePaneView = useEditorStore((s) => s.updatePaneView);
  const markPaneDetached = useEditorStore((s) => s.markPaneDetached);
  const reattachPane = useEditorStore((s) => s.reattachPane);
  const loadWorkspaceLayout = useEditorStore((s) => s.loadWorkspaceLayout);
  const setFileTree = useEditorStore((s) => s.setFileTree);
  const toggleExplorer = useEditorStore((s) => s.toggleExplorer);
  const toggleDirectory = useEditorStore((s) => s.toggleDirectory);
  const setGitStatus = useEditorStore((s) => s.setGitStatus);

  const { settings, setSettings } = useEditorSettings();
  const { mode } = useZedMode();
  const editorRefs = useRef(
    new Map<string, Monaco.editor.IStandaloneCodeEditor>(),
  );
  const syncClients = useRef(new Map<string, EditorBufferSyncClient>());
  const syncSourceId = useRef(
    `editor-main:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  );
  const [showFind, setShowFind] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalMode, setTerminalMode] =
    useState<EditorTerminalMode>("opencode");

  const focusedPane =
    leafById(workspace.layout, workspace.focusedPaneId) ??
    getAttachedEditorPanes(workspace.layout)[0] ??
    getEditorPaneLeaves(workspace.layout)[0];
  const focusedBuffer = focusedPane
    ? buffers[focusedPane.bufferId]
    : undefined;

  const ensureBufferSync = useCallback(
    async (bufferId: string) => {
      const state = useEditorStore.getState();
      const buffer = state.buffers[bufferId];
      if (!buffer) {
        throw new Error(`Unknown editor buffer: ${bufferId}`);
      }
      const existing = syncClients.current.get(bufferId);
      if (existing) {
        await existing.start({
          bufferId,
          filePath: buffer.file_path,
          content: buffer.content,
          language: buffer.language,
          dirty: buffer.is_dirty,
          sourceId: syncSourceId.current,
        });
        return existing;
      }

      const client = new EditorBufferSyncClient({
        bufferId,
        sourceId: syncSourceId.current,
        onSnapshot: (snapshot) => {
          useEditorStore.getState().patchBuffer(bufferId, {
            file_path: snapshot.filePath,
            content: snapshot.content,
            language: snapshot.language,
            is_dirty: snapshot.dirty,
            revision: snapshot.revision,
            sync_status: "synced",
            error: null,
          });
        },
        onRevision: (snapshot) => {
          useEditorStore.getState().patchBuffer(bufferId, {
            revision: snapshot.revision,
          });
        },
        onStatus: (sync_status, error) => {
          useEditorStore.getState().patchBuffer(bufferId, {
            sync_status,
            error: error ?? null,
          });
        },
      });
      syncClients.current.set(bufferId, client);
      try {
        await client.start({
          bufferId,
          filePath: buffer.file_path,
          content: buffer.content,
          language: buffer.language,
          dirty: buffer.is_dirty,
          sourceId: syncSourceId.current,
        });
      } catch (error) {
        client.dispose();
        syncClients.current.delete(bufferId);
        throw error;
      }
      return client;
    },
    [],
  );

  useEffect(
    () => () => {
      for (const client of syncClients.current.values()) client.dispose();
      syncClients.current.clear();
    },
    [],
  );

  useEffect(() => {
    const detachedBufferIds = new Set(
      getEditorPaneLeaves(workspace.layout)
        .filter((pane) => pane.detachedWindowId !== null)
        .map((pane) => pane.bufferId),
    );
    for (const bufferId of detachedBufferIds) {
      void ensureBufferSync(bufferId).catch((error) => {
        patchWorkspace(tab.id, { error: String(error) });
      });
    }
  }, [workspace.layout, tab.id, ensureBufferSync, patchWorkspace]);

  // Rehydrate layout first, then populate every file-backed buffer from disk.
  // Unsaved text is deliberately not part of Phase 2 layout persistence.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const detachedWindows = await editorDetachedWindowList().catch(() => []);
      const liveWindowIds = new Set(
        detachedWindows
          .filter((window) => window.tabId === tab.id)
          .map((window) => window.windowId),
      );
      const hydrated = await loadWorkspaceLayout(tab.id, liveWindowIds);
      if (cancelled) return;

      const primary = await editorGetState(tab.id).catch(() => null);
      if (cancelled) return;

      const state = useEditorStore.getState();
      const current = state.workspaces[tab.id] ?? hydrated;
      const filePaths = new Set(
        getEditorPaneLeaves(current.layout)
          .map((pane) => state.buffers[pane.bufferId]?.file_path)
          .filter((path): path is string => Boolean(path)),
      );
      if (primary?.file_path) filePaths.add(primary.file_path);

      for (const filePath of filePaths) {
        if (cancelled) return;
        const loaded =
          primary?.file_path === filePath
            ? primary
            : await editorOpenFile(tab.id, filePath).catch(() => null);
        if (!loaded) continue;
        const latest = useEditorStore.getState();
        const bufferId = bufferIdForFile(loaded.file_path);
        const matchingPane = getEditorPaneLeaves(
          latest.workspaces[tab.id].layout,
        ).find((pane) => pane.bufferId === bufferId);
        if (matchingPane && latest.buffers[bufferId]) {
          latest.patchBuffer(bufferId, {
            file_path: loaded.file_path,
            content: loaded.content,
            language: loaded.language,
            is_dirty: false,
            error: null,
          });
        } else if (primary?.file_path === filePath) {
          latest.openFileInPane(
            tab.id,
            latest.workspaces[tab.id].focusedPaneId,
            {
              file_path: loaded.file_path,
              content: loaded.content,
              language: loaded.language,
            },
          );
        }
      }

      // Loading secondary files updates the compatibility record. Put the
      // original primary file back last so restart behavior remains stable.
      if (primary?.file_path && filePaths.size > 1 && !cancelled) {
        await editorOpenFile(tab.id, primary.file_path).catch(() => null);
      }
    })().catch((error) => {
      if (!cancelled) {
        patchWorkspace(tab.id, { error: String(error) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tab.id, loadWorkspaceLayout, patchWorkspace]);

  useEffect(() => {
    if (!workspace.root_path) {
      editorGetHomeDirectory()
        .then((homePath) => setFileTree(tab.id, [], homePath))
        .catch((error) =>
          patchWorkspace(tab.id, { error: String(error) })
        );
    }
  }, [
    tab.id,
    workspace.root_path,
    setFileTree,
    patchWorkspace,
  ]);

  useEffect(() => {
    const rootPath = workspace.root_path;
    if (!rootPath) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const refresh = () =>
      gitGetStatus(rootPath)
        .then((status) => {
          if (!cancelled) setGitStatus(tab.id, status, true);
        })
        .catch((error) =>
          console.error("Failed to load git status:", error)
        );

    gitIsRepo(rootPath)
      .then((isRepo) => {
        if (cancelled) return;
        if (!isRepo) {
          setGitStatus(tab.id, [], false);
          return;
        }
        void refresh();
        interval = setInterval(() => void refresh(), 10_000);
      })
      .catch((error) => {
        console.error("Failed to probe git repo:", error);
        if (!cancelled) setGitStatus(tab.id, [], false);
      });

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [tab.id, workspace.root_path, setGitStatus]);

  const saveBuffer = useCallback(
    async (bufferId: string) => {
      const current = useEditorStore.getState().buffers[bufferId];
      if (!current?.file_path) return;
      patchWorkspace(tab.id, { loading: true, error: null });
      try {
        const sync = syncClients.current.get(bufferId);
        const savedRevision = sync
          ? await sync.flushNow()
          : current.revision;
        await editorSaveFile(tab.id, current.file_path, current.content);
        if (sync) {
          await sync.markSaved(savedRevision);
        } else {
          markBufferSaved(bufferId, current.revision);
        }
      } catch (error) {
        patchWorkspace(tab.id, { error: String(error) });
      } finally {
        patchWorkspace(tab.id, { loading: false });
      }
    },
    [tab.id, markBufferSaved, patchWorkspace],
  );

  const openFile = useCallback(
    async (filePath: string) => {
      patchWorkspace(tab.id, { loading: true, error: null });
      try {
        const file = await editorOpenFile(tab.id, filePath);
        const current = useEditorStore.getState().workspaces[tab.id];
        openFileInPane(tab.id, current.focusedPaneId, {
          file_path: file.file_path,
          content: file.content,
          language: file.language,
        });
      } catch (error) {
        patchWorkspace(tab.id, { error: String(error) });
      } finally {
        patchWorkspace(tab.id, { loading: false });
      }
    },
    [tab.id, openFileInPane, patchWorkspace],
  );

  const detachPane = useCallback(
    async (paneId: string) => {
      if (mode !== "zed") return;
      const state = useEditorStore.getState();
      const pane = leafById(state.workspaces[tab.id].layout, paneId);
      const buffer = pane && state.buffers[pane.bufferId];
      if (!pane || !buffer || pane.detachedWindowId) return;
      patchWorkspace(tab.id, { loading: true, error: null });
      try {
        await ensureBufferSync(buffer.id);
        const info = await editorDetachPane(
          tab.id,
          pane.id,
          buffer.id,
          buffer.file_path?.split("/").pop() ?? "Untitled",
        );
        markPaneDetached(tab.id, pane.id, info.windowId);
      } catch (error) {
        patchWorkspace(tab.id, { error: String(error) });
      } finally {
        patchWorkspace(tab.id, { loading: false });
      }
    },
    [
      mode,
      tab.id,
      ensureBufferSync,
      markPaneDetached,
      patchWorkspace,
    ],
  );

  const bringPaneBack = useCallback(
    async (paneId: string) => {
      const state = useEditorStore.getState();
      const pane = leafById(state.workspaces[tab.id].layout, paneId);
      if (!pane?.detachedWindowId) return;
      try {
        await editorDetachedWindowClose(pane.detachedWindowId);
      } catch (error) {
        patchWorkspace(tab.id, { error: String(error) });
      } finally {
        reattachPane(tab.id, paneId);
      }
    },
    [tab.id, patchWorkspace, reattachPane],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (
        meta &&
        event.shiftKey &&
        (event.key === "f" || event.key === "F")
      ) {
        event.preventDefault();
        setShowFind((value) => !value);
      } else if (meta && event.key === ",") {
        event.preventDefault();
        setShowSettings((value) => !value);
      } else if (
        meta &&
        event.shiftKey &&
        (event.key === "e" || event.key === "E")
      ) {
        event.preventDefault();
        toggleExplorer(tab.id);
      } else if (
        meta &&
        event.shiftKey &&
        (event.key === "o" || event.key === "O")
      ) {
        event.preventDefault();
        setTerminalMode("opencode");
        setShowTerminal((value) =>
          terminalMode === "opencode" ? !value : true
        );
      } else if (meta && !event.shiftKey && event.key === "`") {
        event.preventDefault();
        setTerminalMode("shell");
        setShowTerminal((value) =>
          terminalMode === "shell" ? !value : true
        );
      } else if (event.key === "Escape" && (showFind || showSettings)) {
        event.preventDefault();
        setShowFind(false);
        setShowSettings(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    tab.id,
    toggleExplorer,
    showFind,
    showSettings,
    terminalMode,
  ]);

  const classicPane = useMemo(
    () =>
      leafById(workspace.layout, workspace.focusedPaneId) ??
      getAttachedEditorPanes(workspace.layout)[0] ??
      getEditorPaneLeaves(workspace.layout)[0],
    [workspace.layout, workspace.focusedPaneId],
  );
  const focusedEditor =
    editorRefs.current.get(workspace.focusedPaneId) ?? null;
  const paneCallbacks = {
    onFocus: (paneId: string) => focusPane(tab.id, paneId),
    onSplit: (
      paneId: string,
      direction: "horizontal" | "vertical",
    ) => splitPane(tab.id, paneId, direction),
    onDetach: (paneId: string) => void detachPane(paneId),
    onClose: (paneId: string) => {
      editorRefs.current.delete(paneId);
      closePane(tab.id, paneId);
    },
    onResize: (splitId: string, sizes: number[]) =>
      resizePane(tab.id, splitId, sizes),
    onReattach: (paneId: string) => void bringPaneBack(paneId),
    onFocusWindow: (_paneId: string, windowId: string) =>
      void editorDetachedWindowFocus(windowId).catch((error) =>
        patchWorkspace(tab.id, { error: String(error) })
      ),
    onChange: (bufferId: string, content: string) => {
      setBufferContent(bufferId, content);
      const buffer = useEditorStore.getState().buffers[bufferId];
      syncClients.current
        .get(bufferId)
        ?.queueLocal(content, buffer.language, true);
    },
    onCursorChange: (
      paneId: string,
      position: { line: number; column: number },
    ) => updatePaneView(tab.id, paneId, { cursor_position: position }),
    onScrollChange: (paneId: string, scrollTop: number) =>
      updatePaneView(tab.id, paneId, { scroll_position: scrollTop }),
    onSave: (bufferId: string) => void saveBuffer(bufferId),
    onEditorReady: (
      paneId: string,
      editor: Monaco.editor.IStandaloneCodeEditor,
    ) => {
      editorRefs.current.set(paneId, editor);
    },
  };

  return (
    <div
      className="editor-tab"
      data-testid="editor-tab"
      data-editor-mode={mode}
    >
      <div className="editor-toolbar">
        <div className="editor-file-info">
          <span className="file-name">
            {focusedBuffer?.file_path?.split("/").pop() ?? "Untitled"}
          </span>
          {focusedBuffer?.file_path && (
            <span className="file-path">{focusedBuffer.file_path}</span>
          )}
          {focusedBuffer?.is_dirty && (
            <span className="dirty-marker">●</span>
          )}
        </div>
        <div className="editor-actions">
          <button
            onClick={() => toggleExplorer(tab.id)}
            title="Toggle Explorer (Cmd+Shift+E)"
            data-testid="editor-toggle-explorer"
          >
            {workspace.explorer_open ? "◀" : "▶"}
          </button>
          <button
            onClick={() => setShowFind((value) => !value)}
            title="Find & Replace (Cmd+Shift+F)"
            data-testid="editor-find-button"
          >
            🔍
          </button>
          <button
            onClick={() => setShowSettings((value) => !value)}
            title="Editor Settings (Cmd+,)"
            data-testid="editor-settings-button"
          >
            ⚙
          </button>
          <button
            onClick={() => {
              setTerminalMode("opencode");
              setShowTerminal((value) =>
                terminalMode === "opencode" ? !value : true
              );
            }}
            title="opencode (Cmd+Shift+O)"
            data-testid="editor-opencode-button"
          >
            🤖
          </button>
          <button
            onClick={() => {
              setTerminalMode("shell");
              setShowTerminal((value) =>
                terminalMode === "shell" ? !value : true
              );
            }}
            title="Terminal — run claude / codex (Cmd+`)"
            data-testid="editor-terminal-button"
          >
            ⌨
          </button>
          <button
            onClick={() => {
              if (focusedBuffer) void saveBuffer(focusedBuffer.id);
            }}
            disabled={
              !focusedBuffer?.is_dirty ||
              !focusedBuffer.file_path ||
              workspace.loading
            }
            title="Save (Cmd+S)"
            data-testid="editor-save-button"
          >
            Save
          </button>
        </div>
      </div>

      <div className="editor-main">
        {workspace.explorer_open && (
          <FileExplorer
            rootPath={workspace.root_path}
            expandedDirs={workspace.expanded_dirs}
            onSelectFile={openFile}
            onToggleDir={(dirPath) => toggleDirectory(tab.id, dirPath)}
            gitStatus={
              workspace.is_git_repo ? workspace.git_status : undefined
            }
          />
        )}
        <div className="editor-content">
          <div className="editor-canvas">
            {mode === "zed" ? (
              <EditorSplitTree
                node={workspace.layout}
                buffers={buffers}
                tabId={tab.id}
                rootPath={workspace.root_path}
                focusedPaneId={workspace.focusedPaneId}
                settings={settings}
                {...paneCallbacks}
              />
            ) : (
              classicPane &&
              buffers[classicPane.bufferId] && (
                <EditorPane
                  tabId={tab.id}
                  pane={classicPane}
                  buffer={buffers[classicPane.bufferId]}
                  rootPath={workspace.root_path}
                  focused
                  showControls={false}
                  canClose={false}
                  forceAttached
                  settings={settings}
                  onFocus={() => focusPane(tab.id, classicPane.id)}
                  onSplit={() => {}}
                  onDetach={() => {}}
                  onClose={() => {}}
                  onReattach={() => {}}
                  onFocusWindow={() => {}}
                  onChange={(content) =>
                    paneCallbacks.onChange(
                      classicPane.bufferId,
                      content,
                    )
                  }
                  onCursorChange={(position) =>
                    updatePaneView(tab.id, classicPane.id, {
                      cursor_position: position,
                    })
                  }
                  onScrollChange={(scrollTop) =>
                    updatePaneView(tab.id, classicPane.id, {
                      scroll_position: scrollTop,
                    })
                  }
                  onSave={() => void saveBuffer(classicPane.bufferId)}
                  onEditorReady={(editor) => {
                    editorRefs.current.set(classicPane.id, editor);
                  }}
                />
              )
            )}
            {showFind && (
              <FindReplace
                editor={focusedEditor}
                onClose={() => setShowFind(false)}
              />
            )}
            {showSettings && (
              <EditorSettingsPanel
                settings={settings}
                onSave={setSettings}
                onClose={() => setShowSettings(false)}
              />
            )}
          </div>
        </div>
      </div>

      {showTerminal && (
        <EditorTerminalPanel
          tabId={tab.id}
          cwd={workspace.root_path}
          mode={terminalMode}
          onModeChange={setTerminalMode}
          onClose={() => setShowTerminal(false)}
        />
      )}

      {workspace.error && (
        <div className="error-banner" data-testid="editor-error">
          {workspace.error}
        </div>
      )}

      <div className="editor-status-bar">
        <span>{focusedBuffer?.sync_status ?? "local"}</span>
        <span>
          Ln {focusedPane?.cursor_position.line ?? 1}, Col{" "}
          {focusedPane?.cursor_position.column ?? 1}
        </span>
        <span>{focusedBuffer?.language ?? "plaintext"}</span>
      </div>
    </div>
  );
}

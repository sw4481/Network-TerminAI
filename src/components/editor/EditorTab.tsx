import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Tab } from "../../lib/types";
import type { CiscoPlatform } from "../../lib/ciscoLint";
import { registerAppShutdownTask } from "../../lib/appShutdown";
import {
  editorDetachedWindowClose,
  editorDetachedWindowFocus,
  editorDetachedWindowList,
  editorDetachPane,
  editorGetState,
  editorOpenFile,
  editorSaveFile,
  dapBreakpointsGet,
  dapBreakpointsSet,
  gitGetStatus,
  gitIsRepo,
  type DapStackFrame,
  type DetachedEditorWindowClosed,
} from "../../lib/tauri";
import { bufferIdForFile, useEditorStore } from "../../state/editorStore";
import {
  findEditorPane,
  getAttachedEditorPanes,
  getEditorPaneLeaves,
  type EditorPaneLeaf,
} from "./editorPaneLayout";
import { confirmEditorBufferClose, EditorBufferTabs } from "./EditorBufferTabs";
import { EditorActionToolbar } from "./EditorActionToolbar";
import { EditorPane } from "./EditorPane";
import { EditorSplitTree } from "./EditorSplitTree";
import { FileExplorer } from "./FileExplorer";
import { FindReplace } from "./FindReplace";
import { ProblemsPanel, type ProblemStatus } from "./ProblemsPanel";
import { WorkspaceFind } from "./WorkspaceFind";
import { EditorSettingsPanel } from "./EditorSettings";
import {
  EditorTerminalPanel,
  type EditorTerminalMode,
} from "./EditorTerminalPanel";
import { useEditorSettings } from "../../hooks/useEditorSettings";
import { useDebugSession } from "../../hooks/useDebugSession";
import { normalizeLspLanguage } from "../../hooks/useLspClient";
import { useCiscoLint, type CiscoLintView } from "../../hooks/useCiscoLint";
import { useZedMode } from "./ZedModeProvider";
import {
  EditorBufferSyncClient,
  flushEditorBufferSyncClients,
} from "./editorBufferSync";
import {
  applyDetachedEditorWindowClosed,
  EDITOR_DETACHED_WINDOW_CLOSED_EVENT,
} from "./editorWindowLifecycle";
import { GitStatusIndicator } from "./GitStatusIndicator";
import { GitDiffReview } from "./GitDiffReview";
import { GitPanel } from "./GitPanel";
import { useGitPanel } from "./useGitPanel";
import { isGitPanelToggleShortcut } from "./gitPanelState";
import type { GitDiffPayload } from "../../lib/tauri";
import { useGitRepositorySummary } from "./useGitRepositorySummary";
import {
  WorkspaceSymbolSearch,
  type WorkspaceSymbolResult,
} from "./lsp/WorkspaceSymbolSearch";
import {
  EDITOR_LSP_OPEN_LOCATION_EVENT,
  EDITOR_WORKSPACE_SYMBOL_SEARCH_EVENT,
  fileUriToPath,
  pathIsWithinWorkspace,
  type EditorLspOpenLocation,
} from "./lsp/locationRouting";
import { DebugPanel } from "./debug/DebugPanel";
import { pickWorkspaceFolder } from "./workspaceFolderPicker";
import "./EditorTab.css";

function leafById(
  layout: ReturnType<
    typeof useEditorStore.getState
  >["workspaces"][string]["layout"],
  paneId: string,
): EditorPaneLeaf | null {
  const pane = findEditorPane(layout, paneId);
  return pane?.type === "leaf" ? pane : null;
}

export function EditorTab({ tab }: { tab: Tab }) {
  const initializeWorkspace = useEditorStore((s) => s.initializeWorkspace);
  const existingWorkspace = useEditorStore((s) => s.workspaces[tab.id]);
  const workspace = existingWorkspace ?? initializeWorkspace(tab.id);
  const buffers = useEditorStore((s) => s.buffers);
  const patchWorkspace = useEditorStore((s) => s.patchWorkspace);
  const openFileInPane = useEditorStore((s) => s.openFileInPane);
  const closeBuffer = useEditorStore((s) => s.closeBuffer);
  const setBufferContent = useEditorStore((s) => s.setBufferContent);
  const patchBuffer = useEditorStore((s) => s.patchBuffer);
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
  const { mode, hydrated: modeHydrated } = useZedMode();
  const editorRefs = useRef(
    new Map<string, Monaco.editor.IStandaloneCodeEditor>(),
  );
  const editorTabRef = useRef<HTMLDivElement | null>(null);
  const syncClients = useRef(new Map<string, EditorBufferSyncClient>());
  const syncSourceId = useRef(
    `editor-main:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  );
  const [showFind, setShowFind] = useState(false);
  const [showWorkspaceFind, setShowWorkspaceFind] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [, setEditorReadyTick] = useState(0);
  const [fileExplorerRefreshKey, setFileExplorerRefreshKey] = useState(0);
  const [terminalMode, setTerminalMode] =
    useState<EditorTerminalMode>("opencode");
  const debug = useDebugSession(tab.id, modeHydrated ? mode === "zed" : null);

  const focusedPane =
    leafById(workspace.layout, workspace.focusedPaneId) ??
    getAttachedEditorPanes(workspace.layout)[0] ??
    getEditorPaneLeaves(workspace.layout)[0];
  const focusedBuffer = focusedPane ? buffers[focusedPane.bufferId] : undefined;
  const ciscoLint = useCiscoLint({
    content: focusedBuffer?.content ?? "",
    platform: focusedBuffer?.cisco_platform ?? null,
  });
  const ciscoLintSignature = JSON.stringify(ciscoLint);
  const [latestCiscoLint, setLatestCiscoLint] = useState<{
    bufferId: string;
    signature: string;
    result: CiscoLintView;
  } | null>(null);
  const onCiscoLintResult = useCallback(
    (result: CiscoLintView) => {
      if (!focusedBuffer?.cisco_platform) return;
      const signature = JSON.stringify(result);
      setLatestCiscoLint((current) =>
        current?.bufferId === focusedBuffer.id &&
        current.signature === signature
          ? current
          : { bufferId: focusedBuffer.id, signature, result },
      );
    },
    [focusedBuffer?.id, focusedBuffer?.cisco_platform],
  );
  useEffect(() => {
    if (!focusedBuffer?.cisco_platform) {
      setLatestCiscoLint(null);
      return;
    }
    onCiscoLintResult(ciscoLint);
  }, [
    focusedBuffer?.id,
    focusedBuffer?.cisco_platform,
    ciscoLintSignature,
    onCiscoLintResult,
  ]);
  const activeCiscoLint =
    focusedBuffer?.cisco_platform &&
    latestCiscoLint?.bufferId === focusedBuffer.id
      ? latestCiscoLint.result
      : null;
  const ciscoProblemStatuses: ProblemStatus[] = activeCiscoLint
    ? [
        {
          name: "Structural",
          state: activeCiscoLint.structuralStatus,
          reason: null,
        },
        { name: "Guardrails", ...activeCiscoLint.guardrails },
      ]
    : [
        { name: "Structural", state: "idle", reason: null },
        { name: "Guardrails", state: "idle", reason: null },
      ];
  const openBuffers = workspace.openBufferIds
    .map((bufferId) => buffers[bufferId])
    .filter((buffer): buffer is NonNullable<typeof buffer> => Boolean(buffer));
  const pythonDebuggable =
    mode === "zed" &&
    Boolean(workspace.root_path) &&
    Boolean(focusedBuffer?.file_path) &&
    focusedBuffer?.language.trim().toLowerCase() === "python";
  const { summary: gitSummary, refresh: refreshGitSummary } =
    useGitRepositorySummary(
      focusedBuffer?.file_path ?? workspace.root_path,
      mode === "zed",
    );
  const gitPanel = useGitPanel({
    workspaceRoot: workspace.root_path ?? "",
    focusedFile: focusedBuffer?.file_path ?? null,
    enabled: mode === "zed",
  });
  const [gitDiffReview, setGitDiffReview] = useState<{
    path: string;
    payload: GitDiffPayload;
  } | null>(null);

  const ensureBufferSync = useCallback(async (bufferId: string) => {
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
        ciscoPlatform: buffer.cisco_platform,
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
          cisco_platform: snapshot.ciscoPlatform,
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
        ciscoPlatform: buffer.cisco_platform,
        dirty: buffer.is_dirty,
        sourceId: syncSourceId.current,
      });
    } catch (error) {
      client.dispose();
      syncClients.current.delete(bufferId);
      throw error;
    }
    return client;
  }, []);

  useEffect(
    () => () => {
      for (const client of syncClients.current.values()) client.dispose();
      syncClients.current.clear();
    },
    [],
  );

  useEffect(
    () =>
      registerAppShutdownTask(`editor:${tab.id}`, () =>
        flushEditorBufferSyncClients(syncClients.current.values()),
      ),
    [tab.id],
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

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<DetachedEditorWindowClosed>(
      EDITOR_DETACHED_WINDOW_CLOSED_EVENT,
      (event) => {
        if (!disposed && event.payload.tabId === tab.id) {
          applyDetachedEditorWindowClosed(event.payload);
        }
      },
    )
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((listenError) => {
        if (!disposed) {
          patchWorkspace(tab.id, { error: String(listenError) });
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tab.id, patchWorkspace]);

  useEffect(() => {
    if (!modeHydrated || mode !== "monaco") return;
    let disposed = false;
    // Detached webviews flush and close themselves on the same mode snapshot.
    // This delayed source-side pass is a fallback for a crashed/unresponsive
    // detached frontend, without racing its normal data-preserving close path.
    const fallback = setTimeout(() => {
      void editorDetachedWindowList()
        .then(async (windows) => {
          const owned = windows.filter((window) => window.tabId === tab.id);
          for (const window of owned) {
            if (disposed) return;
            await editorDetachedWindowClose(window.windowId);
          }
        })
        .catch((closeError) => {
          if (!disposed) {
            patchWorkspace(tab.id, { error: String(closeError) });
          }
        });
    }, 500);
    return () => {
      disposed = true;
      clearTimeout(fallback);
    };
  }, [modeHydrated, mode, tab.id, patchWorkspace]);

  // Rehydrate layout first, then populate every file-backed buffer from disk.
  // Unsaved text is deliberately not part of Phase 2 layout persistence.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const detachedWindows = await editorDetachedWindowList().catch(
        () => null,
      );
      const liveWindowIds = detachedWindows
        ? new Set(
            detachedWindows
              .filter((window) => window.tabId === tab.id)
              .map((window) => window.windowId),
          )
        : undefined;
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
    const rootPath = workspace.root_path;
    if (!rootPath) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const refresh = () =>
      gitGetStatus(rootPath)
        .then((status) => {
          if (!cancelled) setGitStatus(tab.id, status, true);
        })
        .catch((error) => console.error("Failed to load git status:", error));

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
      if (!current?.file_path) return false;
      patchWorkspace(tab.id, { loading: true, error: null });
      try {
        const sync = syncClients.current.get(bufferId);
        const synchronized = sync ? await sync.flushNow() : null;
        await editorSaveFile(
          tab.id,
          current.file_path,
          synchronized?.content ?? current.content,
        );
        if (sync) {
          await sync.markSaved(synchronized!.revision);
        } else {
          markBufferSaved(bufferId, current.revision);
        }
        await refreshGitSummary();
        return true;
      } catch (error) {
        patchWorkspace(tab.id, { error: String(error) });
        return false;
      } finally {
        patchWorkspace(tab.id, { loading: false });
      }
    },
    [tab.id, markBufferSaved, patchWorkspace, refreshGitSummary],
  );

  const revealEditorLocation = useCallback(
    (
      paneId: string,
      filePath: string,
      position: { line: number; column: number },
    ): Promise<boolean> =>
      new Promise((resolve) => {
        let attempts = 0;
        const reveal = () => {
          const editor = editorRefs.current.get(paneId);
          const currentPath = editor?.getModel()
            ? fileUriToPath(editor.getModel()!.uri.toString())
            : null;
          if (editor && currentPath === filePath) {
            editor.setPosition({
              lineNumber: Math.max(1, position.line),
              column: Math.max(1, position.column),
            });
            editor.revealPositionInCenter({
              lineNumber: Math.max(1, position.line),
              column: Math.max(1, position.column),
            });
            editor.focus();
            resolve(true);
            return;
          }
          attempts += 1;
          if (attempts >= 20) {
            resolve(false);
            return;
          }
          globalThis.setTimeout(reveal, 16);
        };
        reveal();
      }),
    [],
  );

  const openFileAtPane = useCallback(
    async (
      paneId: string,
      filePath: string,
      position?: { line: number; column: number },
    ): Promise<boolean> => {
      const state = useEditorStore.getState();
      const currentWorkspace = state.workspaces[tab.id];
      if (!currentWorkspace) return false;
      if (
        position &&
        (!currentWorkspace.root_path ||
          !pathIsWithinWorkspace(filePath, currentWorkspace.root_path))
      ) {
        patchWorkspace(tab.id, {
          error: "Language-server target is outside the open workspace",
        });
        return false;
      }
      const requestedPane = leafById(currentWorkspace.layout, paneId);
      const targetPane =
        requestedPane?.detachedWindowId === null
          ? requestedPane
          : getAttachedEditorPanes(currentWorkspace.layout)[0];
      if (!targetPane) return false;

      patchWorkspace(tab.id, { loading: true, error: null });
      try {
        const file = await editorOpenFile(tab.id, filePath);
        openFileInPane(tab.id, targetPane.id, {
          file_path: file.file_path,
          content: file.content,
          language: file.language,
        });
        if (position) {
          return await revealEditorLocation(
            targetPane.id,
            file.file_path,
            position,
          );
        }
        return true;
      } catch (error) {
        patchWorkspace(tab.id, { error: String(error) });
        return false;
      } finally {
        patchWorkspace(tab.id, { loading: false });
      }
    },
    [tab.id, openFileInPane, patchWorkspace, revealEditorLocation],
  );

  const openFile = useCallback(
    async (filePath: string) => {
      const current = useEditorStore.getState().workspaces[tab.id];
      await openFileAtPane(current.focusedPaneId, filePath);
    },
    [tab.id, openFileAtPane],
  );

  const selectOpenBuffer = useCallback(
    (bufferId: string) => {
      const state = useEditorStore.getState();
      const currentWorkspace = state.workspaces[tab.id];
      const buffer = state.buffers[bufferId];
      if (!currentWorkspace || !buffer) return;
      const focused = leafById(
        currentWorkspace.layout,
        currentWorkspace.focusedPaneId,
      );
      const target =
        focused?.detachedWindowId === null
          ? focused
          : getAttachedEditorPanes(currentWorkspace.layout)[0];
      if (!target) return;
      openFileInPane(tab.id, target.id, {
        file_path: buffer.file_path,
        content: buffer.content,
        language: buffer.language,
      });
    },
    [openFileInPane, tab.id],
  );

  const closeOpenBuffer = useCallback(
    async (bufferId: string) => {
      const state = useEditorStore.getState();
      const buffer = state.buffers[bufferId];
      const currentWorkspace = state.workspaces[tab.id];
      if (!buffer || !currentWorkspace || !confirmEditorBufferClose(buffer)) {
        return;
      }

      const detachedPanes = getEditorPaneLeaves(currentWorkspace.layout).filter(
        (pane) => pane.bufferId === bufferId && pane.detachedWindowId !== null,
      );
      for (const pane of detachedPanes) {
        try {
          await editorDetachedWindowClose(pane.detachedWindowId!);
        } catch (error) {
          patchWorkspace(tab.id, { error: String(error) });
        } finally {
          reattachPane(tab.id, pane.id);
        }
      }
      closeBuffer(tab.id, bufferId);
    },
    [closeBuffer, patchWorkspace, reattachPane, tab.id],
  );

  const selectWorkspaceFolder = useCallback(async () => {
    patchWorkspace(tab.id, { loading: true, error: null });
    try {
      const selected = await pickWorkspaceFolder(
        useEditorStore.getState().workspaces[tab.id]?.root_path ?? null,
      );
      if (!selected) return;
      setFileTree(tab.id, [], selected);
      patchWorkspace(tab.id, { explorer_open: true });
    } catch (error) {
      patchWorkspace(tab.id, { error: String(error) });
    } finally {
      patchWorkspace(tab.id, { loading: false });
    }
  }, [patchWorkspace, setFileTree, tab.id]);

  const startDebugging = useCallback(async () => {
    const state = useEditorStore.getState();
    const currentWorkspace = state.workspaces[tab.id];
    const pane =
      leafById(currentWorkspace.layout, currentWorkspace.focusedPaneId) ??
      getAttachedEditorPanes(currentWorkspace.layout)[0];
    const buffer = pane ? state.buffers[pane.bufferId] : undefined;
    if (
      mode !== "zed" ||
      !currentWorkspace.root_path ||
      !buffer?.file_path ||
      buffer.language.trim().toLowerCase() !== "python"
    ) {
      return;
    }
    if (buffer.is_dirty && !(await saveBuffer(buffer.id))) return;
    setShowTerminal(false);
    setShowDebug(true);
    await debug.start({
      tabId: tab.id,
      workspaceRoot: currentWorkspace.root_path,
      program: buffer.file_path,
    });
  }, [debug.start, mode, saveBuffer, tab.id]);

  const continueOrStartDebugging = useCallback(async () => {
    if (debug.status === "paused") {
      await debug.continueExecution();
      return;
    }
    if (
      debug.status === "idle" ||
      debug.status === "stopped" ||
      debug.status === "error"
    ) {
      await startDebugging();
    }
  }, [debug.continueExecution, debug.status, startDebugging]);

  const toggleCurrentBreakpoint = useCallback(async () => {
    const state = useEditorStore.getState();
    const currentWorkspace = state.workspaces[tab.id];
    const pane =
      leafById(currentWorkspace.layout, currentWorkspace.focusedPaneId) ??
      getAttachedEditorPanes(currentWorkspace.layout)[0];
    const buffer = pane ? state.buffers[pane.bufferId] : undefined;
    if (
      mode !== "zed" ||
      !currentWorkspace.root_path ||
      !buffer?.file_path ||
      buffer.language.trim().toLowerCase() !== "python"
    ) {
      return;
    }
    const line =
      editorRefs.current.get(pane.id)?.getPosition()?.lineNumber ??
      pane.cursor_position.line;
    try {
      const current = await dapBreakpointsGet(
        tab.id,
        currentWorkspace.root_path,
        buffer.file_path,
      );
      const lines = new Set(
        current.breakpoints.map((breakpoint) => breakpoint.line),
      );
      if (lines.has(line)) lines.delete(line);
      else lines.add(line);
      await dapBreakpointsSet(
        tab.id,
        currentWorkspace.root_path,
        buffer.file_path,
        [...lines].sort((left, right) => left - right),
      );
    } catch (breakpointError) {
      patchWorkspace(tab.id, { error: String(breakpointError) });
    }
  }, [mode, patchWorkspace, tab.id]);

  const revealDebugFrame = useCallback(
    async (frame: DapStackFrame) => {
      const filePath = frame.source?.path;
      if (!filePath) return;
      const current = useEditorStore.getState().workspaces[tab.id];
      if (
        !current.root_path ||
        !pathIsWithinWorkspace(filePath, current.root_path)
      ) {
        patchWorkspace(tab.id, {
          error: "Debug stack frame is outside the open workspace",
        });
        return;
      }
      const focused = leafById(current.layout, current.focusedPaneId);
      const target =
        focused?.detachedWindowId === null
          ? focused
          : getAttachedEditorPanes(current.layout)[0];
      if (!target) return;
      await openFileAtPane(target.id, filePath, {
        line: frame.line,
        column: frame.column,
      });
    },
    [openFileAtPane, patchWorkspace, tab.id],
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
          state.workspaces[tab.id].root_path,
        );
        markPaneDetached(tab.id, pane.id, info.windowId);
      } catch (error) {
        patchWorkspace(tab.id, { error: String(error) });
      } finally {
        patchWorkspace(tab.id, { loading: false });
      }
    },
    [mode, tab.id, ensureBufferSync, markPaneDetached, patchWorkspace],
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
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<EditorLspOpenLocation>(
      EDITOR_LSP_OPEN_LOCATION_EVENT,
      (event) => {
        if (disposed || event.payload.tabId !== tab.id) return;
        const filePath = fileUriToPath(event.payload.uri);
        if (!filePath) return;
        const current = useEditorStore.getState().workspaces[tab.id];
        const focused = leafById(current.layout, current.focusedPaneId);
        const target =
          focused?.detachedWindowId === null
            ? focused
            : getAttachedEditorPanes(current.layout)[0];
        if (target) {
          void openFileAtPane(target.id, filePath, event.payload.position);
        }
      },
    )
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((listenError) => {
        if (!disposed) patchWorkspace(tab.id, { error: String(listenError) });
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tab.id, openFileAtPane, patchWorkspace]);

  useEffect(() => {
    const openSymbols = (event: Event) => {
      const source = (event as CustomEvent<{ source?: Node }>).detail?.source;
      if (source && editorTabRef.current?.contains(source)) {
        setShowSymbolSearch(true);
      }
    };
    window.addEventListener(EDITOR_WORKSPACE_SYMBOL_SEARCH_EVENT, openSymbols);
    return () =>
      window.removeEventListener(
        EDITOR_WORKSPACE_SYMBOL_SEARCH_EVENT,
        openSymbols,
      );
  }, []);

  useEffect(() => {
    if (mode !== "zed") setShowDebug(false);
  }, [mode]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.target instanceof Node &&
        !editorTabRef.current?.contains(event.target)
      ) {
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      const ownsDebugKeys =
        mode === "zed" && (pythonDebuggable || debug.session !== null);
      if (ownsDebugKeys && event.key === "F9") {
        event.preventDefault();
        void toggleCurrentBreakpoint();
      } else if (ownsDebugKeys && event.key === "F10") {
        event.preventDefault();
        if (debug.status === "paused") void debug.stepOver();
      } else if (ownsDebugKeys && event.key === "F11") {
        event.preventDefault();
        if (debug.status === "paused") {
          if (event.shiftKey) void debug.stepOut();
          else void debug.stepInto();
        }
      } else if (
        ownsDebugKeys &&
        event.key === "F5" &&
        meta &&
        event.shiftKey
      ) {
        event.preventDefault();
        setShowTerminal(false);
        setShowDebug(true);
        void debug.restart();
      } else if (ownsDebugKeys && event.key === "F5" && event.shiftKey) {
        event.preventDefault();
        void debug.stop();
      } else if (ownsDebugKeys && event.key === "F5") {
        event.preventDefault();
        setShowTerminal(false);
        setShowDebug(true);
        void continueOrStartDebugging();
      } else if (
        mode === "zed" &&
        meta &&
        !event.shiftKey &&
        (event.key === "t" || event.key === "T")
      ) {
        event.preventDefault();
        setShowSymbolSearch((value) => !value);
      } else if (isGitPanelToggleShortcut(event, mode)) {
        event.preventDefault();
        gitPanel.setOpen(!gitPanel.preferences.open);
      } else if (
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
        setShowDebug(false);
        setTerminalMode("opencode");
        setShowTerminal((value) =>
          terminalMode === "opencode" ? !value : true,
        );
      } else if (meta && !event.shiftKey && event.key === "`") {
        event.preventDefault();
        setShowDebug(false);
        setTerminalMode("shell");
        setShowTerminal((value) => (terminalMode === "shell" ? !value : true));
      } else if (
        event.key === "Escape" &&
        (showFind ||
          showWorkspaceFind ||
          showSettings ||
          showSymbolSearch ||
          gitDiffReview)
      ) {
        event.preventDefault();
        setShowFind(false);
        setShowWorkspaceFind(false);
        setShowSettings(false);
        setShowSymbolSearch(false);
        setGitDiffReview(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    tab.id,
    toggleExplorer,
    showFind,
    showWorkspaceFind,
    showSettings,
    showSymbolSearch,
    gitDiffReview,
    gitPanel.preferences.open,
    gitPanel.setOpen,
    terminalMode,
    mode,
    pythonDebuggable,
    debug.session,
    debug.restart,
    debug.stepInto,
    debug.stepOut,
    debug.stepOver,
    debug.stop,
    continueOrStartDebugging,
    toggleCurrentBreakpoint,
  ]);

  const classicPane = useMemo(
    () =>
      leafById(workspace.layout, workspace.focusedPaneId) ??
      getAttachedEditorPanes(workspace.layout)[0] ??
      getEditorPaneLeaves(workspace.layout)[0],
    [workspace.layout, workspace.focusedPaneId],
  );
  const focusedEditor = editorRefs.current.get(workspace.focusedPaneId) ?? null;
  const setCiscoPlatform = (value: string) => {
    if (!focusedBuffer) return;
    const platform: CiscoPlatform | null =
      value === "iosxe" || value === "nxos" ? value : null;
    patchBuffer(focusedBuffer.id, { cisco_platform: platform });
    syncClients.current
      .get(focusedBuffer.id)
      ?.queueLocal(
        focusedBuffer.content,
        focusedBuffer.language,
        platform,
        focusedBuffer.is_dirty,
      );
    if (!platform) setLatestCiscoLint(null);
  };
  const jumpToCiscoProblem = (line: number, column: number) => {
    const editor = focusedEditor;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  };
  const paneCallbacks = {
    onFocus: (paneId: string) => focusPane(tab.id, paneId),
    onSplit: (paneId: string, direction: "horizontal" | "vertical") =>
      splitPane(tab.id, paneId, direction),
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
        patchWorkspace(tab.id, { error: String(error) }),
      ),
    onChange: (bufferId: string, content: string) => {
      setBufferContent(bufferId, content);
      const buffer = useEditorStore.getState().buffers[bufferId];
      syncClients.current
        .get(bufferId)
        ?.queueLocal(content, buffer.language, buffer.cisco_platform, true);
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
      if (editorRefs.current.get(paneId) !== editor) {
        editorRefs.current.set(paneId, editor);
        setEditorReadyTick((value) => value + 1);
      }
    },
    onOpenResource: (
      paneId: string,
      uri: string,
      position: { line: number; column: number },
    ) => {
      const filePath = fileUriToPath(uri);
      return filePath
        ? openFileAtPane(paneId, filePath, position)
        : Promise.resolve(false);
    },
  };

  return (
    <div
      ref={editorTabRef}
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
          {focusedBuffer?.is_dirty && <span className="dirty-marker">●</span>}
        </div>
        <div className="editor-actions">
          <button
            type="button"
            onClick={() => void selectWorkspaceFolder()}
            title="Select Workspace Folder"
            aria-label="Select Workspace Folder"
            data-testid="editor-select-workspace"
          >
            📂
          </button>
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
          <select
            aria-label="Cisco editor mode"
            value={focusedBuffer?.cisco_platform ?? ""}
            disabled={!focusedBuffer}
            onChange={(event) => setCiscoPlatform(event.target.value)}
          >
            <option value="">Off</option>
            <option value="iosxe">IOS-XE</option>
            <option value="nxos">NX-OS</option>
          </select>
          <button
            onClick={() => setShowWorkspaceFind((value) => !value)}
            title="Workspace Search"
            aria-label="Workspace Search"
            data-testid="editor-workspace-find-button"
          >
            🔎
          </button>
          {mode === "zed" && (
            <button
              onClick={() => setShowSymbolSearch((value) => !value)}
              title="Go to Symbol in Project (Cmd+T)"
              data-testid="editor-symbol-search-button"
              disabled={
                !workspace.root_path ||
                !focusedBuffer ||
                !normalizeLspLanguage(focusedBuffer.language)
              }
            >
              ◇
            </button>
          )}
          {pythonDebuggable && (
            <div
              className="editor-debug-actions"
              data-testid="editor-debug-actions"
              role="group"
              aria-label="Python debug controls"
            >
              <button
                type="button"
                aria-label={
                  debug.status === "paused"
                    ? "Continue debugging"
                    : "Start debugging"
                }
                title={
                  debug.status === "paused"
                    ? "Continue (F5)"
                    : "Start Python Debugging (F5)"
                }
                disabled={
                  debug.status === "starting" || debug.status === "running"
                }
                onClick={() => {
                  setShowTerminal(false);
                  setShowDebug(true);
                  void continueOrStartDebugging();
                }}
              >
                ▶
              </button>
              <button
                type="button"
                aria-label="Pause debugging"
                title="Pause"
                disabled={debug.status !== "running"}
                onClick={() => void debug.pause()}
              >
                ⏸
              </button>
              <button
                type="button"
                aria-label="Step over"
                title="Step Over (F10)"
                disabled={debug.status !== "paused"}
                onClick={() => void debug.stepOver()}
              >
                ↷
              </button>
              <button
                type="button"
                aria-label="Step into"
                title="Step Into (F11)"
                disabled={debug.status !== "paused"}
                onClick={() => void debug.stepInto()}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label="Step out"
                title="Step Out (Shift+F11)"
                disabled={debug.status !== "paused"}
                onClick={() => void debug.stepOut()}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Restart debugging"
                title="Restart (Cmd/Ctrl+Shift+F5)"
                disabled={
                  debug.status === "idle" || debug.status === "starting"
                }
                onClick={() => void debug.restart()}
              >
                ↻
              </button>
              <button
                type="button"
                aria-label="Stop debugging"
                title="Stop (Shift+F5)"
                disabled={
                  debug.status === "idle" ||
                  debug.status === "stopped" ||
                  debug.status === "error"
                }
                onClick={() => void debug.stop()}
              >
                ■
              </button>
              <button
                type="button"
                aria-label="Toggle breakpoint"
                title="Toggle Breakpoint (F9)"
                onClick={() => void toggleCurrentBreakpoint()}
              >
                ●
              </button>
              <button
                type="button"
                aria-label="Toggle debug panel"
                title="Toggle Debug Panel"
                onClick={() => {
                  setShowTerminal(false);
                  setShowDebug((value) => !value);
                }}
              >
                🐞
              </button>
            </div>
          )}
          <button
            onClick={() => setShowSettings((value) => !value)}
            title="Editor Settings (Cmd+,)"
            data-testid="editor-settings-button"
          >
            ⚙
          </button>
          <button
            onClick={() => {
              setShowDebug(false);
              setTerminalMode("opencode");
              setShowTerminal((value) =>
                terminalMode === "opencode" ? !value : true,
              );
            }}
            title="opencode (Cmd+Shift+O)"
            data-testid="editor-opencode-button"
          >
            🤖
          </button>
          <button
            onClick={() => {
              setShowDebug(false);
              setTerminalMode("shell");
              setShowTerminal((value) =>
                terminalMode === "shell" ? !value : true,
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

      <EditorBufferTabs
        buffers={openBuffers}
        activeBufferId={focusedBuffer?.id ?? null}
        onSelect={selectOpenBuffer}
        onClose={(bufferId) => void closeOpenBuffer(bufferId)}
      />

      <EditorActionToolbar
        editor={focusedEditor}
        canSave={Boolean(
          focusedBuffer?.is_dirty && focusedBuffer.file_path && !workspace.loading,
        )}
        onSave={() => {
          if (focusedBuffer) void saveBuffer(focusedBuffer.id);
        }}
        onOpenWorkspace={() => void selectWorkspaceFolder()}
        onToggleExplorer={() => toggleExplorer(tab.id)}
        onFind={() => setShowFind((value) => !value)}
        onWorkspaceFind={() => setShowWorkspaceFind((value) => !value)}
        onGoToSymbol={
          mode === "zed" &&
          workspace.root_path &&
          focusedBuffer &&
          normalizeLspLanguage(focusedBuffer.language)
            ? () => setShowSymbolSearch((value) => !value)
            : undefined
        }
        onSettings={() => setShowSettings((value) => !value)}
        onSplitRight={
          mode === "zed" && focusedPane?.detachedWindowId === null
            ? () => splitPane(tab.id, focusedPane.id, "horizontal")
            : undefined
        }
        onSplitDown={
          mode === "zed" && focusedPane?.detachedWindowId === null
            ? () => splitPane(tab.id, focusedPane.id, "vertical")
            : undefined
        }
        onDetach={
          mode === "zed" && focusedPane?.detachedWindowId === null
            ? () => void detachPane(focusedPane.id)
            : undefined
        }
        onProblems={focusedBuffer?.cisco_platform ? () => {} : undefined}
        onTerminal={() => {
          setShowDebug(false);
          setTerminalMode("shell");
          setShowTerminal((value) => (terminalMode === "shell" ? !value : true));
        }}
        onAssistant={() => {
          setShowDebug(false);
          setTerminalMode("opencode");
          setShowTerminal((value) =>
            terminalMode === "opencode" ? !value : true,
          );
        }}
      />

      <div className="editor-main">
        {workspace.explorer_open && (
          <FileExplorer
            rootPath={workspace.root_path}
            refreshKey={fileExplorerRefreshKey}
            expandedDirs={workspace.expanded_dirs}
            onSelectFile={openFile}
            onToggleDir={(dirPath) => toggleDirectory(tab.id, dirPath)}
            onSelectWorkspace={() => void selectWorkspaceFolder()}
            gitStatus={workspace.is_git_repo ? workspace.git_status : undefined}
          />
        )}
        <div className="editor-content">
          <div className="editor-canvas">
            {mode === "zed" && gitDiffReview ? (
              <GitDiffReview
                path={gitDiffReview.path}
                payload={gitDiffReview.payload}
                style={gitPanel.preferences.diffStyle}
                onStyleChange={gitPanel.setDiffStyle}
                onClose={() => setGitDiffReview(null)}
              />
            ) : mode === "zed" ? (
              <EditorSplitTree
                node={workspace.layout}
                buffers={buffers}
                tabId={tab.id}
                rootPath={workspace.root_path}
                focusedPaneId={workspace.focusedPaneId}
                ciscoDiagnostics={activeCiscoLint?.diagnostics}
                ciscoGuardrailStatus={activeCiscoLint?.guardrails}
                onCiscoLintResult={onCiscoLintResult}
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
                  ciscoPlatform={focusedBuffer?.cisco_platform ?? null}
                  ciscoDiagnostics={activeCiscoLint?.diagnostics}
                  ciscoGuardrailStatus={activeCiscoLint?.guardrails}
                  onCiscoLintResult={onCiscoLintResult}
                  settings={settings}
                  onFocus={() => focusPane(tab.id, classicPane.id)}
                  onSplit={() => {}}
                  onDetach={() => {}}
                  onClose={() => {}}
                  onReattach={() => {}}
                  onFocusWindow={() => {}}
                  onChange={(content) =>
                    paneCallbacks.onChange(classicPane.bufferId, content)
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
                    if (editorRefs.current.get(classicPane.id) !== editor) {
                      editorRefs.current.set(classicPane.id, editor);
                      setEditorReadyTick((value) => value + 1);
                    }
                  }}
                  onOpenResource={(uri, position) =>
                    paneCallbacks.onOpenResource(classicPane.id, uri, position)
                  }
                />
              )
            )}
            {!gitDiffReview && showFind && (
              <FindReplace
                editor={focusedEditor}
                onClose={() => setShowFind(false)}
              />
            )}
            {!gitDiffReview && showWorkspaceFind && (
              <WorkspaceFind
                rootPath={workspace.root_path}
                onClose={() => setShowWorkspaceFind(false)}
                onOpenResult={async (filePath, position) => {
                  const current =
                    useEditorStore.getState().workspaces[tab.id];
                  const focused = leafById(
                    current.layout,
                    current.focusedPaneId,
                  );
                  const target =
                    focused?.detachedWindowId === null
                      ? focused
                      : getAttachedEditorPanes(current.layout)[0];
                  return target
                    ? openFileAtPane(target.id, filePath, position)
                    : false;
                }}
              />
            )}
            {showSettings && (
              <EditorSettingsPanel
                settings={settings}
                onSave={setSettings}
                onClose={() => setShowSettings(false)}
              />
            )}
            <WorkspaceSymbolSearch
              open={mode === "zed" && showSymbolSearch}
              language={focusedBuffer?.language ?? "plaintext"}
              workspaceRoot={workspace.root_path}
              onClose={() => setShowSymbolSearch(false)}
              onSelect={async (symbol: WorkspaceSymbolResult) => {
                const current = useEditorStore.getState().workspaces[tab.id];
                const focused = leafById(current.layout, current.focusedPaneId);
                const target =
                  focused?.detachedWindowId === null
                    ? focused
                    : getAttachedEditorPanes(current.layout)[0];
                if (!target) return;
                await openFileAtPane(target.id, symbol.filePath, {
                  line: symbol.range.start.line + 1,
                  column: symbol.range.start.character + 1,
                });
              }}
            />
          </div>
          {focusedBuffer?.cisco_platform && (
            <ProblemsPanel
              diagnostics={activeCiscoLint?.diagnostics ?? []}
              statuses={ciscoProblemStatuses}
              onJumpTo={jumpToCiscoProblem}
            />
          )}
        </div>
        {mode === "zed" && gitPanel.preferences.open && (
          <GitPanel
            controller={gitPanel}
            workspaceRoot={workspace.root_path ?? ""}
            focusedFile={focusedBuffer?.file_path ?? null}
            getBufferContents={(absolutePath) => {
              const normalizedTarget = absolutePath.replace(/\\/g, "/");
              return Object.values(useEditorStore.getState().buffers).find(
                (buffer) =>
                  buffer.file_path?.replace(/\\/g, "/") === normalizedTarget,
              )?.content;
            }}
            onOpenDiff={(review) => setGitDiffReview(review)}
            onOpenWorkspace={(root) => {
              setFileTree(tab.id, [], root);
              patchWorkspace(tab.id, { explorer_open: true });
              setGitDiffReview(null);
            }}
            onRepositoryChanged={() => {
              setFileExplorerRefreshKey((current) => current + 1);
              void refreshGitSummary();
              if (workspace.root_path) {
                void gitGetStatus(workspace.root_path)
                  .then((status) => setGitStatus(tab.id, status, true))
                  .catch(() => undefined);
              }
            }}
          />
        )}
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

      {mode === "zed" && showDebug && (
        <DebugPanel
          controller={debug}
          onClose={() => setShowDebug(false)}
          onFrameSelect={revealDebugFrame}
        />
      )}

      {workspace.error && (
        <div className="error-banner" data-testid="editor-error">
          {workspace.error}
        </div>
      )}

      <div className="editor-status-bar">
        {mode === "zed" && (
          <GitStatusIndicator
            summary={gitSummary}
            bufferDirty={focusedBuffer?.is_dirty}
            panelOpen={gitPanel.preferences.open}
            onToggle={() => gitPanel.setOpen(!gitPanel.preferences.open)}
          />
        )}
        <span>{focusedBuffer?.sync_status ?? "local"}</span>
        {mode === "zed" && debug.status !== "idle" && (
          <span
            className={`editor-debug-status editor-debug-status--${debug.status}`}
            data-testid="editor-debug-status"
          >
            Debug: {debug.status}
          </span>
        )}
        <span>
          Ln {focusedPane?.cursor_position.line ?? 1}, Col{" "}
          {focusedPane?.cursor_position.column ?? 1}
        </span>
        <span>{focusedBuffer?.language ?? "plaintext"}</span>
      </div>
    </div>
  );
}

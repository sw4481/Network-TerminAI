import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EditorBufferState } from "../../state/editorStore";
import {
  editorDetachedWindowClose,
  editorDetachedWindowGetCurrent,
  editorSaveFile,
  editorSourceWindowFocus,
  DAP_EVENT,
  dapSessionForTab,
  type DapEventEnvelope,
  type DapSessionStatus,
  type DetachedEditorWindowInfo,
  type EditorBufferSnapshot,
} from "../../lib/tauri";
import { useEditorSettings } from "../../hooks/useEditorSettings";
import { useCiscoLint } from "../../hooks/useCiscoLint";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { EditorBufferSyncClient } from "./editorBufferSync";
import { EditorPane } from "./EditorPane";
import { useZedMode } from "./ZedModeProvider";
import { useAppearance } from "../../theme/AppearanceProvider";
import { resolveMonacoTheme } from "../../theme/monacoThemes";
import {
  installAppShutdownResponder,
  registerAppShutdownTask,
} from "../../lib/appShutdown";
import type { EditorPaneLeaf } from "./editorPaneLayout";
import { GitStatusIndicator } from "./GitStatusIndicator";
import { useGitRepositorySummary } from "./useGitRepositorySummary";
import {
  EDITOR_LSP_OPEN_LOCATION_EVENT,
  fileUriToPath,
  pathIsWithinWorkspace,
  type EditorLspOpenLocation,
} from "./lsp/locationRouting";
import "./DetachedEditorWindow.css";

function bufferFromSnapshot(
  snapshot: EditorBufferSnapshot,
  syncStatus: EditorBufferState["sync_status"] = "synced",
): EditorBufferState {
  return {
    id: snapshot.bufferId,
    file_path: snapshot.filePath,
    content: snapshot.content,
    language: snapshot.language,
    cisco_platform: snapshot.ciscoPlatform,
    is_dirty: snapshot.dirty,
    revision: snapshot.revision,
    sync_status: syncStatus,
    error: null,
  };
}

export function DetachedEditorWindow() {
  const { settings } = useEditorSettings();
  const { mode, hydrated } = useZedMode();
  const {
    settings: appearanceSettings,
    authoritativeState,
    error: appearanceError,
    retryAuthoritativeSettings,
  } = useAppearance();
  const [metadata, setMetadata] = useState<DetachedEditorWindowInfo | null>(
    null,
  );
  const [buffer, setBuffer] = useState<EditorBufferState | null>(null);
  const bufferRef = useRef<EditorBufferState | null>(null);
  const [view, setView] = useState({
    cursor_position: { line: 1, column: 1 },
    scroll_position: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [debugStatus, setDebugStatus] =
    useState<DapSessionStatus | null>(null);
  const clientRef = useRef<EditorBufferSyncClient | null>(null);
  const clientReadyRef = useRef<Promise<void> | null>(null);
  const closingRef = useRef(false);
  const sourceIdRef = useRef(
    `editor-detached:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  );
  bufferRef.current = buffer;
  const {
    summary: gitSummary,
    refresh: refreshGitSummary,
  } = useGitRepositorySummary(buffer?.file_path ?? null, mode === "zed");
  const ciscoLint = useCiscoLint({
    content: buffer?.content ?? "",
    platform: buffer?.cisco_platform ?? null,
  });

  useEffect(() => {
    let disposed = false;
    let client: EditorBufferSyncClient | null = null;

    const ready = (async () => {
      const current = await editorDetachedWindowGetCurrent();
      if (disposed) return;
      setMetadata(current);

      client = new EditorBufferSyncClient({
        bufferId: current.bufferId,
        sourceId: sourceIdRef.current,
        onSnapshot: (snapshot) => {
          if (!disposed) {
            setBuffer(bufferFromSnapshot(snapshot));
            setError(null);
          }
        },
        onRevision: (snapshot) => {
          if (!disposed) {
            setBuffer((existing) =>
              existing
                ? { ...existing, revision: snapshot.revision }
                : existing,
            );
          }
        },
        onStatus: (sync_status, syncError) => {
          if (disposed) return;
          setBuffer((existing) =>
            existing
              ? {
                  ...existing,
                  sync_status,
                  error: syncError ?? null,
                }
              : existing,
          );
          if (syncError) setError(syncError);
        },
      });
      clientRef.current = client;
      await client.start({
        bufferId: current.bufferId,
        filePath: null,
        content: "",
        language: "plaintext",
        ciscoPlatform: null,
        dirty: false,
        sourceId: sourceIdRef.current,
      });
    })();
    clientReadyRef.current = ready;
    void ready.catch((loadError) => {
      if (!disposed) setError(String(loadError));
    });

    return () => {
      disposed = true;
      client?.dispose();
      if (clientRef.current === client) clientRef.current = null;
      if (clientReadyRef.current === ready) clientReadyRef.current = null;
    };
  }, []);

  useEffect(
    () =>
      registerAppShutdownTask(
        `editor-detached:${sourceIdRef.current}`,
        async () => {
          const ready = clientReadyRef.current;
          if (!ready) throw new Error("detached editor buffer is not ready");
          await ready;
          const client = clientRef.current;
          if (!client) throw new Error("detached editor sync client is unavailable");
          await client.flushNow();
        },
      ),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void installAppShutdownResponder()
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((listenError) => {
        if (!disposed) setError(String(listenError));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const closeDetachedWindow = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    try {
      await clientRef.current?.flushNow();
      if (metadata) {
        await editorDetachedWindowClose(metadata.windowId);
      } else {
        await getCurrentWindow().close();
      }
    } catch (closeError) {
      closingRef.current = false;
      setError(String(closeError));
    }
  }, [metadata]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (disposed || closingRef.current) return;
        event.preventDefault();
        await closeDetachedWindow();
      })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((closeListenError) => {
        if (!disposed) setError(String(closeListenError));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [closeDetachedWindow]);

  useEffect(() => {
    if (hydrated && mode === "monaco") {
      void closeDetachedWindow();
    }
  }, [hydrated, mode, closeDetachedWindow]);

  useEffect(() => {
    if (!metadata || mode !== "zed") {
      setDebugStatus(null);
      return;
    }
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void dapSessionForTab(metadata.tabId)
      .then((session) => {
        if (!disposed) setDebugStatus(session?.status ?? null);
      })
      .catch(() => {});
    void listen<DapEventEnvelope>(DAP_EVENT, (event) => {
      if (disposed || event.payload.tabId !== metadata.tabId) return;
      switch (event.payload.event) {
        case "stopped":
          setDebugStatus("paused");
          break;
        case "process":
        case "continued":
          setDebugStatus("running");
          break;
        case "exited":
        case "terminated":
          setDebugStatus("stopped");
          break;
        case "adapterError":
          setDebugStatus("error");
          break;
        default:
          break;
      }
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [metadata, mode]);

  const save = useCallback(async () => {
    const current = bufferRef.current;
    const client = clientRef.current;
    if (!metadata || !current?.file_path || !client || saving) return;
    setSaving(true);
    setError(null);
    try {
      const synchronized = await client.flushNow();
      await editorSaveFile(
        metadata.tabId,
        current.file_path,
        synchronized.content,
      );
      await client.markSaved(synchronized.revision);
      await refreshGitSummary();
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }, [metadata, saving, refreshGitSummary]);

  if (!metadata || !buffer) {
    return (
      <main className="detached-editor-state">
        {error ? (
          <>
            <div role="alert">{error}</div>
            <button type="button" onClick={() => void closeDetachedWindow()}>
              Close Window
            </button>
          </>
        ) : (
          <span>Loading detached editor…</span>
        )}
      </main>
    );
  }

  // Do not create a detached Monaco editor from a transient default. The
  // provider applies the mirrored app theme before React and waits here for
  // the validated cross-window snapshot before the pane becomes interactive.
  if (authoritativeState === "pending") {
    return <main className="detached-editor-state">Loading editor appearance…</main>;
  }
  if (authoritativeState === "failed") {
    return (
      <main className="detached-editor-state">
        <div role="alert">Unable to load editor appearance: {appearanceError ?? "unknown error"}</div>
        <button type="button" onClick={() => void retryAuthoritativeSettings().catch(() => {})}>
          Retry appearance
        </button>
      </main>
    );
  }
  if (!hydrated) {
    return <main className="detached-editor-state">Loading editor mode…</main>;
  }

  const pane: EditorPaneLeaf = {
    type: "leaf",
    id: metadata.paneId,
    size: 100,
    bufferId: buffer.id,
    detachedWindowId: null,
    ...view,
  };

  return (
    <main
      className="detached-editor-window"
      data-testid="detached-editor-window"
      data-editor-theme={resolveMonacoTheme(appearanceSettings, mode)}
    >
      <header className="detached-editor-toolbar">
        <div className="detached-editor-title">
          <strong>{metadata.title}</strong>
          {buffer.is_dirty && <span aria-label="Unsaved changes">●</span>}
        </div>
        <div className="detached-editor-actions">
          <button
            type="button"
            onClick={() =>
              void editorSourceWindowFocus().catch((focusError) =>
                setError(String(focusError)),
              )
            }
          >
            Focus Source
          </button>
          <button
            type="button"
            disabled={!buffer.file_path || !buffer.is_dirty || saving}
            onClick={() => void save()}
          >
            Save
          </button>
          <button type="button" onClick={() => void closeDetachedWindow()}>
            Bring Back
          </button>
          <button
            type="button"
            aria-label="Close detached editor"
            onClick={() => void closeDetachedWindow()}
          >
            ×
          </button>
        </div>
      </header>

      {buffer.file_path && (
        <EditorBreadcrumbs
          filePath={buffer.file_path}
          rootPath={metadata.workspaceRoot}
        />
      )}

      <div className="detached-editor-canvas">
        <EditorPane
          tabId={metadata.tabId}
          pane={pane}
          buffer={buffer}
          rootPath={metadata.workspaceRoot}
          focused
          showControls={false}
          canClose={false}
          ciscoPlatform={buffer.cisco_platform}
          ciscoDiagnostics={ciscoLint.diagnostics}
          ciscoGuardrailStatus={ciscoLint.guardrails}
          settings={settings}
          onFocus={() => {}}
          onSplit={() => {}}
          onDetach={() => {}}
          onClose={() => void closeDetachedWindow()}
          onReattach={() => void closeDetachedWindow()}
          onFocusWindow={() => {}}
          onChange={(content) => {
            setBuffer((current) =>
              current
                ? {
                    ...current,
                    content,
                    is_dirty: true,
                    sync_status: "local",
                  }
                : current,
            );
            clientRef.current?.queueLocal(
              content,
              buffer.language,
              buffer.cisco_platform,
              true,
            );
          }}
          onCursorChange={(cursor_position) =>
            setView((current) => ({ ...current, cursor_position }))
          }
          onScrollChange={(scroll_position) =>
            setView((current) => ({ ...current, scroll_position }))
          }
          onSave={() => void save()}
          onEditorReady={() => {}}
          onOpenResource={async (uri, position) => {
            const filePath = fileUriToPath(uri);
            if (
              !filePath ||
              !metadata.workspaceRoot ||
              !pathIsWithinWorkspace(filePath, metadata.workspaceRoot)
            ) {
              return false;
            }
            const payload: EditorLspOpenLocation = {
              tabId: metadata.tabId,
              uri,
              position,
            };
            await emit(EDITOR_LSP_OPEN_LOCATION_EVENT, payload);
            await editorSourceWindowFocus();
            return true;
          }}
        />
      </div>

      {error && (
        <div className="detached-editor-error" role="alert">
          {error}
        </div>
      )}
      <footer className="detached-editor-status">
        {mode === "zed" && (
          <GitStatusIndicator
            summary={gitSummary}
            bufferDirty={buffer.is_dirty}
          />
        )}
        <span>{buffer.sync_status}</span>
        {mode === "zed" &&
          buffer.language.trim().toLowerCase() === "python" &&
          debugStatus && <span>Debug: {debugStatus}</span>}
        <span>
          Ln {view.cursor_position.line}, Col {view.cursor_position.column}
        </span>
        <span>{buffer.language}</span>
      </footer>
    </main>
  );
}

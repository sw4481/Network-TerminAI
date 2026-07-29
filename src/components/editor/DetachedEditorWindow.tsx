import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { EditorBufferState } from "../../state/editorStore";
import {
  editorDetachedWindowClose,
  editorDetachedWindowGetCurrent,
  editorSaveFile,
  editorSourceWindowFocus,
  type DetachedEditorWindowInfo,
  type EditorBufferSnapshot,
} from "../../lib/tauri";
import { useEditorSettings } from "../../hooks/useEditorSettings";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { EditorBufferSyncClient } from "./editorBufferSync";
import { EditorPane } from "./EditorPane";
import { useZedMode } from "./ZedModeProvider";
import type { EditorPaneLeaf } from "./editorPaneLayout";
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
    is_dirty: snapshot.dirty,
    revision: snapshot.revision,
    sync_status: syncStatus,
    error: null,
  };
}

export function DetachedEditorWindow() {
  const { settings } = useEditorSettings();
  const { mode, hydrated } = useZedMode();
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
  const clientRef = useRef<EditorBufferSyncClient | null>(null);
  const closingRef = useRef(false);
  const sourceIdRef = useRef(
    `editor-detached:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  );
  bufferRef.current = buffer;

  useEffect(() => {
    let disposed = false;
    let client: EditorBufferSyncClient | null = null;

    void (async () => {
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
        dirty: false,
        sourceId: sourceIdRef.current,
      });
    })().catch((loadError) => {
      if (!disposed) setError(String(loadError));
    });

    return () => {
      disposed = true;
      client?.dispose();
      if (clientRef.current === client) clientRef.current = null;
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
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }, [metadata, saving]);

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
        <EditorBreadcrumbs filePath={buffer.file_path} rootPath={null} />
      )}

      <div className="detached-editor-canvas">
        <EditorPane
          tabId={metadata.tabId}
          pane={pane}
          buffer={buffer}
          rootPath={null}
          focused
          showControls={false}
          canClose={false}
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
            clientRef.current?.queueLocal(content, buffer.language, true);
          }}
          onCursorChange={(cursor_position) =>
            setView((current) => ({ ...current, cursor_position }))
          }
          onScrollChange={(scroll_position) =>
            setView((current) => ({ ...current, scroll_position }))
          }
          onSave={() => void save()}
          onEditorReady={() => {}}
        />
      </div>

      {error && (
        <div className="detached-editor-error" role="alert">
          {error}
        </div>
      )}
      <footer className="detached-editor-status">
        <span>{buffer.sync_status}</span>
        <span>
          Ln {view.cursor_position.line}, Col {view.cursor_position.column}
        </span>
        <span>{buffer.language}</span>
      </footer>
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { Tab } from "../../lib/types";
import {
  editorOpenFile,
  editorSaveFile,
  editorGetState,
  editorGetHomeDirectory,
  gitIsRepo,
  gitGetStatus,
} from "../../lib/tauri";
import { useEditorStore } from "../../state/editorStore";
import { MonacoEditor } from "./MonacoEditor";
import { FileExplorer } from "./FileExplorer";
import { FindReplace } from "./FindReplace";
import { EditorSettingsPanel } from "./EditorSettings";
import { EditorTerminalPanel, type EditorTerminalMode } from "./EditorTerminalPanel";
import { useEditorSettings } from "../../hooks/useEditorSettings";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { useZedMode } from "./ZedModeProvider";
import "./EditorTab.css";

export function EditorTab({ tab }: { tab: Tab }) {
  const ensure = useEditorStore((s) => s.ensure);
  const state = useEditorStore((s) => s.tabs[tab.id]) ?? ensure(tab.id);
  const patch = useEditorStore((s) => s.patch);
  const setContent = useEditorStore((s) => s.setContent);
  const setDirty = useEditorStore((s) => s.setDirty);
  const setCursor = useEditorStore((s) => s.setCursor);
  const setFileTree = useEditorStore((s) => s.setFileTree);
  const toggleExplorer = useEditorStore((s) => s.toggleExplorer);
  const toggleDirectory = useEditorStore((s) => s.toggleDirectory);
  const setGitStatus = useEditorStore((s) => s.setGitStatus);

  const { settings, setSettings } = useEditorSettings();
  const { mode } = useZedMode();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const vimStatusRef = useRef<HTMLSpanElement | null>(null);
  const [showFind, setShowFind] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalMode, setTerminalMode] = useState<EditorTerminalMode>("opencode");

  // Load persisted state on mount
  useEffect(() => {
    editorGetState(tab.id)
      .then((file) => {
        if (file) {
          patch(tab.id, {
            file_path: file.file_path,
            content: file.content,
            language: file.language,
            is_dirty: false,
          });
        }
      })
      .catch(console.error);
  }, [tab.id, patch]);

  // Load home directory on mount if no root path set
  useEffect(() => {
    if (!state.root_path) {
      editorGetHomeDirectory()
        .then((homePath) => {
          setFileTree(tab.id, [], homePath);
        })
        .catch(console.error);
    }
  }, [tab.id, state.root_path, setFileTree]);

  // Detect git repo at root_path, then refresh status every 10s while it is one.
  useEffect(() => {
    const rootPath = state.root_path;
    if (!rootPath) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const refresh = () =>
      gitGetStatus(rootPath)
        .then((status) => {
          if (!cancelled) setGitStatus(tab.id, status, true);
        })
        .catch((err) => console.error("Failed to load git status:", err));

    gitIsRepo(rootPath)
      .then((isRepo) => {
        if (cancelled) return;
        if (!isRepo) {
          setGitStatus(tab.id, [], false);
          return;
        }
        void refresh();
        interval = setInterval(() => {
          void refresh();
        }, 10_000);
      })
      .catch((err) => {
        console.error("Failed to probe git repo:", err);
        if (!cancelled) setGitStatus(tab.id, [], false);
      });

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [tab.id, state.root_path, setGitStatus]);

  const onSave = useCallback(async () => {
    if (!state.file_path) {
      console.warn("No file path to save");
      return;
    }
    patch(tab.id, { loading: true, error: null });
    try {
      await editorSaveFile(tab.id, state.file_path, state.content);
      setDirty(tab.id, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(tab.id, { error: msg });
    } finally {
      patch(tab.id, { loading: false });
    }
  }, [state, tab.id, patch, setDirty]);

  // Global keybindings for this tab. Shortcuts:
  //   Cmd/Ctrl + Shift + F  → custom Find/Replace widget (Monaco keeps Cmd+F)
  //   Cmd/Ctrl + ,          → settings panel
  //   Cmd/Ctrl + Shift + E  → toggle file explorer
  //   Esc                   → close any open overlay
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setShowFind((v) => !v);
        return;
      }
      if (meta && e.key === ",") {
        e.preventDefault();
        setShowSettings((v) => !v);
        return;
      }
      if (meta && e.shiftKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        toggleExplorer(tab.id);
        return;
      }
      if (meta && e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        setTerminalMode("opencode");
        setShowTerminal((v) => (terminalMode === "opencode" ? !v : true));
        return;
      }
      if (meta && !e.shiftKey && e.key === "`") {
        e.preventDefault();
        setTerminalMode("shell");
        setShowTerminal((v) => (terminalMode === "shell" ? !v : true));
        return;
      }
      if (e.key === "Escape" && (showFind || showSettings)) {
        e.preventDefault();
        setShowFind(false);
        setShowSettings(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [tab.id, toggleExplorer, showFind, showSettings, terminalMode]);

  const onOpenFile = useCallback(
    async (filePath: string) => {
      patch(tab.id, { loading: true, error: null });
      try {
        const file = await editorOpenFile(tab.id, filePath);
        patch(tab.id, {
          file_path: file.file_path,
          content: file.content,
          language: file.language,
          is_dirty: false,
          loading: false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        patch(tab.id, { error: msg, loading: false });
      }
    },
    [tab.id, patch]
  );

  return (
    <div
      className="editor-tab"
      data-testid="editor-tab"
      data-editor-mode={mode}
    >
      <div className="editor-toolbar">
        <div className="editor-file-info">
          {state.file_path ? (
            <>
              <span className="file-name">{state.file_path.split("/").pop()}</span>
              <span className="file-path">{state.file_path}</span>
              {state.is_dirty && <span className="dirty-marker">●</span>}
            </>
          ) : (
            <span className="file-name">Untitled</span>
          )}
        </div>
        <div className="editor-actions">
          <button
            onClick={() => toggleExplorer(tab.id)}
            title="Toggle Explorer (Cmd+Shift+E)"
            data-testid="editor-toggle-explorer"
          >
            {state.explorer_open ? "◀" : "▶"}
          </button>
          <button
            onClick={() => setShowFind((v) => !v)}
            title="Find & Replace (Cmd+Shift+F)"
            data-testid="editor-find-button"
          >
            🔍
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            title="Editor Settings (Cmd+,)"
            data-testid="editor-settings-button"
          >
            ⚙
          </button>
          <button
            onClick={() => {
              setTerminalMode("opencode");
              setShowTerminal((v) => (terminalMode === "opencode" ? !v : true));
            }}
            title="opencode (Cmd+Shift+O)"
            data-testid="editor-opencode-button"
          >
            🤖
          </button>
          <button
            onClick={() => {
              setTerminalMode("shell");
              setShowTerminal((v) => (terminalMode === "shell" ? !v : true));
            }}
            title="Terminal — run claude / codex (Cmd+`)"
            data-testid="editor-terminal-button"
          >
            ⌨
          </button>
          <button
            onClick={onSave}
            disabled={!state.is_dirty || !state.file_path || state.loading}
            title="Save (Cmd+S)"
            data-testid="editor-save-button"
          >
            Save
          </button>
        </div>
      </div>

      <div className="editor-main">
        {state.explorer_open && (
          <FileExplorer
            rootPath={state.root_path}
            expandedDirs={state.expanded_dirs}
            onSelectFile={onOpenFile}
            onToggleDir={(dirPath) => toggleDirectory(tab.id, dirPath)}
            gitStatus={state.is_git_repo ? state.git_status : undefined}
          />
        )}
        <div className="editor-content">
          {mode === "zed" && state.file_path && (
            <EditorBreadcrumbs
              filePath={state.file_path}
              rootPath={state.root_path}
            />
          )}
          <div className="editor-canvas">
            <MonacoEditor
              value={state.content}
              language={state.language}
              onChange={(content) => setContent(tab.id, content)}
              onCursorChange={(pos) => setCursor(tab.id, pos.line, pos.column)}
              onSave={onSave}
              settings={settings}
              tabId={tab.id}
              filePath={state.file_path}
              vimStatusRef={vimStatusRef}
              onEditorReady={(editor) => {
                editorRef.current = editor;
              }}
            />
            {showFind && (
              <FindReplace
                editor={editorRef.current}
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
          cwd={state.root_path}
          mode={terminalMode}
          onModeChange={setTerminalMode}
          onClose={() => setShowTerminal(false)}
        />
      )}

      {state.error && (
        <div className="error-banner" data-testid="editor-error">
          {state.error}
        </div>
      )}

      <div className="editor-status-bar">
        <span
          ref={vimStatusRef}
          className="zed-vim-status"
          aria-live="polite"
        />
        <span>
          Ln {state.cursor_position.line}, Col {state.cursor_position.column}
        </span>
        <span>{state.language}</span>
      </div>
    </div>
  );
}

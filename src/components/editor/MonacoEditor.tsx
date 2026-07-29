import { useRef, useEffect, useState, type RefObject } from "react";
import type * as Monaco from "monaco-editor";
import { useLspClient } from "../../hooks/useLspClient";
import { registerCompletionProvider } from "./lsp/CompletionProvider";
import { registerHoverProvider } from "./lsp/HoverProvider";
import { registerHclLanguage } from "./lsp/hclLanguage";
import { dispatchAskAi, type AskAiAction } from "./askAi";
import { useZedMode } from "./ZedModeProvider";
import {
  applyEditorModeTheme,
  fontFamilyForEditorMode,
  themeForEditorMode,
} from "./themes/zed-one-dark";
import { installZedKeybindings } from "./zedKeybindings";
import { useVimMode } from "./useVimMode";
import {
  createEditorDisposalOwnership,
  type EditorDisposalOwnership,
} from "./monacoEditorOwnership";
import {
  getMonacoModelRegistry,
  MonacoPaneModelController,
  type MonacoModelLease,
} from "./monacoModelRegistry";
import "./MonacoEditor.css";

export type EditorSettings = {
  fontSize: number;
  tabSize: number;
  wordWrap: "on" | "off";
  minimap: boolean;
  lineNumbers: boolean;
  renderWhitespace: boolean;
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 14,
  tabSize: 2,
  wordWrap: "on",
  minimap: true,
  lineNumbers: true,
  renderWhitespace: false,
};

type MonacoEditorProps = {
  /** Logical buffer identity. Equal IDs share one model in this webview. */
  bufferId?: string;
  value: string;
  language: string;
  onChange: (value: string) => void;
  onCursorChange?: (position: { line: number; column: number }) => void;
  onScrollChange?: (scrollTop: number) => void;
  onSave?: () => void;
  readOnly?: boolean;
  enableLsp?: boolean;
  settings?: EditorSettings;
  onEditorReady?: (
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
  ) => void;
  /**
   * Tab ID used for routing "Ask AI" events to the right AgentPanel bucket.
   * When omitted, Ask-AI actions are not registered.
   */
  tabId?: string;
  /** Current file path; included as context in AI prompts. */
  filePath?: string | null;
  vimStatusRef?: RefObject<HTMLSpanElement | null>;
};

let monacoModule: typeof Monaco | null = null;
let monacoLoading: Promise<typeof Monaco> | null = null;

async function loadMonaco(): Promise<typeof Monaco> {
  if (monacoModule) return monacoModule;
  if (monacoLoading) return monacoLoading;

  monacoLoading = (async () => {
    const monaco = await import("monaco-editor");
    monacoModule = monaco;
    return monaco;
  })();

  return monacoLoading;
}

export function MonacoEditor({
  bufferId,
  value,
  language,
  onChange,
  onCursorChange,
  onScrollChange,
  onSave,
  readOnly = false,
  enableLsp = true,
  settings = DEFAULT_EDITOR_SETTINGS,
  onEditorReady,
  tabId,
  filePath = null,
  vimStatusRef,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorOwnershipRef = useRef<EditorDisposalOwnership | null>(null);
  const modelLeaseRef = useRef<MonacoModelLease | null>(null);
  const paneModelControllerRef = useRef<MonacoPaneModelController | null>(null);
  const [monaco, setMonaco] = useState<typeof Monaco | null>(null);
  const [editorInstance, setEditorInstance] =
    useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const fallbackVimStatusRef = useRef<HTMLSpanElement | null>(null);
  const activeVimStatusRef = vimStatusRef ?? fallbackVimStatusRef;
  const [error, setError] = useState<string | null>(null);
  const { mode, vimEnabled } = useZedMode();
  const fallbackBufferIdRef = useRef(
    `standalone:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  );
  const activeBufferId = bufferId ?? fallbackBufferIdRef.current;

  // Refs keep the latest values accessible from Monaco action callbacks,
  // which are registered once and persist for the editor lifetime.
  const tabIdRef = useRef<string | undefined>(tabId);
  const languageRef = useRef<string>(language);
  const filePathRef = useRef<string | null>(filePath);
  const bufferIdRef = useRef(activeBufferId);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const onScrollChangeRef = useRef(onScrollChange);
  const onSaveRef = useRef(onSave);
  const onEditorReadyRef = useRef(onEditorReady);
  tabIdRef.current = tabId;
  languageRef.current = language;
  filePathRef.current = filePath;
  bufferIdRef.current = activeBufferId;
  valueRef.current = value;
  onChangeRef.current = onChange;
  onCursorChangeRef.current = onCursorChange;
  onScrollChangeRef.current = onScrollChange;
  onSaveRef.current = onSave;
  onEditorReadyRef.current = onEditorReady;

  const { sendRequest, ready: lspReady } = useLspClient(language, enableLsp);

  useEffect(() => {
    loadMonaco()
      .then((m) => {
        registerHclLanguage(m);
        setMonaco(m);
      })
      .catch((e) => {
        console.error("Failed to load Monaco:", e);
        setError(String(e));
      });
  }, []);

  useEffect(() => {
    if (!monaco || !containerRef.current) return;
    if (editorRef.current) return;

    if (mode === "zed") {
      applyEditorModeTheme(monaco, mode);
    }

    const editorDisposables: Monaco.IDisposable[] = [];
    const registry = getMonacoModelRegistry(monaco);
    const modelLease = registry.acquire(
      bufferIdRef.current,
      valueRef.current,
      languageRef.current,
    );
    modelLeaseRef.current = modelLease;
    let editor: Monaco.editor.IStandaloneCodeEditor;
    try {
      editor = monaco.editor.create(containerRef.current, {
      model: modelLease.model,
      theme: themeForEditorMode(mode),
      fontSize: settings.fontSize,
      fontFamily: fontFamilyForEditorMode(mode),
      minimap: { enabled: settings.minimap },
      scrollBeyondLastLine: false,
      wordWrap: settings.wordWrap,
      automaticLayout: true,
      tabSize: settings.tabSize,
      insertSpaces: true,
      formatOnPaste: true,
      formatOnType: true,
      suggestOnTriggerCharacters: true,
      quickSuggestions: true,
      parameterHints: { enabled: true },
      folding: true,
      lineNumbers: settings.lineNumbers ? "on" : "off",
      renderWhitespace: settings.renderWhitespace ? "all" : "selection",
      readOnly,
      scrollbar: { vertical: "auto", horizontal: "auto" },
      });
    } catch (error) {
      modelLeaseRef.current = null;
      modelLease.release();
      throw error;
    }
    paneModelControllerRef.current = new MonacoPaneModelController(
      editor,
      bufferIdRef.current,
    );

    let ownership: EditorDisposalOwnership;
    ownership = createEditorDisposalOwnership(
      editor,
      () => editorDisposables.forEach((disposable) => disposable.dispose()),
      () => {
        const ownsCurrentEditor = editorRef.current === editor;
        if (ownsCurrentEditor) {
          editorRef.current = null;
          paneModelControllerRef.current?.clear();
          paneModelControllerRef.current = null;
          const currentLease = modelLeaseRef.current;
          modelLeaseRef.current = null;
          currentLease?.release();
        }
        if (editorOwnershipRef.current === ownership) {
          editorOwnershipRef.current = null;
        }
      },
    );
    editorRef.current = editor;
    editorOwnershipRef.current = ownership;
    onEditorReadyRef.current?.(editor, monaco);

    // "Ask AI" editor actions — appear in Monaco's native context menu and
    // via Cmd+L (for the custom Ask…). Each reads live values through refs
    // so actions always dispatch with the current tab/file/language.
    const registerAskAi = (
      id: AskAiAction,
      label: string,
      order: number,
      keybindings?: number[],
    ) => {
      const disposable = editor.addAction({
        id: `ccie.editor.askAi.${id}`,
        label,
        contextMenuGroupId: "1_askai",
        contextMenuOrder: order,
        keybindings,
        precondition: "editorHasSelection",
        run: (ed) => {
          const tid = tabIdRef.current;
          if (!tid) return;
          const selection = ed.getSelection();
          const model = ed.getModel();
          if (!selection || !model) return;
          const text = model.getValueInRange(selection);
          if (!text.trim()) return;
          dispatchAskAi({
            tabId: tid,
            action: id,
            selection: text,
            language: languageRef.current,
            filePath: filePathRef.current,
          });
        },
      });
      editorDisposables.push(disposable);
    };

    registerAskAi("explain", "✨ Ask AI: Explain", 1.1);
    registerAskAi("fix", "✨ Ask AI: Fix", 1.2);
    registerAskAi("refactor", "✨ Ask AI: Refactor", 1.3);
    registerAskAi("ask", "✨ Ask AI…", 1.4, [
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL,
    ]);

    const changeDisposable = editor.onDidChangeModelContent(() => {
      const lease = modelLeaseRef.current;
      if (
        lease &&
        !registry.isApplyingContent(lease.bufferId)
      ) {
        onChangeRef.current(editor.getValue());
      }
    });
    editorDisposables.push(changeDisposable);

    editorDisposables.push(
      editor.onDidChangeCursorPosition((e) => {
        onCursorChangeRef.current?.({
          line: e.position.lineNumber,
          column: e.position.column,
        });
      }),
    );
    editorDisposables.push(
      editor.onDidScrollChange((event) => {
        if (event.scrollTopChanged) {
          onScrollChangeRef.current?.(event.scrollTop);
        }
      }),
    );

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });

    editor.focus();
    setEditorInstance(editor);

    return () => ownership.disposeIfUnclaimed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco]);

  useEffect(() => {
    if (!editorInstance) return;
    const ownership = editorOwnershipRef.current;
    if (!ownership || ownership.editor !== editorInstance) return;
    return () => ownership.disposeRegistrations();
  }, [editorInstance]);

  useEffect(() => {
    if (!monaco || !editorInstance || mode !== "zed") return;
    const installed = installZedKeybindings(editorInstance, monaco);
    return () => installed.dispose();
  }, [monaco, editorInstance, mode]);

  useVimMode(
    editorInstance,
    activeVimStatusRef,
    mode === "zed" && vimEnabled,
  );

  useEffect(() => {
    if (!editorInstance) return;
    const ownership = editorOwnershipRef.current;
    if (!ownership || ownership.editor !== editorInstance) return;
    ownership.claimFinalOwner();
    return () => {
      ownership.disposeEditor();
    };
  }, [editorInstance]);

  useEffect(() => {
    if (!monaco) return;
    applyEditorModeTheme(monaco, mode);
  }, [monaco, mode]);

  useEffect(() => {
    if (!monaco || !editorInstance) return;
    const currentLease = modelLeaseRef.current;
    if (currentLease?.bufferId === activeBufferId) return;

    const registry = getMonacoModelRegistry(monaco);
    const nextLease = registry.acquire(activeBufferId, value, language);
    paneModelControllerRef.current?.switchTo(activeBufferId, nextLease.model);
    modelLeaseRef.current = nextLease;
    currentLease?.release();
  }, [monaco, editorInstance, activeBufferId, value, language]);

  useEffect(() => {
    if (!monaco || !editorInstance) return;
    getMonacoModelRegistry(monaco).applyContent(activeBufferId, value);
  }, [monaco, editorInstance, activeBufferId, value]);

  useEffect(() => {
    if (!monaco) return;
    const lease = modelLeaseRef.current;
    if (lease?.bufferId === activeBufferId) {
      monaco.editor.setModelLanguage(lease.model, language);
    }
  }, [monaco, activeBufferId, language]);

  useEffect(() => {
    if (editorRef.current) editorRef.current.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.updateOptions({
      fontSize: settings.fontSize,
      tabSize: settings.tabSize,
      wordWrap: settings.wordWrap,
      minimap: { enabled: settings.minimap },
      lineNumbers: settings.lineNumbers ? "on" : "off",
      renderWhitespace: settings.renderWhitespace ? "all" : "selection",
      fontFamily: fontFamilyForEditorMode(mode),
    });
  }, [settings, mode]);

  useEffect(() => {
    if (!monaco || !lspReady || !enableLsp) return;

    const disposables: Monaco.IDisposable[] = [
      registerCompletionProvider(monaco, language, sendRequest),
      registerHoverProvider(monaco, language, sendRequest),
    ];

    return () => {
      disposables.forEach((d) => d.dispose());
    };
  }, [monaco, lspReady, enableLsp, language, sendRequest]);

  if (error) {
    return <div style={{ color: "#f87171", padding: "20px" }}>Editor failed to load: {error}</div>;
  }

  if (!monaco) {
    return <div style={{ color: "#888", padding: "20px" }}>Loading editor...</div>;
  }

  return (
    <div className="monaco-editor-shell">
      <div
        ref={containerRef}
        className="monaco-editor-wrapper"
        data-editor-mode={mode}
        data-editor-theme={themeForEditorMode(mode)}
        data-vim-enabled={String(mode === "zed" && vimEnabled)}
        style={{ height: "100%", width: "100%" }}
      />
      {!vimStatusRef && (
        <span
          ref={fallbackVimStatusRef}
          className="zed-vim-status zed-vim-status--overlay"
          aria-live="polite"
        />
      )}
    </div>
  );
}

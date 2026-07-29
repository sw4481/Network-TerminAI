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
  value: string;
  language: string;
  onChange: (value: string) => void;
  onCursorChange?: (position: { line: number; column: number }) => void;
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
  value,
  language,
  onChange,
  onCursorChange,
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
  const [monaco, setMonaco] = useState<typeof Monaco | null>(null);
  const [editorInstance, setEditorInstance] =
    useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const fallbackVimStatusRef = useRef<HTMLSpanElement | null>(null);
  const activeVimStatusRef = vimStatusRef ?? fallbackVimStatusRef;
  const [error, setError] = useState<string | null>(null);
  const { mode, vimEnabled } = useZedMode();

  // Refs keep the latest values accessible from Monaco action callbacks,
  // which are registered once and persist for the editor lifetime.
  const tabIdRef = useRef<string | undefined>(tabId);
  const languageRef = useRef<string>(language);
  const filePathRef = useRef<string | null>(filePath);
  useEffect(() => { tabIdRef.current = tabId; }, [tabId]);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { filePathRef.current = filePath; }, [filePath]);

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
    const editor = monaco.editor.create(containerRef.current, {
      value,
      language,
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

    let ownership: EditorDisposalOwnership;
    ownership = createEditorDisposalOwnership(
      editor,
      () => editorDisposables.forEach((disposable) => disposable.dispose()),
      () => {
        if (editorRef.current === editor) {
          editorRef.current = null;
        }
        if (editorOwnershipRef.current === ownership) {
          editorOwnershipRef.current = null;
        }
      },
    );
    editorRef.current = editor;
    editorOwnershipRef.current = ownership;
    onEditorReady?.(editor, monaco);

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
      onChange(editor.getValue());
    });
    editorDisposables.push(changeDisposable);

    if (onCursorChange) {
      editorDisposables.push(
        editor.onDidChangeCursorPosition((e) => {
          onCursorChange({
            line: e.position.lineNumber,
            column: e.position.column,
          });
        }),
      );
    }

    if (onSave) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSave();
      });
    }

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
    if (editorRef.current && editorRef.current.getValue() !== value) {
      editorRef.current.setValue(value);
    }
  }, [value]);

  useEffect(() => {
    if (!monaco || !editorRef.current) return;
    const model = editorRef.current.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [monaco, language]);

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

import { useRef, useEffect, useState, type RefObject } from "react";
import type * as Monaco from "monaco-editor";
import { useLspClient } from "../../hooks/useLspClient";
import { registerCompletionProvider } from "./lsp/CompletionProvider";
import { registerHoverProvider } from "./lsp/HoverProvider";
import {
  registerDefinitionProvider,
  registerReferenceProvider,
} from "./lsp/NavigationProviders";
import { acquireLspDocument } from "./lsp/lspDocumentSync";
import { registerHclLanguage } from "./lsp/hclLanguage";
import { registerCiscoLanguages } from "./lsp/ciscoLanguage";
import {
  ciscoLanguageId,
  type CiscoDiagnostic,
  type CiscoPlatform,
} from "../../lib/ciscoLint";
import type {
  CiscoGuardrailStatus,
  CiscoLintView,
} from "../../hooks/useCiscoLint";
import { clearCiscoMarkers, setCiscoMarkers } from "./ciscoMarkers";
import { dispatchAskAi, type AskAiAction } from "./askAi";
import { useZedMode } from "./ZedModeProvider";
import {
  fontFamilyForEditorMode,
} from "./themes/zed-one-dark";
import { applyMonacoTheme, resolveMonacoTheme } from "../../theme/monacoThemes";
import { useAppearance } from "../../theme/AppearanceProvider";
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
import { installGitAwareness } from "./gitAwareness";
import { installDebugDecorations } from "./debug/debugDecorations";
import { registerPowerEditingActions } from "./powerEditingActions";
import {
  createBookmarkController,
  type BookmarkController,
} from "./bookmarkController";
import { createEditorMacroController } from "./editorMacro";
import "./MonacoEditor.css";
import "./git-awareness.css";
import "./debug/debug-decorations.css";

export type EditorSettings = {
  fontSize: number;
  tabSize: number;
  wordWrap: "on" | "off";
  minimap: boolean;
  lineNumbers: boolean;
  renderWhitespace: boolean;
  columnSelection: boolean;
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 14,
  tabSize: 2,
  wordWrap: "on",
  minimap: true,
  lineNumbers: true,
  renderWhitespace: false,
  columnSelection: false,
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
  /** Project root used to scope the persistent language-server process. */
  workspaceRoot?: string | null;
  /** Handles Monaco cross-file definition/reference open operations. */
  onOpenResource?: (
    uri: string,
    position: { line: number; column: number },
  ) => boolean | Promise<boolean>;
  vimStatusRef?: RefObject<HTMLSpanElement | null>;
  ciscoPlatform?: CiscoPlatform | null;
  ciscoDiagnostics?: readonly CiscoDiagnostic[];
  ciscoGuardrailStatus?: CiscoGuardrailStatus;
  onCiscoLintResult?: (result: CiscoLintView) => void;
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
  workspaceRoot = null,
  onOpenResource,
  vimStatusRef,
  ciscoPlatform = null,
  ciscoDiagnostics,
  ciscoGuardrailStatus,
  onCiscoLintResult,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorOwnershipRef = useRef<EditorDisposalOwnership | null>(null);
  const modelLeaseRef = useRef<MonacoModelLease | null>(null);
  const paneModelControllerRef = useRef<MonacoPaneModelController | null>(null);
  const bookmarkControllerRef = useRef<BookmarkController | null>(null);
  const ciscoMarkerModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const ciscoMarkerBufferIdRef = useRef<string | null>(null);
  const [monaco, setMonaco] = useState<typeof Monaco | null>(null);
  const [editorInstance, setEditorInstance] =
    useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const fallbackVimStatusRef = useRef<HTMLSpanElement | null>(null);
  const activeVimStatusRef = vimStatusRef ?? fallbackVimStatusRef;
  const [error, setError] = useState<string | null>(null);
  const [lspDocumentReady, setLspDocumentReady] = useState(false);
  const { mode, vimEnabled } = useZedMode();
  const { settings: appearanceSettings } = useAppearance();
  const resolvedTheme = resolveMonacoTheme(appearanceSettings, mode);
  const fallbackBufferIdRef = useRef(
    `standalone:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  );
  const activeBufferId = bufferId ?? fallbackBufferIdRef.current;
  const effectiveModelLanguage = ciscoPlatform
    ? ciscoLanguageId(ciscoPlatform)
    : language;

  // Refs keep the latest values accessible from Monaco action callbacks,
  // which are registered once and persist for the editor lifetime.
  const tabIdRef = useRef<string | undefined>(tabId);
  const languageRef = useRef<string>(language);
  const effectiveModelLanguageRef = useRef(effectiveModelLanguage);
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
  effectiveModelLanguageRef.current = effectiveModelLanguage;
  filePathRef.current = filePath;
  bufferIdRef.current = activeBufferId;
  valueRef.current = value;
  onChangeRef.current = onChange;
  onCursorChangeRef.current = onCursorChange;
  onScrollChangeRef.current = onScrollChange;
  onSaveRef.current = onSave;
  onEditorReadyRef.current = onEditorReady;

  const lspClient = useLspClient(
    language,
    workspaceRoot,
    enableLsp && ciscoPlatform === null && Boolean(filePath),
  );
  const { sendRequest, ready: lspReady } = lspClient;

  useEffect(() => {
    loadMonaco()
      .then((m) => {
        registerHclLanguage(m);
        registerCiscoLanguages(m);
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

    applyMonacoTheme(monaco, resolvedTheme);

    const editorDisposables: Monaco.IDisposable[] = [];
    const registry = getMonacoModelRegistry(monaco);
    const modelLease = registry.acquire(
      bufferIdRef.current,
      valueRef.current,
      effectiveModelLanguageRef.current,
    );
    modelLeaseRef.current = modelLease;
    let editor: Monaco.editor.IStandaloneCodeEditor;
    try {
      editor = monaco.editor.create(containerRef.current, {
      model: modelLease.model,
      theme: resolvedTheme,
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
      glyphMargin: true,
      lineNumbers: settings.lineNumbers ? "on" : "off",
      renderWhitespace: settings.renderWhitespace ? "all" : "selection",
      columnSelection: settings.columnSelection,
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
    let bookmarksForEditor: BookmarkController | null = null;

    let ownership: EditorDisposalOwnership;
    ownership = createEditorDisposalOwnership(
      editor,
      () => editorDisposables.forEach((disposable) => disposable.dispose()),
      () => {
        const ownsCurrentEditor = editorRef.current === editor;
        if (ownsCurrentEditor) {
          editorRef.current = null;
          if (bookmarkControllerRef.current === bookmarksForEditor) {
            bookmarkControllerRef.current = null;
          }
          paneModelControllerRef.current?.clear();
          paneModelControllerRef.current = null;
          const markerModel = ciscoMarkerModelRef.current;
          const markerBufferId = ciscoMarkerBufferIdRef.current;
          if (
            markerModel &&
            markerBufferId &&
            getMonacoModelRegistry(monaco).referenceCount(markerBufferId) <= 1
          ) {
            clearCiscoMarkers(monaco, markerModel);
          }
          if (markerModel) {
            ciscoMarkerModelRef.current = null;
            ciscoMarkerBufferIdRef.current = null;
          }
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
    const bookmarks = createBookmarkController(
      editor,
      monaco,
      bufferIdRef.current,
    );
    bookmarksForEditor = bookmarks;
    bookmarkControllerRef.current = bookmarks;
    editorDisposables.push({ dispose: bookmarks.dispose });

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
    editorDisposables.push(registerPowerEditingActions(editor));
    const macroController = createEditorMacroController(editor);
    editorDisposables.push({ dispose: macroController.dispose });

    const changeDisposable = editor.onDidChangeModelContent((event) => {
      const lease = modelLeaseRef.current;
      if (!lease || registry.isApplyingContent(lease.bufferId)) return;
      macroController.recordChanges(event.changes);
      onChangeRef.current(editor.getValue());
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
    // Monaco applies themes to the existing editor/model; avoid lifecycle work
    // here so changing appearance cannot interrupt splits, LSP, or DAP.
    applyMonacoTheme(monaco, resolvedTheme);
  }, [monaco, resolvedTheme]);

  useEffect(() => {
    if (!monaco || !editorInstance) return;
    const currentLease = modelLeaseRef.current;
    if (currentLease?.bufferId === activeBufferId) return;

    const registry = getMonacoModelRegistry(monaco);
    const nextLease = registry.acquire(
      activeBufferId,
      value,
      effectiveModelLanguage,
    );
    paneModelControllerRef.current?.switchTo(activeBufferId, nextLease.model);
    bookmarkControllerRef.current?.setBuffer(activeBufferId);
    modelLeaseRef.current = nextLease;
    currentLease?.release();
  }, [
    monaco,
    editorInstance,
    activeBufferId,
    value,
    effectiveModelLanguage,
  ]);

  useEffect(() => {
    if (!monaco || !editorInstance) return;
    getMonacoModelRegistry(monaco).applyContent(activeBufferId, value);
  }, [monaco, editorInstance, activeBufferId, value]);

  useEffect(() => {
    if (!monaco) return;
    const lease = modelLeaseRef.current;
    if (lease?.bufferId === activeBufferId) {
      monaco.editor.setModelLanguage(lease.model, effectiveModelLanguage);
    }
  }, [monaco, activeBufferId, effectiveModelLanguage]);

  useEffect(() => {
    if (!monaco || !editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;

    const previousModel = ciscoMarkerModelRef.current;
    const previousBufferId = ciscoMarkerBufferIdRef.current;
    const modelChanged =
      previousModel !== model || previousBufferId !== activeBufferId;
    if (
      previousModel &&
      previousBufferId &&
      (modelChanged || !ciscoPlatform)
    ) {
      const shouldClear =
        (!modelChanged && !ciscoPlatform) ||
        (modelChanged &&
          getMonacoModelRegistry(monaco).referenceCount(previousBufferId) === 0);
      if (shouldClear) {
        clearCiscoMarkers(monaco, previousModel);
      }
    }

    if (!ciscoPlatform || ciscoDiagnostics === undefined) {
      if (modelChanged) {
        ciscoMarkerModelRef.current = null;
        ciscoMarkerBufferIdRef.current = null;
      }
      return;
    }

    ciscoMarkerModelRef.current = model;
    ciscoMarkerBufferIdRef.current = activeBufferId;
    setCiscoMarkers(monaco, model, ciscoDiagnostics);
    onCiscoLintResult?.({
      diagnostics: [...ciscoDiagnostics],
      structuralStatus: "ready",
      guardrails: ciscoGuardrailStatus ?? { state: "idle", reason: null },
    });
  }, [
    monaco,
    editorInstance,
    activeBufferId,
    ciscoPlatform,
    ciscoDiagnostics,
    ciscoGuardrailStatus,
    onCiscoLintResult,
  ]);

  useEffect(() => {
    if (
      !monaco ||
      !editorInstance ||
      mode !== "zed" ||
      !filePath
    ) {
      return;
    }
    const awareness = installGitAwareness({
      editor: editorInstance,
      monaco,
      filePath,
    });
    return () => awareness.dispose();
  }, [monaco, editorInstance, mode, activeBufferId, filePath]);

  useEffect(() => {
    if (
      !monaco ||
      !editorInstance ||
      mode !== "zed" ||
      language.trim().toLowerCase() !== "python" ||
      !tabId ||
      !workspaceRoot ||
      !filePath
    ) {
      return;
    }
    const decorations = installDebugDecorations({
      editor: editorInstance,
      monaco,
      tabId,
      workspaceRoot,
      filePath,
      dependencies: {
        onError: (debugError) =>
          console.error(`Python debug decoration failed for ${filePath}:`, debugError),
      },
    });
    return () => decorations.dispose();
  }, [
    monaco,
    editorInstance,
    mode,
    activeBufferId,
    language,
    tabId,
    workspaceRoot,
    filePath,
  ]);

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.updateOptions({
      readOnly,
      glyphMargin: true,
    });
  }, [readOnly, mode]);

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.updateOptions({
      fontSize: settings.fontSize,
      tabSize: settings.tabSize,
      wordWrap: settings.wordWrap,
      minimap: { enabled: settings.minimap },
      lineNumbers: settings.lineNumbers ? "on" : "off",
      renderWhitespace: settings.renderWhitespace ? "all" : "selection",
      columnSelection: settings.columnSelection,
      fontFamily: fontFamilyForEditorMode(mode),
    });
  }, [settings, mode]);

  useEffect(() => {
    if (
      !monaco ||
      !editorInstance ||
      !lspReady ||
      !enableLsp ||
      ciscoPlatform !== null ||
      !workspaceRoot ||
      !filePath
    ) {
      setLspDocumentReady(false);
      return;
    }
    const model = editorInstance.getModel();
    if (!model || model.uri.scheme !== "file") {
      setLspDocumentReady(false);
      return;
    }
    let active = true;
    setLspDocumentReady(false);
    const lease = acquireLspDocument({
      monaco,
      model,
      sessionKey: `${language}:${workspaceRoot}`,
      languageId: language,
      transport: lspClient,
    });
    void lease.ready
      .then(() => {
        if (active) setLspDocumentReady(true);
      })
      .catch((documentError) => {
        if (active) {
          setLspDocumentReady(false);
          console.error(`Failed to open LSP document ${filePath}:`, documentError);
        }
      });
    return () => {
      active = false;
      setLspDocumentReady(false);
      lease.dispose();
    };
  }, [
    monaco,
    editorInstance,
    lspReady,
    enableLsp,
    ciscoPlatform,
    workspaceRoot,
    filePath,
    activeBufferId,
    language,
    lspClient.clientId,
    lspClient.openDocument,
    lspClient.changeDocument,
    lspClient.closeDocument,
  ]);

  useEffect(() => {
    if (
      !monaco ||
      !editorInstance ||
      !lspDocumentReady ||
      !enableLsp ||
      ciscoPlatform !== null
    ) {
      return;
    }
    const ownsModel = (model: Monaco.editor.ITextModel) =>
      editorInstance.getModel() === model;
    const ownsFocusedModel = (model: Monaco.editor.ITextModel) =>
      ownsModel(model) && editorInstance.hasTextFocus();

    const disposables: Monaco.IDisposable[] = [
      registerCompletionProvider(
        monaco,
        language,
        sendRequest,
        ownsFocusedModel,
      ),
      registerHoverProvider(monaco, language, sendRequest, ownsFocusedModel),
    ];
    if (mode === "zed") {
      disposables.push(
        registerDefinitionProvider(
          monaco,
          language,
          sendRequest,
          ownsFocusedModel,
        ),
        registerReferenceProvider(
          monaco,
          language,
          sendRequest,
          ownsFocusedModel,
        ),
      );
    }

    return () => {
      disposables.forEach((d) => d.dispose());
    };
  }, [
    monaco,
    editorInstance,
    lspDocumentReady,
    enableLsp,
    ciscoPlatform,
    language,
    sendRequest,
    mode,
  ]);

  useEffect(() => {
    if (
      !monaco ||
      !editorInstance ||
      mode !== "zed" ||
      !onOpenResource
    ) {
      return;
    }
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor(source, resource, selectionOrPosition) {
        if (source !== editorInstance || resource.scheme !== "file") {
          return false;
        }
        const selection = selectionOrPosition as
          | Monaco.IRange
          | Monaco.IPosition
          | undefined;
        const line =
          selection && "startLineNumber" in selection
            ? selection.startLineNumber
            : selection?.lineNumber ?? 1;
        const column =
          selection && "startColumn" in selection
            ? selection.startColumn
            : selection?.column ?? 1;
        return onOpenResource(resource.toString(), { line, column });
      },
    });
    return () => opener.dispose();
  }, [monaco, editorInstance, mode, onOpenResource]);

  if (error) {
    return <div style={{ color: "var(--status-danger)", padding: "20px" }}>Editor failed to load: {error}</div>;
  }

  if (!monaco) {
    return <div style={{ color: "var(--status-info)", padding: "20px" }}>Loading editor...</div>;
  }

  return (
    <div className="monaco-editor-shell">
      <div
        ref={containerRef}
        className="monaco-editor-wrapper"
        data-editor-mode={mode}
        data-editor-theme={resolvedTheme}
        data-vim-enabled={String(mode === "zed" && vimEnabled)}
        data-lsp-ready={String(lspDocumentReady)}
        data-lsp-server={lspClient.serverName ?? ""}
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

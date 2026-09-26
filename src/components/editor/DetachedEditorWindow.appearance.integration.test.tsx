import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../../theme/AppearanceProvider";
import { DEFAULT_APPEARANCE_SETTINGS } from "../../theme/defaults";
import { ZedModeProvider } from "./ZedModeProvider";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const models = new Map<string, ReturnType<typeof createModel>>();
  const lifecycle = {
    createEditor: vi.fn(),
    createModel: vi.fn(),
    disposeEditor: vi.fn(),
    disposeModel: vi.fn(),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    startLsp: vi.fn(),
    stopLsp: vi.fn(),
    openLspDocument: vi.fn(),
    closeLspDocument: vi.fn(),
  };

  function uri(path: string, scheme: string) {
    return {
      path,
      scheme,
      toString: () => `${scheme}://${path}`,
    };
  }

  function createModel(value: string, language: string, modelUri: ReturnType<typeof uri>) {
    let currentValue = value;
    let currentLanguage = language;
    return {
      uri: modelUri,
      getLanguageId: () => currentLanguage,
      getValue: () => currentValue,
      getValueInRange: () => currentValue,
      getFullModelRange: () => ({}),
      onDidChangeContent: vi.fn(() => ({ dispose: vi.fn() })),
      isDisposed: () => false,
      pushEditOperations: (_selections: unknown, edits: Array<{ text: string }>) => {
        currentValue = edits[0]?.text ?? currentValue;
      },
      setLanguage: (next: string) => {
        currentLanguage = next;
      },
      dispose: lifecycle.disposeModel,
    };
  }

  const monaco = {
    Uri: {
      file: (path: string) => uri(path, "file"),
      parse: (path: string) => uri(path, "inmemory"),
    },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyL: 2, KeyS: 3 },
    languages: {
      getLanguages: () => [],
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerDefinitionProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerReferenceProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
    editor: {
      create: vi.fn((_container: Element, options: { model: ReturnType<typeof createModel> }) => {
        lifecycle.createEditor();
        let model = options.model;
        return {
          addAction: vi.fn(() => ({ dispose: vi.fn() })),
          addCommand: vi.fn(),
          onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
          onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
          onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
          focus: vi.fn(),
          getModel: () => model,
          setModel: (next: ReturnType<typeof createModel>) => {
            model = next;
          },
          saveViewState: () => null,
          restoreViewState: vi.fn(),
          setPosition: vi.fn(),
          setScrollTop: vi.fn(),
          updateOptions: vi.fn(),
          hasTextFocus: () => true,
          getSelection: () => null,
          getValue: () => model.getValue(),
          dispose: lifecycle.disposeEditor,
        };
      }),
      getModel: vi.fn((modelUri: { toString: () => string }) => models.get(modelUri.toString())),
      createModel: vi.fn((value: string, language: string, modelUri: ReturnType<typeof uri>) => {
        lifecycle.createModel();
        const model = createModel(value, language, modelUri);
        models.set(modelUri.toString(), model);
        return model;
      }),
      setModelLanguage: vi.fn((model: ReturnType<typeof createModel>, language: string) => model.setLanguage(language)),
      defineTheme: lifecycle.defineTheme,
      setTheme: lifecycle.setTheme,
      registerEditorOpener: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };

  return {
    listeners,
    models,
    lifecycle,
    monaco,
    appearanceSettingsGet: vi.fn(),
    editorModeGet: vi.fn(),
    lspCheckAvailable: vi.fn(),
    editorDetachedWindowGetCurrent: vi.fn(),
    editorBufferRegister: vi.fn(),
    dapSessionForTab: vi.fn(),
    emit: vi.fn(),
    unlisten: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return mocks.unlisten;
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: vi.fn(), onCloseRequested: vi.fn(async () => vi.fn()) }),
}));

vi.mock("../../lib/tauri", () => ({
  editorDetachedWindowGetCurrent: mocks.editorDetachedWindowGetCurrent,
  editorDetachedWindowClose: vi.fn(),
  editorSourceWindowFocus: vi.fn(),
  editorSaveFile: vi.fn(),
  editorBufferRegister: mocks.editorBufferRegister,
  editorBufferUpdate: vi.fn(),
  editorBufferMarkSaved: vi.fn(),
  appearanceSettingsGet: mocks.appearanceSettingsGet,
  appearanceSettingsSet: vi.fn(),
  editorModeGet: mocks.editorModeGet,
  editorModeSet: vi.fn(),
  dapSessionForTab: mocks.dapSessionForTab,
  DAP_EVENT: "dap://event",
  gitGetRepositorySummary: vi.fn(),
  lspCheckAvailable: mocks.lspCheckAvailable,
  lspStart: mocks.lifecycle.startLsp,
  lspStop: mocks.lifecycle.stopLsp,
  lspRequest: vi.fn(),
  lspDocumentOpen: mocks.lifecycle.openLspDocument,
  lspDocumentChange: vi.fn(),
  lspDocumentClose: mocks.lifecycle.closeLspDocument,
}));

vi.mock("monaco-editor", () => mocks.monaco);

import { DetachedEditorWindow } from "./DetachedEditorWindow";

const metadata = {
  windowId: "editor-window-1",
  tabId: "editor-tab-1",
  paneId: "pane-1",
  bufferId: "file:/repo/a.ts",
  title: "a.py",
  workspaceRoot: "/repo",
};

const snapshot = {
  bufferId: metadata.bufferId,
  filePath: "/repo/a.py",
  content: "answer = 42",
  language: "python",
  dirty: false,
  revision: 1,
  sourceId: "source-window",
};

describe("DetachedEditorWindow appearance event integration", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.models.clear();
    for (const mock of Object.values(mocks.lifecycle)) mock.mockClear();
    mocks.appearanceSettingsGet.mockReset().mockResolvedValue(DEFAULT_APPEARANCE_SETTINGS);
    mocks.editorModeGet.mockReset().mockResolvedValue("monaco");
    mocks.editorDetachedWindowGetCurrent.mockReset().mockResolvedValue(metadata);
    mocks.editorBufferRegister.mockReset().mockResolvedValue(snapshot);
    mocks.dapSessionForTab.mockReset().mockResolvedValue(null);
    mocks.lspCheckAvailable.mockReset().mockResolvedValue(["python"]);
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.unlisten.mockReset();
    mocks.monaco.editor.create.mockClear();
    mocks.monaco.editor.createModel.mockClear();
    mocks.monaco.editor.getModel.mockClear();
    mocks.monaco.editor.setModelLanguage.mockClear();
    mocks.lifecycle.startLsp.mockResolvedValue({ serverName: "Pyright" });
    mocks.lifecycle.stopLsp.mockResolvedValue(undefined);
    mocks.lifecycle.openLspDocument.mockResolvedValue(undefined);
    mocks.lifecycle.closeLspDocument.mockResolvedValue(undefined);
  });

  it.each([
    ["Matrix", { appTheme: "matrix" }, "ccie-matrix"],
    ["Slate Grey", { appTheme: "slate-grey" }, "ccie-slate-grey"],
    [
      "an explicit Zed One Dark editor override",
      { appTheme: "matrix", editorTheme: "zed-one-dark" },
      "ccie-zed-one-dark",
    ],
  ] as const)("applies a live %s event to the existing detached Monaco editor without lifecycle churn", async (_label, changes, expectedTheme) => {
    render(
      <AppearanceProvider>
        <ZedModeProvider>
          <DetachedEditorWindow />
        </ZedModeProvider>
      </AppearanceProvider>,
    );

    await waitFor(() => expect(mocks.lifecycle.createEditor).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.listeners.get("appearance-settings-changed")).toBeTypeOf("function"));
    await waitFor(() => expect(mocks.lifecycle.openLspDocument).toHaveBeenCalledOnce());

    for (const mock of Object.values(mocks.lifecycle)) mock.mockClear();
    await act(async () => {
      mocks.listeners.get("appearance-settings-changed")?.({
        payload: { ...DEFAULT_APPEARANCE_SETTINGS, ...changes },
      });
    });

    await waitFor(() => expect(mocks.lifecycle.setTheme).toHaveBeenCalledWith(expectedTheme));
    expect(mocks.lifecycle.defineTheme).toHaveBeenCalledWith(expectedTheme, expect.any(Object));
    expect(mocks.lifecycle.createEditor).not.toHaveBeenCalled();
    expect(mocks.lifecycle.createModel).not.toHaveBeenCalled();
    expect(mocks.lifecycle.disposeEditor).not.toHaveBeenCalled();
    expect(mocks.lifecycle.disposeModel).not.toHaveBeenCalled();
    expect(mocks.lifecycle.startLsp).not.toHaveBeenCalled();
    expect(mocks.lifecycle.stopLsp).not.toHaveBeenCalled();
    expect(mocks.lifecycle.openLspDocument).not.toHaveBeenCalled();
    expect(mocks.lifecycle.closeLspDocument).not.toHaveBeenCalled();
  });
});

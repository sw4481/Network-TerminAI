import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const model = { uri: { scheme: "inmemory" } };
  const actionRegistrations: Array<{
    descriptor: { id: string };
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const editor = {
    addAction: vi.fn((descriptor: { id: string }) => {
      const registration = { descriptor, dispose: vi.fn() };
      actionRegistrations.push(registration);
      return registration;
    }),
    onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
    onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
    addCommand: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    updateOptions: vi.fn(),
    getModel: vi.fn(() => model),
    getValue: vi.fn(() => "text"),
    hasTextFocus: vi.fn(() => true),
    getSelection: vi.fn(() => null),
  };
  return {
    model,
    editor,
    actionRegistrations,
    create: vi.fn(() => editor),
    release: vi.fn(),
    applyContent: vi.fn(),
  };
});

vi.mock("monaco-editor", () => ({
  editor: {
    create: mocks.create,
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    setModelLanguage: vi.fn(),
    registerEditorOpener: vi.fn(() => ({ dispose: vi.fn() })),
  },
  KeyMod: { CtrlCmd: 1 },
  KeyCode: { KeyL: 2, KeyS: 3 },
}));
vi.mock("../../hooks/useLspClient", () => ({
  useLspClient: () => ({
    ready: false,
    sendRequest: vi.fn(),
    clientId: "test",
  }),
}));
vi.mock("./lsp/hclLanguage", () => ({ registerHclLanguage: vi.fn() }));
vi.mock("./lsp/CompletionProvider", () => ({
  registerCompletionProvider: vi.fn(),
}));
vi.mock("./lsp/HoverProvider", () => ({ registerHoverProvider: vi.fn() }));
vi.mock("./lsp/NavigationProviders", () => ({
  registerDefinitionProvider: vi.fn(),
  registerReferenceProvider: vi.fn(),
}));
vi.mock("./lsp/lspDocumentSync", () => ({ acquireLspDocument: vi.fn() }));
vi.mock("./zedKeybindings", () => ({
  installZedKeybindings: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("./useVimMode", () => ({ useVimMode: vi.fn() }));
vi.mock("./gitAwareness", () => ({ installGitAwareness: vi.fn() }));
vi.mock("./debug/debugDecorations", () => ({
  installDebugDecorations: vi.fn(),
}));
vi.mock("./ZedModeProvider", () => ({
  useZedMode: () => ({ mode: "classic", vimEnabled: false }),
}));
vi.mock("../../theme/AppearanceProvider", () => ({
  useAppearance: () => ({
    settings: {
      schemaVersion: 1,
      appTheme: "terminai-dark",
      editorTheme: "follow-app",
    },
  }),
}));
vi.mock("./monacoModelRegistry", () => ({
  getMonacoModelRegistry: () => ({
    acquire: () => ({
      bufferId: "buffer",
      model: mocks.model,
      release: mocks.release,
    }),
    isApplyingContent: () => false,
    applyContent: mocks.applyContent,
  }),
  MonacoPaneModelController: class {
    clear = vi.fn();
    switchTo = vi.fn();
  },
}));

import { DEFAULT_EDITOR_SETTINGS, MonacoEditor } from "./MonacoEditor";

describe("MonacoEditor power editing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actionRegistrations.length = 0;
  });

  it("creates Monaco with column selection disabled by default", async () => {
    expect(DEFAULT_EDITOR_SETTINGS.columnSelection).toBe(false);

    render(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="typescript"
        onChange={() => {}}
        enableLsp={false}
      />,
    );

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    expect(mocks.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ columnSelection: false }),
    );
  });

  it("registers and disposes the power editing actions with the editor", async () => {
    const view = render(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="typescript"
        onChange={() => {}}
        enableLsp={false}
      />,
    );

    await waitFor(() =>
      expect(mocks.editor.addAction).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "ccie.editor.powerEditing.multicursor-lines",
        }),
      ),
    );
    const registration = mocks.actionRegistrations.find(
      ({ descriptor }) =>
        descriptor.id === "ccie.editor.powerEditing.multicursor-lines",
    );

    view.unmount();

    expect(registration?.dispose).toHaveBeenCalledOnce();
  });
});

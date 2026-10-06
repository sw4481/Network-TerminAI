import { render, waitFor } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const model = { uri: { scheme: "inmemory" } };
  const cursorOptions = { cursorBlinking: "solid" };
  const configurationDispose = vi.fn();
  const mode = { mode: "zed", vimEnabled: false };
  const editor = {
    addAction: vi.fn(() => ({ dispose: vi.fn() })), onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })), onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
    addCommand: vi.fn(), focus: vi.fn(), dispose: vi.fn(), updateOptions: vi.fn(), getModel: vi.fn(() => model),
    getRawOptions: vi.fn(() => cursorOptions),
    onDidChangeConfiguration: vi.fn((_callback: (event: { hasChanged: (option: number) => boolean }) => void) => ({ dispose: configurationDispose })),
    getValue: vi.fn(() => "text"), hasTextFocus: vi.fn(() => true), getSelection: vi.fn(() => null),
  };
  return { model, editor, cursorOptions, configurationDispose, mode, create: vi.fn((_container: HTMLElement, _options: Monaco.editor.IStandaloneEditorConstructionOptions) => editor), defineTheme: vi.fn(), setTheme: vi.fn(), release: vi.fn(), applyContent: vi.fn(), appearance: { appTheme: "terminai-dark", editorTheme: "follow-app" } };
});

vi.mock("monaco-editor", () => ({
  editor: { EditorOption: { cursorBlinking: 26 }, create: mocks.create, defineTheme: mocks.defineTheme, setTheme: mocks.setTheme, setModelLanguage: vi.fn(), registerEditorOpener: vi.fn(() => ({ dispose: vi.fn() })) },
  KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyL: 2, KeyS: 3 },
}));
vi.mock("../../hooks/useLspClient", () => ({ useLspClient: () => ({ ready: false, sendRequest: vi.fn(), clientId: "test" }) }));
vi.mock("./lsp/hclLanguage", () => ({ registerHclLanguage: vi.fn() }));
vi.mock("./lsp/CompletionProvider", () => ({ registerCompletionProvider: vi.fn() }));
vi.mock("./lsp/HoverProvider", () => ({ registerHoverProvider: vi.fn() }));
vi.mock("./lsp/NavigationProviders", () => ({ registerDefinitionProvider: vi.fn(), registerReferenceProvider: vi.fn() }));
vi.mock("./lsp/lspDocumentSync", () => ({ acquireLspDocument: vi.fn() }));
vi.mock("./zedKeybindings", () => ({ installZedKeybindings: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock("./useVimMode", () => ({ useVimMode: vi.fn() }));
vi.mock("./gitAwareness", () => ({ installGitAwareness: vi.fn() }));
vi.mock("./debug/debugDecorations", () => ({ installDebugDecorations: vi.fn() }));
vi.mock("./ZedModeProvider", () => ({ useZedMode: () => mocks.mode }));
vi.mock("../../theme/AppearanceProvider", () => ({ useAppearance: () => ({ settings: { schemaVersion: 1, ...mocks.appearance } }) }));
vi.mock("./monacoModelRegistry", () => ({
  getMonacoModelRegistry: () => ({ acquire: () => ({ bufferId: "buffer", model: mocks.model, release: mocks.release }), isApplyingContent: () => false, applyContent: mocks.applyContent }),
  MonacoPaneModelController: class { clear = vi.fn(); switchTo = vi.fn(); },
}));

import { MonacoEditor } from "./MonacoEditor";

afterEach(() => vi.restoreAllMocks());

describe("MonacoEditor platform cursor policy", () => {
  beforeEach(() => {
    mocks.create.mockClear();
    mocks.editor.updateOptions.mockClear();
    mocks.editor.onDidChangeConfiguration.mockClear();
    mocks.configurationDispose.mockClear();
    mocks.cursorOptions.cursorBlinking = "solid";
    mocks.mode.mode = "zed";
  });

  it.each([
    ["Win32", "monaco", "solid"],
    ["Win32", "zed", "solid"],
    ["MacIntel", "monaco", "blink"],
    ["MacIntel", "zed", "blink"],
    ["Darwin", "monaco", "blink"],
    ["Linux x86_64", "monaco", "blink"],
  ])("uses %s/%s cursor blinking %s", async (platform, mode, cursorBlinking) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    mocks.mode.mode = mode;
    render(<MonacoEditor bufferId="buffer" value="text" language="plaintext" onChange={() => {}} />);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({ cursorBlinking });
    expect(mocks.editor.focus).toHaveBeenCalled();
    expect(mocks.editor.onDidChangeConfiguration).toHaveBeenCalledTimes(platform === "Win32" ? 1 : 0);
  });

  it("keeps the Windows cursor solid when Vim insert mode restores blink and disposes the guard", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const view = render(<MonacoEditor bufferId="buffer" value="text" language="plaintext" onChange={() => {}} />);
    await waitFor(() => expect(mocks.editor.onDidChangeConfiguration).toHaveBeenCalledOnce());
    const onConfigurationChanged = mocks.editor.onDidChangeConfiguration.mock.calls[0]![0];
    mocks.editor.updateOptions.mockClear();
    mocks.cursorOptions.cursorBlinking = "blink";
    onConfigurationChanged({ hasChanged: (option: number) => option === 26 });
    expect(mocks.editor.updateOptions).toHaveBeenCalledExactlyOnceWith({ cursorBlinking: "solid" });
    mocks.cursorOptions.cursorBlinking = "solid";
    onConfigurationChanged({ hasChanged: () => true });
    onConfigurationChanged({ hasChanged: () => false });
    expect(mocks.editor.updateOptions).toHaveBeenCalledOnce();
    view.unmount();
    expect(mocks.configurationDispose).toHaveBeenCalledOnce();
  });
});

describe("MonacoEditor appearance provider integration", () => {
  beforeEach(() => {
    for (const mock of [mocks.create, mocks.defineTheme, mocks.setTheme, mocks.release, mocks.applyContent, mocks.editor.dispose]) mock.mockClear();
    mocks.appearance.appTheme = "terminai-dark";
    mocks.appearance.editorTheme = "follow-app";
  });

  it("updates a provider-driven Matrix theme on the same editor and model without lifecycle recreation", async () => {
    const view = render(<MonacoEditor bufferId="buffer" value="text" language="typescript" onChange={() => {}} />);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    const originalModel = mocks.create.mock.calls[0]?.[1]?.model;
    mocks.appearance.appTheme = "matrix";
    view.rerender(<MonacoEditor bufferId="buffer" value="text" language="typescript" onChange={() => {}} />);
    await waitFor(() => expect(mocks.setTheme).toHaveBeenLastCalledWith("ccie-matrix"));
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0]?.[1]?.model).toBe(originalModel);
    expect(mocks.editor.getModel()).toBe(originalModel);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.editor.dispose).not.toHaveBeenCalled();
  });
});

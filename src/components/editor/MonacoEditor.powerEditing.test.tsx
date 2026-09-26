import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let applyingContent = false;
  let modelContentListener:
    | ((event: { changes: readonly unknown[] }) => void)
    | null = null;
  const model = {
    uri: { scheme: "inmemory" },
    getLineCount: vi.fn(() => 10),
  };
  const secondModel = {
    uri: { scheme: "inmemory" },
    getLineCount: vi.fn(() => 10),
  };
  let activeModel = model;
  const modelReferences = new Map<string, number>();
  const actionRegistrations: Array<{
    descriptor: { id: string };
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const paneModelController = {
    clear: vi.fn(),
    switchTo: vi.fn((_bufferId: string, nextModel: typeof model) => {
      activeModel = nextModel;
    }),
  };
  const editor = {
    addAction: vi.fn((descriptor: { id: string }) => {
      const registration = { descriptor, dispose: vi.fn() };
      actionRegistrations.push(registration);
      return registration;
    }),
    onDidChangeModelContent: vi.fn(
      (listener: (event: { changes: readonly unknown[] }) => void) => {
        modelContentListener = listener;
        return { dispose: vi.fn() };
      },
    ),
    onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
    onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
    addCommand: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    updateOptions: vi.fn(),
    getModel: vi.fn(() => activeModel),
    getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
    deltaDecorations: vi.fn(() => []),
    getValue: vi.fn(() => "text"),
    hasTextFocus: vi.fn(() => true),
    getSelection: vi.fn(() => null),
  };
  return {
    model,
    secondModel,
    editor,
    actionRegistrations,
    bookmarkControllers: [] as Array<{
      setBuffer: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }>,
    macroControllers: [] as Array<{
      recordChanges: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }>,
    paneModelController,
    create: vi.fn(() => editor),
    setModelMarkers: vi.fn(),
    setModelLanguage: vi.fn(),
    useLspClient: vi.fn(() => ({
      ready: false,
      sendRequest: vi.fn(),
      clientId: "test",
    })),
    modelReferences,
    leaseEvents: [] as string[],
    release: vi.fn(),
    applyContent: vi.fn(),
    emitModelContentChange: (changes: readonly unknown[]) => {
      modelContentListener?.({ changes });
    },
    resetModelContentState: () => {
      applyingContent = false;
      modelContentListener = null;
      activeModel = model;
      modelReferences.clear();
      mocks.leaseEvents.length = 0;
    },
    setApplyingContent: (value: boolean) => {
      applyingContent = value;
    },
    isApplyingContent: () => applyingContent,
  };
});

vi.mock("monaco-editor", () => ({
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  editor: {
    create: mocks.create,
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    setModelLanguage: mocks.setModelLanguage,
    setModelMarkers: mocks.setModelMarkers,
    registerEditorOpener: vi.fn(() => ({ dispose: vi.fn() })),
  },
  KeyMod: { CtrlCmd: 1 },
  KeyCode: { KeyL: 2, KeyS: 3 },
}));
vi.mock("../../hooks/useLspClient", () => ({
  useLspClient: mocks.useLspClient,
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
vi.mock("./bookmarkController", async () => {
  const actual = await vi.importActual<typeof import("./bookmarkController")>(
    "./bookmarkController",
  );
  return {
    ...actual,
    createBookmarkController: vi.fn((editor, monaco, bufferId) => {
      const actualController = actual.createBookmarkController(
        editor,
        monaco,
        bufferId,
      );
      const controller = {
        ...actualController,
        setBuffer: vi.fn(actualController.setBuffer),
        dispose: vi.fn(actualController.dispose),
      };
      mocks.bookmarkControllers.push(controller);
      return controller;
    }),
  };
});
vi.mock("./editorMacro", async () => {
  const actual = await vi.importActual<typeof import("./editorMacro")>(
    "./editorMacro",
  );
  return {
    ...actual,
    createEditorMacroController: vi.fn((editor) => {
      const actualController = actual.createEditorMacroController(editor);
      const controller = {
        ...actualController,
        recordChanges: vi.fn(actualController.recordChanges),
        dispose: vi.fn(actualController.dispose),
      };
      mocks.macroControllers.push(controller);
      return controller;
    }),
  };
});
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
    acquire: (bufferId: string) => {
      mocks.modelReferences.set(
        bufferId,
        (mocks.modelReferences.get(bufferId) ?? 0) + 1,
      );
      mocks.leaseEvents.push(`acquire:${bufferId}`);
      let released = false;
      return {
        bufferId,
        model: bufferId === "buffer-b" ? mocks.secondModel : mocks.model,
        release: vi.fn(() => {
          if (released) return;
          released = true;
          mocks.modelReferences.set(
            bufferId,
            Math.max(0, (mocks.modelReferences.get(bufferId) ?? 0) - 1),
          );
          mocks.leaseEvents.push(
            `release:${bufferId}:${mocks.modelReferences.get(bufferId) ?? 0}`,
          );
        }),
      };
    },
    referenceCount: (bufferId: string) => {
      const count = mocks.modelReferences.get(bufferId) ?? 0;
      mocks.leaseEvents.push(`referenceCount:${bufferId}:${count}`);
      return count;
    },
    isApplyingContent: mocks.isApplyingContent,
    applyContent: mocks.applyContent,
  }),
  MonacoPaneModelController: class {
    clear = mocks.paneModelController.clear;
    switchTo = mocks.paneModelController.switchTo;
  },
}));

import { DEFAULT_EDITOR_SETTINGS, MonacoEditor } from "./MonacoEditor";

describe("MonacoEditor power editing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actionRegistrations.length = 0;
    mocks.bookmarkControllers.length = 0;
    mocks.macroControllers.length = 0;
    mocks.resetModelContentState();
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

  it("creates one bookmark controller and action set across rerenders", async () => {
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
      expect(mocks.bookmarkControllers).toHaveLength(1),
    );
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ glyphMargin: true }),
    );
    expect(mocks.editor.addAction.mock.calls.filter(([action]) =>
      action.id.startsWith("ccie.editor.bookmark."),
    )).toHaveLength(4);
    view.rerender(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="typescript"
        onChange={() => {}}
        enableLsp={false}
        readOnly
      />,
    );

    expect(mocks.bookmarkControllers).toHaveLength(1);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.editor.addAction.mock.calls.filter(([action]) =>
      action.id.startsWith("ccie.editor.bookmark."),
    )).toHaveLength(4);
    await waitFor(() =>
      expect(mocks.editor.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true, glyphMargin: true }),
      ),
    );

    view.unmount();
  });

  it("disposes the bookmark controller once on unmount", async () => {
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
      expect(mocks.bookmarkControllers).toHaveLength(1),
    );
    const controller = mocks.bookmarkControllers[0]!;

    view.unmount();
    view.unmount();

    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("creates one macro controller and registers its actions on the same editor", async () => {
    const { createEditorMacroController } = await import("./editorMacro");
    const view = render(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="typescript"
        onChange={() => {}}
        enableLsp={false}
      />,
    );

    await waitFor(() => expect(mocks.macroControllers).toHaveLength(1));
    expect(createEditorMacroController).toHaveBeenCalledWith(mocks.editor);
    expect(
      mocks.editor.addAction.mock.calls
        .filter(([action]) => action.id.startsWith("ccie.editor.macro."))
        .map(([action]) => action.id),
    ).toEqual([
      "ccie.editor.macro.start",
      "ccie.editor.macro.stop",
      "ccie.editor.macro.replay",
      "ccie.editor.macro.clear",
    ]);

    view.unmount();
  });

  it("disposes the macro controller once on unmount", async () => {
    const view = render(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="typescript"
        onChange={() => {}}
        enableLsp={false}
      />,
    );

    await waitFor(() => expect(mocks.macroControllers).toHaveLength(1));
    const controller = mocks.macroControllers[0]!;

    view.unmount();
    view.unmount();

    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("does not record externally applied model content", async () => {
    const onChange = vi.fn();
    const view = render(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="typescript"
        onChange={onChange}
        enableLsp={false}
      />,
    );

    await waitFor(() => expect(mocks.macroControllers).toHaveLength(1));
    const controller = mocks.macroControllers[0]!;
    const changes = [{ range: {}, text: "external" }];
    mocks.setApplyingContent(true);

    mocks.emitModelContentChange(changes);

    expect(controller.recordChanges).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    mocks.setApplyingContent(false);
    mocks.emitModelContentChange(changes);
    expect(controller.recordChanges).toHaveBeenCalledWith(changes);
    expect(onChange).toHaveBeenCalledWith("text");

    view.unmount();
  });

  it("sets the bookmark buffer after switching the Monaco model", async () => {
    const view = render(
      <MonacoEditor
        bufferId="buffer-a"
        value="text"
        language="typescript"
        onChange={() => {}}
        enableLsp={false}
      />,
    );

    await waitFor(() =>
      expect(mocks.bookmarkControllers).toHaveLength(1),
    );
    const controller = mocks.bookmarkControllers[0]!;
    mocks.paneModelController.switchTo.mockClear();
    controller.setBuffer.mockClear();

    view.rerender(
      <MonacoEditor
        bufferId="buffer-b"
        value="text"
        language="typescript"
        onChange={() => {}}
        enableLsp={false}
      />,
    );

    await waitFor(() =>
      expect(mocks.paneModelController.switchTo).toHaveBeenCalledOnce(),
    );
    expect(controller.setBuffer).toHaveBeenCalledWith("buffer-b");
    expect(controller.setBuffer.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.paneModelController.switchTo.mock.invocationCallOrder[0],
    );

    view.unmount();
  });

  it("isolates Cisco markers and clears them on mode change and disposal", async () => {
    const diagnostics = [
      {
        line: 4,
        column: 2,
        endColumn: 12,
        severity: "warning" as const,
        message: "High impact",
        source: "guardrails" as const,
        code: "guardrail-save",
      },
    ];
    const view = render(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
        ciscoDiagnostics={diagnostics}
        ciscoGuardrailStatus={{ state: "ready", reason: null }}
      />,
    );

    await waitFor(() =>
      expect(mocks.setModelMarkers).toHaveBeenCalledWith(
        mocks.model,
        "cisco-lint",
        expect.any(Array),
      ),
    );

    view.rerender(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform={null}
        ciscoDiagnostics={[]}
        ciscoGuardrailStatus={{ state: "idle", reason: null }}
      />,
    );

    await waitFor(() =>
      expect(mocks.setModelMarkers).toHaveBeenCalledWith(
        mocks.model,
        "cisco-lint",
        [],
      ),
    );

    mocks.setModelMarkers.mockClear();
    view.unmount();
    expect(mocks.setModelMarkers).toHaveBeenCalledWith(
      mocks.model,
      "cisco-lint",
      [],
    );
  });

  it("uses the Cisco language and suppresses the generic LSP", async () => {
    render(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="typescript"
        onChange={() => {}}
        workspaceRoot="/repo"
        filePath="/repo/config.txt"
        ciscoPlatform="iosxe"
      />,
    );

    await waitFor(() =>
      expect(mocks.setModelLanguage).toHaveBeenCalledWith(
        mocks.model,
        "cisco-iosxe",
      ),
    );
    expect(mocks.useLspClient).toHaveBeenCalledWith(
      "typescript",
      "/repo",
      false,
    );
  });

  it("does not let a non-owning shared pane replace focused Cisco markers", async () => {
    const diagnostics = [
      {
        line: 1,
        column: 1,
        endColumn: 5,
        severity: "warning" as const,
        message: "Captured prompt",
        source: "cisco-structural" as const,
        code: "cli-prompt",
      },
    ];
    render(
      <MonacoEditor
        bufferId="shared-buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
        ciscoDiagnostics={diagnostics}
      />,
    );

    await waitFor(() =>
      expect(mocks.setModelMarkers).toHaveBeenCalledWith(
        mocks.model,
        "cisco-lint",
        expect.any(Array),
      ),
    );
    mocks.setModelMarkers.mockClear();

    render(
      <MonacoEditor
        bufferId="shared-buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
      />,
    );

    await waitFor(() =>
      expect(mocks.modelReferences.get("shared-buffer")).toBe(2),
    );
    expect(mocks.setModelMarkers).not.toHaveBeenCalled();
  });

  it("clears shared-buffer Cisco markers when both panes switch Off", async () => {
    const props = {
      bufferId: "shared-buffer",
      value: "text",
      language: "plaintext",
      onChange: () => {},
      enableLsp: false,
      ciscoPlatform: "iosxe" as const,
      ciscoDiagnostics: [],
    };
    const firstPane = render(<MonacoEditor {...props} />);
    const secondPane = render(<MonacoEditor {...props} />);

    await waitFor(() =>
      expect(mocks.modelReferences.get("shared-buffer")).toBe(2),
    );
    mocks.setModelMarkers.mockClear();

    firstPane.rerender(<MonacoEditor {...props} ciscoPlatform={null} />);
    secondPane.rerender(<MonacoEditor {...props} ciscoPlatform={null} />);

    await waitFor(() =>
      expect(mocks.setModelMarkers).toHaveBeenCalledWith(
        mocks.model,
        "cisco-lint",
        [],
      ),
    );
  });

  it("reports the active Cisco lint view through the optional callback", async () => {
    const diagnostics = [
      {
        line: 4,
        column: 2,
        endColumn: 12,
        severity: "warning" as const,
        message: "High impact",
        source: "guardrails" as const,
        code: "guardrail-save",
      },
    ];
    const onCiscoLintResult = vi.fn();

    render(
      <MonacoEditor
        bufferId="buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
        ciscoDiagnostics={diagnostics}
        ciscoGuardrailStatus={{ state: "ready", reason: null }}
        onCiscoLintResult={onCiscoLintResult}
      />,
    );

    await waitFor(() =>
      expect(onCiscoLintResult).toHaveBeenCalledWith({
        diagnostics,
        structuralStatus: "ready",
        guardrails: { state: "ready", reason: null },
      }),
    );
  });

  it("clears final-consumer Cisco markers after its old lease is released", async () => {
    const view = render(
      <MonacoEditor
        bufferId="buffer-a"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="nxos"
        ciscoDiagnostics={[]}
      />,
    );

    await waitFor(() =>
      expect(mocks.setModelMarkers).toHaveBeenCalledWith(
        mocks.model,
        "cisco-lint",
        [],
      ),
    );
    mocks.setModelMarkers.mockClear();

    view.rerender(
      <MonacoEditor
        bufferId="buffer-b"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="nxos"
        ciscoDiagnostics={[]}
      />,
    );

    await waitFor(() =>
      expect(mocks.setModelMarkers).toHaveBeenCalledWith(
        mocks.model,
        "cisco-lint",
        [],
      ),
    );
    expect(mocks.setModelMarkers).toHaveBeenCalledWith(
      mocks.secondModel,
      "cisco-lint",
      [],
    );
    const releaseIndex = mocks.leaseEvents.indexOf("release:buffer-a:0");
    const referenceCountIndex = mocks.leaseEvents.indexOf(
      "referenceCount:buffer-a:0",
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(referenceCountIndex).toBeGreaterThan(releaseIndex);

    view.unmount();
  });

  it("keeps shared-buffer Cisco markers when one pane switches or unmounts", async () => {
    const firstPane = render(
      <MonacoEditor
        bufferId="shared-buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
        ciscoDiagnostics={[]}
      />,
    );
    const secondPane = render(
      <MonacoEditor
        bufferId="shared-buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
        ciscoDiagnostics={[]}
      />,
    );

    await waitFor(() =>
      expect(mocks.modelReferences.get("shared-buffer")).toBe(2),
    );
    mocks.setModelMarkers.mockClear();

    firstPane.rerender(
      <MonacoEditor
        bufferId="buffer-b"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
        ciscoDiagnostics={[]}
      />,
    );

    await waitFor(() =>
      expect(mocks.setModelMarkers).toHaveBeenCalledWith(
        mocks.secondModel,
        "cisco-lint",
        [],
      ),
    );
    expect(mocks.setModelMarkers).not.toHaveBeenCalledWith(
      mocks.model,
      "cisco-lint",
      [],
    );

    mocks.setModelMarkers.mockClear();
    firstPane.unmount();

    expect(mocks.setModelMarkers).not.toHaveBeenCalledWith(
      mocks.model,
      "cisco-lint",
      [],
    );

    secondPane.unmount();
    expect(mocks.setModelMarkers).toHaveBeenCalledWith(
      mocks.model,
      "cisco-lint",
      [],
    );
  });

  it("keeps old Cisco markers when one pane switches to a different Off buffer", async () => {
    const firstPane = render(
      <MonacoEditor
        bufferId="shared-buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
        ciscoDiagnostics={[]}
      />,
    );
    const secondPane = render(
      <MonacoEditor
        bufferId="shared-buffer"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform="iosxe"
        ciscoDiagnostics={[]}
      />,
    );

    await waitFor(() =>
      expect(mocks.modelReferences.get("shared-buffer")).toBe(2),
    );
    mocks.setModelMarkers.mockClear();

    firstPane.rerender(
      <MonacoEditor
        bufferId="buffer-b"
        value="text"
        language="plaintext"
        onChange={() => {}}
        enableLsp={false}
        ciscoPlatform={null}
        ciscoDiagnostics={[]}
      />,
    );

    await waitFor(() =>
      expect(mocks.modelReferences.get("shared-buffer")).toBe(1),
    );
    expect(mocks.setModelMarkers).not.toHaveBeenCalledWith(
      mocks.model,
      "cisco-lint",
      [],
    );

    firstPane.unmount();
    expect(mocks.setModelMarkers).not.toHaveBeenCalledWith(
      mocks.model,
      "cisco-lint",
      [],
    );
    secondPane.unmount();
  });
});

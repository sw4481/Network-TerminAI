import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorBufferState } from "../../state/editorStore";

const mocks = vi.hoisted(() => ({
  ciscoResult: {
    diagnostics: [] as Array<{
      line: number;
      column: number;
      endColumn: number;
      severity: "error" | "warning" | "info";
      message: string;
      source: "cisco-structural" | "guardrails";
      code: string;
    }>,
    structuralStatus: "ready" as const,
    guardrails: { state: "ready" as const, reason: null as string | null },
  },
  focusedEditor: null as {
    revealLineInCenter: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  } | null,
  lint: vi.fn(),
  paneProps: null as Record<string, unknown> | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("../../lib/tauri", () => ({
  editorDetachedWindowClose: vi.fn().mockResolvedValue(undefined),
  editorDetachedWindowFocus: vi.fn().mockResolvedValue(undefined),
  editorDetachedWindowList: vi.fn().mockResolvedValue([]),
  editorDetachPane: vi.fn().mockResolvedValue(undefined),
  editorGetState: vi.fn().mockResolvedValue(null),
  editorOpenFile: vi.fn().mockResolvedValue(null),
  editorSaveFile: vi.fn().mockResolvedValue(undefined),
  dapBreakpointsGet: vi.fn().mockResolvedValue([]),
  dapBreakpointsSet: vi.fn().mockResolvedValue(undefined),
  gitGetStatus: vi.fn().mockResolvedValue([]),
  gitIsRepo: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../lib/appShutdown", () => ({
  registerAppShutdownTask: vi.fn(() => vi.fn()),
}));

vi.mock("../../hooks/useCiscoLint", () => ({
  useCiscoLint: mocks.lint,
}));

vi.mock("../../hooks/useEditorSettings", () => ({
  useEditorSettings: () => ({
    settings: {
      fontSize: 14,
      tabSize: 2,
      wordWrap: "on",
      minimap: true,
      lineNumbers: true,
      renderWhitespace: false,
      columnSelection: false,
    },
    setSettings: vi.fn(),
  }),
}));

vi.mock("../../hooks/useDebugSession", () => ({
  useDebugSession: () => ({
    status: "idle",
    session: null,
    start: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    continueExecution: vi.fn(),
    pause: vi.fn(),
    stepOver: vi.fn(),
    stepInto: vi.fn(),
    stepOut: vi.fn(),
  }),
}));

vi.mock("./ZedModeProvider", () => ({
  useZedMode: () => ({ mode: "monaco", hydrated: true }),
}));

vi.mock("./useGitRepositorySummary", () => ({
  useGitRepositorySummary: () => ({ summary: null, refresh: vi.fn() }),
}));

vi.mock("./useGitPanel", () => ({
  useGitPanel: () => ({
    preferences: { open: false, diffStyle: "split" },
    setOpen: vi.fn(),
    setDiffStyle: vi.fn(),
  }),
}));

vi.mock("./EditorPane", async () => {
  const React = await import("react");
  return {
    EditorPane: (props: { onEditorReady: (editor: unknown) => void } & Record<string, unknown>) => {
      mocks.paneProps = props;
      React.useEffect(() => {
        if (mocks.focusedEditor) props.onEditorReady(mocks.focusedEditor);
      }, [props.onEditorReady]);
      return <div data-testid="mock-editor-pane" />;
    },
  };
});

vi.mock("./EditorBufferTabs", () => ({
  EditorBufferTabs: () => null,
  confirmEditorBufferClose: vi.fn().mockResolvedValue(true),
}));
vi.mock("./FileExplorer", () => ({ FileExplorer: () => null }));
vi.mock("./FindReplace", () => ({ FindReplace: () => null }));
vi.mock("./WorkspaceFind", () => ({ WorkspaceFind: () => null }));
vi.mock("./EditorSettings", () => ({ EditorSettingsPanel: () => null }));
vi.mock("./EditorTerminalPanel", () => ({ EditorTerminalPanel: () => null }));
vi.mock("./GitStatusIndicator", () => ({ GitStatusIndicator: () => null }));
vi.mock("./GitDiffReview", () => ({ GitDiffReview: () => null }));
vi.mock("./GitPanel", () => ({ GitPanel: () => null }));
vi.mock("./lsp/WorkspaceSymbolSearch", () => ({
  WorkspaceSymbolSearch: () => null,
}));
vi.mock("./debug/DebugPanel", () => ({ DebugPanel: () => null }));
vi.mock("./workspaceFolderPicker", () => ({
  pickWorkspaceFolder: vi.fn().mockResolvedValue(null),
}));
vi.mock("./editorBufferSync", () => ({
  EditorBufferSyncClient: class {},
  flushEditorBufferSyncClients: vi.fn().mockResolvedValue(undefined),
}));

import { useEditorStore } from "../../state/editorStore";
import { EditorTab } from "./EditorTab";

const tab = {
  id: "editor-tab-1",
  title: "Editor",
  shell_cmd: "",
  cwd: "/repo",
  created_at: 1,
  tab_type: "editor" as const,
};

const buffer: EditorBufferState = {
  id: "file:/repo/running.cfg",
  file_path: "/repo/running.cfg",
  content: "interface GigabitEthernet1\n description uplink",
  language: "plaintext",
  cisco_platform: null,
  is_dirty: true,
  revision: 1,
  sync_status: "local",
  error: null,
};

function renderEditorTab({
  nextBuffer = buffer,
  patchBuffer,
  focusedEditor = null,
  ciscoResult = mocks.ciscoResult,
}: {
  nextBuffer?: EditorBufferState;
  patchBuffer?: (
    bufferId: string,
    partial: Partial<Omit<EditorBufferState, "id">>,
  ) => void;
  focusedEditor?: typeof mocks.focusedEditor;
  ciscoResult?: typeof mocks.ciscoResult;
} = {}) {
  useEditorStore.getState().initializeWorkspace(tab.id, {
    paneId: "pane-1",
    bufferId: nextBuffer.id,
    buffer: nextBuffer,
  });
  if (patchBuffer) useEditorStore.setState({ patchBuffer });
  mocks.focusedEditor = focusedEditor;
  mocks.ciscoResult = ciscoResult;
  const view = render(<EditorTab tab={tab} />);
  view.rerender(<EditorTab tab={tab} />);
  return view;
}

describe("EditorTab Cisco mode", () => {
  beforeEach(() => {
    useEditorStore.getState().resetAll();
    mocks.focusedEditor = null;
    mocks.paneProps = null;
    mocks.ciscoResult = {
      diagnostics: [],
      structuralStatus: "ready",
      guardrails: { state: "ready", reason: null },
    };
    mocks.lint.mockReset().mockImplementation(() => mocks.ciscoResult);
  });

  it("offers Off, IOS-XE, and NX-OS without inferring a platform", () => {
    renderEditorTab({
      nextBuffer: { ...buffer, language: "plaintext", cisco_platform: null },
    });

    const selector = screen.getByLabelText("Cisco editor mode");
    expect(selector).toHaveValue("");
    expect(screen.getByRole("option", { name: "IOS-XE" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "NX-OS" })).toBeInTheDocument();
    expect(mocks.lint).toHaveBeenLastCalledWith({
      content: buffer.content,
      platform: null,
    });
  });

  it("updates only the focused buffer profile", () => {
    const patchBuffer = vi.fn();
    renderEditorTab({ nextBuffer: buffer, patchBuffer });

    fireEvent.change(screen.getByLabelText("Cisco editor mode"), {
      target: { value: "nxos" },
    });

    expect(patchBuffer).toHaveBeenCalledWith("file:/repo/running.cfg", {
      cisco_platform: "nxos",
    });
    expect(tab).not.toHaveProperty("vendor");
    expect(tab).not.toHaveProperty("platform");
  });

  it("renders Problems for the active Cisco buffer and navigates the focused editor", async () => {
    const editor = {
      revealLineInCenter: vi.fn(),
      setPosition: vi.fn(),
      focus: vi.fn(),
    };
    renderEditorTab({
      nextBuffer: { ...buffer, cisco_platform: "iosxe" },
      focusedEditor: editor,
      ciscoResult: {
        diagnostics: [
          {
            line: 5,
            column: 4,
            endColumn: 10,
            severity: "warning",
            message: "Captured CLI prompt",
            source: "cisco-structural",
            code: "cli-prompt",
          },
        ],
        structuralStatus: "ready",
        guardrails: { state: "ready", reason: null },
      },
    });

    fireEvent.click(await screen.findByTestId("problem-0"));
    expect(mocks.paneProps).toMatchObject({
      ciscoPlatform: "iosxe",
      ciscoDiagnostics: mocks.ciscoResult.diagnostics,
      ciscoGuardrailStatus: { state: "ready", reason: null },
      onCiscoLintResult: expect.any(Function),
    });
    expect(editor.revealLineInCenter).toHaveBeenCalledWith(5);
    expect(editor.setPosition).toHaveBeenCalledWith({
      lineNumber: 5,
      column: 4,
    });
    expect(editor.focus).toHaveBeenCalled();
  });

  it("updates the focused result through the typed Monaco callback", async () => {
    renderEditorTab({ nextBuffer: { ...buffer, cisco_platform: "iosxe" } });
    const onCiscoLintResult = mocks.paneProps?.onCiscoLintResult as
      | ((result: typeof mocks.ciscoResult) => void)
      | undefined;
    expect(onCiscoLintResult).toEqual(expect.any(Function));

    const callbackResult = {
      ...mocks.ciscoResult,
      diagnostics: [
        {
          line: 8,
          column: 2,
          endColumn: 12,
          severity: "error" as const,
          message: "Callback result",
          source: "guardrails" as const,
          code: "guardrail-t3",
        },
      ],
    };
    act(() => onCiscoLintResult?.(callbackResult));
    expect(await screen.findByTestId("problem-0")).toHaveTextContent(
      "Callback result",
    );
  });

  it("does not render the removed Send Selection to Cisco surface", () => {
    renderEditorTab();
    expect(screen.queryByText(/Send Selection to Cisco/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-cisco-send-button")).not.toBeInTheDocument();
  });

  it("keeps save enabled while Cisco diagnostics are present", async () => {
    renderEditorTab({
      nextBuffer: { ...buffer, cisco_platform: "iosxe" },
      ciscoResult: {
        diagnostics: [
          {
            line: 1,
            column: 1,
            endColumn: 9,
            severity: "error",
            message: "Advisory finding",
            source: "guardrails",
            code: "guardrail-t3",
          },
        ],
        structuralStatus: "ready",
        guardrails: { state: "ready", reason: null },
      },
    });

    await waitFor(() => expect(screen.getByTestId("problem-0")).toBeInTheDocument());
    expect(screen.getByTestId("editor-save-button")).toBeEnabled();
  });

  it("renders the shared dense editor action toolbar", () => {
    const editor = {
      revealLineInCenter: vi.fn(),
      setPosition: vi.fn(),
      focus: vi.fn(),
      trigger: vi.fn(),
      getAction: vi.fn(() => ({ run: vi.fn() })),
    };
    renderEditorTab({ focusedEditor: editor });

    expect(screen.getByRole("toolbar", { name: "Editor actions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Format document" }));
    expect(editor.getAction).toHaveBeenCalledWith("editor.action.formatDocument");
  });
});

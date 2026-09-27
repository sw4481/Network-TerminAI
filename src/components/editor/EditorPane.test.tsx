import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorBufferState } from "../../state/editorStore";
import { createEditorPaneLayout } from "./editorPaneLayout";
import { EditorPane } from "./EditorPane";

const mocks = vi.hoisted(() => ({
  monacoProps: null as Record<string, unknown> | null,
}));

vi.mock("./MonacoEditor", () => ({
  MonacoEditor: (props: {
    bufferId: string;
    onChange: (content: string) => void;
  } & Record<string, unknown>) => {
    mocks.monacoProps = props;
    return (
      <button
        data-testid={`monaco-${props.bufferId}`}
        onClick={() => props.onChange("changed")}
      >
        Monaco
      </button>
    );
  },
}));

const buffer: EditorBufferState = {
  id: "file:/repo/a.ts",
  file_path: "/repo/a.ts",
  content: "const a = 1;",
  language: "typescript",
  cisco_platform: null,
  is_dirty: false,
  revision: 0,
  sync_status: "local",
  error: null,
};

function props() {
  return {
    tabId: "editor-tab-1",
    pane: createEditorPaneLayout(buffer.id, "pane-1"),
    buffer,
    rootPath: "/repo",
    focused: true,
    showControls: true,
    canClose: false,
    settings: {
      fontSize: 14,
      tabSize: 2,
      wordWrap: "on" as const,
      minimap: true,
      lineNumbers: true,
      renderWhitespace: false,
      columnSelection: false,
    },
    onFocus: vi.fn(),
    onSplit: vi.fn(),
    onDetach: vi.fn(),
    onClose: vi.fn(),
    onReattach: vi.fn(),
    onFocusWindow: vi.fn(),
    onChange: vi.fn(),
    onCursorChange: vi.fn(),
    onScrollChange: vi.fn(),
    onSave: vi.fn(),
    onEditorReady: vi.fn(),
  };
}

describe("EditorPane", () => {
  it("renders a shared-buffer Monaco view and accessible Zed controls", () => {
    const paneProps = props();
    render(<EditorPane {...paneProps} />);

    expect(screen.getByTestId(`monaco-${buffer.id}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Split pane right" }));
    fireEvent.click(screen.getByRole("button", { name: "Split pane down" }));
    fireEvent.click(screen.getByRole("button", { name: "Detach pane" }));

    expect(paneProps.onSplit).toHaveBeenNthCalledWith(1, "horizontal");
    expect(paneProps.onSplit).toHaveBeenNthCalledWith(2, "vertical");
    expect(paneProps.onDetach).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Close pane" })).toBeDisabled();
  });

  it("hides all Phase 2 controls in classic mode", () => {
    render(<EditorPane {...props()} showControls={false} />);

    expect(
      screen.queryByRole("button", { name: "Split pane right" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Detach pane" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId(`monaco-${buffer.id}`)).toBeInTheDocument();
  });

  it("forwards the Cisco lint result callback to Monaco", () => {
    const onCiscoLintResult = vi.fn();
    render(
      <EditorPane
        {...props()}
        ciscoPlatform="nxos"
        ciscoDiagnostics={[]}
        ciscoGuardrailStatus={{ state: "ready", reason: null }}
        onCiscoLintResult={onCiscoLintResult}
      />,
    );

    expect(mocks.monacoProps).toMatchObject({
      ciscoPlatform: "nxos",
      ciscoDiagnostics: [],
      ciscoGuardrailStatus: { state: "ready", reason: null },
      onCiscoLintResult,
    });
  });

  it("renders a detached placeholder instead of a duplicate Monaco view", () => {
    const paneProps = props();
    render(
      <EditorPane
        {...paneProps}
        pane={{
          ...paneProps.pane,
          detachedWindowId: "editor-window-1",
        }}
      />,
    );

    expect(screen.queryByTestId(`monaco-${buffer.id}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Focus detached window" }));
    fireEvent.click(screen.getByRole("button", { name: "Bring pane back" }));
    expect(paneProps.onFocusWindow).toHaveBeenCalledOnce();
    expect(paneProps.onReattach).toHaveBeenCalledOnce();
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorBufferState } from "../../state/editorStore";
import {
  createEditorPaneLayout,
  splitEditorPane,
} from "./editorPaneLayout";
import { EditorSplitTree } from "./EditorSplitTree";

const mocks = vi.hoisted(() => ({
  monacoProps: [] as Array<Record<string, unknown>>,
}));

const editorSplitStyles = readFileSync(
  resolve(process.cwd(), "src/components/editor/editor-splits.css"),
  "utf8",
);

vi.mock("./MonacoEditor", () => ({
  MonacoEditor: (props: { bufferId: string } & Record<string, unknown>) => {
    mocks.monacoProps.push(props);
    return <div data-testid={`model-view-${props.bufferId}`} />;
  },
}));

const buffer: EditorBufferState = {
  id: "file:/repo/a.ts",
  file_path: "/repo/a.ts",
  content: "shared",
  language: "typescript",
  cisco_platform: null,
  is_dirty: false,
  revision: 0,
  sync_status: "local",
  error: null,
};

function treeProps() {
  return {
    node: splitEditorPane(
      createEditorPaneLayout(buffer.id, "pane-left"),
      "pane-left",
      "horizontal" as const,
      "pane-right",
      "split-root",
    ),
    buffers: { [buffer.id]: buffer },
    tabId: "editor-tab-1",
    rootPath: "/repo",
    focusedPaneId: "pane-left",
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
    onResize: vi.fn(),
    onReattach: vi.fn(),
    onFocusWindow: vi.fn(),
    onChange: vi.fn(),
    onCursorChange: vi.fn(),
    onScrollChange: vi.fn(),
    onSave: vi.fn(),
    onEditorReady: vi.fn(),
    onOpenResource: vi.fn(),
  };
}

describe("EditorSplitTree", () => {
  beforeEach(() => {
    mocks.monacoProps.length = 0;
  });

  it("stretches a lone root pane to fill the editor workspace", () => {
    const tree = treeProps();
    const styles = document.createElement("style");
    styles.textContent = editorSplitStyles;
    document.head.append(styles);

    try {
      render(
        <EditorSplitTree
          {...tree}
          node={createEditorPaneLayout(buffer.id, "pane-only")}
          focusedPaneId="pane-only"
        />,
      );

      expect(screen.getByTestId("editor-split-tree")).toHaveStyle({
        display: "flex",
      });
      expect(screen.getByTestId("editor-pane-pane-only")).toBeVisible();
    } finally {
      styles.remove();
    }
  });

  it("renders recursive panes that share the same logical model", () => {
    const tree = treeProps();
    render(<EditorSplitTree {...tree} />);

    expect(screen.getAllByTestId(`model-view-${buffer.id}`)).toHaveLength(2);
    expect(screen.getByTestId("editor-pane-pane-left")).toHaveAttribute(
      "data-focused",
      "true",
    );
    expect(screen.getByTestId("editor-pane-pane-right")).toHaveAttribute(
      "data-focused",
      "false",
    );
  });

  it("keeps a shared buffer's Cisco profile on every pane while focus owns diagnostics", () => {
    const tree = treeProps();
    const ciscoBuffer = { ...buffer, cisco_platform: "iosxe" as const };
    const diagnostics = [{
      line: 1,
      column: 1,
      endColumn: 5,
      severity: "warning" as const,
      message: "Captured prompt",
      source: "cisco-structural" as const,
      code: "cli-prompt",
    }];
    const onCiscoLintResult = vi.fn();
    const view = render(
      <EditorSplitTree
        {...tree}
        buffers={{ [ciscoBuffer.id]: ciscoBuffer }}
        ciscoDiagnostics={diagnostics}
        ciscoGuardrailStatus={{ state: "ready", reason: null }}
        onCiscoLintResult={onCiscoLintResult}
      />,
    );

    expect(mocks.monacoProps.slice(-2).map((props) => props.ciscoPlatform)).toEqual([
      "iosxe",
      "iosxe",
    ]);
    expect(
      mocks.monacoProps.slice(-2).filter((props) => props.ciscoDiagnostics === diagnostics),
    ).toHaveLength(1);
    expect(
      mocks.monacoProps.slice(-2).filter(
        (props) => props.onCiscoLintResult === onCiscoLintResult,
      ),
    ).toHaveLength(1);

    view.rerender(
      <EditorSplitTree
        {...tree}
        buffers={{ [ciscoBuffer.id]: ciscoBuffer }}
        focusedPaneId="pane-right"
        ciscoDiagnostics={diagnostics}
        ciscoGuardrailStatus={{ state: "ready", reason: null }}
        onCiscoLintResult={onCiscoLintResult}
      />,
    );

    expect(mocks.monacoProps.slice(-2).map((props) => props.ciscoPlatform)).toEqual([
      "iosxe",
      "iosxe",
    ]);
    expect(
      mocks.monacoProps.slice(-2).filter((props) => props.ciscoDiagnostics === diagnostics),
    ).toHaveLength(1);
  });

  it("focuses a pane on pointer interaction and supports keyboard traversal", () => {
    const tree = treeProps();
    render(<EditorSplitTree {...tree} />);

    fireEvent.mouseDown(screen.getByTestId("editor-pane-pane-right"));
    expect(tree.onFocus).toHaveBeenCalledWith("pane-right");

    fireEvent.keyDown(screen.getByTestId("editor-split-tree"), {
      key: "ArrowRight",
      altKey: true,
    });
    expect(tree.onFocus).toHaveBeenLastCalledWith("pane-right");
  });

  it("routes resize deltas to the owning split", () => {
    const tree = treeProps();
    render(<EditorSplitTree {...tree} />);
    const split = screen.getByTestId("editor-split-split-root");
    Object.defineProperty(split, "offsetWidth", {
      configurable: true,
      value: 1000,
    });
    const handle = split.querySelector(".pane-handle");
    expect(handle).not.toBeNull();

    fireEvent.mouseDown(handle!, { clientX: 400 });
    fireEvent.mouseMove(document, { clientX: 500 });
    fireEvent.mouseUp(document);

    expect(tree.onResize).toHaveBeenCalledWith(
      "split-root",
      expect.arrayContaining([60, 40]),
    );
  });
});

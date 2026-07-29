import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const runWhenReady = vi.fn((_id?: any, _cmd?: any) => {});
vi.mock("../../lib/terminalRegistry", () => ({
  runWhenReady: (id?: any, cmd?: any) => runWhenReady(id, cmd),
}));

// Stub TerminalSlot: expose a button that invokes onRegistered so we can
// simulate the PTY becoming ready (potentially more than once, e.g. remount).
vi.mock("../TerminalSlot", () => ({
  TerminalSlot: ({ terminalId, onRegistered }: any) => (
    <button
      data-testid="fake-slot"
      data-term-id={terminalId}
      onClick={() => onRegistered?.("pty-1")}
    >
      slot
    </button>
  ),
}));

import { EditorTerminalPanel } from "./EditorTerminalPanel";

beforeEach(() => {
  runWhenReady.mockClear();
});

describe("EditorTerminalPanel", () => {
  it("uses a stable per-tab opencode terminal id", () => {
    const { getByTestId } = render(
      <EditorTerminalPanel
        tabId="tab-42"
        cwd="/proj"
        mode="opencode"
        onModeChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(getByTestId("fake-slot").getAttribute("data-term-id")).toBe(
      "editor-term-tab-42",
    );
  });

  it("uses a distinct per-tab shell terminal id in shell mode", () => {
    const { getByTestId } = render(
      <EditorTerminalPanel
        tabId="tab-42"
        cwd="/proj"
        mode="shell"
        onModeChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(getByTestId("fake-slot").getAttribute("data-term-id")).toBe(
      "editor-shell-tab-42",
    );
  });

  it("launches opencode exactly once even if the PTY reports ready twice", () => {
    const { getByTestId } = render(
      <EditorTerminalPanel
        tabId="tab-1"
        cwd="/proj"
        mode="opencode"
        onModeChange={() => {}}
        onClose={() => {}}
      />,
    );
    const slot = getByTestId("fake-slot");
    fireEvent.click(slot);
    fireEvent.click(slot);
    expect(runWhenReady).toHaveBeenCalledTimes(1);
    expect(runWhenReady).toHaveBeenCalledWith("editor-term-tab-1", "opencode");
  });

  it("does not auto-run opencode in shell mode", () => {
    const { getByTestId } = render(
      <EditorTerminalPanel
        tabId="tab-1"
        cwd="/proj"
        mode="shell"
        onModeChange={() => {}}
        onClose={() => {}}
      />,
    );
    // The shell slot has no onRegistered wired, so clicking is a no-op.
    fireEvent.click(getByTestId("fake-slot"));
    expect(runWhenReady).not.toHaveBeenCalled();
  });

  it("fires onModeChange from the tab buttons", () => {
    const onModeChange = vi.fn();
    const { getByTestId } = render(
      <EditorTerminalPanel
        tabId="t"
        cwd={null}
        mode="opencode"
        onModeChange={onModeChange}
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByTestId("editor-terminal-tab-shell"));
    expect(onModeChange).toHaveBeenCalledWith("shell");
    fireEvent.click(getByTestId("editor-terminal-tab-opencode"));
    expect(onModeChange).toHaveBeenCalledWith("opencode");
  });

  it("resizes the panel when the handle is dragged up", () => {
    const { getByTestId } = render(
      <EditorTerminalPanel
        tabId="t"
        cwd={null}
        mode="opencode"
        onModeChange={() => {}}
        onClose={() => {}}
      />,
    );
    const panel = getByTestId("editor-terminal-panel");
    expect(panel.style.height).toBe("280px");
    fireEvent.mouseDown(getByTestId("editor-terminal-resize"), { clientY: 500 });
    // Drag up 100px → panel grows by 100.
    fireEvent.mouseMove(document, { clientY: 400 });
    expect(panel.style.height).toBe("380px");
    fireEvent.mouseUp(document);
  });

  it("fires onClose from the close button", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <EditorTerminalPanel
        tabId="t"
        cwd={null}
        mode="opencode"
        onModeChange={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByTestId("editor-terminal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

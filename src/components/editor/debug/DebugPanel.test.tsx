import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DebugSessionController } from "../../../hooks/useDebugSession";
import { DebugPanel } from "./DebugPanel";

function controller(): DebugSessionController {
  return {
    status: "paused",
    session: {
      sessionId: "session-1",
      tabId: "tab-1",
      workspaceRoot: "/repo",
      program: "/repo/main.py",
      interpreter: "/repo/.venv/bin/python",
      adapterName: "debugpy",
      status: "paused",
    },
    error: null,
    threads: [{ id: 7, name: "MainThread" }],
    selectedThreadId: 7,
    frames: [
      {
        id: 11,
        name: "main",
        source: { name: "main.py", path: "/repo/main.py" },
        line: 5,
        column: 1,
      },
    ],
    selectedFrameId: 11,
    scopes: [
      {
        name: "Locals",
        variablesReference: 21,
        expensive: false,
        loading: false,
        error: null,
        variables: [
          {
            name: "router",
            value: "{'hostname': 'r1'}",
            type: "dict",
            variablesReference: 31,
          },
        ],
      },
    ],
    watches: [
      {
        id: "watch-1",
        expression: "router['hostname']",
        value: "'r1'",
        type: "str",
        variablesReference: 0,
        error: null,
      },
    ],
    output: [{ category: "stdout", output: "connected\n" }],
    start: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    continueExecution: vi.fn(),
    pause: vi.fn(),
    stepOver: vi.fn(),
    stepInto: vi.fn(),
    stepOut: vi.fn(),
    selectThread: vi.fn(),
    selectFrame: vi.fn(),
    loadVariables: vi.fn().mockResolvedValue([
      {
        name: "hostname",
        value: "'r1'",
        type: "str",
        variablesReference: 0,
      },
    ]),
    addWatch: vi.fn(),
    removeWatch: vi.fn(),
    clearOutput: vi.fn(),
  };
}

describe("DebugPanel", () => {
  it("renders paused inspection state and routes controls/frame navigation", () => {
    const debug = controller();
    const onFrameSelect = vi.fn();
    render(
      <DebugPanel
        controller={debug}
        onClose={vi.fn()}
        onFrameSelect={onFrameSelect}
      />,
    );

    expect(screen.getByTestId("debug-status")).toHaveTextContent("paused");
    expect(screen.getByText("MainThread")).toBeInTheDocument();
    expect(screen.getByText("router")).toBeInTheDocument();
    expect(screen.getByLabelText("Debug output")).toHaveTextContent(
      "connected",
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue debugging" }));
    fireEvent.click(screen.getByRole("button", { name: "Step over" }));
    fireEvent.click(screen.getByRole("button", { name: /main/ }));

    expect(debug.continueExecution).toHaveBeenCalledOnce();
    expect(debug.stepOver).toHaveBeenCalledOnce();
    expect(debug.selectFrame).toHaveBeenCalledWith(debug.frames[0]);
    expect(onFrameSelect).toHaveBeenCalledWith(debug.frames[0]);
  });

  it("adds/removes watches and lazily expands child variables", async () => {
    const debug = controller();
    render(
      <DebugPanel
        controller={debug}
        onClose={vi.fn()}
        onFrameSelect={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Watch expression"), {
      target: { value: "router['port']" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(debug.addWatch).toHaveBeenCalledWith("router['port']"),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove watch router['hostname']",
      }),
    );
    expect(debug.removeWatch).toHaveBeenCalledWith("watch-1");

    fireEvent.click(screen.getByRole("button", { name: "Expand router" }));
    await waitFor(() =>
      expect(debug.loadVariables).toHaveBeenCalledWith(31),
    );
    expect(await screen.findByText("hostname")).toBeInTheDocument();
  });

  it("resizes from the top edge", () => {
    render(
      <DebugPanel
        controller={controller()}
        onClose={vi.fn()}
        onFrameSelect={vi.fn()}
      />,
    );
    const panel = screen.getByTestId("debug-panel");
    expect(panel).toHaveStyle({ height: "300px" });
    fireEvent.mouseDown(screen.getByTestId("debug-panel-resize"), {
      clientY: 500,
    });
    fireEvent.mouseMove(document, { clientY: 400 });
    expect(panel).toHaveStyle({ height: "400px" });
    fireEvent.mouseUp(document);
  });
});

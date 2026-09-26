import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowRunner } from "./WorkflowRunner";
import { useWorkflowsStore } from "../state/workflowsStore";
import type { Workflow } from "../lib/workflows";

const runWorkflowOnTerminalMock = vi.fn();
vi.mock("../lib/workflowDispatcher", () => ({
  runWorkflowOnTerminal: (...args: unknown[]) => runWorkflowOnTerminalMock(...args),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

const noParamSingle: Workflow = {
  id: "1",
  name: "Show version",
  description: "",
  vendor: "cisco",
  platform: "iosxe",
  tags: [],
  steps: [{ idx: 0, command_template: "show version" }],
  params: [],
  created_at: 0,
  updated_at: 0,
};

const paramSingle: Workflow = {
  id: "2",
  name: "Show interface",
  description: "",
  vendor: "cisco",
  platform: "iosxe",
  tags: [],
  steps: [{ idx: 0, command_template: "show interface {{ intf }}" }],
  params: [
    {
      name: "intf",
      type: "interface",
      default_value: null,
      required: true,
      description: "",
      enum_values: null,
    },
  ],
  created_at: 0,
  updated_at: 0,
};

const noParamMulti: Workflow = {
  id: "3",
  name: "Show two",
  description: "",
  vendor: "cisco",
  platform: "iosxe",
  tags: [],
  steps: [
    { idx: 0, command_template: "show ver" },
    { idx: 1, command_template: "show ip int br" },
  ],
  params: [],
  created_at: 0,
  updated_at: 0,
};

function setInvokeRouting(extras: Record<string, unknown[]> = {}) {
  // Round-robin queues per Tauri command name. Picker calls workflow_list on
  // mount; tests can supply mock responses for workflow_run / workflow_run_complete
  // without those getting consumed by the unrelated workflow_list call.
  const queues: Record<string, unknown[]> = { workflow_list: [[]], ...extras };
  invokeMock.mockImplementation(async (cmd: string) => {
    const q = queues[cmd] ?? [undefined];
    return q.length > 1 ? q.shift() : q[0];
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  setInvokeRouting();
  useWorkflowsStore.setState({ workflows: [], loading: false, error: null });
  runWorkflowOnTerminalMock.mockReset();
  runWorkflowOnTerminalMock.mockResolvedValue({
    run_id: "run-id",
    workflow_name: "workflow",
    commands: [],
  });
});

describe("WorkflowRunner", () => {
  it("@smoke runs a single-step no-param workflow against the focused terminal", async () => {
    // Picker calls loadFor() on mount -> workflow_list. Route it to return
    // the seed workflow so the store ends up populated after the effect.
    setInvokeRouting({ workflow_list: [[noParamSingle]] });
    const onClose = vi.fn();
    render(
      <WorkflowRunner
        open
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onClose={onClose}
      />,
    );
    // Wait until the picker actually renders the row (post-loadFor effect).
    await waitFor(() => screen.getByText("Show version"));
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() =>
      expect(runWorkflowOnTerminalMock).toHaveBeenCalledWith(noParamSingle, "t1", {}),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens param form for single-step workflow with params; submits dispatches via workflow_run", async () => {
    setInvokeRouting({
      workflow_list: [[paramSingle]],
      workflow_run: [
        {
          run_id: "r1",
          workflow_name: "Show interface",
          commands: ["show interface Gi0/0"],
        },
      ],
      workflow_run_complete: [undefined],
    });
    render(
      <WorkflowRunner
        open
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText("Show interface"));
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => screen.getByLabelText(/intf/i));
    fireEvent.change(screen.getByLabelText(/intf/i), {
      target: { value: "Gi0/0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run workflow/i }));
    await waitFor(() =>
      expect(runWorkflowOnTerminalMock).toHaveBeenCalledWith(paramSingle, "t1", {
        intf: "Gi0/0",
      }),
    );
  });

  it("dispatches multi-step no-param workflow as a group", async () => {
    setInvokeRouting({
      workflow_list: [[noParamMulti]],
      workflow_run: [
        {
          run_id: "r2",
          workflow_name: "Show two",
          commands: ["show ver", "show ip int br"],
        },
      ],
      workflow_run_complete: [undefined],
    });
    render(
      <WorkflowRunner
        open
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText("Show two"));
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() =>
      expect(runWorkflowOnTerminalMock).toHaveBeenCalledWith(noParamMulti, "t1", {}),
    );
  });

  it("Cmd+Enter forces param form even on no-param single-step workflow", async () => {
    setInvokeRouting({ workflow_list: [[noParamSingle]] });
    render(
      <WorkflowRunner
        open
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText("Show version"));
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    // No params, but the form opens (and immediately renders an empty fields div).
    // We verify by finding the Cancel button which only exists in the form.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument(),
    );
  });

  it("returns null when not open", () => {
    const { container } = render(
      <WorkflowRunner
        open={false}
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("surfaces a terminal write failure and keeps the picker open", async () => {
    setInvokeRouting({ workflow_list: [[noParamSingle]] });
    runWorkflowOnTerminalMock.mockRejectedValueOnce(new Error("PTY write failed"));
    const onClose = vi.fn();
    render(
      <WorkflowRunner
        open
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByText("Show version"));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("PTY write failed");
    expect(onClose).not.toHaveBeenCalled();
  });
});

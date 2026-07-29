import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowRunner } from "./WorkflowRunner";
import { useWorkflowsStore } from "../state/workflowsStore";
import type { Workflow } from "../lib/workflows";

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
});

describe("WorkflowRunner", () => {
  it("@smoke runs single-step no-param workflow immediately via onInjectCommand", async () => {
    // Picker calls loadFor() on mount -> workflow_list. Route it to return
    // the seed workflow so the store ends up populated after the effect.
    setInvokeRouting({ workflow_list: [[noParamSingle]] });
    const onInjectCommand = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkflowRunner
        open
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onInjectCommand={onInjectCommand}
        onDispatchGroup={vi.fn(async () => {})}
        onClose={onClose}
      />,
    );
    // Wait until the picker actually renders the row (post-loadFor effect).
    await waitFor(() => screen.getByText("Show version"));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onInjectCommand).toHaveBeenCalledWith("show version");
    expect(onClose).toHaveBeenCalled();
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
    const onInjectCommand = vi.fn();
    render(
      <WorkflowRunner
        open
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onInjectCommand={onInjectCommand}
        onDispatchGroup={vi.fn(async () => {})}
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
    await waitFor(() => expect(onInjectCommand).toHaveBeenCalled());
    expect(onInjectCommand).toHaveBeenCalledWith("show interface Gi0/0");
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
    const onDispatchGroup = vi.fn(async () => {});
    render(
      <WorkflowRunner
        open
        vendor="cisco"
        platform="iosxe"
        tabId="t1"
        onInjectCommand={vi.fn()}
        onDispatchGroup={onDispatchGroup}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText("Show two"));
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(onDispatchGroup).toHaveBeenCalled());
    expect(onDispatchGroup).toHaveBeenCalledWith(
      "r2",
      "Show two",
      ["show ver", "show ip int br"],
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
        onInjectCommand={vi.fn()}
        onDispatchGroup={vi.fn(async () => {})}
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
        onInjectCommand={vi.fn()}
        onDispatchGroup={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

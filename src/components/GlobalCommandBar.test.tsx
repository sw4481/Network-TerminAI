import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Workflow } from "../lib/workflows";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  list: vi.fn(),
  run: vi.fn(),
}));

const generic: Workflow = {
  id: "generic",
  name: "Ping",
  description: "Generic check",
  vendor: "generic",
  platform: "generic",
  tags: [],
  steps: [{ idx: 0, command_template: "ping" }],
  params: [],
  created_at: 0,
  updated_at: 0,
};
const cisco: Workflow = {
  ...generic,
  id: "cisco",
  name: "Show version",
  vendor: "cisco",
  platform: "iosxe",
};
const juniper: Workflow = {
  ...generic,
  id: "juniper",
  name: "Show chassis",
  vendor: "juniper",
  platform: "junos",
};
const parameterized: Workflow = {
  ...generic,
  id: "parameterized",
  name: "Show interface",
  params: [{
    name: "interface",
    type: "interface",
    default_value: null,
    required: true,
    description: "",
    enum_values: null,
  }],
};

vi.mock("../lib/workflows", () => ({
  globalCommandBarGet: (...args: unknown[]) => mocks.get(...args),
  globalCommandBarSet: (...args: unknown[]) => mocks.set(...args),
  workflowList: (...args: unknown[]) => mocks.list(...args),
}));
vi.mock("../lib/workflowDispatcher", () => ({
  runWorkflowOnTerminal: (...args: unknown[]) => mocks.run(...args),
}));
vi.mock("./WorkflowPicker", () => ({
  WorkflowPicker: ({ onSelect, onClose }: { onSelect: (workflow: Workflow) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Pin picker">
      <button type="button" onClick={() => onSelect(juniper)}>Choose Juniper</button>
      <button type="button" onClick={onClose}>Close picker</button>
    </div>
  ),
}));

import { GlobalCommandBar, workflowMatchesDevice } from "./GlobalCommandBar";

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue({ schema_version: 1, workflow_ids: ["generic", "cisco"] });
  mocks.set.mockReset().mockResolvedValue(undefined);
  mocks.list.mockReset().mockResolvedValue([generic, cisco, juniper, parameterized]);
  mocks.run.mockReset().mockResolvedValue({ run_id: "run", workflow_name: "x", commands: [] });
});

describe("GlobalCommandBar", () => {
  it("hydrates persisted order and disables a visible device mismatch", async () => {
    mocks.get.mockResolvedValueOnce({ schema_version: 1, workflow_ids: ["juniper", "generic"] });
    render(<GlobalCommandBar tabId="tab-1" vendor="cisco" platform="iosxe" />);
    const junosButton = await screen.findByRole("button", { name: "Show chassis" });
    expect(junosButton).toBeDisabled();
    expect(junosButton).toHaveAttribute("title", expect.stringContaining("focused device is cisco/iosxe"));
    expect(screen.getByText("juniper/junos only")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ping" })).toBeEnabled();
  });

  it("persists keyboard-accessible reorder and unpin actions", async () => {
    render(<GlobalCommandBar tabId="tab-1" vendor="cisco" platform="iosxe" />);
    await screen.findByRole("button", { name: "Show version" });
    fireEvent.click(screen.getByRole("button", { name: "Move Ping right" }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({
      schema_version: 1,
      workflow_ids: ["cisco", "generic"],
    }));
    fireEvent.click(screen.getByRole("button", { name: "Unpin Show version" }));
    await waitFor(() => expect(mocks.set).toHaveBeenLastCalledWith({
      schema_version: 1,
      workflow_ids: ["generic"],
    }));
  });

  it("reuses the workflow picker to pin a workflow", async () => {
    render(<GlobalCommandBar tabId="tab-1" vendor="cisco" platform="iosxe" />);
    await screen.findByRole("button", { name: "Pin workflow" });
    fireEvent.click(screen.getByRole("button", { name: "Pin workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose Juniper" }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({
      schema_version: 1,
      workflow_ids: ["generic", "cisco", "juniper"],
    }));
  });

  it("executes no-parameter workflows immediately and opens the existing form for parameters", async () => {
    mocks.get.mockResolvedValueOnce({ schema_version: 1, workflow_ids: ["generic", "parameterized"] });
    render(<GlobalCommandBar tabId="tab-1" vendor="cisco" platform="iosxe" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ping" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(generic, "tab-1", {}));

    fireEvent.click(screen.getByRole("button", { name: "Show interface" }));
    fireEvent.change(await screen.findByRole("textbox", { name: /interface/i }), { target: { value: "Gi0/1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(parameterized, "tab-1", {
      interface: "Gi0/1",
    }));
  });

  it("surfaces execution errors", async () => {
    mocks.run.mockRejectedValueOnce(new Error("render failed"));
    render(<GlobalCommandBar tabId="tab-1" vendor="cisco" platform="iosxe" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ping" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("render failed");
  });
});

describe("workflowMatchesDevice", () => {
  it("always enables generic workflows and checks vendor plus platform for specific workflows", () => {
    expect(workflowMatchesDevice(generic, "arista", "eos")).toBe(true);
    expect(workflowMatchesDevice(cisco, "cisco", "iosxe")).toBe(true);
    expect(workflowMatchesDevice(cisco, "cisco", "nxos")).toBe(false);
    expect(workflowMatchesDevice(cisco, "juniper", "iosxe")).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "./workflows";

const ptyWriteMock = vi.fn();
const ptyTabIdForMock = vi.fn();
const invokeMock = vi.fn();
const resolveRecordingTerminalIdMock = vi.fn();

vi.mock("./tauri", () => ({
  ptyWrite: (...args: unknown[]) => ptyWriteMock(...args),
}));
vi.mock("./terminalRegistry", () => ({
  ptyTabIdFor: (...args: unknown[]) => ptyTabIdForMock(...args),
}));
vi.mock("../state/panesStore", () => ({
  usePanesStore: {
    getState: () => ({ resolveRecordingTerminalId: resolveRecordingTerminalIdMock }),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  dispatchWorkflowToTerminal,
  resolveWorkflowTerminalTarget,
  runWorkflowOnTerminal,
} from "./workflowDispatcher";

const workflow: Workflow = {
  id: "wf-1",
  name: "Checks",
  description: "",
  vendor: "generic",
  platform: "generic",
  tags: [],
  steps: [
    { idx: 0, command_template: "show one" },
    { idx: 1, command_template: "show two" },
  ],
  params: [],
  created_at: 0,
  updated_at: 0,
};

beforeEach(() => {
  ptyWriteMock.mockReset().mockResolvedValue(undefined);
  ptyTabIdForMock.mockReset().mockReturnValue("pty-focused");
  resolveRecordingTerminalIdMock.mockReset().mockReturnValue("terminal-focused");
  invokeMock.mockReset().mockImplementation(async (command: string) => {
    if (command === "workflow_run") {
      return { run_id: "run-1", workflow_name: "Checks", commands: ["show one", "show two"] };
    }
    return undefined;
  });
});

describe("workflow terminal dispatcher", () => {
  it("resolves the focused stable terminal through the registry backend ID", () => {
    expect(resolveWorkflowTerminalTarget("tab-1")).toEqual({
      terminalId: "terminal-focused",
      backendPtyId: "pty-focused",
    });
  });

  it("uses the legacy backend ID directly when no registry entry exists", () => {
    ptyTabIdForMock.mockReturnValue(null);
    expect(resolveWorkflowTerminalTarget("legacy-tab").backendPtyId).toBe("terminal-focused");
  });

  it("writes multi-step commands sequentially in stored order", async () => {
    const order: string[] = [];
    ptyWriteMock.mockImplementation(async (_id: string, bytes: Uint8Array) => {
      order.push(new TextDecoder().decode(bytes));
    });
    await dispatchWorkflowToTerminal(
      { terminalId: "stable", backendPtyId: "pty" },
      ["first", "second"],
    );
    expect(order).toEqual(["first\n", "second\n"]);
  });

  it("marks the workflow complete only after every PTY write succeeds", async () => {
    await runWorkflowOnTerminal(workflow, "tab-1", {});
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      "workflow_run",
      "workflow_run_complete",
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "workflow_run", {
      workflowId: "wf-1",
      tabId: "pty-focused",
      values: {},
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "workflow_run_complete", { runId: "run-1" });
  });

  it("does not mark a failed PTY dispatch complete", async () => {
    ptyWriteMock.mockRejectedValueOnce(new Error("write failed"));
    await expect(runWorkflowOnTerminal(workflow, "tab-1", {})).rejects.toThrow("write failed");
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(["workflow_run"]);
  });
});

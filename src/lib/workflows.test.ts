import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Workflow } from "./workflows";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import {
  workflowList,
  workflowUpsert,
  workflowGet,
  workflowDelete,
  workflowRun,
  workflowRunComplete,
  globalCommandBarGet,
  globalCommandBarSet,
} from "./workflows";

beforeEach(() => invokeMock.mockReset());

const sample: Workflow = {
  id: "",
  name: "x",
  description: "",
  vendor: "cisco",
  platform: "iosxe",
  tags: [],
  steps: [{ idx: 0, command_template: "show ver" }],
  params: [],
  created_at: 0,
  updated_at: 0,
};

describe("workflows lib", () => {
  it("workflowList forwards vendor/platform filter (camelCase namePrefix)", async () => {
    invokeMock.mockResolvedValue([]);
    await workflowList({ vendor: "cisco", platform: "iosxe" });
    expect(invokeMock).toHaveBeenCalledWith("workflow_list", {
      vendor: "cisco",
      platform: "iosxe",
      namePrefix: undefined,
    });
  });

  it("workflowList passes namePrefix when provided", async () => {
    invokeMock.mockResolvedValue([]);
    await workflowList({ namePrefix: "Show" });
    expect(invokeMock).toHaveBeenCalledWith("workflow_list", {
      vendor: undefined,
      platform: undefined,
      namePrefix: "Show",
    });
  });

  it("workflowUpsert returns id", async () => {
    invokeMock.mockResolvedValue("new-id");
    const id = await workflowUpsert(sample);
    expect(id).toBe("new-id");
    expect(invokeMock).toHaveBeenCalledWith("workflow_upsert", { workflow: sample });
  });

  it("workflowGet forwards id", async () => {
    invokeMock.mockResolvedValue(null);
    const out = await workflowGet("abc");
    expect(out).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("workflow_get", { id: "abc" });
  });

  it("workflowDelete forwards id", async () => {
    invokeMock.mockResolvedValue(undefined);
    await workflowDelete("abc");
    expect(invokeMock).toHaveBeenCalledWith("workflow_delete", { id: "abc" });
  });

  it("workflowRun forwards values map", async () => {
    invokeMock.mockResolvedValue({
      run_id: "r1",
      workflow_name: "x",
      commands: ["show ver"],
    });
    const r = await workflowRun("wf-1", "tab-a", { intf: "Gi0/0" });
    expect(r.commands).toEqual(["show ver"]);
    expect(invokeMock).toHaveBeenCalledWith("workflow_run", {
      workflowId: "wf-1",
      tabId: "tab-a",
      values: { intf: "Gi0/0" },
    });
  });

  it("workflowRunComplete forwards runId", async () => {
    invokeMock.mockResolvedValue(undefined);
    await workflowRunComplete("r1");
    expect(invokeMock).toHaveBeenCalledWith("workflow_run_complete", { runId: "r1" });
  });

  it("global command bar wrappers use exact Tauri arguments", async () => {
    invokeMock.mockResolvedValueOnce({ schema_version: 1, workflow_ids: ["wf-1"] });
    await expect(globalCommandBarGet()).resolves.toEqual({
      schema_version: 1,
      workflow_ids: ["wf-1"],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "global_command_bar_get");

    invokeMock.mockResolvedValueOnce(undefined);
    await globalCommandBarSet({ schema_version: 1, workflow_ids: ["wf-1"] });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "global_command_bar_set", {
      settings: { schema_version: 1, workflow_ids: ["wf-1"] },
    });
  });
});

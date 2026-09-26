import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import { useWorkflowsStore } from "./workflowsStore";

beforeEach(() => {
  invokeMock.mockReset();
  useWorkflowsStore.setState({ workflows: [], loading: false, error: null });
});

describe("workflowsStore", () => {
  it("loadFor populates workflows", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        id: "1",
        name: "A",
        description: "",
        vendor: "cisco",
        platform: "iosxe",
        tags: [],
        steps: [],
        params: [],
        created_at: 0,
        updated_at: 0,
      },
    ]);
    await useWorkflowsStore.getState().loadFor("cisco", "iosxe");
    expect(useWorkflowsStore.getState().workflows).toHaveLength(1);
    expect(useWorkflowsStore.getState().error).toBeNull();
  });

  it("loadFor sets error on failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("bad"));
    await useWorkflowsStore.getState().loadFor("cisco", "iosxe");
    expect(useWorkflowsStore.getState().error).toContain("bad");
    expect(useWorkflowsStore.getState().loading).toBe(false);
  });

  it("save refetches and upserts", async () => {
    invokeMock
      .mockResolvedValueOnce("new-id") // workflow_upsert
      .mockResolvedValueOnce({
        // workflow_get
        id: "new-id",
        name: "B",
        description: "",
        vendor: "cisco",
        platform: "iosxe",
        tags: [],
        steps: [],
        params: [],
        created_at: 0,
        updated_at: 0,
      });
    const id = await useWorkflowsStore.getState().save({
      id: "",
      name: "B",
      description: "",
      vendor: "cisco",
      platform: "iosxe",
      tags: [],
      steps: [],
      params: [],
      created_at: 0,
      updated_at: 0,
    });
    expect(id).toBe("new-id");
    expect(
      useWorkflowsStore.getState().workflows.some((w) => w.id === "new-id"),
    ).toBe(true);
  });

  it("remove drops workflow from store", async () => {
    useWorkflowsStore.setState({
      workflows: [
        {
          id: "1",
          name: "A",
          description: "",
          vendor: "cisco",
          platform: "iosxe",
          tags: [],
          steps: [],
          params: [],
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await useWorkflowsStore.getState().remove("1");
    expect(useWorkflowsStore.getState().workflows).toHaveLength(0);
  });
});

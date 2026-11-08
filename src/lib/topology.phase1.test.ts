import { beforeEach, expect, it, vi } from "vitest";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
import * as topology from "./topology";

beforeEach(() => invokeMock.mockReset());

it("projects legacy same-reference kinds deterministically and exposes conflicting fields", () => {
  const rows: topology.TopologyNode[] = [
    { graph_id: "lab", device_ref: "r1", device_kind: "discovered", label: "Claimed", vendor: "juniper" },
    { graph_id: "lab", device_ref: "r1", device_kind: "ssh", label: "Saved", vendor: "cisco" },
    { graph_id: "other", device_ref: "r1", device_kind: "netconf", label: "Foreign" },
  ];
  const first = topology.TopologyProjection.project(rows, "lab");
  const reversed = topology.TopologyProjection.project([...rows].reverse(), "lab");
  expect(first).toEqual(reversed);
  expect(first.nodes).toEqual([rows[1]]);
  expect(first.warnings.join(" ")).toMatch(/r1.*device_kind.*label.*vendor/);
  expect(first.warnings.join(" ")).toContain("Claimed");
});

it("does not merge references just because their labels match", () => {
  const rows: topology.TopologyNode[] = ["10.0.0.1", "10.0.0.2"].map((device_ref) => ({ graph_id: "lab", device_ref, device_kind: "ssh", label: "duplicate" }));
  expect(topology.TopologyProjection.project(rows, "lab").nodes).toHaveLength(2);
});

it("forwards the explicit manual graph and durable layout commands", async () => {
  invokeMock.mockResolvedValue(undefined);
  await topology.topologyApi.discoverDevice("saved", "", "", undefined, "lab");
  expect(invokeMock).toHaveBeenLastCalledWith("topology_discover_device", { connectionId: "saved", vendor: "", platform: "", password: undefined, graphId: "lab" });
  const positions = [{ device_ref: "r1", x: 1, y: 2 }];
  await topology.topologyApi.saveLayout("lab", positions);
  expect(invokeMock).toHaveBeenLastCalledWith("topology_save_layout", { graphId: "lab", positions });
  await topology.topologyApi.resetLayout("lab");
  expect(invokeMock).toHaveBeenLastCalledWith("topology_reset_layout", { graphId: "lab" });
});

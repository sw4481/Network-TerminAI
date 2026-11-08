import { beforeEach, expect, it, vi } from "vitest";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
import { useTopologyStore } from "./topologyStore";
import { TopologyMap } from "../lib/topologyMap";
import type { GraphSnapshot } from "../lib/topology";
const initial = useTopologyStore.getState();
const snapshot: GraphSnapshot = {
  graph: { id: "imported", name: "Imported", created_at: 12, updated_at: 13 }, nodes: [], edges: [], positions: [],
  import_provenance: { format: "sc2", imported_at: 14, node_metadata: [], unsupported_protocols: [] },
};
beforeEach(() => { invokeMock.mockReset(); useTopologyStore.setState({ ...initial, autoRefreshIntervalMs: null }); });
it("adds a completed import without replacing a newer selection or workspace", async () => {
  let resolve!: (value: GraphSnapshot) => void;
  invokeMock.mockReturnValue(new Promise<GraphSnapshot>((done) => { resolve = done; }));
  const pending = useTopologyStore.getState().importGraph("{}", "Imported");
  useTopologyStore.setState({ currentGraphId: "newer", nodes: [], edges: [] });
  resolve(snapshot); await pending;
  expect(invokeMock).toHaveBeenCalledWith("topology_import_graph", { content: "{}", name: "Imported" });
  expect(useTopologyStore.getState().currentGraphId).toBe("newer");
  expect(useTopologyStore.getState().graphs).toContainEqual(snapshot.graph);
  expect(useTopologyStore.getState().nodes).toEqual([]);
});
it("publishes import origin with its owned snapshot and clears it on selection", async () => {
  invokeMock.mockResolvedValue(snapshot);
  useTopologyStore.setState({ currentGraphId: "imported" });
  await useTopologyStore.getState().refresh();
  expect(useTopologyStore.getState().snapshotGraph).toEqual(snapshot.graph);
  expect(useTopologyStore.getState().importProvenance).toEqual(snapshot.import_provenance);
  invokeMock.mockReturnValue(new Promise(() => {}));
  void useTopologyStore.getState().selectGraph("newer");
  expect(useTopologyStore.getState().snapshotGraph).toBeNull();
  expect(useTopologyStore.getState().importProvenance).toBeUndefined();
});
it("classifies imported EIGRP as routing without inventing collection or physical ports", () => {
  expect(TopologyMap.evidenceLabel("eigrp")).toBe("Routing adjacency");
  expect(TopologyMap.portLabel("eigrp", "peer:192.0.2.1")).toBe("Logical peer 192.0.2.1 (port not recorded)");
  expect(TopologyMap.evidenceLabel("unknown")).toBe("Unknown evidence");
});

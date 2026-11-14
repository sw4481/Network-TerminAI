import { beforeEach, expect, it, vi } from "vitest";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
import { useTopologyStore } from "./topologyStore";
import { GLOBAL_GRAPH_ID, type GraphSnapshot } from "../lib/topology";
const initial = useTopologyStore.getState();
const snapshot = (id: string, withEvidence = true): GraphSnapshot => ({ graph: { id, name: id, created_at: 1, updated_at: 2 }, nodes: [], edges: [],
  ...(withEvidence ? { capture_evidence: [{ source_ref: id, protocol: "bgp", source_command: "show ip bgp summary", attempted_at: 100, status: "completed", observations: [] }] } : {}),
});
beforeEach(() => { invokeMock.mockReset(); useTopologyStore.setState({ ...initial, currentGraphId: "a", autoRefreshIntervalMs: null }); });

it("loads local evidence through refresh/select and clears it when absent without import hijacking the current selection", async () => {
  invokeMock.mockResolvedValueOnce(snapshot("a"));
  await useTopologyStore.getState().refresh();
  expect(useTopologyStore.getState().captureEvidence).toEqual(snapshot("a").capture_evidence);
  let resolve!: (value: GraphSnapshot) => void;
  invokeMock.mockReturnValueOnce(new Promise<GraphSnapshot>((done) => { resolve = done; }));
  const select = useTopologyStore.getState().selectGraph("b");
  expect(useTopologyStore.getState().captureEvidence).toEqual([]);
  resolve(snapshot("b")); await select;
  expect(useTopologyStore.getState().captureEvidence).toEqual(snapshot("b").capture_evidence);
  invokeMock.mockResolvedValueOnce(snapshot("imported", false));
  await useTopologyStore.getState().importGraph("synthetic-json", "Imported");
  expect(useTopologyStore.getState().currentGraphId).toBe("b");
  expect(useTopologyStore.getState().captureEvidence).toEqual(snapshot("b").capture_evidence);
  invokeMock.mockResolvedValueOnce(snapshot("imported", false));
  await useTopologyStore.getState().selectGraph("imported");
  expect(useTopologyStore.getState().captureEvidence).toEqual([]);
  expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["topology_get_graph", "topology_get_graph", "topology_import_graph", "topology_get_graph"]);
});

it("rejects evidence from stale refreshes or a foreign graph and preserves it on refresh failure", async () => {
  let resolve!: (value: GraphSnapshot) => void;
  invokeMock.mockReturnValueOnce(new Promise<GraphSnapshot>((done) => { resolve = done; }));
  const old = useTopologyStore.getState().refresh();
  invokeMock.mockResolvedValueOnce(snapshot("b"));
  await useTopologyStore.getState().selectGraph("b");
  resolve(snapshot("a")); await old;
  expect(useTopologyStore.getState().captureEvidence).toEqual(snapshot("b").capture_evidence);
  invokeMock.mockResolvedValueOnce(snapshot("foreign"));
  await useTopologyStore.getState().refresh();
  expect(useTopologyStore.getState().captureEvidence).toEqual(snapshot("b").capture_evidence);
  invokeMock.mockRejectedValueOnce(new Error("synthetic-failure"));
  await useTopologyStore.getState().refresh();
  expect(useTopologyStore.getState().captureEvidence).toEqual(snapshot("b").capture_evidence);
  invokeMock.mockResolvedValueOnce(snapshot("b", false));
  await useTopologyStore.getState().refresh();
  expect(useTopologyStore.getState().captureEvidence).toEqual([]);
});

it("clear invalidates pending evidence and background Global refresh cannot replace selected evidence", async () => {
  invokeMock.mockResolvedValueOnce(snapshot("a")); await useTopologyStore.getState().refresh();
  invokeMock.mockResolvedValueOnce(snapshot(GLOBAL_GRAPH_ID)); await useTopologyStore.getState().refreshGlobal();
  expect(useTopologyStore.getState().captureEvidence).toEqual(snapshot("a").capture_evidence);
  let resolve!: (value: GraphSnapshot) => void;
  invokeMock.mockReturnValueOnce(new Promise<GraphSnapshot>((done) => { resolve = done; }));
  const old = useTopologyStore.getState().refresh();
  invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(snapshot("a", false));
  await useTopologyStore.getState().clearGraph("a");
  resolve(snapshot("a")); await old;
  expect(useTopologyStore.getState().captureEvidence).toEqual([]);
});

import { beforeEach, expect, it, vi } from "vitest";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
import { useTopologyStore } from "./topologyStore";
import { topologyApi, type DiscoveryRun } from "../lib/topology";
const initial = useTopologyStore.getState();
const report = (run_id = "run-a", graph_id = "graph-a"): DiscoveryRun => ({ run_id, graph_id, state: "running", max_depth: 0, devices: [], not_dialed: [], additional_not_dialed: 0, nodes_processed: 0, edges_processed: 0, parser_admission_ms: 0, parser_reply_ms: 0 });
const request = { graph_id: "graph-a", seed_ids: ["seed"], eligible_ids: ["seed"], passwords: { seed: "temporary-synthetic" }, max_depth: 0 as const };
beforeEach(() => { invokeMock.mockReset(); useTopologyStore.setState({ ...initial, autoRefreshIntervalMs: null }); });
it("sends explicit scope once and retains only secret-free native report across selection changes", async () => {
  let done!: (run: DiscoveryRun) => void;
  invokeMock.mockReturnValue(new Promise<DiscoveryRun>((resolve) => { done = resolve; }));
  const start = useTopologyStore.getState().startDiscovery(request);
  await useTopologyStore.getState().startDiscovery(request);
  expect(invokeMock).toHaveBeenCalledTimes(1);
  useTopologyStore.setState({ currentGraphId: "other" });
  done(report()); await start;
  expect(invokeMock).toHaveBeenCalledWith("topology_discovery_start", { request });
  expect(useTopologyStore.getState().currentGraphId).toBe("other");
  expect(useTopologyStore.getState().discoveryRun?.graph_id).toBe("graph-a");
  expect(JSON.stringify(useTopologyStore.getState())).not.toContain("temporary-synthetic");
});
it("recovers the native run on remount without selecting its destination", async () => {
  invokeMock.mockResolvedValue(report());
  useTopologyStore.setState({ currentGraphId: "other" });
  await useTopologyStore.getState().refreshDiscovery();
  expect(invokeMock).toHaveBeenCalledWith("topology_discovery_status", { runId: undefined });
  expect(useTopologyStore.getState().discoveryRun?.run_id).toBe("run-a");
  expect(useTopologyStore.getState().currentGraphId).toBe("other");
});
it("rejects late poll and Stop replies after a new run takes ownership", async () => {
  useTopologyStore.setState({ discoveryRun: report() });
  let pollDone!: (run: DiscoveryRun) => void;
  invokeMock.mockReturnValueOnce(new Promise<DiscoveryRun>((resolve) => { pollDone = resolve; }));
  const poll = useTopologyStore.getState().refreshDiscovery("run-a");
  invokeMock.mockResolvedValueOnce(report("run-b"));
  await useTopologyStore.getState().startDiscovery(request);
  pollDone({ ...report(), state: "completed" }); await poll;
  expect(useTopologyStore.getState().discoveryRun?.run_id).toBe("run-b");
  let stopDone!: (run: DiscoveryRun) => void;
  invokeMock.mockReturnValueOnce(new Promise<DiscoveryRun>((resolve) => { stopDone = resolve; }));
  const stop = useTopologyStore.getState().cancelDiscovery();
  useTopologyStore.setState({ discoveryRun: report("run-c") });
  stopDone({ ...report("run-b"), state: "cancelling" }); await stop;
  expect(useTopologyStore.getState().discoveryRun?.run_id).toBe("run-c");
});
it("refreshes only the completed destination, preserving another selected graph", async () => {
  const refresh = vi.fn(); const refreshGlobal = vi.fn();
  useTopologyStore.setState({ discoveryRun: report(), currentGraphId: "other", refresh, refreshGlobal });
  invokeMock.mockResolvedValue({ ...report(), state: "cancelled", nodes_processed: 1 });
  await useTopologyStore.getState().refreshDiscovery("run-a");
  expect(refresh).not.toHaveBeenCalled(); expect(refreshGlobal).not.toHaveBeenCalled();
  expect(useTopologyStore.getState().discoveryRun?.nodes_processed).toBe(1);
});
it("surfaces generic start/Stop errors without retaining request secrets", async () => {
  invokeMock.mockRejectedValue(new Error("temporary-synthetic"));
  await useTopologyStore.getState().startDiscovery(request);
  expect(useTopologyStore.getState().discoveryError).toContain("Could not start");
  useTopologyStore.setState({ discoveryRun: report() });
  await useTopologyStore.getState().cancelDiscovery();
  expect(useTopologyStore.getState().discoveryError).toContain("Stop could not be confirmed");
  expect(JSON.stringify(useTopologyStore.getState())).not.toContain("temporary-synthetic");
});
it("refreshes distinct completed runs and retries a failed destination refresh", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  useTopologyStore.setState({ discoveryRun: { ...report(), state: "completed" }, currentGraphId: "graph-a", refresh });
  invokeMock.mockResolvedValue({ ...report("run-b"), state: "completed" });
  await useTopologyStore.getState().refreshDiscovery();
  expect(refresh).toHaveBeenCalledTimes(1);
  refresh.mockImplementationOnce(async () => { useTopologyStore.setState({ error: "Synthetic snapshot failure" }); });
  await useTopologyStore.getState().refreshDiscovery();
  await useTopologyStore.getState().refreshDiscovery();
  expect(refresh).toHaveBeenCalledTimes(3);
});
it("gives pending Stop ownership over overlapping status polls", async () => {
  useTopologyStore.setState({ discoveryRun: report() });
  let stopDone!: (run: DiscoveryRun) => void;
  invokeMock.mockReturnValueOnce(new Promise<DiscoveryRun>((resolve) => { stopDone = resolve; }));
  const stop = useTopologyStore.getState().cancelDiscovery();
  invokeMock.mockResolvedValueOnce(report());
  await useTopologyStore.getState().refreshDiscovery("run-a");
  stopDone({ ...report(), state: "cancelling" }); await stop;
  expect(useTopologyStore.getState().discoveryRun?.state).toBe("cancelling");
});
it("recovers the current native run after scoped status expires", async () => {
  useTopologyStore.setState({ discoveryRun: report() });
  invokeMock.mockRejectedValueOnce(new Error("Discovery run is no longer available")).mockResolvedValueOnce(report("run-b"));
  await useTopologyStore.getState().refreshDiscovery("run-a");
  expect(useTopologyStore.getState().discoveryRun?.run_id).toBe("run-b");
  expect(useTopologyStore.getState().discoveryError).toBeNull();
  expect(invokeMock).toHaveBeenLastCalledWith("topology_discovery_status", { runId: undefined });
});
it("keeps start/status/cancel wrappers thin and run-scoped", async () => {
  invokeMock.mockResolvedValue(report());
  await topologyApi.startDiscovery(request); await topologyApi.discoveryStatus("run-a"); await topologyApi.cancelDiscovery("run-a");
  expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(["topology_discovery_start", "topology_discovery_status", "topology_discovery_cancel"]);
  expect(invokeMock).toHaveBeenLastCalledWith("topology_discovery_cancel", { runId: "run-a" });
});

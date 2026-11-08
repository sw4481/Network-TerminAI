import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
import { useTopologyStore } from "./topologyStore";
import { GLOBAL_GRAPH_ID, type GraphSnapshot } from "../lib/topology";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const snapshot = (id: string, ref = id): GraphSnapshot => ({
  graph: { id, name: id, created_at: 0, updated_at: 0 },
  nodes: [{ graph_id: id, device_ref: ref, device_kind: "ssh", label: ref }],
  edges: [],
  positions: [{ device_ref: ref, x: 12, y: 34 }],
});
const capture = (status: string, records = 0) => ({ protocol: "cdp", status, records });
const outcome = (status: string, records = 0) => ({
  status, nodes_added: records, edges_added: records, cache_updated: status !== "failed",
  captures: [capture(status === "partial" ? "failed" : status, records)],
});
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  invokeMock.mockReset();
  useTopologyStore.setState({
    graphs: [], currentGraphId: GLOBAL_GRAPH_ID, nodes: [], edges: [], positions: [],
    globalNodes: [], globalEdges: [], layoutAttempts: new Map(),
    loading: false, error: null, layoutError: null, autoRefreshIntervalMs: null,
  });
  invokeMock.mockImplementation((command: string, args: { graphId: string }) => {
    if (command === "topology_get_graph") return Promise.resolve(snapshot(args.graphId));
    return Promise.resolve(undefined);
  });
});

describe("Phase 1 graph ownership", () => {
  it("clears the previous graph immediately and ignores its late snapshot", async () => {
    const old = deferred<GraphSnapshot>();
    invokeMock.mockImplementation((command: string, args: { graphId: string }) => {
      if (command === "topology_get_graph") return args.graphId === GLOBAL_GRAPH_ID ? old.promise : Promise.resolve(snapshot("lab"));
    });
    const first = useTopologyStore.getState().refresh();
    useTopologyStore.setState({ nodes: snapshot(GLOBAL_GRAPH_ID).nodes });
    const second = useTopologyStore.getState().selectGraph("lab");
    expect(useTopologyStore.getState().nodes).toEqual([]);
    await second;
    old.resolve(snapshot(GLOBAL_GRAPH_ID));
    await first;
    expect(useTopologyStore.getState().nodes[0].graph_id).toBe("lab");
    expect(useTopologyStore.getState().positions).toEqual(snapshot("lab").positions);
  });

  it("ignores an older same-graph refresh and its late error", async () => {
    const old = deferred<GraphSnapshot>();
    invokeMock.mockImplementationOnce(() => old.promise);
    const first = useTopologyStore.getState().refresh();
    await useTopologyStore.getState().refresh();
    old.reject(new Error("obsolete"));
    await first;
    expect(useTopologyStore.getState().error).toBeNull();
    expect(useTopologyStore.getState().nodes).toEqual(snapshot(GLOBAL_GRAPH_ID).nodes);
  });

  it("does not let a pending graph list erase a newly created graph", async () => {
    const list = deferred<GraphSnapshot["graph"][]>();
    invokeMock.mockImplementation((command: string) => command === "topology_list_graphs" ? list.promise : Promise.resolve(snapshot("new").graph));
    const pending = useTopologyStore.getState().loadGraphs();
    await useTopologyStore.getState().createGraph("new");
    list.resolve([snapshot(GLOBAL_GRAPH_ID).graph]);
    await pending;
    expect(useTopologyStore.getState().graphs.map((graph) => graph.id)).toEqual([GLOBAL_GRAPH_ID, "new"]);
  });

  it("keeps legacy automatic ingestion Global-only without refreshing a selected named graph", async () => {
    useTopologyStore.setState({ currentGraphId: "lab" });
    await useTopologyStore.getState().ingestFromText("show cdp neighbors", "output", "cisco", "iosxe", "r1", "ssh");
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["topology_ingest_from_text", "topology_get_graph"]);
    expect(invokeMock.mock.calls[0][1]).not.toHaveProperty("graphId");
    expect(invokeMock).toHaveBeenLastCalledWith("topology_get_graph", { graphId: GLOBAL_GRAPH_ID });
    expect(useTopologyStore.getState().currentGraphId).toBe("lab");
    expect(useTopologyStore.getState().nodes).toEqual([]);
    expect(useTopologyStore.getState().globalNodes).toEqual(snapshot(GLOBAL_GRAPH_ID).nodes);
  });

  it("hydrates the initially empty Global cache after its first read completes with a named workspace selected", async () => {
    const pending = deferred<GraphSnapshot>();
    const global = snapshot(GLOBAL_GRAPH_ID);
    global.nodes.push(...snapshot(GLOBAL_GRAPH_ID, "peer").nodes);
    global.edges.push({ graph_id: GLOBAL_GRAPH_ID, a_device_ref: GLOBAL_GRAPH_ID, a_port: "Gi1", b_device_ref: "peer", b_port: "Gi2", protocol: "cdp", captured_at: 0 });
    invokeMock.mockImplementation((_command: string, args: { graphId: string }) => args.graphId === GLOBAL_GRAPH_ID ? pending.promise : Promise.resolve(snapshot(args.graphId)));
    expect(useTopologyStore.getState().globalNodes).toEqual([]);
    const first = useTopologyStore.getState().refresh();
    await useTopologyStore.getState().selectGraph("lab");
    const named = useTopologyStore.getState();
    pending.resolve(global);
    await first;
    const state = useTopologyStore.getState();
    expect(state.globalNodes).toEqual(global.nodes);
    expect(state.globalEdges).toEqual(global.edges);
    expect(state).toMatchObject({ currentGraphId: "lab", nodes: named.nodes, edges: named.edges, positions: named.positions, loading: named.loading, error: named.error });
  });

  it("retains the completed Global snapshot when switching away during a pending Global load", async () => {
    await useTopologyStore.getState().selectGraph("lab");
    await useTopologyStore.getState().refreshGlobal();
    const pending = deferred<GraphSnapshot>();
    invokeMock.mockImplementation((_command: string, args: { graphId: string }) => args.graphId === GLOBAL_GRAPH_ID ? pending.promise : Promise.resolve(snapshot(args.graphId)));
    const selecting = useTopologyStore.getState().selectGraph(GLOBAL_GRAPH_ID);
    await useTopologyStore.getState().selectGraph("lab");
    expect(useTopologyStore.getState().globalNodes).toEqual(snapshot(GLOBAL_GRAPH_ID).nodes);
    pending.resolve(snapshot(GLOBAL_GRAPH_ID, "fresh Global"));
    await selecting;
    expect(useTopologyStore.getState().globalNodes).toEqual(snapshot(GLOBAL_GRAPH_ID, "fresh Global").nodes);
    expect(useTopologyStore.getState().nodes).toEqual(snapshot("lab").nodes);
  });

  it.each(["newer Global read", "Global clear", "foreign graph response"])("rejects late Global cache publication after %s", async (reason) => {
    const pending = deferred<GraphSnapshot>();
    let globalReads = 0;
    invokeMock.mockImplementation((command: string, args: { graphId: string }) => {
      if (command !== "topology_get_graph") return Promise.resolve();
      if (args.graphId === GLOBAL_GRAPH_ID) return ++globalReads === 1 ? pending.promise : Promise.resolve(snapshot(GLOBAL_GRAPH_ID, "newest"));
      return Promise.resolve(snapshot(args.graphId));
    });
    const first = useTopologyStore.getState().refresh();
    await useTopologyStore.getState().selectGraph("lab");
    if (reason === "newer Global read") await useTopologyStore.getState().refreshGlobal();
    if (reason === "Global clear") await useTopologyStore.getState().clearGraph(GLOBAL_GRAPH_ID);
    pending.resolve(snapshot(reason === "foreign graph response" ? "foreign" : GLOBAL_GRAPH_ID, "stale"));
    await first;
    expect(useTopologyStore.getState().globalNodes).toEqual(reason === "newer Global read" ? snapshot(GLOBAL_GRAPH_ID, "newest").nodes : []);
    expect(useTopologyStore.getState()).toMatchObject({ currentGraphId: "lab", nodes: snapshot("lab").nodes, error: null });
  });

  it("snapshots the manual destination for every selected device and counts failed responses honestly", async () => {
    const first = deferred<ReturnType<typeof outcome>>();
    let calls = 0;
    invokeMock.mockImplementation((command: string, args: { graphId: string }) => {
      if (command === "topology_discover_device") return ++calls === 1 ? first.promise : Promise.resolve(outcome("failed"));
      if (command === "topology_get_graph") return Promise.resolve(snapshot(args.graphId));
    });
    const pending = useTopologyStore.getState().discoverDevices(["one", "two"], {});
    await useTopologyStore.getState().selectGraph("lab");
    first.resolve(outcome("completed", 0));
    const result = await pending;
    const discoveries = invokeMock.mock.calls.filter(([command]) => command === "topology_discover_device");
    expect(discoveries.map(([, args]) => args.graphId)).toEqual([GLOBAL_GRAPH_ID, GLOBAL_GRAPH_ID]);
    expect(discoveries[0][1]).toMatchObject({ vendor: "", platform: "" });
    expect(result).toMatchObject({ succeeded: 1, failed: 1, partial: 0, nodesProcessed: 0, edgesProcessed: 0 });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(useTopologyStore.getState().currentGraphId).toBe("lab");
  });

  it("distinguishes partial, completed with processed rows, and valid empty", async () => {
    invokeMock.mockImplementation((command: string, args: { connectionId: string; graphId: string }) => {
      if (command === "topology_get_graph") return Promise.resolve(snapshot(args.graphId));
      if (command === "topology_discover_device") return Promise.resolve(outcome(args.connectionId === "partial" ? "partial" : "completed", args.connectionId === "empty" ? 0 : 3));
    });
    const result = await useTopologyStore.getState().discoverDevices(["partial", "rows", "empty"], {});
    expect(result).toMatchObject({ succeeded: 2, partial: 1, failed: 0, nodesProcessed: 6, edgesProcessed: 6 });
  });
});

describe("Phase 1 durable layout", () => {
  it("serializes saves per graph so older writes cannot finish after newer writes", async () => {
    const first = deferred<void>();
    let saves = 0;
    invokeMock.mockImplementation((command: string) => command === "topology_save_layout" && ++saves === 1 ? first.promise : Promise.resolve());
    const a = useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r1", x: 1, y: 1 }]);
    const b = useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r1", x: 2, y: 2 }]);
    await tick();
    expect(saves).toBe(1);
    first.resolve();
    await Promise.all([a, b]);
    expect(saves).toBe(2);
    expect(useTopologyStore.getState().positions).toEqual([{ device_ref: "r1", x: 2, y: 2 }]);
  });

  it("surfaces layout failure without claiming save or losing the dragged position", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));
    const saved = await useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r1", x: 4, y: 5 }]);
    expect(saved).toBe(false);
    expect(useTopologyStore.getState().layoutError).toContain("disk full");
    expect(useTopologyStore.getState().positions).toEqual([{ device_ref: "r1", x: 4, y: 5 }]);
  });

  it("does not show an old graph's save failure in a newly selected graph", async () => {
    const save = deferred<void>();
    invokeMock.mockImplementation((command: string, args: { graphId: string }) => command === "topology_save_layout" ? save.promise : Promise.resolve(snapshot(args.graphId)));
    const pending = useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r1", x: 1, y: 1 }]);
    await tick();
    await useTopologyStore.getState().selectGraph("lab");
    save.reject(new Error("old failure"));
    await pending;
    expect(useTopologyStore.getState().layoutError).toBeNull();
    expect(useTopologyStore.getState().positions).toEqual(snapshot("lab").positions);
  });

  it("retains a late failed save for A after switching A to B and back", async () => {
    const save = deferred<void>();
    invokeMock.mockImplementation((command: string, args: { graphId: string }) => command === "topology_save_layout" ? save.promise : Promise.resolve(snapshot(args.graphId)));
    await useTopologyStore.getState().selectGraph("save-A");
    const attempted = [{ device_ref: "save-A", x: 401, y: 502 }];
    const saving = useTopologyStore.getState().saveLayout("save-A", attempted);
    await tick();
    await useTopologyStore.getState().selectGraph("save-B");
    expect(useTopologyStore.getState().layoutError).toBeNull();
    expect(useTopologyStore.getState().positions).toEqual(snapshot("save-B").positions);
    const returning = useTopologyStore.getState().selectGraph("save-A");
    save.reject(new Error("A disk full"));
    await Promise.all([saving, returning]);
    expect(useTopologyStore.getState().layoutError).toContain("A disk full");
    expect(useTopologyStore.getState().positions).toEqual(attempted);
    await useTopologyStore.getState().selectGraph("save-B");
    expect(useTopologyStore.getState().layoutError).toBeNull();
    await useTopologyStore.getState().selectGraph("save-A");
    expect(useTopologyStore.getState().positions).toEqual(attempted);
    expect(useTopologyStore.getState().layoutError).toContain("A disk full");
  });

  it("attributes a late reset failure to its graph across A to B to A", async () => {
    const reset = deferred<void>();
    invokeMock.mockImplementation((command: string, args: { graphId: string }) => command === "topology_reset_layout" ? reset.promise : Promise.resolve(snapshot(args.graphId)));
    await useTopologyStore.getState().selectGraph("reset-A");
    const resetting = useTopologyStore.getState().resetLayout("reset-A");
    await useTopologyStore.getState().selectGraph("reset-B");
    expect(useTopologyStore.getState().layoutError).toBeNull();
    const returning = useTopologyStore.getState().selectGraph("reset-A");
    reset.reject(new Error("reset disk full"));
    await Promise.all([resetting, returning]);
    expect(useTopologyStore.getState().layoutError).toContain("reset disk full");
    expect(useTopologyStore.getState().positions).toEqual(snapshot("reset-A").positions);
  });

  it.each(["reset", "clear"])("does not resurrect failed coordinates after successful %s while another graph is selected", async (operation) => {
    const graphId = `failed-${operation}`;
    invokeMock.mockImplementation((command: string, args: { graphId: string }) => {
      if (command === "topology_save_layout") return Promise.reject(new Error("failed position"));
      if (command === "topology_get_graph") return Promise.resolve({ ...snapshot(args.graphId), positions: [] });
      return Promise.resolve();
    });
    await useTopologyStore.getState().selectGraph(graphId);
    await useTopologyStore.getState().saveLayout(graphId, [{ device_ref: graphId, x: 401, y: 502 }]);
    const pending = operation === "reset" ? useTopologyStore.getState().resetLayout(graphId) : useTopologyStore.getState().clearGraph(graphId);
    await useTopologyStore.getState().selectGraph("unrelated");
    await pending;
    await useTopologyStore.getState().selectGraph(graphId);
    expect(useTopologyStore.getState().layoutError).toBeNull();
    expect(useTopologyStore.getState().positions).toEqual([]);
  });

  it("queues clear after a pending save and discards stale pre-clear snapshots", async () => {
    const save = deferred<void>();
    const stale = deferred<GraphSnapshot>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "topology_save_layout") return save.promise;
      if (command === "topology_get_graph") return stale.promise;
      return Promise.resolve();
    });
    const refresh = useTopologyStore.getState().refresh();
    const saving = useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r1", x: 1, y: 1 }]);
    const clearing = useTopologyStore.getState().clearGraph(GLOBAL_GRAPH_ID);
    await tick();
    expect(invokeMock.mock.calls.some(([command]) => command === "topology_clear_graph")).toBe(false);
    stale.resolve(snapshot(GLOBAL_GRAPH_ID));
    await refresh;
    expect(useTopologyStore.getState().nodes).toEqual([]);
    invokeMock.mockImplementation((command: string) => command === "topology_get_graph" ? Promise.resolve({ ...snapshot(GLOBAL_GRAPH_ID), nodes: [], positions: [] }) : Promise.resolve());
    save.resolve();
    await Promise.all([saving, clearing]);
    expect(useTopologyStore.getState().nodes).toEqual([]);
    expect(useTopologyStore.getState().positions).toEqual([]);
  });

  it("a later successful different-node save also persists the previously failed position", async () => {
    let saves = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "topology_get_graph") return Promise.resolve({ ...snapshot(GLOBAL_GRAPH_ID), positions: [] });
      return ++saves === 1 ? Promise.reject(new Error("temporary failure")) : Promise.resolve();
    });
    await useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r1", x: 1, y: 1 }]);
    await useTopologyStore.getState().refresh();
    expect(useTopologyStore.getState().layoutError).toContain("temporary failure");
    await useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r2", x: 2, y: 2 }]);
    expect(invokeMock).toHaveBeenLastCalledWith("topology_save_layout", { graphId: GLOBAL_GRAPH_ID, positions: [
      { device_ref: "r1", x: 1, y: 1 }, { device_ref: "r2", x: 2, y: 2 },
    ] });
    expect(useTopologyStore.getState().layoutError).toBeNull();
  });

  it("does not admit a stale drag while a layout reset is pending", async () => {
    const reset = deferred<void>();
    invokeMock.mockImplementation((command: string) => command === "topology_reset_layout" ? reset.promise : Promise.resolve());
    const pending = useTopologyStore.getState().resetLayout(GLOBAL_GRAPH_ID);
    await tick();
    const saving = useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r1", x: 9, y: 9 }]);
    await tick();
    reset.resolve();
    await pending;
    const saved = await saving;
    expect(saved).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "topology_save_layout")).toBe(false);
    expect(useTopologyStore.getState().positions).toEqual([]);
  });

  it("rejects stale-graph or nonfinite saves before IPC", async () => {
    expect(await useTopologyStore.getState().saveLayout("other", [{ device_ref: "r1", x: 1, y: 1 }])).toBe(false);
    expect(await useTopologyStore.getState().saveLayout(GLOBAL_GRAPH_ID, [{ device_ref: "r1", x: Infinity, y: 1 }])).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

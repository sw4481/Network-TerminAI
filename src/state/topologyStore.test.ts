import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  useTopologyStore,
  selectNodesByVendor,
  selectEdgesByProtocol,
} from "./topologyStore";
import {
  GLOBAL_GRAPH_ID,
  type TopologyGraph,
  type TopologyNode,
  type TopologyEdge,
  type GraphSnapshot,
  type IngestSummary,
} from "../lib/topology";

/**
 * Each test resets the store back to its initial state so action
 * sequencing (e.g. `selectGraph` → `refresh`) is observable in
 * isolation.
 */
function resetStore() {
  useTopologyStore.setState({
    graphs: [],
    currentGraphId: GLOBAL_GRAPH_ID,
    nodes: [],
    edges: [],
    loading: false,
    error: null,
    autoRefreshIntervalMs: null,
  });
}

describe("topologyStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
  });

  it("loadGraphs populates `graphs` and clears `loading`", async () => {
    const graphs: TopologyGraph[] = [
      {
        id: GLOBAL_GRAPH_ID,
        name: "Global",
        created_at: 0,
        updated_at: 0,
      },
      { id: "g-1", name: "lab", created_at: 1, updated_at: 1 },
    ];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "topology_list_graphs") return Promise.resolve(graphs);
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await useTopologyStore.getState().loadGraphs();

    const state = useTopologyStore.getState();
    expect(state.graphs).toEqual(graphs);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("loadGraphs records an error and clears `loading` on failure", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    await useTopologyStore.getState().loadGraphs();
    const state = useTopologyStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toContain("boom");
    expect(state.graphs).toEqual([]);
  });

  it("selectGraph updates `currentGraphId` and triggers `refresh`", async () => {
    const snap: GraphSnapshot = {
      graph: { id: "g-1", name: "lab", created_at: 0, updated_at: 0 },
      nodes: [
        {
          graph_id: "g-1",
          device_ref: "R1",
          device_kind: "ssh",
          label: "R1",
        },
      ],
      edges: [],
    };
    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "topology_get_graph") {
        expect(args).toEqual({ graphId: "g-1" });
        return Promise.resolve(snap);
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await useTopologyStore.getState().selectGraph("g-1");

    const state = useTopologyStore.getState();
    expect(state.currentGraphId).toBe("g-1");
    expect(state.nodes).toEqual(snap.nodes);
    expect(state.edges).toEqual(snap.edges);
    expect(state.loading).toBe(false);
  });

  it("refresh populates `nodes`/`edges` from the snapshot", async () => {
    const snap: GraphSnapshot = {
      graph: {
        id: GLOBAL_GRAPH_ID,
        name: "Global",
        created_at: 0,
        updated_at: 0,
      },
      nodes: [
        {
          graph_id: GLOBAL_GRAPH_ID,
          device_ref: "R1",
          device_kind: "ssh",
          label: "R1",
        },
        {
          graph_id: GLOBAL_GRAPH_ID,
          device_ref: "R2",
          device_kind: "ssh",
          label: "R2",
        },
      ],
      edges: [
        {
          graph_id: GLOBAL_GRAPH_ID,
          a_device_ref: "R1",
          a_port: "Gi0/0",
          b_device_ref: "R2",
          b_port: "Gi0/0",
          protocol: "cdp",
          captured_at: 1,
        },
      ],
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "topology_get_graph") return Promise.resolve(snap);
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await useTopologyStore.getState().refresh();

    const state = useTopologyStore.getState();
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("refresh records an error on failure", async () => {
    invokeMock.mockRejectedValue(new Error("db locked"));
    await useTopologyStore.getState().refresh();
    const state = useTopologyStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toContain("db locked");
  });

  it("ingestFromBlock calls topology_ingest_from_block then triggers refresh", async () => {
    const summary: IngestSummary = {
      nodes_added: 2,
      edges_added: 1,
      cache_updated: true,
    };
    const snap: GraphSnapshot = {
      graph: {
        id: GLOBAL_GRAPH_ID,
        name: "Global",
        created_at: 0,
        updated_at: 0,
      },
      nodes: [
        {
          graph_id: GLOBAL_GRAPH_ID,
          device_ref: "R1",
          device_kind: "ssh",
          label: "R1",
        },
      ],
      edges: [],
    };

    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "topology_ingest_from_block") {
        expect(args).toEqual({
          blockId: "b1",
          vendor: "cisco",
          platform: "iosxe",
          deviceRef: "R1",
          deviceKind: "ssh",
        });
        return Promise.resolve(summary);
      }
      if (cmd === "topology_get_graph") {
        return Promise.resolve(snap);
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await useTopologyStore
      .getState()
      .ingestFromBlock("b1", "cisco", "iosxe", "R1", "ssh");

    // Both commands should have been invoked, in order.
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["topology_ingest_from_block", "topology_get_graph"]);

    const state = useTopologyStore.getState();
    expect(state.nodes).toEqual(snap.nodes);
  });

  it("ingestFromBlock swallows ingest errors (does not throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "topology_ingest_from_block") {
        return Promise.reject(new Error("parser blew up"));
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await expect(
      useTopologyStore
        .getState()
        .ingestFromBlock("b1", "cisco", "iosxe", "R1", "ssh"),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("createGraph appends to `graphs`", async () => {
    const g: TopologyGraph = {
      id: "g-new",
      name: "lab",
      created_at: 1,
      updated_at: 1,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "topology_create_graph") return Promise.resolve(g);
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await useTopologyStore.getState().createGraph("lab");
    expect(useTopologyStore.getState().graphs).toEqual([g]);
  });

  it("clearGraph triggers refresh when clearing the active graph", async () => {
    const snap: GraphSnapshot = {
      graph: {
        id: GLOBAL_GRAPH_ID,
        name: "Global",
        created_at: 0,
        updated_at: 0,
      },
      nodes: [],
      edges: [],
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "topology_clear_graph") return Promise.resolve(undefined);
      if (cmd === "topology_get_graph") return Promise.resolve(snap);
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    // Seed some stale nodes so we can verify they get replaced.
    useTopologyStore.setState({
      nodes: [
        {
          graph_id: GLOBAL_GRAPH_ID,
          device_ref: "stale",
          device_kind: "ssh",
          label: "stale",
        },
      ],
    });

    await useTopologyStore.getState().clearGraph(GLOBAL_GRAPH_ID);

    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["topology_clear_graph", "topology_get_graph"]);
    expect(useTopologyStore.getState().nodes).toEqual([]);
  });

  it("clearGraph does NOT refresh when clearing a non-active graph", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "topology_clear_graph") return Promise.resolve(undefined);
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await useTopologyStore.getState().clearGraph("some-other-graph");
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["topology_clear_graph"]);
  });
});

describe("topologyStore selectors", () => {
  it("selectNodesByVendor groups case-insensitively and buckets nullish under 'unknown'", () => {
    const nodes: TopologyNode[] = [
      {
        graph_id: GLOBAL_GRAPH_ID,
        device_ref: "R1",
        device_kind: "ssh",
        label: "R1",
        vendor: "Cisco",
      },
      {
        graph_id: GLOBAL_GRAPH_ID,
        device_ref: "R2",
        device_kind: "ssh",
        label: "R2",
        vendor: "cisco",
      },
      {
        graph_id: GLOBAL_GRAPH_ID,
        device_ref: "J1",
        device_kind: "netconf",
        label: "J1",
        vendor: "Juniper",
      },
      {
        graph_id: GLOBAL_GRAPH_ID,
        device_ref: "X1",
        device_kind: "discovered",
        label: "X1",
      },
    ];
    const m = selectNodesByVendor({
      graphs: [],
      currentGraphId: GLOBAL_GRAPH_ID,
      nodes,
      edges: [],
      loading: false,
      error: null,
      // actions are not touched by the selector
      autoRefreshIntervalMs: null,
      loadGraphs: async () => {},
      selectGraph: async () => {},
      refresh: async () => {},
      ingestFromBlock: async () => {},
      ingestFromText: async () => {},
      discoverDevices: async () => ({ succeeded: 0, failed: 0, errors: [] }),
      createGraph: async () => {},
      clearGraph: async () => {},
      setAutoRefreshInterval: () => {},
    });
    expect(m.get("cisco")?.length).toBe(2);
    expect(m.get("juniper")?.length).toBe(1);
    expect(m.get("unknown")?.length).toBe(1);
  });

  it("selectEdgesByProtocol groups by protocol token", () => {
    const edges: TopologyEdge[] = [
      {
        graph_id: GLOBAL_GRAPH_ID,
        a_device_ref: "R1",
        a_port: "Gi0/0",
        b_device_ref: "R2",
        b_port: "Gi0/0",
        protocol: "cdp",
        captured_at: 1,
      },
      {
        graph_id: GLOBAL_GRAPH_ID,
        a_device_ref: "R2",
        a_port: "Gi0/1",
        b_device_ref: "R3",
        b_port: "Gi0/1",
        protocol: "cdp",
        captured_at: 2,
      },
      {
        graph_id: GLOBAL_GRAPH_ID,
        a_device_ref: "R3",
        a_port: "Gi0/2",
        b_device_ref: "R4",
        b_port: "Gi0/2",
        protocol: "lldp",
        captured_at: 3,
      },
    ];
    const m = selectEdgesByProtocol({
      graphs: [],
      currentGraphId: GLOBAL_GRAPH_ID,
      nodes: [],
      edges,
      loading: false,
      error: null,
      autoRefreshIntervalMs: null,
      loadGraphs: async () => {},
      selectGraph: async () => {},
      refresh: async () => {},
      ingestFromBlock: async () => {},
      ingestFromText: async () => {},
      discoverDevices: async () => ({ succeeded: 0, failed: 0, errors: [] }),
      createGraph: async () => {},
      clearGraph: async () => {},
      setAutoRefreshInterval: () => {},
    });
    expect(m.get("cdp")?.length).toBe(2);
    expect(m.get("lldp")?.length).toBe(1);
  });
});

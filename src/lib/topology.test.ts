import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  topologyApi,
  TOPOLOGY_TRIGGER_CMD_RE,
  ENABLE_TOPOLOGY_INGEST_KEY,
  isTopologyIngestEnabled,
  GLOBAL_GRAPH_ID,
  type IngestSummary,
  type TopologyGraph,
  type GraphSnapshot,
  type NeighborCacheRow,
} from "./topology";

describe("topology.ts", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  describe("topologyApi", () => {
    it("ingestFromBlock invokes topology_ingest_from_block with the right payload", async () => {
      const summary: IngestSummary = {
        nodes_added: 3,
        edges_added: 2,
        cache_updated: true,
      };
      invokeMock.mockResolvedValue(summary);
      const r = await topologyApi.ingestFromBlock(
        "b1",
        "cisco",
        "iosxe",
        "R1",
        "ssh",
      );
      expect(invokeMock).toHaveBeenCalledWith("topology_ingest_from_block", {
        blockId: "b1",
        vendor: "cisco",
        platform: "iosxe",
        deviceRef: "R1",
        deviceKind: "ssh",
      });
      expect(r).toEqual(summary);
    });

    it("listGraphs invokes topology_list_graphs and returns the list", async () => {
      const graphs: TopologyGraph[] = [
        {
          id: GLOBAL_GRAPH_ID,
          name: "Global",
          description: "auto",
          created_at: 0,
          updated_at: 0,
        },
      ];
      invokeMock.mockResolvedValue(graphs);
      const r = await topologyApi.listGraphs();
      expect(invokeMock).toHaveBeenCalledWith("topology_list_graphs");
      expect(r).toEqual(graphs);
    });

    it("getGraph invokes topology_get_graph with the graph id", async () => {
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
      invokeMock.mockResolvedValue(snap);
      const r = await topologyApi.getGraph(GLOBAL_GRAPH_ID);
      expect(invokeMock).toHaveBeenCalledWith("topology_get_graph", {
        graphId: GLOBAL_GRAPH_ID,
      });
      expect(r).toEqual(snap);
    });

    it("createGraph invokes topology_create_graph with name + optional description", async () => {
      const g: TopologyGraph = {
        id: "g-1",
        name: "lab",
        description: "lab notes",
        created_at: 1,
        updated_at: 1,
      };
      invokeMock.mockResolvedValue(g);
      const r = await topologyApi.createGraph("lab", "lab notes");
      expect(invokeMock).toHaveBeenCalledWith("topology_create_graph", {
        name: "lab",
        description: "lab notes",
      });
      expect(r).toEqual(g);
    });

    it("createGraph forwards undefined description without an error", async () => {
      invokeMock.mockResolvedValue({
        id: "g-2",
        name: "no-desc",
        created_at: 0,
        updated_at: 0,
      });
      await topologyApi.createGraph("no-desc");
      expect(invokeMock).toHaveBeenCalledWith("topology_create_graph", {
        name: "no-desc",
        description: undefined,
      });
    });

    it("deleteGraph invokes topology_delete_graph with the graph id", async () => {
      invokeMock.mockResolvedValue(undefined);
      await topologyApi.deleteGraph("g-1");
      expect(invokeMock).toHaveBeenCalledWith("topology_delete_graph", {
        graphId: "g-1",
      });
    });

    it("clearGraph invokes topology_clear_graph with the graph id", async () => {
      invokeMock.mockResolvedValue(undefined);
      await topologyApi.clearGraph(GLOBAL_GRAPH_ID);
      expect(invokeMock).toHaveBeenCalledWith("topology_clear_graph", {
        graphId: GLOBAL_GRAPH_ID,
      });
    });

    it("neighborCacheList invokes topology_neighbor_cache_list", async () => {
      const rows: NeighborCacheRow[] = [
        {
          device_ref: "R1",
          device_kind: "ssh",
          source_cmd: "show cdp neighbors",
          captured_at: 12345,
          parsed_json: "[]",
        },
      ];
      invokeMock.mockResolvedValue(rows);
      const r = await topologyApi.neighborCacheList();
      expect(invokeMock).toHaveBeenCalledWith("topology_neighbor_cache_list");
      expect(r).toEqual(rows);
    });
  });

  describe("TOPOLOGY_TRIGGER_CMD_RE", () => {
    it("matches `show cdp neighbors`", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show cdp neighbors")).toBe(true);
    });

    it("matches `show cdp neigh` (abbreviated)", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show cdp neigh")).toBe(true);
    });

    it("matches `show lldp neighbors detail`", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show lldp neighbors detail")).toBe(
        true,
      );
    });

    it("matches `show lldp neigh` (abbreviated)", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show lldp neigh")).toBe(true);
    });

    it("matches `show ip bgp summary`", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show ip bgp summary")).toBe(true);
    });

    it("matches `show ip bgp summ` (abbreviated)", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show ip bgp summ")).toBe(true);
    });

    it("matches `show ip ospf neighbor`", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show ip ospf neighbor")).toBe(true);
    });

    it("matches `show ip ospf neigh` (abbreviated)", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show ip ospf neigh")).toBe(true);
    });

    it("matches `show isis neighbors`", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show isis neighbors")).toBe(true);
    });

    it("matches `show isis neigh` (abbreviated)", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show isis neigh")).toBe(true);
    });

    it("matches `  SHOW CDP NEIGHBORS` (leading whitespace + uppercase)", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("  SHOW CDP NEIGHBORS")).toBe(true);
    });

    it("does NOT match `show version`", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show version")).toBe(false);
    });

    it("does NOT match `show ip route`", () => {
      expect(TOPOLOGY_TRIGGER_CMD_RE.test("show ip route")).toBe(false);
    });
  });

  describe("isTopologyIngestEnabled", () => {
    afterEach(() => {
      try {
        window.localStorage.removeItem(ENABLE_TOPOLOGY_INGEST_KEY);
      } catch {
        // ignore
      }
    });

    it("defaults to true when the key is unset", () => {
      window.localStorage.removeItem(ENABLE_TOPOLOGY_INGEST_KEY);
      expect(isTopologyIngestEnabled()).toBe(true);
    });

    it("returns false when the key is the literal string 'false'", () => {
      window.localStorage.setItem(ENABLE_TOPOLOGY_INGEST_KEY, "false");
      expect(isTopologyIngestEnabled()).toBe(false);
    });

    it("returns true for any non-'false' value (e.g. 'true')", () => {
      window.localStorage.setItem(ENABLE_TOPOLOGY_INGEST_KEY, "true");
      expect(isTopologyIngestEnabled()).toBe(true);
    });

    it("returns true for arbitrary truthy strings", () => {
      window.localStorage.setItem(ENABLE_TOPOLOGY_INGEST_KEY, "1");
      expect(isTopologyIngestEnabled()).toBe(true);
    });
  });
});

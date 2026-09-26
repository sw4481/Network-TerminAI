/**
 * Plan 13 Phase 1.4 — Zustand store wrapping `topologyApi`.
 *
 * Holds the list of graphs, the currently selected graph id (defaults to
 * the seeded Global graph), and the snapshot of nodes/edges for that
 * graph. Mirrors the loading/error pattern used by `ragStore.ts`.
 *
 * Selectors at the bottom (e.g. `selectNodesByVendor`) are kept out of
 * the store object so consumers can pick a memoized slice without
 * re-rendering on unrelated state changes.
 */
import { create } from "zustand";
import {
  GLOBAL_GRAPH_ID,
  topologyApi,
  type TopologyGraph,
  type TopologyNode,
  type TopologyEdge,
  type GraphSnapshot,
} from "../lib/topology";

type TopologyStoreState = {
  graphs: TopologyGraph[];
  currentGraphId: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  loading: boolean;
  error: string | null;
  /**
   * Auto-refresh interval (ms). `null` means disabled. Persisted in
   * localStorage under `ccie:topology.autoRefreshIntervalMs`. Phase 4
   * stores the preference; Phase 5.1 wires the actual setInterval.
   */
  autoRefreshIntervalMs: number | null;

  loadGraphs: () => Promise<void>;
  selectGraph: (graphId: string) => Promise<void>;
  refresh: () => Promise<void>;
  ingestFromBlock: (
    blockId: string,
    vendor: string,
    platform: string,
    deviceRef: string,
    deviceKind: string,
  ) => Promise<void>;
  ingestFromText: (
    command: string,
    output: string,
    vendor: string,
    platform: string,
    deviceRef: string,
    deviceKind: string,
  ) => Promise<void>;
  discoverDevices: (
    connectionIds: string[],
    passwords: Record<string, string>,
    onProgress?: (current: number, total: number, deviceName: string) => void,
  ) => Promise<{ succeeded: number; failed: number; errors: string[] }>;
  createGraph: (name: string, description?: string) => Promise<void>;
  clearGraph: (graphId: string) => Promise<void>;
  setAutoRefreshInterval: (ms: number | null) => void;
};

const AUTO_REFRESH_LS_KEY = "ccie:topology.autoRefreshIntervalMs";

function loadAutoRefreshIntervalFromStorage(): number | null {
  try {
    const raw = window.localStorage.getItem(AUTO_REFRESH_LS_KEY);
    if (raw === null || raw === "null") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function persistAutoRefreshInterval(ms: number | null): void {
  try {
    if (ms === null) {
      window.localStorage.setItem(AUTO_REFRESH_LS_KEY, "null");
    } else {
      window.localStorage.setItem(AUTO_REFRESH_LS_KEY, String(ms));
    }
  } catch {
    /* localStorage may be unavailable in some environments — ignore. */
  }
}

export const useTopologyStore = create<TopologyStoreState>((set, get) => ({
  graphs: [],
  currentGraphId: GLOBAL_GRAPH_ID,
  nodes: [],
  edges: [],
  loading: false,
  error: null,
  autoRefreshIntervalMs: loadAutoRefreshIntervalFromStorage(),

  loadGraphs: async () => {
    set({ loading: true, error: null });
    try {
      const graphs = await topologyApi.listGraphs();
      set({ graphs, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  selectGraph: async (graphId) => {
    set({ currentGraphId: graphId });
    await get().refresh();
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const snap: GraphSnapshot = await topologyApi.getGraph(
        get().currentGraphId,
      );
      set({ nodes: snap.nodes, edges: snap.edges, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  ingestFromBlock: async (blockId, vendor, platform, deviceRef, deviceKind) => {
    try {
      await topologyApi.ingestFromBlock(
        blockId,
        vendor,
        platform,
        deviceRef,
        deviceKind,
      );
      // Refresh whatever graph the user is currently viewing (Global by default).
      await get().refresh();
    } catch (e) {
      // Ingest failures are non-fatal — we don't want a parser hiccup to
      // block command-block completion. Surface to console for debugging.
      console.warn("topology ingest failed:", e);
    }
  },

  ingestFromText: async (command, output, vendor, platform, deviceRef, deviceKind) => {
    try {
      await topologyApi.ingestFromText(
        command,
        output,
        vendor,
        platform,
        deviceRef,
        deviceKind,
      );
      // Refresh whatever graph the user is currently viewing (Global by default).
      await get().refresh();
    } catch (e) {
      console.warn("topology ingest from text failed:", e);
      // Re-throw for user-facing error handling
      throw e;
    }
  },

  discoverDevices: async (connectionIds, passwords, onProgress) => {
    const errors: string[] = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < connectionIds.length; i++) {
      const connId = connectionIds[i];

      // Default to cisco/iosxe for now - could be enhanced to query device info
      const vendor = "cisco";
      const platform = "iosxe";

      if (onProgress) {
        onProgress(i + 1, connectionIds.length, connId);
      }

      try {
        console.log(`[topologyStore] Discovering device ${connId}...`);
        const password = passwords[connId];
        await topologyApi.discoverDevice(connId, vendor, platform, password);
        succeeded++;
      } catch (e) {
        console.error(`[topologyStore] Discovery failed for ${connId}:`, e);
        errors.push(`${connId}: ${String(e)}`);
        failed++;
      }
    }

    // Refresh the graph to show newly discovered topology
    await get().refresh();

    return { succeeded, failed, errors };
  },

  createGraph: async (name, description) => {
    const g = await topologyApi.createGraph(name, description);
    set((s) => ({ graphs: [...s.graphs, g] }));
  },

  clearGraph: async (graphId) => {
    await topologyApi.clearGraph(graphId);
    if (graphId === get().currentGraphId) {
      await get().refresh();
    }
  },

  setAutoRefreshInterval: (ms) => {
    persistAutoRefreshInterval(ms);
    set({ autoRefreshIntervalMs: ms });
  },
}));

/**
 * Selector: nodes grouped by vendor (case-insensitive, "unknown" bucket
 * for nullish). Used by the inline topology panel to render per-vendor
 * sub-groups.
 */
export const selectNodesByVendor = (
  state: TopologyStoreState,
): Map<string, TopologyNode[]> => {
  const m = new Map<string, TopologyNode[]>();
  for (const n of state.nodes) {
    const key = (n.vendor ?? "unknown").toLowerCase();
    const arr = m.get(key) ?? [];
    arr.push(n);
    m.set(key, arr);
  }
  return m;
};

/** Selector: edges grouped by protocol. */
export const selectEdgesByProtocol = (
  state: TopologyStoreState,
): Map<string, TopologyEdge[]> => {
  const m = new Map<string, TopologyEdge[]>();
  for (const e of state.edges) {
    const arr = m.get(e.protocol) ?? [];
    arr.push(e);
    m.set(e.protocol, arr);
  }
  return m;
};

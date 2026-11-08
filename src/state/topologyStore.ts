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
  type NodePosition,
  type DiscoveryRequest,
  type DiscoveryRun,
  type CaptureEvidence,
} from "../lib/topology";

export interface DiscoveryResult {
  succeeded: number;
  partial: number;
  failed: number;
  nodesProcessed: number;
  edgesProcessed: number;
  errors: string[];
}

type TopologyStoreState = {
  graphs: TopologyGraph[];
  discoveryRun: DiscoveryRun | null;
  discoveryStarting: boolean;
  discoveryError: string | null;
  startDiscovery: (request: DiscoveryRequest) => Promise<void>;
  refreshDiscovery: (runId?: string) => Promise<void>;
  cancelDiscovery: () => Promise<void>;
  currentGraphId: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  positions: NodePosition[];
  snapshotGraph: TopologyGraph | null;
  importProvenance: GraphSnapshot["import_provenance"];
  captureEvidence: CaptureEvidence[];
  globalNodes: TopologyNode[];
  globalEdges: TopologyEdge[];
  layoutAttempts: Map<string, { positions: NodePosition[]; error: string | null; version: number }>;
  layoutError: string | null;
  layoutVersion: number;
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
  refreshGlobal: () => Promise<void>;
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
    graphId?: string,
  ) => Promise<DiscoveryResult>;
  createGraph: (name: string, description?: string) => Promise<void>;
  importGraph: (content: string, name: string) => Promise<GraphSnapshot>;
  clearGraph: (graphId: string) => Promise<void>;
  saveLayout: (graphId: string, positions: NodePosition[]) => Promise<boolean>;
  resetLayout: (graphId: string) => Promise<boolean>;
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

/** Own asynchronous work without changing the app-wide graph selection model. */
class TopologyRequests {
  snapshot = 0;
  discovery = 0;
  stoppingDiscovery: string | null = null;
  globalSnapshot = 0;
  list = 0;
  selection = 0;
  destructive = new Map<string, number>();
  private versions = new Map<string, number>();
  private writes = new Map<string, Promise<void>>();

  version(graphId: string): number { return this.versions.get(graphId) ?? 0; }
  change(graphId: string): number {
    const version = this.version(graphId) + 1;
    this.versions.set(graphId, version);
    return version;
  }
  pending(graphId: string): Promise<void> | undefined { return this.writes.get(graphId); }
  write(graphId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(graphId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => {}, () => {});
    this.writes.set(graphId, settled);
    void settled.then(() => {
      if (this.writes.get(graphId) === settled) this.writes.delete(graphId);
    });
    return result;
  }
}
const requests = new TopologyRequests();

export const useTopologyStore = create<TopologyStoreState>((set, get) => ({
  graphs: [],
  discoveryRun: null,
  discoveryStarting: false,
  discoveryError: null,
  startDiscovery: async (request) => {
    if (get().discoveryStarting) return;
    const version = ++requests.discovery;
    set({ discoveryStarting: true, discoveryError: null });
    try {
      const report = await topologyApi.startDiscovery(request);
      if (version === requests.discovery) set({ discoveryRun: report });
    } catch {
      if (version === requests.discovery) set({ discoveryError: "Could not start discovery. Check saved profiles and scope, then retry." });
    } finally {
      set({ discoveryStarting: false });
    }
  },
  refreshDiscovery: async (runId) => {
    if (get().discoveryStarting || requests.stoppingDiscovery) return;
    const version = ++requests.discovery;
    try {
      let report: DiscoveryRun | null;
      try {
        report = await topologyApi.discoveryStatus(runId);
        if (runId && report?.run_id !== runId) throw new Error("Wrong discovery run");
      } catch {
        if (!runId || version !== requests.discovery) throw new Error("Discovery status unavailable");
        report = await topologyApi.discoveryStatus();
      }
      if (version !== requests.discovery || (runId && get().discoveryRun?.run_id !== runId)) return;
      set({ discoveryRun: report, discoveryError: null });
      // Terminal polling stops; an explicit retry must also retry the graph refresh.
      if (report && !["running", "cancelling"].includes(report.state)) {
        if (report.graph_id === GLOBAL_GRAPH_ID) await get().refreshGlobal();
        else if (report.graph_id === get().currentGraphId) await get().refresh();
      }
    } catch {
      if (version === requests.discovery) set({ discoveryError: "Could not read discovery status. Retry status; the native job may still be running." });
    }
  },
  cancelDiscovery: async () => {
    const run = get().discoveryRun;
    if (!run || !["running", "cancelling"].includes(run.state) || requests.stoppingDiscovery) return;
    const version = ++requests.discovery;
    requests.stoppingDiscovery = run.run_id;
    try {
      const report = await topologyApi.cancelDiscovery(run.run_id);
      if (version === requests.discovery && get().discoveryRun?.run_id === run.run_id && report.run_id === run.run_id) set({ discoveryRun: report, discoveryError: null });
    } catch {
      if (version === requests.discovery) set({ discoveryError: "Stop could not be confirmed. Retry Stop or status." });
    } finally {
      requests.stoppingDiscovery = null;
    }
  },
  currentGraphId: GLOBAL_GRAPH_ID,
  nodes: [],
  edges: [],
  positions: [],
  snapshotGraph: null,
  importProvenance: undefined,
  captureEvidence: [],
  globalNodes: [],
  globalEdges: [],
  layoutAttempts: new Map(),
  layoutError: null,
  layoutVersion: 0,
  loading: false,
  error: null,
  autoRefreshIntervalMs: loadAutoRefreshIntervalFromStorage(),

  loadGraphs: async () => {
    const request = ++requests.list;
    const initialIds = new Set(get().graphs.map((graph) => graph.id));
    try {
      const graphs = await topologyApi.listGraphs();
      if (request !== requests.list) return;
      set((state) => ({ graphs: [...graphs, ...state.graphs.filter((graph) =>
        !initialIds.has(graph.id) && !graphs.some((loaded) => loaded.id === graph.id))] }));
    } catch (e) {
      if (request === requests.list) set({ error: String(e) });
    }
  },

  selectGraph: async (graphId) => {
    requests.selection++;
    set((state) => ({
      currentGraphId: graphId, nodes: [], edges: [], snapshotGraph: null, importProvenance: undefined, captureEvidence: [],
      positions: state.layoutAttempts.get(graphId)?.positions ?? [],
      error: null, layoutError: state.layoutAttempts.get(graphId)?.error ?? null, layoutVersion: state.layoutVersion + 1,
    }));
    await get().refresh();
  },

  refresh: async () => {
    const graphId = get().currentGraphId;
    const request = ++requests.snapshot;
    const globalRequest = graphId === GLOBAL_GRAPH_ID ? ++requests.globalSnapshot : null;
    const version = requests.version(graphId);
    const owns = () => request === requests.snapshot && get().currentGraphId === graphId && requests.version(graphId) === version && (globalRequest === null || globalRequest === requests.globalSnapshot);
    const ownsGlobal = () => globalRequest !== null && globalRequest === requests.globalSnapshot && requests.version(graphId) === version;
    set({ loading: true, error: null });
    try {
      const pending = requests.pending(graphId);
      if (pending) await pending;
      if (!owns() && !ownsGlobal()) return;
      const snap: GraphSnapshot = await topologyApi.getGraph(graphId);
      if (!owns() && !ownsGlobal()) return;
      if (snap.graph.id !== graphId) throw new Error("Topology response belongs to another graph");
      if (ownsGlobal()) set({ globalNodes: snap.nodes, globalEdges: snap.edges });
      if (!owns()) return;
      const attempt = get().layoutAttempts.get(graphId);
      const positions = attempt
        ? [...new Map([...(snap.positions ?? []), ...attempt.positions].map((position) => [position.device_ref, position])).values()]
        : snap.positions ?? [];
      set({ nodes: snap.nodes, edges: snap.edges, positions, snapshotGraph: snap.graph,
        importProvenance: snap.import_provenance, captureEvidence: snap.capture_evidence ?? [], layoutError: attempt?.error ?? null, loading: false });
    } catch (e) {
      if (owns()) set({ error: String(e), loading: false });
    }
  },

  refreshGlobal: async () => {
    if (get().currentGraphId === GLOBAL_GRAPH_ID) return get().refresh();
    const request = ++requests.globalSnapshot;
    const version = requests.version(GLOBAL_GRAPH_ID);
    const owns = () => request === requests.globalSnapshot && version === requests.version(GLOBAL_GRAPH_ID);
    const pending = requests.pending(GLOBAL_GRAPH_ID);
    if (pending) await pending;
    if (!owns()) return;
    const snap = await topologyApi.getGraph(GLOBAL_GRAPH_ID);
    if (!owns()) return;
    if (snap.graph.id !== GLOBAL_GRAPH_ID) throw new Error("Topology response belongs to another graph");
    set({ globalNodes: snap.nodes, globalEdges: snap.edges });
  },

  ingestFromBlock: async (blockId, vendor, platform, deviceRef, deviceKind) => {
    try {
      await topologyApi.ingestFromBlock(blockId, vendor, platform, deviceRef, deviceKind);
      await get().refreshGlobal();
    } catch (e) {
      console.warn("topology ingest failed:", e);
    }
  },

  ingestFromText: async (command, output, vendor, platform, deviceRef, deviceKind) => {
    try {
      await topologyApi.ingestFromText(command, output, vendor, platform, deviceRef, deviceKind);
      await get().refreshGlobal();
    } catch (e) {
      console.warn("topology ingest from text failed:", e);
      throw e;
    }
  },

  discoverDevices: async (connectionIds, passwords, onProgress, destination) => {
    const graphId = destination ?? get().currentGraphId;
    const result: DiscoveryResult = { succeeded: 0, partial: 0, failed: 0, nodesProcessed: 0, edgesProcessed: 0, errors: [] };
    for (let i = 0; i < connectionIds.length; i++) {
      const connId = connectionIds[i];
      onProgress?.(i + 1, connectionIds.length, connId);
      try {
        // Saved vendor/platform are authoritative in the native command.
        const summary = await topologyApi.discoverDevice(connId, "", "", passwords[connId], graphId);
        if (!["completed", "partial", "failed"].includes(summary.status)) throw new Error("Discovery returned no valid outcome");
        if (summary.status === "completed") result.succeeded++;
        else if (summary.status === "partial") result.partial++;
        else result.failed++;
        result.nodesProcessed += summary.nodes_added;
        result.edgesProcessed += summary.edges_added;
        for (const capture of summary.captures) {
          if (capture.status !== "completed") result.errors.push(`${connId} (${capture.protocol}, ${capture.status}): ${capture.error ?? "no completed capture"}`);
        }
        if (summary.status !== "completed" && !summary.captures.some((capture) => capture.status !== "completed")) {
          result.errors.push(`${connId}: ${summary.status}`);
        }
      } catch (e) {
        result.errors.push(`${connId}: ${String(e)}`);
        result.failed++;
      }
    }
    if (graphId === GLOBAL_GRAPH_ID) await get().refreshGlobal();
    else if (get().currentGraphId === graphId) await get().refresh();
    return result;
  },

  createGraph: async (name, description) => {
    const graph = await topologyApi.createGraph(name, description);
    set((state) => ({ graphs: [...state.graphs.filter((item) => item.id !== graph.id), graph] }));
  },

  importGraph: async (content, name) => {
    const snapshot = await topologyApi.importGraph(content, name);
    set((state) => ({ graphs: [...state.graphs.filter((graph) => graph.id !== snapshot.graph.id), snapshot.graph] }));
    return snapshot;
  },

  clearGraph: async (graphId) => {
    const selection = requests.selection;
    const version = requests.change(graphId);
    requests.destructive.set(graphId, version);
    const owns = () => get().currentGraphId === graphId && requests.selection === selection && requests.version(graphId) === version;
    if (get().currentGraphId === graphId) set({ loading: false });
    try {
      await requests.write(graphId, () => topologyApi.clearGraph(graphId));
      set((state) => {
        const layoutAttempts = new Map(state.layoutAttempts);
        layoutAttempts.delete(graphId);
        return { layoutAttempts, ...(graphId === GLOBAL_GRAPH_ID ? { globalNodes: [], globalEdges: [] } : {}) };
      });
      if (owns()) {
        set((state) => ({ nodes: [], edges: [], positions: [], importProvenance: undefined, captureEvidence: [], layoutError: null, layoutVersion: state.layoutVersion + 1 }));
        await get().refresh();
      }
    } catch (e) {
      if (owns()) set({ error: `Clear failed: ${String(e)}` });
      throw e;
    } finally {
      if (requests.destructive.get(graphId) === version) requests.destructive.delete(graphId);
    }
  },

  saveLayout: async (graphId, positions) => {
    if (get().currentGraphId !== graphId) return false;
    if (requests.destructive.has(graphId)) {
      set({ layoutError: "Layout not saved: Reset or Clear is still pending" });
      return false;
    }
    if (positions.some((position) => !Number.isFinite(position.x) || !Number.isFinite(position.y))) {
      set({ layoutError: "Layout not saved: coordinates must be finite" });
      return false;
    }
    const saved = [...new Map([...get().positions, ...positions].map((position) => [position.device_ref, { ...position }])).values()];
    const version = requests.change(graphId);
    set((state) => ({ positions: saved, loading: false, layoutAttempts: new Map(state.layoutAttempts).set(graphId, {
      positions: saved, error: state.layoutAttempts.get(graphId)?.error ?? null, version,
    }) }));
    try {
      await requests.write(graphId, () => topologyApi.saveLayout(graphId, saved));
      if (get().layoutAttempts.get(graphId)?.version === version) set((state) => {
        const layoutAttempts = new Map(state.layoutAttempts);
        layoutAttempts.delete(graphId);
        return { layoutAttempts, ...(state.currentGraphId === graphId ? { layoutError: null } : {}) };
      });
      return true;
    } catch (e) {
      if (get().layoutAttempts.get(graphId)?.version === version) set((state) => {
        const error = `Layout not saved: ${String(e)}`;
        return { layoutAttempts: new Map(state.layoutAttempts).set(graphId, { positions: saved, error, version }),
          ...(state.currentGraphId === graphId ? { positions: saved, layoutError: error } : {}),
        };
      });
      return false;
    }
  },

  resetLayout: async (graphId) => {
    if (get().currentGraphId !== graphId) return false;
    const positions = get().positions;
    const selection = requests.selection;
    const version = requests.change(graphId);
    requests.destructive.set(graphId, version);
    const owns = () => get().currentGraphId === graphId && requests.selection === selection && requests.version(graphId) === version;
    set({ loading: false });
    try {
      await requests.write(graphId, () => topologyApi.resetLayout(graphId));
      set((state) => {
        const layoutAttempts = new Map(state.layoutAttempts);
        layoutAttempts.delete(graphId);
        return { layoutAttempts };
      });
      if (owns()) set((state) => ({ positions: [], layoutError: null, layoutVersion: state.layoutVersion + 1 }));
      return owns();
    } catch (e) {
      if (requests.version(graphId) === version) set((state) => {
        const error = `Layout not reset: ${String(e)}`;
        return { layoutAttempts: new Map(state.layoutAttempts).set(graphId, { positions, error, version }),
          ...(state.currentGraphId === graphId ? { layoutError: error } : {}),
        };
      });
      return false;
    } finally {
      if (requests.destructive.get(graphId) === version) requests.destructive.delete(graphId);
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
export const selectNodesByVendor = <T extends Pick<TopologyStoreState, "nodes">>(
  state: T,
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
export const selectEdgesByProtocol = <T extends Pick<TopologyStoreState, "edges">>(
  state: T,
): Map<string, TopologyEdge[]> => {
  const m = new Map<string, TopologyEdge[]>();
  for (const e of state.edges) {
    const arr = m.get(e.protocol) ?? [];
    arr.push(e);
    m.set(e.protocol, arr);
  }
  return m;
};

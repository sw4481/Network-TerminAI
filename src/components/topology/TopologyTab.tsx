/**
 * Plan 13 Phase 4 Task 4.2 — Global Topology tab.
 *
 * Aggregates ALL `neighbor_cache` rows across ALL devices into a single
 * merged graph. Three columns: filter tree (left), ReactFlow canvas
 * (center), inspector (right, slides in when a node is selected).
 *
 * Phase 4 owns the UI; Phase 5.1 will hook the auto-refresh setInterval
 * once the timer wiring lands. Layout is deterministic radial for ≤15
 * nodes and a vendor-bucketed grid for >15 — `d3-force` is intentionally
 * deferred until customer feedback warrants the dependency.
 */
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TopologyMap } from "../../lib/topologyMap";
import { TopologyInterchange } from "./TopologyInterchange";
import "@xyflow/react/dist/style.css";

import { useTopologyStore } from "../../state/topologyStore";
import { NeighborNode, type NeighborNodeT } from "./NeighborNode";
import { NeighborEdge } from "./NeighborEdge";
import {
  TopologyProjection,
  type NodePosition,
  type SavedDeviceLookup,
  type TopologyNode,
} from "../../lib/topology";
import {
  TopologyFilterTree,
  type TopologyFilterState,
} from "./TopologyFilterTree";
import { TopologyToolbar } from "./TopologyToolbar";
import { TopologyInspector } from "./TopologyInspector";
import { SaveNeighborModal } from "./SaveNeighborModal";
import { DeviceDiscoveryModal } from "./DeviceDiscoveryModal";
import "./TopologyTab.css";
import { StpWorkspace, TopolographWorkspace } from "./TopologyIntegrationWorkspace";

const NODE_TYPES = { neighbor: NeighborNode };
const EDGE_TYPES = { default: NeighborEdge };

const RADIAL_THRESHOLD = 15;
const RADIAL_RADIUS_PX = 220;
const TIER_COLS = 6;
const TIER_X_STEP = 200;
const TIER_Y_STEP = 160;

export interface TopologyTabProps {
  tabId: string;
  onOpenSshTab?: (ref: string) => Promise<void> | void;
  onOpenNetconfTab?: (ref: string) => Promise<void> | void;
}

/**
 * Deterministic layout. Radial for small graphs (≤15 nodes), vendor-
 * bucketed grid for larger graphs. Either way the algorithm depends
 * only on `device_ref` ordering so auto-refresh doesn't shuffle nodes.
 */
function layoutPositions(
  nodes: TopologyNode[],
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = Object.create(null);
  if (nodes.length === 0) return out;

  if (nodes.length <= RADIAL_THRESHOLD) {
    const sorted = [...nodes].sort((a, b) =>
      a.device_ref.localeCompare(b.device_ref),
    );
    if (sorted.length === 1) {
      out[sorted[0].device_ref] = { x: 0, y: 0 };
      return out;
    }
    sorted.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / sorted.length - Math.PI / 2;
      out[n.device_ref] = {
        x: Math.round(RADIAL_RADIUS_PX * Math.cos(angle)),
        y: Math.round(RADIAL_RADIUS_PX * Math.sin(angle)),
      };
    });
    return out;
  }

  // Tier grid: bucket by vendor, then arrange each bucket as a row of
  // up to TIER_COLS columns. Within a vendor bucket, sort by device_ref
  // so the layout is stable.
  const buckets = new Map<string, TopologyNode[]>();
  for (const n of nodes) {
    const key = (n.vendor ?? "unknown").toLowerCase();
    const arr = buckets.get(key) ?? [];
    arr.push(n);
    buckets.set(key, arr);
  }
  const orderedVendors = Array.from(buckets.keys()).sort();
  let row = 0;
  for (const vendor of orderedVendors) {
    const bucket = (buckets.get(vendor) ?? []).sort((a, b) =>
      a.device_ref.localeCompare(b.device_ref),
    );
    for (let i = 0; i < bucket.length; i++) {
      const col = i % TIER_COLS;
      const subRow = Math.floor(i / TIER_COLS);
      out[bucket[i].device_ref] = {
        x: col * TIER_X_STEP,
        y: (row + subRow) * TIER_Y_STEP,
      };
    }
    row += Math.max(1, Math.ceil(bucket.length / TIER_COLS));
  }
  return out;
}

export function TopologyTab({ tabId, onOpenSshTab, onOpenNetconfTab }: TopologyTabProps) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const actionId = useRef(0);
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(() => window.matchMedia?.("(min-width: 900px)").matches ?? true);
  const filterToggleRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<"neighbors" | "topolograph" | "stp">("neighbors");
  const modes = ["neighbors", "topolograph", "stp"] as const;
  type Mode = typeof modes[number];
  const instanceId = useId();
  const tabRefs = useRef<Record<Mode, HTMLButtonElement | null>>({ neighbors: null, topolograph: null, stp: null });
  const tabDomId = (item: Mode) => `topology-tab-${instanceId}-${item}`;
  const panelDomId = (item: Mode) => `topology-panel-${instanceId}-${item}`;
  const selectModeFromKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = modes.indexOf(event.currentTarget.dataset.mode as Mode);
    const next = event.key === "ArrowRight" ? (index + 1) % modes.length : event.key === "ArrowLeft" ? (index + modes.length - 1) % modes.length : -1;
    if (next < 0) return;
    event.preventDefault();
    const nextMode = modes[next];
    setMode(nextMode);
    tabRefs.current[nextMode]?.focus();
  };
  const rawNodes = useTopologyStore((s) => s.nodes);
  const edges = useTopologyStore((s) => s.edges);
  const storedPositions = useTopologyStore((s) => s.positions);
  const layoutVersion = useTopologyStore((s) => s.layoutVersion);
  const layoutError = useTopologyStore((s) => s.layoutError);
  const error = useTopologyStore((s) => s.error);
  const loading = useTopologyStore((s) => s.loading);
  const refresh = useTopologyStore((s) => s.refresh);
  const loadGraphs = useTopologyStore((s) => s.loadGraphs);
  const clearGraph = useTopologyStore((s) => s.clearGraph);
  const saveLayout = useTopologyStore((s) => s.saveLayout);
  const resetLayout = useTopologyStore((s) => s.resetLayout);
  const currentGraphId = useTopologyStore((s) => s.currentGraphId);
  const snapshotGraph = useTopologyStore((s) => s.snapshotGraph);
  const importProvenance = useTopologyStore((s) => s.importProvenance);
  const captureEvidence = useTopologyStore((s) => s.captureEvidence);
  const projection = useMemo(() => TopologyProjection.project(rawNodes, currentGraphId), [rawNodes, currentGraphId]);
  const nodes = projection.nodes;
  const scope = useRef({ graphId: currentGraphId, version: layoutVersion });
  scope.current = { graphId: currentGraphId, version: layoutVersion };
  const fallbackCache = useRef<{ graphId: string; version: number; positions: Record<string, { x: number; y: number }> }>({ graphId: currentGraphId, version: layoutVersion, positions: Object.create(null) });
  const [dragPositions, setDragPositions] = useState({ graphId: currentGraphId, version: layoutVersion, positions: Object.create(null) as Record<string, { x: number; y: number }> });
  const discoveryRun = useTopologyStore((s) => s.discoveryRun);
  const discoveryStarting = useTopologyStore((s) => s.discoveryStarting);
  const discoveryError = useTopologyStore((s) => s.discoveryError);
  const refreshDiscovery = useTopologyStore((s) => s.refreshDiscovery);
  const discoveryActive = discoveryRun?.state === "running" || discoveryRun?.state === "cancelling";
  const captureIssues = discoveryRun?.devices.reduce((count, device) => count + device.captures.filter((capture) => capture.status !== "completed").length, 0) ?? 0;
  const deviceIssues = discoveryRun?.devices.filter((device) => device.error || ["failed", "partial", "unsupported", "timed_out", "cancelled"].includes(device.status)).length ?? 0;
  const autoRefreshIntervalMs = useTopologyStore(
    (s) => s.autoRefreshIntervalMs,
  );

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [unknownNeighbor, setUnknownNeighbor] = useState<TopologyNode | null>(
    null,
  );
  const [showDiscoveryModal, setShowDiscoveryModal] = useState(false);
  useEffect(() => { void refreshDiscovery(); }, [refreshDiscovery]);
  useEffect(() => {
    if (!discoveryActive || !discoveryRun) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refreshDiscovery(discoveryRun.run_id);
      if (active) timer = setTimeout(() => { void poll(); }, 750);
    };
    timer = setTimeout(() => { void poll(); }, 750);
    return () => { active = false; clearTimeout(timer); };
  }, [discoveryActive, discoveryRun?.run_id, refreshDiscovery]);
  const [filterState, setFilterState] = useState<TopologyFilterState>(() => ({
    sites: new Set(),
    vendors: new Set(),
    platforms: new Set(),
    protocols: new Set(),
  }));

  useEffect(() => {
    actionId.current++;
    setOpenError(null);
    setSelectedNodeId(null);
    setFocusRef(null);
    setUnknownNeighbor(null);
    return () => { actionId.current++; };
  }, [currentGraphId, mode]);

  // Initial hydrate: list graphs, then snapshot the current (Global) graph.
  useEffect(() => {
    loadGraphs()
      .then(() => refresh())
      .catch(() => {});
  }, [loadGraphs, refresh]);

  // Phase 5.1 — Auto-refresh timer. The interval (ms) lives in the store
  // and is persisted to localStorage by `setAutoRefreshInterval`. When the
  // user picks "Off" (null) we tear the interval down. Plan 13 names a
  // hypothetical `settingsStore` with key `topology.autoRefreshInterval`,
  // but Phase 4.2 already chose localStorage with key
  // `ccie:topology.autoRefreshIntervalMs` — keeping that to avoid a churny
  // double-write. Documented in the commit message.
  useEffect(() => {
    if (autoRefreshIntervalMs == null) return;
    const id = setInterval(() => {
      refresh().catch((err) =>
        console.warn("[topology] auto-refresh failed:", err),
      );
    }, autoRefreshIntervalMs);
    return () => clearInterval(id);
  }, [autoRefreshIntervalMs, refresh]);

  const filterOptions = useMemo(() => {
    const vendors = new Set<string>();
    const platforms = new Set<string>();
    const protocols = new Set<string>();
    for (const n of nodes) {
      vendors.add((n.vendor ?? "unknown").toLowerCase());
      if (n.platform) platforms.add(n.platform);
    }
    for (const e of edges) protocols.add(e.protocol);
    return { vendors, platforms, protocols };
  }, [nodes, edges]);

  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      const vendor = (n.vendor ?? "unknown").toLowerCase();
      if (filterState.vendors.size > 0 && !filterState.vendors.has(vendor)) {
        return false;
      }
      if (
        filterState.platforms.size > 0 &&
        n.platform !== undefined &&
        !filterState.platforms.has(n.platform)
      ) {
        return false;
      }
      // If platform filter is active and this node has no platform, hide
      // it so the filter is meaningful for partially-tagged graphs.
      if (
        filterState.platforms.size > 0 &&
        n.platform === undefined
      ) {
        return false;
      }
      return true;
    });
  }, [nodes, filterState]);

  const filteredEdges = useMemo(() => {
    const visibleRefs = new Set(filteredNodes.map((n) => n.device_ref));
    return edges.filter((e) => {
      if (
        filterState.protocols.size > 0 &&
        !filterState.protocols.has(e.protocol)
      ) {
        return false;
      }
      return e.graph_id === currentGraphId && visibleRefs.has(e.a_device_ref) && visibleRefs.has(e.b_device_ref);
    });
  }, [edges, filterState, filteredNodes, currentGraphId]);
  const neighborhood = useMemo(() => focusRef ? TopologyMap.oneHop(filteredEdges, focusRef) : null, [focusRef, filteredEdges]);
  const visibleNodes = useMemo(() => filteredNodes.filter((node) => !neighborhood || neighborhood.has(node.device_ref)), [filteredNodes, neighborhood]);
  const visibleEdges = useMemo(() => filteredEdges.filter((edge) => !focusRef || edge.a_device_ref === focusRef || edge.b_device_ref === focusRef), [filteredEdges, focusRef]);

  const positions = useMemo(() => {
    if (fallbackCache.current.graphId !== currentGraphId || fallbackCache.current.version !== layoutVersion) {
      fallbackCache.current = { graphId: currentGraphId, version: layoutVersion, positions: Object.create(null) };
    }
    const fallback = fallbackCache.current.positions;
    const initial = layoutPositions(nodes);
    const overrides: Record<string, { x: number; y: number }> = Object.create(null);
    for (const position of storedPositions) overrides[position.device_ref] = { x: position.x, y: position.y };
    if (dragPositions.graphId === currentGraphId && dragPositions.version === layoutVersion) Object.assign(overrides, dragPositions.positions);
    const occupied = nodes.flatMap((node) => {
      const position = overrides[node.device_ref] ?? fallback[node.device_ref];
      return position ? [position] : [];
    });
    const hasRetainedPositions = occupied.length > 0;
    // ponytail: linear free-slot scan; use a spatial index if graph size warrants it.
    const isFree = (position: { x: number; y: number }) => occupied.every((other) =>
      Math.abs(position.x - other.x) >= TIER_X_STEP || Math.abs(position.y - other.y) >= TIER_Y_STEP);
    for (const node of nodes) {
      if (fallback[node.device_ref]) continue;
      if (overrides[node.device_ref]) {
        fallback[node.device_ref] = overrides[node.device_ref];
        continue;
      }
      let position = initial[node.device_ref];
      let slot = 0;
      while (hasRetainedPositions && !isFree(position)) {
        position = { x: (slot % TIER_COLS) * TIER_X_STEP, y: Math.floor(slot / TIER_COLS) * TIER_Y_STEP };
        slot++;
      }
      fallback[node.device_ref] = position;
      occupied.push(position);
    }
    return Object.assign(Object.create(null), fallback, overrides) as Record<string, { x: number; y: number }>;
  }, [nodes, storedPositions, dragPositions, currentGraphId, layoutVersion]);

  const activateNode = (nodeId: string) => {
    actionId.current++;
    setOpenError(null);
    setSelectedNodeId(nodeId);
  };

  const rfNodes: Node[] = useMemo(() => {
    return visibleNodes.map((n) => {
      const data: NeighborNodeT["data"] = {
        label: n.label,
        vendor: (n.vendor ?? "unknown").toLowerCase(),
        mgmtIp: n.mgmt_ip,
        deviceKind: n.device_kind,
        deviceRef: n.device_ref,
        isSource: false,
        onActivate: () => activateNode(n.device_ref),
      };
      return {
        id: n.device_ref,
        type: "neighbor",
        selected: selectedNodeId === n.device_ref,
        position: positions[n.device_ref] ?? { x: 0, y: 0 },
        data: data as Record<string, unknown>,
      };
    });
  }, [visibleNodes, positions, selectedNodeId]);

  const ownsLayout = () => scope.current.graphId === currentGraphId && scope.current.version === layoutVersion &&
    useTopologyStore.getState().currentGraphId === currentGraphId && useTopologyStore.getState().layoutVersion === layoutVersion;

  const handleNodesChange = (changes: NodeChange[]) => {
    if (!ownsLayout()) return;
    const moved = applyNodeChanges(changes, rfNodes).filter((node) => {
      const previous = rfNodes.find((item) => item.id === node.id);
      return previous && (previous.position.x !== node.position.x || previous.position.y !== node.position.y);
    });
    if (!moved.length) return;
    setDragPositions((state) => ({ graphId: currentGraphId, version: layoutVersion, positions: {
      ...(state.graphId === currentGraphId && state.version === layoutVersion ? state.positions : {}),
      ...Object.fromEntries(moved.map((node) => [node.id, node.position])),
    } }));
  };

  const persistPositions = async (saved: NodePosition[]) => {
    if (!saved.length || !ownsLayout()) return;
    const success = await saveLayout(currentGraphId, saved);
    if (!success || !ownsLayout()) return;
    setDragPositions((state) => {
      if (state.graphId !== currentGraphId || state.version !== layoutVersion) return state;
      const remaining = { ...state.positions };
      for (const item of saved) {
        if (remaining[item.device_ref]?.x === item.x && remaining[item.device_ref]?.y === item.y) delete remaining[item.device_ref];
      }
      return { ...state, positions: remaining };
    });
  };

  const handleArrange = () => {
    if (!ownsLayout()) return;
    const arranged = layoutPositions(nodes);
    setDragPositions({ graphId: currentGraphId, version: layoutVersion, positions: arranged });
    void persistPositions(nodes.map((node) => ({ device_ref: node.device_ref, ...arranged[node.device_ref] })));
  };

  const handleArrangeConnected = () => {
    if (!ownsLayout()) return;
    const arranged = TopologyMap.connectedPositions(nodes, edges);
    setDragPositions({ graphId: currentGraphId, version: layoutVersion, positions: arranged });
    void persistPositions(nodes.map((node) => ({ device_ref: node.device_ref, ...arranged[node.device_ref] })));
  };

  const rfEdges: Edge[] = useMemo(() => TopologyMap.links(visibleEdges, selectedNodeId), [visibleEdges, selectedNodeId]);

  const selectedNode = useMemo(() => {
    return selectedNodeId
      ? visibleNodes.find((n) => n.device_ref === selectedNodeId) ?? null
      : null;
  }, [selectedNodeId, visibleNodes]);

  const selectedNodeEdges = useMemo(() => {
    return selectedNodeId
      ? visibleEdges.filter(
          (e) =>
            e.a_device_ref === selectedNodeId ||
            e.b_device_ref === selectedNodeId,
        )
      : [];
  }, [selectedNodeId, visibleEdges]);

  const handleNodeClick = (_: React.MouseEvent, node: Node) => {
    activateNode(node.id);
  };

  const closeInspector = () => {
    const ref = selectedNodeId;
    activateNode("");
    setSelectedNodeId(null);
    const element = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>("[data-device-ref]") ?? []).find((item) => item.dataset.deviceRef === ref);
    element?.focus();
  };

  const handleInspectorOpen = async () => {
    if (!selectedNode || selectedNode.device_ref.startsWith("routing:") || openingRef.current) return;
    const request = ++actionId.current;
    const isCurrent = () => request === actionId.current && useTopologyStore.getState().currentGraphId === currentGraphId;
    openingRef.current = true;
    setOpening(true);
    setOpenError(null);
    try {
      const ref = selectedNode.device_kind === "discovered" ? selectedNode.mgmt_ip ?? selectedNode.device_ref : selectedNode.device_ref;
      let saved: SavedDeviceLookup | null = { kind: selectedNode.device_kind === "netconf" ? "netconf" : "ssh", device_ref: ref };
      if (selectedNode.device_kind === "discovered") {
        // Use the existing inventory resolver, but do not mistake lookup failure for an unsaved device.
        saved = await invoke<SavedDeviceLookup | null>("device_lookup_by_ref", { ref });
        if (!isCurrent()) return;
        if (!saved) { setUnknownNeighbor(selectedNode); return; }
      }
      const opener = saved.kind === "ssh" ? onOpenSshTab : onOpenNetconfTab;
      if (!opener) throw new Error("Device opening is unavailable in this view.");
      await opener(saved.device_ref);
    } catch (error) {
      if (isCurrent()) setOpenError(error instanceof Error ? error.message : "Device could not be opened. Check the saved profile and try again.");
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  const handleClearGraph = async () => {
    const ok = window.confirm(
      "Clear all nodes and edges in the current graph? This cannot be undone.",
    );
    if (!ok) return;
    try { await clearGraph(currentGraphId); } catch { /* Store exposes the failure. */ }
  };

  return (
    <div
      className="topology-tab"
      ref={workspaceRef}
      data-testid="topology-tab"
      data-tab-id={tabId}
    >
      <div
        className="topology-tab__view-tabs"
        role="tablist"
        aria-label="Topology views"
      >
        <button className="topology-tab__view-tab" ref={(element) => { tabRefs.current.neighbors = element; }} data-mode="neighbors" id={tabDomId("neighbors")} role="tab" aria-controls={panelDomId("neighbors")} aria-selected={mode === "neighbors"} tabIndex={mode === "neighbors" ? 0 : -1} onKeyDown={selectModeFromKey} onClick={() => setMode("neighbors")}>Neighbors</button>
        <button className="topology-tab__view-tab" ref={(element) => { tabRefs.current.topolograph = element; }} data-mode="topolograph" id={tabDomId("topolograph")} role="tab" aria-controls={panelDomId("topolograph")} aria-selected={mode === "topolograph"} tabIndex={mode === "topolograph" ? 0 : -1} onKeyDown={selectModeFromKey} onClick={() => setMode("topolograph")}>Topolograph</button>
        <button className="topology-tab__view-tab" ref={(element) => { tabRefs.current.stp = element; }} data-mode="stp" id={tabDomId("stp")} role="tab" aria-controls={panelDomId("stp")} aria-selected={mode === "stp"} tabIndex={mode === "stp" ? 0 : -1} onKeyDown={selectModeFromKey} onClick={() => setMode("stp")}>Spanning Tree</button>
      </div>
      <section id={panelDomId("topolograph")} role="tabpanel" aria-labelledby={tabDomId("topolograph")} hidden={mode !== "topolograph"}>
        {mode === "topolograph" ? <TopolographWorkspace /> : null}
      </section>
      <section id={panelDomId("stp")} role="tabpanel" aria-labelledby={tabDomId("stp")} hidden={mode !== "stp"}>
        {mode === "stp" ? <StpWorkspace /> : null}
      </section>
      <section
        className="topology-tab__panel"
        id={panelDomId("neighbors")}
        role="tabpanel"
        aria-labelledby={tabDomId("neighbors")}
        hidden={mode !== "neighbors"}
      >
      {mode === "neighbors" ? (
      <div
        className="topology-tab__workspace"
        role="region"
        aria-label="Neighbors topology workspace"
      >
      <header className="topology-tab__controls">
        <div className="topology-tab__title">
          <h2>Network neighbors</h2>
          <p>Recorded neighbor observations and routing adjacencies.</p>
        </div>
        <TopologyToolbar
          onRefresh={() => refresh()}
          onDiscoverDevices={() => setShowDiscoveryModal(true)}
          onClearGraph={handleClearGraph}
          onArrange={handleArrange}
          onArrangeConnected={handleArrangeConnected}
          onResetLayout={() => { void resetLayout(currentGraphId); }}
          discovering={discoveryStarting || discoveryActive}
        >
          <TopologyInterchange key={currentGraphId} snapshot={snapshotGraph?.id === currentGraphId && !loading ? {
            graph: snapshotGraph, nodes: rawNodes, edges, capture_evidence: captureEvidence,
            positions: nodes.map((node) => ({ device_ref: node.device_ref, ...positions[node.device_ref] })),
            ...(importProvenance ? { import_provenance: importProvenance } : {}),
          } : null} visibleNodes={filteredNodes} visibleEdges={filteredEdges} />
        </TopologyToolbar>
      </header>
      {importProvenance && <p>Imported graph ({importProvenance.format}) — file claims do not verify reachability; later native observations may coexist.</p>}
      {error && <div role="alert">{error}</div>}
      {layoutError && <div role="alert">{layoutError}</div>}
      {projection.warnings.length > 0 && <details><summary>Identity conflicts ({projection.warnings.length})</summary>{projection.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
      {discoveryError && <div role="alert">{discoveryError}</div>}
      {discoveryError && <button onClick={() => { void refreshDiscovery(); }}>Retry discovery status</button>}
      {discoveryRun && <section className="topology-discovery-report" aria-label="Discovery run">
        <div className="topology-discovery-report__overview">
          <p role="status"><strong>Discovery {discoveryRun.state} — {useTopologyStore.getState().graphs.find((graph) => graph.id === discoveryRun.graph_id)?.name ?? discoveryRun.graph_id}</strong><span>{discoveryRun.devices.length}/50 attempts</span></p>
          {discoveryActive && <button className="topology-toolbar__button" onClick={() => { void useTopologyStore.getState().cancelDiscovery(); }} disabled={discoveryRun.state === "cancelling"}>{discoveryRun.state === "cancelling" ? "Stopping and cleaning up…" : "Stop discovery"}</button>}
          {(deviceIssues > 0 || captureIssues > 0 || ["failed", "timed_out", "cancelled"].includes(discoveryRun.state)) && <span role="alert" className="topology-discovery-report__warning">{captureIssues > 0 || deviceIssues > 0 ? `${captureIssues} capture issue${captureIssues === 1 ? "" : "s"} · ${deviceIssues} device${deviceIssues === 1 ? " needs" : "s need"} attention. Review outcomes.` : "Run needs attention. Review outcomes."}</span>}
        </div>
        <details key={discoveryRun.run_id} className="topology-discovery-report__details"><summary>Device outcomes and neighbors not dialed</summary>
          <div className="topology-discovery-report__content">
            <p>Processed node rows: {discoveryRun.nodes_processed} | Processed link rows: {discoveryRun.edges_processed} (not newly discovered counts). Stop retains committed captures.</p>
            <ul>{discoveryRun.devices.map((device) => <li key={device.connection_id}>{device.host} · depth {device.depth} · {device.status}{device.error ? ` — ${device.error}` : ""}
              <ul>{device.captures.map((capture) => <li key={capture.protocol}>{capture.protocol}: {capture.status} ({capture.records} rows){capture.error ? ` — ${capture.error}` : ""}</li>)}</ul>
            </li>)}</ul>
            {discoveryRun.not_dialed.length > 0 && <details className="topology-discovery-report__skipped">
              <summary>Neighbors not dialed ({discoveryRun.not_dialed.length})</summary>
              <ul>{discoveryRun.not_dialed.map((neighbor, index) => <li key={index}>{neighbor.reference || "Unknown neighbor"}: not dialed — {neighbor.reason}</li>)}</ul>
            </details>}
            {discoveryRun.additional_not_dialed > 0 && <p>{discoveryRun.additional_not_dialed} additional not-dialed observations omitted from the bounded report.</p>}
            <p className="topology-discovery-report__timing">Parser admission wait: {discoveryRun.parser_admission_ms} ms; submission/reply wait: {discoveryRun.parser_reply_ms} ms (includes shared-sidecar queueing, not isolated parser execution).</p>
          </div>
        </details>
      </section>}
      <div
        className={`topology-tab__body topology-tab__body--filters-${filtersOpen ? "open" : "closed"} topology-tab__body--inspector-${selectedNode ? "open" : "closed"}`}
        data-testid="topology-workspace-body"
      >
        <div
          className="topology-tab__rail"
          data-testid="topology-navigation-rail"
          id={`topology-filters-${instanceId}`}
          hidden={!filtersOpen}
        >
          <div className="topology-tab__rail-heading"><strong>Filters</strong><button type="button" className="topology-toolbar__button" aria-label="Close filters" onClick={() => { setFiltersOpen(false); filterToggleRef.current?.focus(); }}>×</button></div>
          <TopologyFilterTree
            options={filterOptions}
            state={filterState}
            onChange={setFilterState}
          />
        </div>
        <section
          className="topology-tab__canvas-panel"
          aria-busy={loading}
          role="region"
          aria-label="Topology canvas"
          data-state={visibleNodes.length === 0 ? "empty" : "populated"}
        >
          <header className="topology-tab__graph-heading">
            <div>
              <h3>Recorded topology</h3>
              <p>{visibleNodes.length} devices · {visibleEdges.length} links · Reachability unverified</p>
              {focusRef && <p>One hop from {nodes.find((node) => node.device_ref === focusRef)?.label ?? focusRef} <button type="button" className="topology-toolbar__button" onClick={() => setFocusRef(null)}>Exit focus</button></p>}
            </div>
            <button type="button" className="topology-toolbar__button" ref={filterToggleRef} aria-expanded={filtersOpen} aria-controls={`topology-filters-${instanceId}`} onClick={() => setFiltersOpen((open) => !open)}>{filtersOpen ? "Hide filters" : "Show filters"}</button>
          </header>
          <div className="topology-tab__canvas">
            {visibleNodes.length === 0 && (
              <div
                className="topology-tab__empty"
                data-testid="topology-empty"
                role="status"
              >
                <strong>Waiting for neighbor evidence</strong>
                <span>
                  Run <code>show cdp neighbors</code> on a device to populate
                  the graph.
                </span>
              </div>
            )}
              <ReactFlow
                key={currentGraphId}
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                nodesDraggable
                nodesConnectable={false}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                onNodesChange={handleNodesChange}
                onNodeDragStop={(_, node, moved) => {
                  const dragged = moved.length ? moved : [node];
                  void persistPositions(dragged.filter((item) => nodes.some((known) => known.device_ref === item.id)).map((item) => ({ device_ref: item.id, ...item.position })));
                }}
                onNodeClick={handleNodeClick}
                proOptions={{ hideAttribution: true }}
                aria-label="Topology graph"
              >
                <MiniMap pannable zoomable />
                <Controls showInteractive={false} fitViewOptions={{ padding: 0.3 }} />
                <Background />
              </ReactFlow>
          </div>
          <p className="topology-tab__legend">□ SSH profile · ◇ NETCONF profile · ○ Discovered neighbor. Select a node for ports and capture times. Protocol labels and dash patterns distinguish recorded links, not device roles or live status.</p>
          <details className="topology-tab__link-table">
            <summary>Link table ({visibleEdges.length})</summary>
            <table aria-label="Recorded link evidence">
              <thead><tr><th>Endpoint A / port</th><th>Endpoint B / port</th><th>Evidence</th><th>Captured</th></tr></thead>
              <tbody>{visibleEdges.map((edge, index) => <tr key={JSON.stringify([edge.graph_id, edge.a_device_ref, edge.a_port, edge.b_device_ref, edge.b_port, edge.protocol, index])}>
                <td>{edge.a_device_ref} / {TopologyMap.portLabel(edge.protocol, edge.a_port)}</td><td>{edge.b_device_ref} / {TopologyMap.portLabel(edge.protocol, edge.b_port)}</td>
                <td>{edge.protocol.toUpperCase()} · {TopologyMap.evidenceLabel(edge.protocol)}</td><td>{TopologyMap.capturedLabel(edge.captured_at)}</td>
              </tr>)}</tbody>
            </table>
          </details>
        </section>
        {selectedNode && (
          <TopologyInspector
            key={JSON.stringify([currentGraphId, selectedNode.device_ref])}
            node={selectedNode}
            edges={selectedNodeEdges}
            captureEvidence={captureEvidence}
            onClose={closeInspector}
            onFocus={() => setFocusRef(selectedNode.device_ref)}
            onOpenUnknown={handleInspectorOpen}
            opening={opening}
            openError={openError}
            onOpenSsh={handleInspectorOpen}
            onOpenNetconf={handleInspectorOpen}
          />
        )}
      </div>
      <SaveNeighborModal
        isOpen={unknownNeighbor !== null}
        neighbor={unknownNeighbor}
        onClose={() => setUnknownNeighbor(null)}
      />
      <DeviceDiscoveryModal
        isOpen={showDiscoveryModal}
        onClose={() => setShowDiscoveryModal(false)}
        onDiscover={(deviceIds, passwords, destination, discoveryScope) => {
          if (discoveryStarting || discoveryActive) return;
          setShowDiscoveryModal(false);
          void useTopologyStore.getState().startDiscovery({
            graph_id: destination ?? currentGraphId,
            seed_ids: deviceIds,
            eligible_ids: discoveryScope?.eligibleIds ?? deviceIds,
            passwords,
            max_depth: discoveryScope?.maxDepth ?? 0,
            include_routing: discoveryScope?.includeRouting ?? false,
            ...(discoveryScope?.collectionMode ? { collection_mode: discoveryScope.collectionMode, snmp_secret_id: discoveryScope.snmpSecretId } : {}),
          });
        }}
      />
      </div>
      ) : null}
      </section>
    </div>
  );
}

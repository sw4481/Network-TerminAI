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
  type Edge,
  type Node,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import "@xyflow/react/dist/style.css";

import { useTopologyStore } from "../../state/topologyStore";
import { NeighborNode, type NeighborNodeT } from "./NeighborNode";
import { NeighborEdge } from "./NeighborEdge";
import {
  openNeighbor,
  type OpenNeighborHandlers,
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

const NODE_TYPES = { neighbor: NeighborNode };
const EDGE_TYPES = { default: NeighborEdge };

const RADIAL_THRESHOLD = 15;
const RADIAL_RADIUS_PX = 220;
const TIER_COLS = 6;
const TIER_X_STEP = 200;
const TIER_Y_STEP = 160;

export interface TopologyTabProps {
  tabId: string;
}

/**
 * Deterministic layout. Radial for small graphs (≤15 nodes), vendor-
 * bucketed grid for larger graphs. Either way the algorithm depends
 * only on `device_ref` ordering so auto-refresh doesn't shuffle nodes.
 */
function layoutPositions(
  nodes: TopologyNode[],
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
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

export function TopologyTab({ tabId }: TopologyTabProps) {
  const nodes = useTopologyStore((s) => s.nodes);
  const edges = useTopologyStore((s) => s.edges);
  const refresh = useTopologyStore((s) => s.refresh);
  const loadGraphs = useTopologyStore((s) => s.loadGraphs);
  const clearGraph = useTopologyStore((s) => s.clearGraph);
  const currentGraphId = useTopologyStore((s) => s.currentGraphId);
  const autoRefreshIntervalMs = useTopologyStore(
    (s) => s.autoRefreshIntervalMs,
  );

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [unknownNeighbor, setUnknownNeighbor] = useState<TopologyNode | null>(
    null,
  );
  const [showDiscoveryModal, setShowDiscoveryModal] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<{
    current: number;
    total: number;
    deviceName: string;
  } | null>(null);
  const [filterState, setFilterState] = useState<TopologyFilterState>(() => ({
    sites: new Set(),
    vendors: new Set(),
    platforms: new Set(),
    protocols: new Set(),
  }));

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

  const visibleNodes = useMemo(() => {
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

  const visibleEdges = useMemo(() => {
    const visibleRefs = new Set(visibleNodes.map((n) => n.device_ref));
    return edges.filter((e) => {
      if (
        filterState.protocols.size > 0 &&
        !filterState.protocols.has(e.protocol)
      ) {
        return false;
      }
      return visibleRefs.has(e.a_device_ref) && visibleRefs.has(e.b_device_ref);
    });
  }, [edges, filterState, visibleNodes]);

  const positions = useMemo(() => layoutPositions(visibleNodes), [visibleNodes]);

  const rfNodes: Node[] = useMemo(() => {
    return visibleNodes.map((n) => {
      const data: NeighborNodeT["data"] = {
        label: n.label,
        vendor: (n.vendor ?? "unknown").toLowerCase(),
        mgmtIp: n.mgmt_ip,
        isSource: false,
      };
      return {
        id: n.device_ref,
        type: "neighbor",
        position: positions[n.device_ref] ?? { x: 0, y: 0 },
        data: data as Record<string, unknown>,
      };
    });
  }, [visibleNodes, positions]);

  const rfEdges: Edge[] = useMemo(() => {
    return visibleEdges.map((e) => ({
      id: `${e.a_device_ref}::${e.a_port}--${e.b_device_ref}::${e.b_port}::${e.protocol}`,
      source: e.a_device_ref,
      target: e.b_device_ref,
      type: "default",
      data: { protocol: e.protocol },
    }));
  }, [visibleEdges]);

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
    setSelectedNodeId(node.id);
  };

  // Stub handlers — Phase 4 only logs. Real tab spawning lands in
  // Phase 5+ once the topology tab has access to the global tab spawner.
  const handleOpenSshTab = async (ref: string) => {
    console.info("[topology] open SSH for", ref);
  };
  const handleOpenNetconfTab = async (ref: string) => {
    console.info("[topology] open NETCONF for", ref);
  };

  const handleInspectorOpen = async () => {
    if (!selectedNode) return;
    const handlers: OpenNeighborHandlers = {
      onOpenSshTab: handleOpenSshTab,
      onOpenNetconfTab: handleOpenNetconfTab,
      onUnknownNeighbor: (n) => setUnknownNeighbor(n),
    };
    await openNeighbor(selectedNode, handlers);
  };

  const handleClearGraph = async () => {
    const ok = window.confirm(
      "Clear all nodes and edges in the current graph? This cannot be undone.",
    );
    if (!ok) return;
    await clearGraph(currentGraphId);
  };

  const handleExportPng = () => {
    // @xyflow/react v12 doesn't expose a built-in toPng helper. The
    // design doc explicitly allows deferring this if the helper isn't
    // available; revisit once html-to-image (or v12.x) ships a stable
    // export path.
    console.warn("[topology] PNG export not yet wired");
  };

  return (
    <div
      className="topology-tab"
      data-testid="topology-tab"
      data-tab-id={tabId}
    >
      <TopologyToolbar
        onRefresh={() => refresh()}
        onDiscoverDevices={() => setShowDiscoveryModal(true)}
        onExportPng={handleExportPng}
        onClearGraph={handleClearGraph}
      />
      <div className="topology-tab__body">
        <TopologyFilterTree
          options={filterOptions}
          state={filterState}
          onChange={setFilterState}
        />
        <div className="topology-tab__canvas">
          {visibleNodes.length === 0 ? (
            <div
              className="topology-tab__empty"
              data-testid="topology-empty"
            >
              No neighbors discovered yet — run{" "}
              <code>show cdp neighbors</code> on a device to populate the
              graph.
            </div>
          ) : (
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              nodesDraggable
              nodesConnectable={false}
              fitView
              onNodeClick={handleNodeClick}
              proOptions={{ hideAttribution: true }}
              aria-label="Global topology graph"
            >
              <MiniMap pannable zoomable />
              <Controls showInteractive={false} />
              <Background />
            </ReactFlow>
          )}
        </div>
        {selectedNode && (
          <TopologyInspector
            node={selectedNode}
            edges={selectedNodeEdges}
            onClose={() => setSelectedNodeId(null)}
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
        onDiscover={async (deviceIds, passwords) => {
          console.log('[TopologyTab] Starting discovery for devices:', deviceIds);
          setShowDiscoveryModal(false);

          try {
            const discoverDevices = useTopologyStore.getState().discoverDevices;
            const result = await discoverDevices(deviceIds, passwords, (current, total, deviceName) => {
              setDiscoveryProgress({ current, total, deviceName });
            });

            setDiscoveryProgress(null);

            // Show result notification
            const statusDiv = document.createElement('div');
            statusDiv.style.cssText = `
              position: fixed;
              top: 20px;
              right: 20px;
              background: var(--surface-2);
              border: 1px solid var(--topology-success);
              border-radius: 8px;
              padding: 12px 16px;
              color: var(--topology-success-text);
              font-size: 14px;
              z-index: 10001;
              box-shadow: 0 4px 12px rgb(var(--backdrop-rgb) / 0.5);
            `;
            statusDiv.innerHTML = `
              ✅ Discovery complete!<br/>
              <small>Succeeded: ${result.succeeded} | Failed: ${result.failed}</small>
            `;
            document.body.appendChild(statusDiv);
            setTimeout(() => {
              document.body.removeChild(statusDiv);
            }, 5000);
          } catch (err) {
            setDiscoveryProgress(null);
            console.error('[TopologyTab] Discovery failed:', err);
            alert(`Discovery failed: ${String(err)}`);
          }
        }}
      />
      {discoveryProgress && (
        <div
          style={{
            position: 'fixed',
            top: 20,
            right: 20,
            background: 'var(--surface-2)',
            border: '1px solid var(--topology-success)',
            borderRadius: 8,
            padding: '12px 16px',
            color: 'var(--topology-success-text)',
            fontSize: 14,
            zIndex: 10001,
            boxShadow: '0 4px 12px rgb(var(--backdrop-rgb) / 0.5)',
          }}
        >
          🔍 Discovering devices... ({discoveryProgress.current}/{discoveryProgress.total})
          <br />
          <small style={{ opacity: 0.7 }}>{discoveryProgress.deviceName}</small>
        </div>
      )}
    </div>
  );
}

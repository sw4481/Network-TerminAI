/**
 * Plan 13 Phase 2 Task 2.3 — Inline neighbor-graph panel.
 *
 * Renders an immediate-neighbors slice of the topology store, scoped to
 * the device a `show cdp|lldp neighbor` block was run against. The
 * panel is display-only: nodes/edges are derived via `useMemo` and
 * passed straight into `<ReactFlow />`. We deliberately avoid
 * `useNodesState` / `useEdgesState` (no drag, no connect, no change
 * tracking) because Phase 4 owns the editable Global topology tab.
 *
 * Click on a neighbor → `onNeighborClick(node)`. The actual SSH /
 * neighbor-resolution flow is wired in Phase 3 — Phase 2 just lifts
 * the click through a callback prop.
 *
 * Layout: source device pinned at (0, 0); neighbors arranged on a
 * radius-120 circle around it. Phase 4 swaps this for `d3-force`.
 *
 * See `docs/design/topology-inline.md` for the spec contract.
 */
import { useMemo } from "react";
import {
  ReactFlow,
  type Edge,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { TopologyEdge, TopologyNode } from "../../lib/topology";
import { NeighborEdge } from "./NeighborEdge";
import { NeighborNode, type NeighborNodeT } from "./NeighborNode";
import { PROTOCOL_EDGE_STYLE } from "./topologyTheme";
import "./InlineTopologyPanel.css";

export type NeighborEdgeT = Edge<{ protocol: "cdp" | "lldp" }, "default">;

export interface InlineTopologyPanelProps {
  /** Topology nodes from the store; component derives reactflow props. */
  storeNodes: TopologyNode[];
  /** Topology edges from the store; component derives reactflow props. */
  storeEdges: TopologyEdge[];
  /**
   * Source device (the device the show command was run on) — used to
   * mark "this" node and to slice the global graph down to just the
   * immediate-neighbor subset.
   */
  sourceDeviceRef: string;
  onNeighborClick: (node: NeighborNodeT) => void;
  /** Optional stub for the "expand to topology tab" button — wired in Phase 4. */
  onExpand?: () => void;
}

const NEIGHBOR_RADIUS_PX = 120;
const SOURCE_POSITION = { x: 0, y: 0 };

const NODE_TYPES: NodeTypes = { neighbor: NeighborNode };

// Custom edge type registered at module scope so ReactFlow doesn't
// rebuild the renderer on every panel render. The default key surfaces
// `data-protocol` on the rendered `<path>` for Playwright selectors.
const EDGE_TYPES: EdgeTypes = { default: NeighborEdge };

const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1.5 } as const;

/** Best-effort vendor pull from the store node, lowercased and defaulted. */
function vendorOf(node: TopologyNode): string {
  return (node.vendor ?? "unknown").toLowerCase();
}

/**
 * Pick the local/neighbor port pair from an edge given the source-side
 * device_ref. Returns `[localPort, neighborPort]`.
 */
function portsFor(
  edge: TopologyEdge,
  sourceRef: string,
): [string | undefined, string | undefined] {
  if (edge.a_device_ref === sourceRef) return [edge.a_port, edge.b_port];
  if (edge.b_device_ref === sourceRef) return [edge.b_port, edge.a_port];
  return [undefined, undefined];
}

/**
 * The "other side" of an edge relative to a known anchor device_ref.
 * Returns null if the edge does not touch the anchor.
 */
function otherEnd(edge: TopologyEdge, anchor: string): string | null {
  if (edge.a_device_ref === anchor) return edge.b_device_ref;
  if (edge.b_device_ref === anchor) return edge.a_device_ref;
  return null;
}

export function InlineTopologyPanel({
  storeNodes,
  storeEdges,
  sourceDeviceRef,
  onNeighborClick,
  onExpand,
}: InlineTopologyPanelProps) {
  // 1. Slice: keep only edges that touch the source, then resolve the
  //    neighbor device_refs from those edges. Phase 5 may broaden this
  //    to multi-hop, but Phase 2 is strictly immediate-neighbors.
  const { neighborRefs, slicedEdges } = useMemo(() => {
    const refs: string[] = [];
    const seenRefs = new Set<string>();
    const sliced: TopologyEdge[] = [];
    for (const edge of storeEdges) {
      const other = otherEnd(edge, sourceDeviceRef);
      if (other === null) continue;
      sliced.push(edge);
      if (!seenRefs.has(other) && other !== sourceDeviceRef) {
        seenRefs.add(other);
        refs.push(other);
      }
    }
    return { neighborRefs: refs, slicedEdges: sliced };
  }, [storeEdges, sourceDeviceRef]);

  // 2. Build a quick lookup so we can hydrate per-node metadata
  //    (vendor, mgmt_ip, label) from the store records.
  const nodeIndex = useMemo(() => {
    const idx = new Map<string, TopologyNode>();
    for (const n of storeNodes) idx.set(n.device_ref, n);
    return idx;
  }, [storeNodes]);

  // 3. Derive reactflow nodes. The source device is pinned at (0, 0);
  //    each neighbor sits on a radius-120 circle around it.
  const rfNodes: NeighborNodeT[] = useMemo(() => {
    if (neighborRefs.length === 0) return [];
    const sourceRecord = nodeIndex.get(sourceDeviceRef);
    const sourceLabel = sourceRecord?.label ?? sourceDeviceRef;
    const sourceVendor = vendorOf(
      sourceRecord ?? ({ vendor: "unknown" } as TopologyNode),
    );

    const out: NeighborNodeT[] = [
      {
        id: sourceDeviceRef,
        type: "neighbor",
        position: SOURCE_POSITION,
        data: {
          label: sourceLabel,
          vendor: sourceVendor,
          mgmtIp: sourceRecord?.mgmt_ip,
          isSource: true,
        },
      },
    ];

    const step = (2 * Math.PI) / neighborRefs.length;
    neighborRefs.forEach((ref, i) => {
      // Start at the top (-π/2) and step clockwise so the first
      // neighbor sits directly above-right and reads naturally.
      const angle = -Math.PI / 2 + i * step;
      const x = Math.round(NEIGHBOR_RADIUS_PX * Math.cos(angle));
      const y = Math.round(NEIGHBOR_RADIUS_PX * Math.sin(angle));
      const record = nodeIndex.get(ref);
      // Find the edge that connects source ↔ this neighbor (any of
      // them — port info is best-effort for the tooltip).
      const edge = slicedEdges.find(
        (e) => otherEnd(e, sourceDeviceRef) === ref,
      );
      const [, neighborPort] = edge
        ? portsFor(edge, sourceDeviceRef)
        : [undefined, undefined];
      const localPort = edge
        ? portsFor(edge, sourceDeviceRef)[0]
        : undefined;
      out.push({
        id: ref,
        type: "neighbor",
        position: { x, y },
        data: {
          label: record?.label ?? ref,
          vendor: vendorOf(record ?? ({ vendor: "unknown" } as TopologyNode)),
          mgmtIp: record?.mgmt_ip,
          localPort,
          neighborPort,
        },
      });
    });

    return out;
  }, [neighborRefs, nodeIndex, sourceDeviceRef, slicedEdges]);

  // 4. Derive reactflow edges. We surface the protocol via `data` so
  //    Playwright/test selectors can hook off `data-protocol`, and we
  //    drive solid/dashed via the shared style tokens.
  const rfEdges: NeighborEdgeT[] = useMemo(() => {
    return slicedEdges
      .filter((e) => e.protocol === "cdp" || e.protocol === "lldp")
      .map((e) => {
        const protocol = e.protocol as "cdp" | "lldp";
        return {
          id: `${e.a_device_ref}::${e.a_port}--${e.b_device_ref}::${e.b_port}::${protocol}`,
          source: e.a_device_ref,
          target: e.b_device_ref,
          type: "default",
          data: { protocol },
          style: PROTOCOL_EDGE_STYLE[protocol],
        } satisfies NeighborEdgeT;
      });
  }, [slicedEdges]);

  // 5. Adapter: ReactFlow's onNodeClick is `(event, node) => void` but
  //    we expose only the node to consumers — the event is internal.
  const handleNodeClick: NodeMouseHandler<NeighborNodeT> = (_event, node) => {
    onNeighborClick(node);
  };

  const isEmpty = rfNodes.length === 0;
  const neighborCount = neighborRefs.length;

  return (
    <div
      className="topology-inline"
      data-testid="topology-inline-panel"
    >
      <header className="topology-inline__header">
        <span className="topology-inline__title">
          Neighbors ({neighborCount})
        </span>
        {onExpand ? (
          <button
            type="button"
            className="topology-inline__expand"
            onClick={onExpand}
            aria-label="Expand to full topology tab"
            title="Expand to full topology tab"
          >
            ⛶
          </button>
        ) : null}
      </header>
      {isEmpty ? (
        <div
          className="topology-inline__empty"
          data-testid="topology-inline-empty"
        >
          No neighbors discovered yet.
        </div>
      ) : (
        <div className="topology-inline__canvas">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodeClick={handleNodeClick}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            panOnDrag={false}
            proOptions={{ hideAttribution: true }}
            aria-label="Neighbor topology graph"
          />
        </div>
      )}
    </div>
  );
}

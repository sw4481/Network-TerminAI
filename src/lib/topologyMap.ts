import type { Edge } from "@xyflow/react";
import type { TopologyEdge, TopologyNode } from "./topology";

/** Pure render projections; callers choose the graph/filter and explicitly request arrangement. */
export class TopologyMap {
  static connectedPositions(nodes: TopologyNode[], edges: TopologyEdge[]): Record<string, { x: number; y: number }> {
    const neighbors = new Map<string, Set<string>>();
    const graphRefs = new Map<string, Set<string>>();
    for (const node of nodes) {
      if (!neighbors.has(node.device_ref)) neighbors.set(node.device_ref, new Set());
      const refs = graphRefs.get(node.graph_id) ?? new Set<string>();
      refs.add(node.device_ref);
      graphRefs.set(node.graph_id, refs);
    }
    for (const edge of edges) {
      const refs = graphRefs.get(edge.graph_id);
      if (!refs?.has(edge.a_device_ref) || !refs.has(edge.b_device_ref)) continue;
      neighbors.get(edge.a_device_ref)!.add(edge.b_device_ref);
      neighbors.get(edge.b_device_ref)!.add(edge.a_device_ref);
    }
    const positions: Record<string, { x: number; y: number }> = Object.create(null);
    const visited = new Set<string>();
    let band = 0;
    for (const root of [...neighbors.keys()].sort()) {
      if (visited.has(root)) continue;
      const queue: [string, number][] = [[root, 0]];
      const levelRows: number[] = [];
      visited.add(root);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const [ref, level] = queue[cursor];
        const row = levelRows[level] ?? 0;
        positions[ref] = { x: level * 220, y: (band + row) * 160 };
        levelRows[level] = row + 1;
        for (const peer of [...neighbors.get(ref)!].sort()) {
          if (visited.has(peer)) continue;
          visited.add(peer);
          queue.push([peer, level + 1]);
        }
      }
      band += Math.max(...levelRows) + 1;
    }
    return positions;
  }

  static oneHop(edges: TopologyEdge[], anchor: string): Set<string> {
    const refs = new Set([anchor]);
    for (const edge of edges) {
      if (edge.a_device_ref === anchor) refs.add(edge.b_device_ref);
      if (edge.b_device_ref === anchor) refs.add(edge.a_device_ref);
    }
    return refs;
  }

  static links(edges: TopologyEdge[], selectedRef: string | null): Edge[] {
    const rows = edges.map((edge) => {
      const reverse = edge.a_device_ref > edge.b_device_ref ||
        (edge.a_device_ref === edge.b_device_ref && edge.a_port > edge.b_port);
      const [source, aPort, target, bPort] = reverse
        ? [edge.b_device_ref, edge.b_port, edge.a_device_ref, edge.a_port]
        : [edge.a_device_ref, edge.a_port, edge.b_device_ref, edge.b_port];
      const key = JSON.stringify([edge.graph_id, source, aPort, target, bPort, edge.protocol]);
      return { key, pair: JSON.stringify([edge.graph_id, source, target]), source, target, aPort, bPort, protocol: edge.protocol };
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.pair, (totals.get(row.pair) ?? 0) + 1);
    const indices = new Map<string, number>();
    const occurrences = new Map<string, number>();
    return rows.map((row) => {
      const index = indices.get(row.pair) ?? 0;
      const occurrence = occurrences.get(row.key) ?? 0;
      indices.set(row.pair, index + 1);
      occurrences.set(row.key, occurrence + 1);
      return {
        id: JSON.stringify(["topology-map", row.key, occurrence]),
        source: row.source, target: row.target, type: "default",
        data: {
          protocol: row.protocol, aPort: row.aPort, bPort: row.bPort,
          offset: (index - (totals.get(row.pair)! - 1) / 2) * 40,
          mapEdge: true, showLabel: selectedRef !== null && (row.source === selectedRef || row.target === selectedRef),
        },
      };
    });
  }

  /** The model has no source/freshness policy; these labels do not imply physical or reverse verification. */
  static evidenceLabel(protocol: string): string {
    if (protocol === "cdp" || protocol === "lldp") return "L2 observation";
    if (protocol === "bgp" || protocol === "ospf" || protocol === "isis" || protocol === "eigrp") return "Routing adjacency";
    return "Unknown evidence";
  }

  static portLabel(protocol: string, port: string): string {
    if (!port) return "Port not recorded";
    // Routing peer:* values are ingest identity placeholders, not recorded interfaces.
    if ((protocol === "bgp" || protocol === "ospf" || protocol === "isis" || protocol === "eigrp") && port.startsWith("peer:")) {
      return `Logical peer ${port.slice(5)} (port not recorded)`;
    }
    return port;
  }

  static capturedLabel(seconds: number): string {
    const date = new Date(seconds * 1000);
    return Number.isFinite(seconds) && seconds > 0 && Number.isFinite(date.getTime())
      ? date.toLocaleString() : "Capture time unknown";
  }
}

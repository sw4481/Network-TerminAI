/**
 * Plan 13 Phase 2 Task 2.3 — Vendor color and edge style tokens for the
 * inline topology panel.
 *
 * These tokens are referenced from `docs/design/topology-inline.md` and
 * are intentionally kept in a standalone file so future phases (the
 * Global Topology tab in Phase 4) can re-use the exact same palette
 * without dragging in any panel-level layout code.
 */
import type { CSSProperties } from "react";

/**
 * Vendor → hex color used for the `.neighbor-node` ring/fill. Falls
 * back to `unknown` (grey) for any vendor string we don't have an
 * explicit token for.
 */
export const VENDOR_COLOR: Record<string, string> = {
  cisco: "#1e6cb6",
  juniper: "#3aa676",
  arista: "#c0392b",
  meraki: "#7f5fb0",
  unknown: "#7f7f7f",
};

/**
 * Resolve a vendor string to its color, normalizing case and falling
 * back to the `unknown` token when the vendor is missing or not in the
 * map.
 */
export function vendorColor(vendor: string | undefined | null): string {
  const key = (vendor ?? "unknown").toLowerCase();
  return VENDOR_COLOR[key] ?? VENDOR_COLOR.unknown;
}

/**
 * Edge style per protocol. Phase 1 — CDP solid / LLDP dashed (same neutral
 * grey, vendor color cues live on the nodes). Phase 5 Task 5.2 — added
 * BGP / OSPF / IS-IS adjacency styles so routing topology stays visually
 * distinguishable in the Global graph.
 */
export const PROTOCOL_EDGE_STYLE: Record<string, CSSProperties> = {
  cdp: { stroke: "#888", strokeWidth: 1.5 },
  lldp: { stroke: "#888", strokeWidth: 1.5, strokeDasharray: "4 3" },
  bgp: { stroke: "#c0392b", strokeWidth: 2.5 },
  ospf: { stroke: "#7f5fb0", strokeWidth: 1.5, strokeDasharray: "1 3" },
  isis: { stroke: "#d68a3c", strokeWidth: 1.5, strokeDasharray: "6 3" },
};

/**
 * Plan 13 Phase 2 Task 2.3 — Custom @xyflow/react node for the inline
 * topology panel.
 *
 * Render contract (from `docs/design/topology-inline.md`):
 *  - Vendor-coloured 40px circle with the device label below.
 *  - Hover surfaces a tooltip with `localPort ↔ neighborPort` plus the
 *    management IP when available.
 *  - Accessibility: `role="button"`, `tabIndex={0}`, `aria-label`
 *    reflecting both vendor and label.
 *  - Source/target `<Handle>`s are rendered (otherwise edges fail to
 *    attach a path), but they're hidden via opacity since this graph
 *    is read-only.
 */
import type { CSSProperties, KeyboardEvent } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { vendorColor } from "./topologyTheme";

export type NeighborNodeT = Node<
  {
    label: string;
    /** 'cisco' | 'juniper' | 'arista' | 'meraki' | 'unknown' (case-insensitive). */
    vendor: string;
    mgmtIp?: string;
    localPort?: string;
    neighborPort?: string;
    /** Marks the device the show command was run on. */
    isSource?: boolean;
    /** Activates the parent inspector without relying on pointer events. */
    onActivate?: () => void;
  },
  "neighbor"
>;

const HIDDEN_HANDLE: CSSProperties = {
  opacity: 0,
  pointerEvents: "none",
  width: 1,
  height: 1,
};

export function NeighborNode({ data }: NodeProps<NeighborNodeT>) {
  const color = vendorColor(data.vendor);
  const tooltipParts: string[] = [];
  if (data.localPort && data.neighborPort) {
    tooltipParts.push(`${data.localPort} ↔ ${data.neighborPort}`);
  } else if (data.localPort) {
    tooltipParts.push(`local: ${data.localPort}`);
  } else if (data.neighborPort) {
    tooltipParts.push(`remote: ${data.neighborPort}`);
  }
  if (data.mgmtIp) {
    tooltipParts.push(`mgmt: ${data.mgmtIp}`);
  }
  const tooltip = tooltipParts.join(" · ");
  const vendorKey = (data.vendor ?? "unknown").toLowerCase();
  const ariaLabel = `${vendorKey}: ${data.label}`;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    data.onActivate?.();
  };

  return (
    <div
      className={`neighbor-node${data.isSource ? " neighbor-node--source" : ""}`}
      data-testid="topology-node"
      data-vendor={vendorKey}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      title={tooltip || undefined}
      onClick={() => data.onActivate?.()}
      onKeyDown={handleKeyDown}
      style={{ "--neighbor-vendor-color": color } as CSSProperties}
    >
      <Handle type="target" position={Position.Top} style={HIDDEN_HANDLE} />
      <span className="neighbor-node__circle" aria-hidden="true" />
      <span className="neighbor-node__label">{data.label}</span>
      {tooltip ? (
        <span className="neighbor-node__tooltip" role="tooltip">
          {tooltip}
        </span>
      ) : null}
      <Handle type="source" position={Position.Bottom} style={HIDDEN_HANDLE} />
    </div>
  );
}

/**
 * Plan 13 Phase 2 Task 2.3 — Custom ReactFlow edge that surfaces the
 * CDP/LLDP protocol on the rendered SVG `<path>` element via
 * `data-protocol`.
 *
 * Why a custom edge: ReactFlow v12 stores `edge.data.protocol` in
 * internal state but does NOT forward it to the DOM. Phase 2.6's e2e
 * selectors (`[data-protocol="cdp"]`, `[data-protocol="lldp"]`) rely on
 * the attribute being on the `<path>`, so we re-render via
 * `<BaseEdge>` and pass `data-protocol` through. SVG elements forward
 * arbitrary `data-*` attributes via React's standard reconciliation,
 * which `BaseEdge` honours.
 */
import type { EdgeProps } from "@xyflow/react";
import { BaseEdge, getBezierPath } from "@xyflow/react";

import { PROTOCOL_EDGE_STYLE } from "./topologyTheme";
import { TopologyMap } from "../../lib/topologyMap";

export function NeighborEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data, style: extraStyle } = props;
  const edgeData = data as {
    protocol?: string; mapEdge?: boolean; offset?: number;
    aPort?: string; bPort?: string; showLabel?: boolean;
  } | undefined;
  const protocol = edgeData?.protocol;
  const style = {
    ...(protocol ? PROTOCOL_EDGE_STYLE[protocol] : {}),
    ...extraStyle,
  };
  if (!edgeData?.mapEdge) {
    // Keep the inline panel's original geometry and styling unchanged.
    const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY });
    return <BaseEdge id={props.id} path={path} style={style} data-protocol={protocol ?? ""} />;
  }

  const directions = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  const [sx, sy] = directions[props.sourcePosition];
  const [tx, ty] = directions[props.targetPosition];
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy);
  const offset = Number.isFinite(edgeData.offset) ? edgeData.offset! : 0;
  const loop = props.source === props.target || length === 0;
  const reach = loop ? 100 + Math.abs(offset) : Math.max(60, length / 3);
  // A cubic's midpoint receives 3/4 of a shared control-point shift.
  const shiftX = loop ? (offset < 0 ? -reach : reach) : -dy / length * offset * 4 / 3;
  const shiftY = loop ? -reach : dx / length * offset * 4 / 3;
  const c1x = sourceX + sx * reach + shiftX;
  const c1y = sourceY + sy * reach + shiftY;
  const c2x = targetX + tx * reach + shiftX;
  const c2y = targetY + ty * reach + shiftY;
  const path = `M${sourceX},${sourceY} C${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`;
  const labelX = (sourceX + 3 * c1x + 3 * c2x + targetX) / 8;
  const labelY = (sourceY + 3 * c1y + 3 * c2y + targetY) / 8;
  const evidence = TopologyMap.evidenceLabel(protocol ?? "");
  const ports = [edgeData.aPort, edgeData.bPort].map((port) => TopologyMap.portLabel(protocol ?? "", port ?? ""));
  const label = ports.map((port) => {
    const characters = Array.from(port);
    return characters.length > 12 ? `${characters.slice(0, 11).join("")}…` : port;
  }).join(" — ");
  const details = `${protocol ?? "unknown"} · ${evidence} · ${ports.join(" — ")}`;
  return (
    <g>
      <title>{`${props.source} — ${props.target} · ${details}`}</title>
      <BaseEdge
        id={props.id}
        path={path}
        style={{ ...style, stroke: "var(--text-muted)" }}
        data-protocol={protocol ?? ""}
        interactionWidth={props.interactionWidth}
        label={edgeData.showLabel || props.selected ? label : undefined}
        labelX={labelX}
        labelY={labelY}
        labelStyle={{ fill: "var(--text-primary)", fontSize: 11 }}
        labelShowBg
        labelBgStyle={{ fill: "var(--surface-2)" }}
        labelBgPadding={[6, 4]}
        labelBgBorderRadius={3}
      />
    </g>
  );
}

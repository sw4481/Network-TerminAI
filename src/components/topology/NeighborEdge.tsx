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

export function NeighborEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data, style: extraStyle } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY });
  const protocol = (data as { protocol?: "cdp" | "lldp" } | undefined)
    ?.protocol;
  const style = {
    ...(protocol ? PROTOCOL_EDGE_STYLE[protocol] : {}),
    ...extraStyle,
  };
  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={style}
      data-protocol={protocol ?? ""}
    />
  );
}

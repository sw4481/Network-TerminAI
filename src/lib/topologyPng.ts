import type { GraphSnapshot } from "./topology";
import { TopologyProjection } from "./topology";
import { TopologyMap } from "./topologyMap";
import type { TopologyNodeGeometry } from "./topologyExport";
import { PROTOCOL_EDGE_STYLE } from "../components/topology/topologyTheme";

export interface TopologyPngText {
  x: number; y: number; fontFamily: string; fontSize: string; fontWeight: string; fill: string;
}
export interface TopologyPngVisual {
  background: string; border: string; accent: string;
  marker: { x: number; y: number; width: number; height: number; fill: string; border: string };
  label: TopologyPngText; kind: TopologyPngText;
  source: { x: number; y: number }; target: { x: number; y: number };
}
export interface TopologyPngTheme { background: string; surface: string; text: string; muted: string; fontFamily: string }
export interface TopologySvg { svg: string; width: number; height: number }

/** Offline SVG primitives only: no HTML/foreignObject, images, CSS URLs or external resources. */
export class TopologyPng {
  static readonly maxDimension = 16384;
  static readonly maxPixels = 32 * 1024 * 1024;
  static readonly maxBytes = 10 * 1024 * 1024;

  static checkSize(width: number, height: number): void {
    if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
      width > this.maxDimension || height > this.maxDimension || width * height > this.maxPixels) {
      throw new Error("PNG exceeds the 16,384px dimension or 32 megapixel limit. Choose a smaller filtered graph.");
    }
  }

  static checkBytes(size: number): void {
    if (!Number.isFinite(size) || size > this.maxBytes) throw new Error("PNG export exceeds the 10 MiB output limit.");
  }

  // Exact map-edge cubic contract from NeighborEdge; handles are measured, not node-centre guesses.
  static curve(source: { x: number; y: number }, target: { x: number; y: number }, offset: number, self: boolean) {
    const dx = target.x - source.x, dy = target.y - source.y;
    const length = Math.hypot(dx, dy);
    const loop = self || length === 0;
    const reach = loop ? 100 + Math.abs(offset) : Math.max(60, length / 3);
    const shiftX = loop ? (offset < 0 ? -reach : reach) : -dy / length * offset * 4 / 3;
    const shiftY = loop ? -reach : dx / length * offset * 4 / 3;
    const c1 = { x: source.x + shiftX, y: source.y + reach + shiftY };
    const c2 = { x: target.x + shiftX, y: target.y - reach + shiftY };
    const points = [source, c1, c2, target];
    if (points.some((point) => ![point.x, point.y].every(Number.isFinite))) throw new Error("Invalid PNG curve geometry.");
    return {
      path: `M${source.x},${source.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${target.x},${target.y}`,
      // Control hull bounds contain the entire cubic, including self loops and parallel offsets.
      points,
      x: (source.x + 3 * c1.x + 3 * c2.x + target.x) / 8,
      y: (source.y + 3 * c1.y + 3 * c2.y + target.y) / 8,
    };
  }

  static toSvg(snapshot: GraphSnapshot, geometry: TopologyNodeGeometry[], theme: TopologyPngTheme): TopologySvg {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const layer = document.createElementNS(ns, "g");
    svg.appendChild(layer);
    const number = (value: number) => {
      if (!Number.isFinite(value)) throw new Error("Invalid measured PNG geometry.");
      return value;
    };
    const color = (value: string) => {
      // Computed colours only; rejecting paint-server/url values keeps SVG entirely self-contained.
      if (!/^(#[\da-f]{3,8}|rgba?\([\d\s.,%/]+\)|[a-z]+)$/i.test(value)) throw new Error("PNG requires resolved theme colours.");
      return value;
    };
    const textValue = (value: string) => {
      for (const character of value) {
        const code = character.codePointAt(0)!;
        if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000)) throw new Error("Cannot export XML: invalid label character.");
      }
      return value;
    };
    const append = (tag: string, attrs: Record<string, string | number>, parent: Element = layer) => {
      const element = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(typeof value === "number" ? number(value) : value));
      parent.appendChild(element);
      return element;
    };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = (x: number, y: number, width = 0, height = 0) => {
      minX = Math.min(minX, number(x)); minY = Math.min(minY, number(y));
      maxX = Math.max(maxX, number(x + width)); maxY = Math.max(maxY, number(y + height));
    };
    const text = (value: string, style: TopologyPngText, anchor = "start") => {
      const element = append("text", { x: style.x, y: style.y, fill: color(style.fill), "font-family": style.fontFamily,
        "font-size": style.fontSize, "font-weight": style.fontWeight, "text-anchor": anchor, "dominant-baseline": "hanging" });
      element.textContent = textValue(value);
      return element as SVGTextElement;
    };
    const measured = new Map(geometry.map((row) => [row.device_ref, row]));
    if (measured.size !== geometry.length) throw new Error("Duplicate measured PNG geometry.");
    const nodes = TopologyProjection.project(snapshot.nodes, snapshot.graph.id).nodes;
    for (const node of nodes) {
      const row = measured.get(node.device_ref);
      if (!row?.visual || row.width <= 0 || row.height <= 0) throw new Error(`Missing measured PNG visuals for ${node.device_ref}.`);
      include(row.x, row.y, row.width, row.height);
    }
    const edgeLabels: { element: SVGTextElement; background: SVGElement }[] = [];
    for (const link of TopologyMap.links(snapshot.edges, null)) {
      const a = measured.get(link.source)!, b = measured.get(link.target)!;
      if (!a?.visual || !b?.visual) throw new Error("PNG link endpoint is outside the measured scope.");
      const data = link.data as { offset: number; protocol: string; aPort: string; bPort: string };
      const curve = this.curve({ x: a.x + a.visual.source.x, y: a.y + a.visual.source.y },
        { x: b.x + b.visual.target.x, y: b.y + b.visual.target.y }, data.offset, link.source === link.target);
      curve.points.forEach((point) => include(point.x, point.y));
      const edgeStyle = PROTOCOL_EDGE_STYLE[data.protocol] ?? PROTOCOL_EDGE_STYLE.unknown;
      append("path", { d: curve.path, fill: "none", stroke: color(theme.muted), "stroke-width": Number(edgeStyle.strokeWidth ?? 1.5),
        ...(edgeStyle.strokeDasharray ? { "stroke-dasharray": String(edgeStyle.strokeDasharray) } : {}), "data-protocol": data.protocol });
      const background = append("rect", { fill: color(theme.surface), rx: 3 });
      const ports = [data.aPort, data.bPort].map((port) => TopologyMap.portLabel(data.protocol, port));
      const element = text(`${data.protocol} · ${TopologyMap.evidenceLabel(data.protocol)} (unverified) · ${ports.join(" — ")}`,
        { x: curve.x, y: curve.y, fontFamily: theme.fontFamily, fontSize: "11px", fontWeight: "400", fill: theme.text }, "middle");
      edgeLabels.push({ element, background });
    }
    for (const node of nodes) {
      const row = measured.get(node.device_ref)!, visual = row.visual!;
      append("rect", { x: row.x, y: row.y, width: row.width, height: row.height, rx: 4, fill: color(visual.background),
        stroke: color(visual.border), "stroke-width": 1, ...(node.device_kind === "discovered" ? { "stroke-dasharray": "4 3" } : {}) });
      append("path", { d: `M${row.x + 1.5},${row.y + 1} V${row.y + row.height - 1}`, stroke: color(visual.accent), "stroke-width": 3 });
      const marker = visual.marker, x = row.x + marker.x, y = row.y + marker.y;
      const attrs = { fill: color(marker.fill), stroke: color(marker.border), "stroke-width": 1 };
      if (node.device_kind === "discovered") append("ellipse", { cx: x + marker.width / 2, cy: y + marker.height / 2, rx: marker.width / 2, ry: marker.height / 2, ...attrs });
      else append("rect", { x, y, width: marker.width, height: marker.height, rx: node.device_kind === "ssh" ? 2 : 0,
        ...(node.device_kind === "netconf" ? { transform: `rotate(45 ${x + marker.width / 2} ${y + marker.height / 2})` } : {}), ...attrs });
      text(node.label, { ...visual.label, x: row.x + visual.label.x, y: row.y + visual.label.y });
      text(node.device_kind === "discovered" ? "Discovered" : `${node.device_kind.toUpperCase()} profile`,
        { ...visual.kind, x: row.x + visual.kind.x, y: row.y + visual.kind.y });
    }
    // Actual font metrics, not a character-count width heuristic. Hidden but laid out locally.
    svg.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(svg);
    try {
      for (const { element, background } of edgeLabels) {
        const bounds = element.getBBox();
        background.setAttribute("x", String(bounds.x - 6)); background.setAttribute("y", String(bounds.y - 4));
        background.setAttribute("width", String(bounds.width + 12)); background.setAttribute("height", String(bounds.height + 8));
        include(bounds.x - 6, bounds.y - 4, bounds.width + 12, bounds.height + 8);
      }
      for (const element of layer.querySelectorAll("text")) {
        const bounds = element.getBBox();
        include(bounds.x, bounds.y, bounds.width, bounds.height);
      }
      if (!nodes.length) include(0, 0, 1, 1);
      const padding = 24;
      const width = Math.ceil(maxX - minX + padding * 2), height = Math.ceil(maxY - minY + padding * 2);
      this.checkSize(width, height);
      svg.removeAttribute("style");
      svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", `${minX - padding} ${minY - padding} ${width} ${height}`);
      const background = document.createElementNS(ns, "rect");
      for (const [key, value] of Object.entries({ x: minX - padding, y: minY - padding, width, height, fill: color(theme.background) })) background.setAttribute(key, String(value));
      svg.insertBefore(background, layer);
      const content = new XMLSerializer().serializeToString(svg);
      this.checkBytes(new TextEncoder().encode(content).byteLength);
      return { svg: content, width, height };
    } finally { svg.remove(); }
  }

  static async rasterize(source: TopologySvg, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    this.checkSize(source.width, source.height);
    this.checkBytes(new TextEncoder().encode(source.svg).byteLength);
    // Native img-src permits data: but not blob:. This needs no CSP expansion or external resource.
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source.svg)}`;
    const image = new Image();
    let canvas: HTMLCanvasElement | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); image.src = ""; reject(signal?.reason ?? new Error("PNG export cancelled.")); };
        image.onload = () => { cleanup(); resolve(); };
        image.onerror = () => { cleanup(); reject(new Error("The webview could not decode the topology SVG.")); };
        signal?.addEventListener("abort", abort, { once: true });
        image.src = url;
      });
      signal?.throwIfAborted();
      canvas = document.createElement("canvas");
      canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("PNG canvas rendering is unavailable.");
      context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas!.toBlob((result) => result ? resolve(result) : reject(new Error("PNG encoding failed.")), "image/png"));
      signal?.throwIfAborted();
      this.checkBytes(blob.size);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      signal?.throwIfAborted();
      return bytes;
    } finally { image.src = ""; if (canvas) { canvas.width = 0; canvas.height = 0; } }
  }
}

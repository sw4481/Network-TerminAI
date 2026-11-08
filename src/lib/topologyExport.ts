import { downloadBinaryFile, downloadFile } from "./export";
import { TopologyPng, type TopologyPngTheme, type TopologyPngVisual, type TopologySvg } from "./topologyPng";
import { TopologyProjection, type GraphSnapshot } from "./topology";
import { TopologyMap } from "./topologyMap";

/** React Flow's current top-left positions and measured (unzoomed) node bounds. */
export interface TopologyNodeGeometry {
  device_ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visual?: TopologyPngVisual;
}

/** Pure conversion of a caller-chosen complete scope; never selects viewport-only data. */
export class TopologyExport {
  static toSvg(snapshot: GraphSnapshot, geometry: TopologyNodeGeometry[], theme: TopologyPngTheme): TopologySvg {
    this.validate(snapshot);
    return TopologyPng.toSvg(snapshot, geometry, theme);
  }

  static async savePng(snapshot: GraphSnapshot, geometry: TopologyNodeGeometry[], theme: TopologyPngTheme, filename: string, signal?: AbortSignal, onSaving?: () => void): Promise<boolean> {
    signal?.throwIfAborted();
    const bytes = await TopologyPng.rasterize(this.toSvg(snapshot, geometry, theme), signal);
    signal?.throwIfAborted();
    onSaving?.();
    return downloadBinaryFile(filename, bytes, "image/png", signal);
  }

  static toJson(snapshot: GraphSnapshot): string {
    this.validate(snapshot);
    // Native v1 carries graph observations, not the local collection-evidence ledger.
    const interchange: Omit<GraphSnapshot, "capture_evidence"> = {
      graph: snapshot.graph, nodes: snapshot.nodes, edges: snapshot.edges,
      ...(snapshot.positions ? { positions: snapshot.positions } : {}),
      ...(snapshot.import_provenance ? { import_provenance: snapshot.import_provenance } : {}),
    };
    return this.bounded(JSON.stringify({ format: "terminai-topology", version: 1, snapshot: interchange }, null, 2));
  }

  static toDrawio(snapshot: GraphSnapshot, geometry: TopologyNodeGeometry[]): string {
    this.validate(snapshot);
    const measured = new Map<string, TopologyNodeGeometry>();
    for (const row of geometry) {
      if (measured.has(row.device_ref)) throw new Error(`Duplicate measured geometry for ${row.device_ref}`);
      if (![row.x, row.y, row.width, row.height, row.x + row.width, row.y + row.height].every(Number.isFinite) || row.width <= 0 || row.height <= 0) {
        throw new Error(`Invalid measured geometry for ${row.device_ref}`);
      }
      measured.set(row.device_ref, row);
    }
    const nodes = TopologyProjection.project(snapshot.nodes, snapshot.graph.id).nodes;
    for (const node of nodes) {
      if (!measured.has(node.device_ref)) throw new Error(`Missing measured geometry for ${node.device_ref}. Wait for the complete export graph to finish layout.`);
    }

    const doc = document.implementation.createDocument(null, "mxfile", null);
    const append = (parent: Element, name: string, attrs: Record<string, string | number> = {}): Element => {
      const element = doc.createElement(name);
      for (const [key, value] of Object.entries(attrs)) {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Topology geometry exceeds finite path bounds.");
        const text = String(value);
        // XMLSerializer escapes markup, but XML 1.0 cannot represent control/lone-surrogate text.
        for (const character of text) {
          const code = character.codePointAt(0)!;
          if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) ||
            (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000)) {
            throw new Error(`Cannot export XML: invalid character in ${key}`);
          }
        }
        element.setAttribute(key, text);
      }
      parent.appendChild(element);
      return element;
    };
    doc.documentElement.setAttribute("compressed", "false");
    const originNote = snapshot.import_provenance
      ? "Graph has an import origin receipt; this is not per-link source evidence. Later native observations may coexist."
      : "No per-link source provenance is declared.";
    const diagram = append(doc.documentElement, "diagram", {
      id: "topology", name: snapshot.graph.name + (snapshot.import_provenance ? " (graph import origin)" : ""),
    });
    const model = append(diagram, "mxGraphModel", { grid: 1, gridSize: 10, page: 0, tooltips: 1 });
    const root = append(model, "root");
    append(root, "mxCell", { id: "0" });
    append(root, "mxCell", { id: "1", parent: "0" });
    const nodeId = (ref: string) => `node:${JSON.stringify(ref)}`;
    for (const node of nodes) {
      const bounds = measured.get(node.device_ref)!;
      const kind = node.device_kind;
      const style = kind === "discovered" ? "rounded=0;dashed=1;" : "rounded=1;dashed=0;";
      const cell = append(root, "mxCell", {
        id: nodeId(node.device_ref), parent: "1", vertex: "1",
        value: `${node.label}\n${kind}`,
        style: `${style}whiteSpace=wrap;html=0;`,
        device_ref: node.device_ref, device_kind: kind,
        vendor: node.vendor ?? "", platform: node.platform ?? "", mgmt_ip: node.mgmt_ip ?? "",
        tooltip: originNote,
      });
      append(cell, "mxGeometry", { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, as: "geometry" });
    }

    // Reuse the renderer's canonical endpoint identity and duplicate/parallel offsets.
    const links = TopologyMap.links(snapshot.edges, null);
    const original = new Map<string, typeof snapshot.edges>();
    for (const edge of snapshot.edges) {
      const reverse = edge.a_device_ref > edge.b_device_ref ||
        (edge.a_device_ref === edge.b_device_ref && edge.a_port > edge.b_port);
      const key = JSON.stringify(reverse
        ? [edge.graph_id, edge.b_device_ref, edge.b_port, edge.a_device_ref, edge.a_port, edge.protocol]
        : [edge.graph_id, edge.a_device_ref, edge.a_port, edge.b_device_ref, edge.b_port, edge.protocol]);
      const group = original.get(key) ?? [];
      group.push(edge);
      original.set(key, group);
    }
    for (const group of original.values()) group.sort((a, b) => a.captured_at - b.captured_at);
    for (const link of links) {
      const data = link.data as { protocol: string; aPort: string; bPort: string; offset: number };
      const [, key, occurrence] = JSON.parse(link.id) as [string, string, number];
      const edge = original.get(key)![occurrence];
      const evidence = TopologyMap.evidenceLabel(data.protocol);
      const pattern = evidence === "L2 observation" ? "dashed=0;" : evidence === "Routing adjacency" ? "dashed=1;dashPattern=8 4;" : "dashed=1;dashPattern=2 4;";
      const cell = append(root, "mxCell", {
        id: `edge:${link.id}`, parent: "1", edge: "1", source: nodeId(link.source), target: nodeId(link.target),
        value: `${data.protocol} · ${evidence} (unverified)\n${link.source}: ${TopologyMap.portLabel(data.protocol, data.aPort)} — ${link.target}: ${TopologyMap.portLabel(data.protocol, data.bPort)}`,
        style: `edgeStyle=none;curved=1;endArrow=none;html=0;whiteSpace=wrap;${pattern}`,
        protocol: data.protocol, a_device_ref: link.source, a_port: data.aPort,
        b_device_ref: link.target, b_port: data.bPort, captured_at: edge.captured_at,
        tooltip: `${originNote} Endpoint order does not establish direction or physical verification.`,
      });
      const path = append(cell, "mxGeometry", { relative: 1, as: "geometry" });
      const points = append(path, "Array", { as: "points" });
      const a = measured.get(link.source)!;
      const b = measured.get(link.target)!;
      const ax = a.x + a.width / 2;
      const ay = a.y + a.height / 2;
      const bx = b.x + b.width / 2;
      const by = b.y + b.height / 2;
      const length = Math.hypot(bx - ax, by - ay);
      if (link.source === link.target || length === 0) {
        const reach = Math.max(a.width, a.height) / 2 + 40 + Math.abs(data.offset);
        const side = data.offset < 0 ? -1 : 1;
        append(points, "mxPoint", { x: ax + reach, y: ay - side * reach });
        append(points, "mxPoint", { x: ax - reach, y: ay - side * reach });
      } else {
        append(points, "mxPoint", {
          x: (ax + bx) / 2 - (by - ay) / length * data.offset,
          y: (ay + by) / 2 + (bx - ax) / length * data.offset,
        });
      }
    }
    return this.bounded(new XMLSerializer().serializeToString(doc));
  }

  static saveJson(snapshot: GraphSnapshot, filename: string): Promise<boolean> {
    return downloadFile(filename, this.toJson(snapshot), "application/json");
  }

  static saveDrawio(snapshot: GraphSnapshot, geometry: TopologyNodeGeometry[], filename: string): Promise<boolean> {
    return downloadFile(filename, this.toDrawio(snapshot, geometry), "application/xml");
  }

  private static validate(snapshot: GraphSnapshot): void {
    if (snapshot.nodes.length > 2000) throw new Error("Topology export supports at most 2,000 node rows.");
    if (snapshot.edges.length > 10000) throw new Error("Topology export supports at most 10,000 link rows.");
    if (![snapshot.graph.created_at, snapshot.graph.updated_at, snapshot.import_provenance?.imported_at ?? 0].every(Number.isFinite)) {
      throw new Error("Topology export contains an invalid graph or import time.");
    }
    const refs = new Set(snapshot.nodes.map((node) => node.device_ref));
    for (const row of [...snapshot.nodes, ...snapshot.edges]) {
      if (row.graph_id !== snapshot.graph.id) throw new Error("Topology export contains rows from another graph.");
    }
    for (const edge of snapshot.edges) {
      if (!refs.has(edge.a_device_ref) || !refs.has(edge.b_device_ref)) throw new Error("Topology export contains an endpoint outside the chosen graph scope.");
      if (!Number.isFinite(edge.captured_at)) throw new Error("Topology export contains an invalid capture time.");
    }
    const positioned = new Set<string>();
    for (const position of snapshot.positions ?? []) {
      if (!refs.has(position.device_ref) || positioned.has(position.device_ref) || ![position.x, position.y].every(Number.isFinite)) {
        throw new Error("Topology export contains an invalid or duplicate position.");
      }
      positioned.add(position.device_ref);
    }
  }

  private static bounded(content: string): string {
    if (new TextEncoder().encode(content).byteLength > 10 * 1024 * 1024) throw new Error("Topology export exceeds the 10 MiB output limit.");
    return content;
  }
}

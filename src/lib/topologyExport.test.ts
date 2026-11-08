import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphSnapshot, TopologyEdge } from "./topology";
import { TopologyExport, type TopologyNodeGeometry } from "./topologyExport";

const save = vi.hoisted(() => vi.fn());
const writeTextFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile }));

function snapshot(): GraphSnapshot {
  return {
    graph: { id: "g", name: "Offline <map> & \"lab\"", description: "original", created_at: 1, updated_at: 2 },
    nodes: [
      { graph_id: "g", device_ref: "a", device_kind: "ssh", label: "A <script>&\"'\nline", vendor: "Cisco", platform: "iosxe", mgmt_ip: "192.0.2.1" },
      { graph_id: "g", device_ref: "b", device_kind: "discovered", label: "B" },
      { graph_id: "g", device_ref: "a", device_kind: "discovered", label: "legacy duplicate kind" },
    ],
    edges: [edge("Gi1<&\"", "Gi2", "cdp"), edge("Gi3", "Gi4", "lldp")],
    positions: [{ device_ref: "a", x: 10, y: -20 }, { device_ref: "b", x: 900, y: 400 }],
  };
}
function edge(a_port: string, b_port: string, protocol: TopologyEdge["protocol"]): TopologyEdge {
  return { graph_id: "g", a_device_ref: "a", a_port, b_device_ref: "b", b_port, protocol, captured_at: 123 };
}
const geometry: TopologyNodeGeometry[] = [
  { device_ref: "a", x: 10, y: -20, width: 187.5, height: 73.25 },
  { device_ref: "b", x: 900, y: 400, width: 141, height: 61 },
];
function xml(graph = snapshot(), measured = geometry): XMLDocument {
  const doc = new DOMParser().parseFromString(TopologyExport.toDrawio(graph, measured), "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

describe("TopologyExport", () => {
  beforeEach(() => { save.mockReset(); writeTextFile.mockReset(); });
  afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

  it("retains the declared original JSON rows, graph, evidence, inventory and positions without projecting", () => {
    const graph = { ...snapshot(), import_provenance: {
      format: "sc2" as const, imported_at: 4, source_graph_id: "original-source",
      node_metadata: [{ device_ref: "a", placeholder: false, model: "synthetic", serial: "example", os_version: "1" }],
      unsupported_protocols: [{ a_device_ref: "a", a_port: "Gi1", b_device_ref: "b", b_port: "Gi2", raw_protocol: "vendor-specific" }],
    } };
    const before = structuredClone(graph);
    const result = JSON.parse(TopologyExport.toJson(graph));
    expect(result).toEqual({ format: "terminai-topology", version: 1, snapshot: before });
    expect(result.snapshot.nodes).toHaveLength(3);
    expect(graph).toEqual(before);
  });

  it("produces uncompressed editable native vertex/edge cells with hostile text safely escaped", () => {
    const doc = xml();
    expect(doc.querySelector("mxfile")?.getAttribute("compressed")).toBe("false");
    expect(doc.querySelector("diagram > mxGraphModel > root")).not.toBeNull();
    const cells = [...doc.querySelectorAll("mxCell")];
    expect(new Set(cells.map((cell) => cell.id)).size).toBe(cells.length);
    expect(doc.querySelectorAll('mxCell[vertex="1"]')).toHaveLength(2);
    expect(doc.querySelectorAll('mxCell[edge="1"]')).toHaveLength(2);
    const node = doc.querySelector('mxCell[vertex="1"]')!;
    expect(node.getAttribute("value")).toContain(snapshot().nodes[0].label);
    expect(node.getAttribute("value")).toContain("ssh");
    expect(node.getAttribute("style")).toContain("html=0");
    expect(doc.querySelector("script, img, image")).toBeNull();
    const link = doc.querySelector('mxCell[edge="1"]')!;
    expect(link.getAttribute("value")).toContain('Gi1<&"');
    expect(link.getAttribute("value")).toContain("cdp");
    expect(link.getAttribute("value")).toContain("L2");
    expect(link.getAttribute("value")).toContain("unverified");
  });

  it("uses current caller positions and exact measured bounds, not saved or invented geometry", () => {
    const current = geometry.map((row) => ({ ...row, x: row.x + 3 }));
    const doc = xml(snapshot(), current);
    const bounds = doc.querySelector('mxCell[vertex="1"] > mxGeometry')!;
    expect(["x", "y", "width", "height"].map((name) => bounds.getAttribute(name)))
      .toEqual(["13", "-20", "187.5", "73.25"]);
  });

  it("retains distinct ports and protocol records, and stable IDs independent of input ordering", () => {
    const graph = snapshot();
    graph.edges.push(edge("Gi1<&\"", "Gi2", "lldp"), { ...graph.edges[0] });
    const first = xml(graph);
    const second = xml({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }, [...geometry].reverse());
    const firstEdges = [...first.querySelectorAll('mxCell[edge="1"]')];
    expect(firstEdges).toHaveLength(4);
    expect(firstEdges.map((cell) => cell.id).sort()).toEqual([...second.querySelectorAll('mxCell[edge="1"]')].map((cell) => cell.id).sort());
    const routes = firstEdges.map((cell) => cell.querySelector("mxGeometry")!.innerHTML);
    expect(new Set(routes).size).toBe(4);
  });

  it("gives finite independent paths to self loops and coincident nodes", () => {
    const graph = snapshot();
    graph.edges.push({ ...edge("lo0", "lo1", "cdp"), b_device_ref: "a" });
    const doc = xml(graph, geometry.map((row) => ({ ...row, x: 0, y: 0 })));
    expect(doc.querySelectorAll('mxCell[edge="1"]')).toHaveLength(3);
    for (const point of doc.querySelectorAll("mxPoint")) {
      expect(Number.isFinite(Number(point.getAttribute("x")))).toBe(true);
      expect(Number.isFinite(Number(point.getAttribute("y")))).toBe(true);
    }
    expect(TopologyExport.toDrawio(graph, geometry)).not.toMatch(/NaN|Infinity/);
  });

  it("routes parallel self loops independently rather than folding symmetric offsets together", () => {
    const graph = snapshot();
    graph.edges = [
      { ...edge("loop0", "loop1", "cdp"), b_device_ref: "a" },
      { ...edge("loop2", "loop3", "lldp"), b_device_ref: "a" },
    ];
    const paths = [...xml(graph).querySelectorAll('mxCell[edge="1"] > mxGeometry')].map((path) => path.innerHTML);
    expect(new Set(paths).size).toBe(2);
  });

  it("rejects finite inputs whose derived geometry overflows rather than writing Infinity", () => {
    const extreme = geometry.map((row) => ({ ...row, x: Number.MAX_VALUE, width: Number.MAX_VALUE }));
    expect(() => TopologyExport.toDrawio(snapshot(), extreme)).toThrow(/geometry/i);
  });

  it("rejects nonfinite graph and import timestamps instead of serializing them as null", () => {
    const graph = snapshot();
    graph.graph.created_at = NaN;
    expect(() => TopologyExport.toJson(graph)).toThrow(/time/i);
    const imported = { ...snapshot(), import_provenance: { format: "sc2" as const, imported_at: Infinity, node_metadata: [], unsupported_protocols: [] } };
    expect(() => TopologyExport.toJson(imported)).toThrow(/time/i);
  });

  it.each(["bgp", "eigrp"] as const)("distinguishes %s routing and unknown evidence with text and dash patterns", (protocol) => {
    const graph = snapshot();
    graph.edges = [edge("peer:192.0.2.2", "", protocol), edge("x", "y", "unknown")];
    const links = [...xml(graph).querySelectorAll('mxCell[edge="1"]')];
    const routing = links.find((cell) => cell.getAttribute("value")!.includes(protocol))!;
    expect(routing.getAttribute("value")).toContain("Routing adjacency");
    expect(routing.getAttribute("value")).toContain("Logical peer");
    expect(routing.getAttribute("style")).toContain("dashed=1");
    const unknown = links.find((cell) => cell !== routing)!;
    expect(unknown.getAttribute("value")).toContain("Unknown evidence");
    expect(unknown.getAttribute("style")).toContain("dashed=1");
    expect(unknown.getAttribute("style")).not.toBe(routing.getAttribute("style"));
  });

  it("preserves raw routing identity ports in metadata and capture timestamps", () => {
    const graph = snapshot();
    graph.edges = [edge("peer:192.0.2.2", "", "bgp")];
    const link = xml(graph).querySelector('mxCell[edge="1"]')!;
    expect(link.getAttribute("a_port")).toBe("peer:192.0.2.2");
    expect(link.getAttribute("b_port")).toBe("");
    expect(link.getAttribute("captured_at")).toBe("123");
  });

  it("notes graph import origin without assigning imported provenance to every edge", () => {
    const graph = { ...snapshot(), import_provenance: { format: "sc2" as const, imported_at: 4, node_metadata: [], unsupported_protocols: [] } };
    const doc = xml(graph);
    expect(doc.querySelector("diagram")?.getAttribute("name")).toContain("import origin");
    expect(doc.querySelector('mxCell[edge="1"]')?.getAttribute("tooltip")).toContain("not per-link");
  });

  it("does not mutate snapshot rows or measured geometry", () => {
    const graph = snapshot();
    const before = structuredClone(graph);
    const bounds = structuredClone(geometry);
    xml(graph);
    expect(graph).toEqual(before);
    expect(geometry).toEqual(bounds);
  });

  it("supports an empty chosen graph without layout guesses", () => {
    const graph = { ...snapshot(), nodes: [], edges: [], positions: [] };
    expect(xml(graph, []).querySelectorAll('mxCell[vertex="1"], mxCell[edge="1"]')).toHaveLength(0);
  });

  it("rejects absent, duplicate, nonfinite, nonpositive or incomplete measurements", () => {
    expect(() => TopologyExport.toDrawio(snapshot(), [])).toThrow(/measured geometry.*a/i);
    expect(() => TopologyExport.toDrawio(snapshot(), [...geometry, geometry[0]])).toThrow(/duplicate.*geometry/i);
    for (const invalid of [{ x: NaN }, { y: Infinity }, { width: 0 }, { height: -1 }]) {
      expect(() => TopologyExport.toDrawio(snapshot(), [{ ...geometry[0], ...invalid }, geometry[1]])).toThrow(/geometry/i);
    }
  });

  it("rejects dangling endpoints, mixed graph rows and invalid stored positions", () => {
    const graph = snapshot();
    graph.edges[0].b_device_ref = "missing";
    expect(() => TopologyExport.toJson(graph)).toThrow(/endpoint/i);
    graph.edges = [];
    graph.nodes[0].graph_id = "other";
    expect(() => TopologyExport.toDrawio(graph, geometry)).toThrow(/graph/i);
    const badPosition = snapshot();
    badPosition.positions![0].x = Infinity;
    expect(() => TopologyExport.toJson(badPosition)).toThrow(/position/i);
  });

  it("rejects impossible XML characters rather than silently changing labels", () => {
    const graph = snapshot();
    graph.nodes[0].label = "bad\u0000label";
    expect(() => TopologyExport.toDrawio(graph, geometry)).toThrow(/XML/i);
    graph.nodes[0].label = "bad\ud800label";
    expect(() => TopologyExport.toDrawio(graph, geometry)).toThrow(/XML/i);
  });

  it("enforces node, link and UTF-8 output ceilings", () => {
    const graph = snapshot();
    graph.nodes = Array.from({ length: 2001 }, () => graph.nodes[0]);
    expect(() => TopologyExport.toJson(graph)).toThrow(/2,?000.*node/i);
    graph.nodes = snapshot().nodes;
    graph.edges = Array.from({ length: 10001 }, () => graph.edges[0]);
    expect(() => TopologyExport.toDrawio(graph, geometry)).toThrow(/10,?000.*link/i);
    graph.edges = [];
    graph.graph.description = "界".repeat(4 * 1024 * 1024);
    expect(() => TopologyExport.toJson(graph)).toThrow(/10 MiB/i);
  });

  it("bounds XML after escaping rather than assuming JSON size equals output size", () => {
    const graph = snapshot();
    graph.nodes[0].label = "&".repeat(2200000);
    expect(() => TopologyExport.toDrawio(graph, geometry)).toThrow(/10 MiB/i);
  });

  it.each(["json", "drawio"] as const)("propagates native %s save cancellation without writing", async (format) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    save.mockResolvedValue(null);
    const result = format === "json"
      ? await TopologyExport.saveJson(snapshot(), "map.json")
      : await TopologyExport.saveDrawio(snapshot(), geometry, "map.drawio");
    expect(result).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("saves XML through the native text helper and propagates write failures", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    save.mockResolvedValue("/synthetic/map.drawio");
    await expect(TopologyExport.saveDrawio(snapshot(), geometry, "map.drawio")).resolves.toBe(true);
    expect(writeTextFile).toHaveBeenCalledWith("/synthetic/map.drawio", TopologyExport.toDrawio(snapshot(), geometry));
    writeTextFile.mockRejectedValue(new Error("disk full"));
    await expect(TopologyExport.saveJson(snapshot(), "map.json")).rejects.toThrow("disk full");
  });

  it("exposes full-scope PNG conversion and save rather than an unavailable stub", () => {
    expect(TopologyExport.toSvg).toBeTypeOf("function");
    expect(TopologyExport.savePng).toBeTypeOf("function");
  });
});

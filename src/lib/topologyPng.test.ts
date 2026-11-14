import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopologyExport, type TopologyNodeGeometry } from "./topologyExport";
import { TopologyPng, type TopologyPngTheme } from "./topologyPng";
import type { GraphSnapshot, TopologyEdge } from "./topology";

const theme: TopologyPngTheme = { background: "#111111", surface: "#222222", text: "#eeeeee", muted: "#999999", fontFamily: "system-ui" };
const graph = (): GraphSnapshot => ({ graph: { id: "g", name: "Map", created_at: 1, updated_at: 1 },
  nodes: ["a", "b", "offscreen"].map((ref) => ({ graph_id: "g", device_ref: ref, label: ref, device_kind: "discovered" })),
  edges: [edge()], positions: [] });
function edge(protocol: TopologyEdge["protocol"] = "cdp"): TopologyEdge {
  return { graph_id: "g", a_device_ref: "a", b_device_ref: "b", a_port: "Gi1", b_port: "Gi2", protocol, captured_at: 1 };
}
const geometry = (): TopologyNodeGeometry[] => ["a", "b", "offscreen"].map((device_ref, i) => ({
  device_ref, x: i * 2000, y: i * 200, width: 150, height: 65,
  visual: { background: theme.surface, border: theme.muted, accent: theme.muted,
    marker: { x: 10, y: 12, width: 10, height: 10, fill: theme.muted, border: theme.background },
    label: { x: 32, y: 10, fontFamily: "system-ui", fontSize: "12px", fontWeight: "600", fill: theme.text },
    kind: { x: 32, y: 35, fontFamily: "system-ui", fontSize: "10px", fontWeight: "400", fill: theme.muted },
    source: { x: 75, y: 65.5 }, target: { x: 75, y: -0.5 } },
}));
function svg(snapshot = graph(), rows = geometry()) {
  const result = TopologyExport.toSvg(snapshot, rows, theme);
  const document = new DOMParser().parseFromString(result.svg, "image/svg+xml");
  expect(document.querySelector("parsererror")).toBeNull();
  return { ...result, document };
}

// jsdom has no SVG layout. Browser harness separately proves actual font bounds and PNG pixels.
beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value(this: SVGElement) {
    const width = Array.from(this.textContent ?? "").length * 7;
    const x = Number(this.getAttribute("x")), y = Number(this.getAttribute("y"));
    return { x: x - (this.getAttribute("text-anchor") === "middle" ? width / 2 : 0), y, width, height: 14 };
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox; });

describe("offline topology PNG", () => {
  it("includes every measured/offscreen node, complete labels and curve hull, without viewport transforms", () => {
    const snapshot = graph(); snapshot.nodes[2].label = "long offscreen label ".repeat(30);
    const result = svg(snapshot);
    expect(result.document.querySelectorAll("text")).toHaveLength(7);
    expect(result.svg).toContain(snapshot.nodes[2].label);
    expect(result.width).toBeGreaterThan(8000);
    expect(result.svg).not.toMatch(/foreignObject|<image|href=|url\(|<style/);
    expect(document.querySelector("body > svg")).toBeNull();
    const paths = result.document.querySelectorAll("path[data-protocol]");
    expect(paths).toHaveLength(1);
    const curve = TopologyPng.curve({ x: 75, y: 65.5 }, { x: 2075, y: 199.5 }, 0, false);
    expect(paths[0].getAttribute("d")).toBe(curve.path);
    const [x, y, width, height] = result.document.documentElement.getAttribute("viewBox")!.split(" ").map(Number);
    for (const point of curve.points) {
      expect(point.x).toBeGreaterThanOrEqual(x); expect(point.x).toBeLessThanOrEqual(x + width);
      expect(point.y).toBeGreaterThanOrEqual(y); expect(point.y).toBeLessThanOrEqual(y + height);
    }
  });
  it("preserves parallel, reversed, duplicate and self records as independently routed paths", () => {
    const snapshot = graph();
    snapshot.edges = [edge(), edge("lldp"), { ...edge(), a_device_ref: "b", b_device_ref: "a", a_port: "Gi2", b_port: "Gi1" },
      { ...edge(), b_device_ref: "a" }, { ...edge("lldp"), b_device_ref: "a" }];
    const paths = [...svg(snapshot).document.querySelectorAll("path[data-protocol]")].map((path) => path.getAttribute("d"));
    expect(paths).toHaveLength(5); expect(new Set(paths).size).toBe(5);
    expect(svg({ ...snapshot, edges: [...snapshot.edges].reverse() }).document.querySelectorAll("path[data-protocol]")).toHaveLength(5);
    const left = TopologyPng.curve({ x: 75, y: 65.5 }, { x: 75, y: -0.5 }, -20, true);
    const right = TopologyPng.curve({ x: 75, y: 65.5 }, { x: 75, y: -0.5 }, 20, true);
    expect(left.points[1].x).toBe(-45); expect(right.points[1].x).toBe(195);
  });
  it("keeps routing/unknown evidence explicit, not a physical-cable claim", () => {
    const snapshot = graph(); snapshot.edges = [{ ...edge("bgp"), a_port: "peer:192.0.2.2", b_port: "" }, edge("unknown")];
    const result = svg(snapshot);
    expect(result.svg).toContain("Routing adjacency (unverified)"); expect(result.svg).toContain("Logical peer 192.0.2.2 (port not recorded)");
    expect(result.svg).toContain("Unknown evidence (unverified)");
    expect(result.document.querySelector('[data-protocol="unknown"]')?.getAttribute("stroke-dasharray")).toBe("2 4");
  });
  it("escapes hostile labels/ports as inert text and rejects impossible XML and paint URLs", () => {
    const snapshot = graph(); snapshot.nodes[0].label = '<script>alert(1)</script> & "α"'; snapshot.edges[0].a_port = '<image href="https://invalid/">';
    const result = svg(snapshot);
    expect(result.document.querySelector("script, image, foreignObject")).toBeNull();
    expect([...result.document.querySelectorAll("text")].map((node) => node.textContent)).toContain(snapshot.nodes[0].label);
    expect(result.svg).toContain("&lt;image");
    snapshot.nodes[0].label = "bad\u0000label";
    expect(() => svg(snapshot)).toThrow(/XML/);
    expect(() => TopologyExport.toSvg(graph(), geometry(), { ...theme, background: "url(https://invalid/)" })).toThrow(/colour/);
  });
  it("rejects missing/duplicate/nonfinite geometry and dangling scope endpoints", () => {
    expect(() => svg(graph(), [])).toThrow(/measured/);
    expect(() => svg(graph(), [...geometry(), geometry()[0]])).toThrow(/duplicate/i);
    const invalid = geometry(); invalid[0].x = Infinity;
    expect(() => svg(graph(), invalid)).toThrow(/geometry/i);
    const snapshot = graph(); snapshot.edges[0].b_device_ref = "absent";
    expect(() => svg(snapshot)).toThrow(/endpoint/);
  });
  it("uses exact CSS colours and preserves input snapshots/measurements", () => {
    const snapshot = graph(), rows = geometry(), before = structuredClone({ snapshot, rows });
    const result = svg(snapshot, rows);
    expect(result.document.querySelector("svg > rect")?.getAttribute("fill")).toBe(theme.background);
    expect({ snapshot, rows }).toEqual(before);
  });
  it("caps dimension, pixel area and UTF-8 output before canvas allocation", async () => {
    const create = vi.spyOn(document, "createElement");
    await expect(TopologyPng.rasterize({ svg: "<svg/>", width: 16385, height: 1 })).rejects.toThrow(/dimension/);
    await expect(TopologyPng.rasterize({ svg: "<svg/>", width: 8192, height: 8192 })).rejects.toThrow(/megapixel/);
    await expect(TopologyPng.rasterize({ svg: "界".repeat(4 * 1024 * 1024), width: 100, height: 100 })).rejects.toThrow(/10 MiB/);
    expect(create.mock.calls.some(([tag]) => tag === "canvas")).toBe(false);
    expect(() => TopologyPng.checkBytes(10 * 1024 * 1024 + 1)).toThrow(/10 MiB/);
    const huge = geometry(); huge[2].x = 20000;
    expect(() => svg(graph(), huge)).toThrow(/dimension/);
    expect(document.querySelector("body > svg")).toBeNull();
  });
  it("uses a CSP-compatible data SVG and bounds encoded PNG bytes before reading them", async () => {
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) { sources.push(value); if (value) queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const read = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback({ size: TopologyPng.maxBytes + 1, arrayBuffer: read } as unknown as Blob));
    await expect(TopologyPng.rasterize({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', width: 1, height: 1 })).rejects.toThrow(/10 MiB/);
    expect(sources[0]).toMatch(/^data:image\/svg\+xml/);
    expect(sources.at(-1)).toBe(""); expect(read).not.toHaveBeenCalled();
  });
  it.each(["decode", "canvas", "encode"])("propagates %s failure and cleans image resources", async (stage) => {
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) { sources.push(value); if (value) queueMicrotask(() => stage === "decode" ? this.onerror?.() : this.onload?.()); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(stage === "canvas" ? null : { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(null));
    await expect(TopologyPng.rasterize({ svg: "<svg/>", width: 1, height: 1 })).rejects.toThrow(/decode|unavailable|encoding/);
    expect(sources.at(-1)).toBe("");
  });
  it("aborts an image decode before canvas allocation", async () => {
    vi.stubGlobal("Image", class { onload = null; onerror = null; set src(_value: string) {} });
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const run = new AbortController();
    const pending = TopologyPng.rasterize({ svg: "<svg/>", width: 1, height: 1 }, run.signal);
    run.abort(); await expect(pending).rejects.toThrow(); expect(context).not.toHaveBeenCalled();
  });
  it("aborts before any image/canvas allocation", async () => {
    const run = new AbortController(); run.abort();
    await expect(TopologyPng.rasterize({ svg: "<svg/>", width: 1, height: 1 }, run.signal)).rejects.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type { TopologyEdge, TopologyNode } from "./topology";
import { TopologyMap } from "./topologyMap";

const node = (device_ref: string): TopologyNode => ({
  graph_id: "g", device_ref, device_kind: "discovered", label: device_ref,
});
const edge = (a: string, b: string, extra: Partial<TopologyEdge> = {}): TopologyEdge => ({
  graph_id: "g", a_device_ref: a, a_port: "Gi1", b_device_ref: b,
  b_port: "Gi2", protocol: "cdp", captured_at: 1, ...extra,
});

describe("TopologyMap.connectedPositions", () => {
  it("uses stable breadth-first levels and separate disconnected bands", () => {
    const nodes = ["a", "b", "c", "d", "e", "isolated"].map(node);
    const edges = [edge("a", "b"), edge("b", "c"), edge("d", "e")];
    const positions = TopologyMap.connectedPositions(nodes, edges);
    expect(positions.a.x).toBeLessThan(positions.b.x);
    expect(positions.b.x).toBeLessThan(positions.c.x);
    expect(positions.d.x).toBeLessThan(positions.e.x);
    expect(Math.min(positions.d.y, positions.e.y)).toBeGreaterThan(
      Math.max(positions.a.y, positions.b.y, positions.c.y),
    );
    expect(positions.isolated.y).toBeGreaterThan(Math.max(positions.d.y, positions.e.y));
    expect(TopologyMap.connectedPositions([...nodes].reverse(), [...edges].reverse())).toEqual(positions);
    for (const [ref, position] of Object.entries(positions)) {
      for (const [other, next] of Object.entries(positions)) {
        if (ref !== other) expect(Math.abs(position.x - next.x) >= 220 || Math.abs(position.y - next.y) >= 160).toBe(true);
      }
    }
    expect(TopologyMap.connectedPositions([], edges)).toEqual({});
  });

  it("handles cycles, duplicate protocols, isolates and prototype-like refs without inventing nodes", () => {
    const nodes = ["__proto__", "constructor", "toString", "alone"].map(node);
    const edges = [edge("__proto__", "constructor"), edge("constructor", "toString"), edge("toString", "__proto__")];
    const positions = TopologyMap.connectedPositions(nodes, edges);
    expect(Object.keys(positions).sort()).toEqual(nodes.map((n) => n.device_ref).sort());
    expect(Object.prototype.hasOwnProperty.call(positions, "__proto__")).toBe(true);
    expect(TopologyMap.connectedPositions([...nodes, node("constructor")], [
      ...edges, edge("__proto__", "constructor", { protocol: "lldp" }),
      edge("alone", "__proto__", { graph_id: "other" }), edge("alone", "missing"),
    ])).toEqual(positions);
    expect(positions["constructor"].x).toBe(positions["toString"].x);
    for (const position of Object.values(positions)) {
      expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
    }
  });
});

describe("TopologyMap evidence labels", () => {
  it("labels only supported evidence kinds without inventing physical or freshness claims", () => {
    for (const protocol of ["cdp", "lldp"]) expect(TopologyMap.evidenceLabel(protocol)).toBe("L2 observation");
    for (const protocol of ["bgp", "ospf", "isis", "eigrp"]) expect(TopologyMap.evidenceLabel(protocol)).toBe("Routing adjacency");
    for (const protocol of ["", "CDP", "unknown", "__proto__"]) expect(TopologyMap.evidenceLabel(protocol)).toBe("Unknown evidence");
  });

  it("identifies routing peer placeholders as logical peers rather than recorded ports", () => {
    for (const protocol of ["bgp", "ospf", "isis", "eigrp"]) {
      expect(TopologyMap.portLabel(protocol, "peer:192.0.2.8")).toBe("Logical peer 192.0.2.8 (port not recorded)");
      expect(TopologyMap.portLabel(protocol, "peer:device:r1")).toBe("Logical peer device:r1 (port not recorded)");
      expect(TopologyMap.portLabel(protocol, "")).toBe("Port not recorded");
      expect(TopologyMap.portLabel(protocol, "GigabitEthernet0/1")).toBe("GigabitEthernet0/1");
    }
  });

  it("preserves nonrouting port strings and reports empty ports without inventing an interface", () => {
    for (const protocol of ["cdp", "lldp", "unknown"]) {
      expect(TopologyMap.portLabel(protocol, "peer:advertised-port")).toBe("peer:advertised-port");
      expect(TopologyMap.portLabel(protocol, "Et1/2")).toBe("Et1/2");
      expect(TopologyMap.portLabel(protocol, "")).toBe("Port not recorded");
    }
  });

  it("formats only positive finite timestamps that yield a valid Date", () => {
    expect(TopologyMap.capturedLabel(1_700_000_000)).toBe(new Date("2023-11-14T22:13:20.000Z").toLocaleString());
    for (const timestamp of [0, -1, NaN, Infinity, -Infinity, Number.MAX_VALUE, 8.64e12 + 1]) {
      expect(TopologyMap.capturedLabel(timestamp)).toBe("Capture time unknown");
    }
  });
});

describe("TopologyMap.oneHop", () => {
  it("includes only the anchor and immediate peers in either direction", () => {
    const edges = [edge("a", "b"), edge("c", "a"), edge("b", "d"), edge("a", "a"), edge("a", "b")];
    expect(TopologyMap.oneHop(edges, "a")).toEqual(new Set(["a", "b", "c"]));
    expect(TopologyMap.oneHop(edges, "__proto__")).toEqual(new Set(["__proto__"]));
    expect(TopologyMap.oneHop([], "")).toEqual(new Set([""]));
  });
});

describe("TopologyMap.links", () => {
  it("keeps every port/protocol/duplicate row with deterministic IDs and separate offsets", () => {
    const rows = [edge("a", "b"), edge("a", "b", { protocol: "lldp" }),
      edge("a", "b", { a_port: "Gi3", b_port: "Gi4" }), edge("b", "a", { a_port: "Gi2", b_port: "Gi1" }),
      edge("a", "b"), edge("c", "d")];
    const links = TopologyMap.links(rows, "a");
    expect(links).toHaveLength(rows.length);
    expect(new Set(links.map((link) => link.id)).size).toBe(rows.length);
    const parallel = links.filter((link) => link.source === "a" && link.target === "b");
    expect(new Set(parallel.map((link) => link.data?.offset)).size).toBe(5);
    expect(parallel.every((link) => link.data?.mapEdge === true && link.data?.showLabel === true)).toBe(true);
    expect(parallel.map((link) => link.data?.protocol).sort()).toEqual(["cdp", "cdp", "cdp", "cdp", "lldp"]);
    expect(links.find((link) => link.source === "c")?.data?.showLabel).toBe(false);
    expect(TopologyMap.links([...rows].reverse(), "a")).toEqual(links);
    expect(TopologyMap.links(rows, null).every((link) => link.data?.showLabel === false)).toBe(true);
    expect(rows[3].a_device_ref).toBe("b");
  });

  it("normalizes reversed geometry and ports without claiming reverse evidence", () => {
    const forward = edge("a", "z");
    const reverse = edge("z", "a", { a_port: "Gi2", b_port: "Gi1" });
    expect(TopologyMap.links([forward], "z")).toEqual(TopologyMap.links([reverse], "z"));
    expect(TopologyMap.links([reverse], "z")[0]).toMatchObject({
      source: "a", target: "z", data: { aPort: "Gi1", bPort: "Gi2", protocol: "cdp" },
    });
    expect(TopologyMap.links([forward, reverse], null)).toHaveLength(2);
  });

  it("avoids delimiter and graph collisions, and handles hostile refs and self-links", () => {
    const rows = [edge("a::b", "c"), edge("a", "b::c"), edge("__proto__", "constructor"),
      edge("a::b", "c", { graph_id: "other" }), edge("self", "self"), edge("self", "self", { protocol: "bgp" })];
    const links = TopologyMap.links(rows, "self");
    expect(new Set(links.map((link) => link.id)).size).toBe(rows.length);
    expect(links.every((link) => Number.isFinite(link.data?.offset))).toBe(true);
    expect(links.filter((link) => link.source === "self")).toHaveLength(2);
    expect(TopologyMap.links([], null)).toEqual([]);
  });
});

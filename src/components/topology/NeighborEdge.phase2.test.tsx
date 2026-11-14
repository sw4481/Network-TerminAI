import { Position, getBezierPath, type EdgeProps } from "@xyflow/react";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NeighborEdge } from "./NeighborEdge";
import { PROTOCOL_EDGE_STYLE } from "./topologyTheme";
import { TopologyMap } from "../../lib/topologyMap";
import type { TopologyEdge } from "../../lib/topology";

const originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
beforeAll(() => {
  // jsdom has no SVG text measurement; browser label placement is a separate acceptance gate.
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true, value: () => ({ x: 0, y: 0, width: 200, height: 16 }),
  });
});
afterAll(() => {
  if (originalBBox) Object.defineProperty(SVGElement.prototype, "getBBox", originalBBox);
  else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
});

const props = (data: Record<string, unknown>, extra: Partial<EdgeProps> = {}): EdgeProps => ({
  id: "test-edge", source: "a", target: "b", sourceX: 0, sourceY: 0,
  targetX: 240, targetY: 160, sourcePosition: Position.Right, targetPosition: Position.Left,
  data, selected: false, ...extra,
});
function mount(data: Record<string, unknown>, extra: Partial<EdgeProps> = {}) {
  return render(<svg><NeighborEdge {...props(data, extra)} /></svg>).container;
}
const mapData = { mapEdge: true, protocol: "lldp", aPort: "Gi1/0/1", bPort: "Et1", offset: 32 };

describe("NeighborEdge Phase 2", () => {
  it("preserves inline Bezier geometry and protocol/extra-style contract without map data", () => {
    const container = mount({ protocol: "lldp" }, { style: { opacity: 0.4 } });
    const path = container.querySelector<SVGPathElement>("path[data-protocol='lldp']")!;
    expect(path.getAttribute("d")).toBe(getBezierPath({ sourceX: 0, sourceY: 0, targetX: 240, targetY: 160 })[0]);
    const expectedStyle = document.createElementNS("http://www.w3.org/2000/svg", "path").style;
    expectedStyle.stroke = String(PROTOCOL_EDGE_STYLE.lldp.stroke);
    expect(path.style.stroke).toBe(expectedStyle.stroke);
    expect(path.style.strokeDasharray).toBe(PROTOCOL_EDGE_STYLE.lldp.strokeDasharray);
    expect(path.style.opacity).toBe("0.4");
    expect(container.querySelector("text")).toBeNull();
    expect(container.querySelector("title")).toBeNull();
  });

  it("renders distinct neutral curves with only compact selected ports and full tooltip details", () => {
    const first = mount({ ...mapData, showLabel: true });
    const second = mount({ ...mapData, offset: -32 });
    const path = first.querySelector<SVGPathElement>("path[data-protocol='lldp']")!;
    expect(path.getAttribute("d")).not.toBe(second.querySelector("path[data-protocol]")?.getAttribute("d"));
    expect(path.style.stroke).toBe("var(--text-muted)");
    expect(path.style.strokeDasharray).toBe(PROTOCOL_EDGE_STYLE.lldp.strokeDasharray);
    expect(first.querySelector("text")?.textContent).toBe("Gi1/0/1 — Et1");
    expect(first.querySelector("text")?.getAttribute("style")).toContain("var(--text-primary)");
    expect(first.querySelector(".react-flow__edge-textbg")?.getAttribute("style")).toContain("var(--");
    expect(first.querySelector("title")?.textContent).toBe("a — b · lldp · L2 observation · Gi1/0/1 — Et1");
    expect(second.querySelector("text")).toBeNull();
    expect(second.querySelector("title")).not.toBeNull();
  });

  it("bounds each long displayed port to 12 characters without truncating tooltip details", () => {
    const container = mount({ ...mapData, aPort: "GigabitEthernet1/0/123", bPort: "TenGigabitEthernet2/1/999", showLabel: true });
    expect(container.querySelector("text")?.textContent).toBe("GigabitEthe… — TenGigabitE…");
    expect(container.querySelector("title")?.textContent).toBe("a — b · lldp · L2 observation · GigabitEthernet1/0/123 — TenGigabitEthernet2/1/999");
  });

  it.each(["bgp", "ospf", "isis"])("keeps full %s logical-peer details in the tooltip with compact visible ports", (protocol) => {
    const container = mount({ ...mapData, protocol, aPort: "GigabitEthernet0/1", bPort: "peer:192.0.2.8", showLabel: true });
    expect(container.querySelector("text")?.textContent).toBe("GigabitEthe… — Logical pee…");
    expect(container.querySelector("title")?.textContent).toBe(`a — b · ${protocol} · Routing adjacency · GigabitEthernet0/1 — Logical peer 192.0.2.8 (port not recorded)`);
  });

  it("reports missing map ports without changing protocol-only inline rendering", () => {
    const map = mount({ ...mapData, protocol: "bgp", aPort: "", bPort: "", showLabel: true });
    expect(map.querySelector("text")?.textContent).toBe("Port not re… — Port not re…");
    expect(map.querySelector("title")?.textContent).toContain("Port not recorded — Port not recorded");
    const inline = mount({ protocol: "bgp", aPort: "peer:192.0.2.8", bPort: "", showLabel: true });
    expect(inline.querySelector("text")).toBeNull();
    expect(inline.querySelector("title")).toBeNull();
  });

  it("honors edge selection and source/target handle positions for map geometry", () => {
    const first = mount({ ...mapData, protocol: "bgp", offset: 0 }, { selected: true });
    const second = mount({ ...mapData, protocol: "bgp", offset: 0 }, {
      sourcePosition: Position.Bottom, targetPosition: Position.Top,
    });
    expect(first.querySelector("text")?.textContent).toBe("Gi1/0/1 — Et1");
    expect(first.querySelector("title")?.textContent).toContain("Routing adjacency");
    expect(first.querySelector("path[data-protocol]")?.getAttribute("d")).not.toBe(
      second.querySelector("path[data-protocol]")?.getAttribute("d"),
    );
    expect(first.querySelector<SVGPathElement>("path[data-protocol]")?.style.stroke).toBe("var(--text-muted)");
  });

  it("projects reverse observations to separate finite curves including coincident self-links", () => {
    const row: TopologyEdge = { graph_id: "g", a_device_ref: "a", a_port: "1", b_device_ref: "b", b_port: "2", protocol: "cdp", captured_at: 1 };
    const links = TopologyMap.links([row, { ...row, a_device_ref: "b", a_port: "2", b_device_ref: "a", b_port: "1" }], null);
    const paths = links.map((link) => mount(link.data!).querySelector("path[data-protocol]")?.getAttribute("d"));
    expect(new Set(paths).size).toBe(2);
    const loops = [-32, 0, 32].map((offset) => mount({ ...mapData, offset }, {
      source: "self", target: "self", targetX: 0, targetY: 0,
    }).querySelector("path[data-protocol]")?.getAttribute("d"));
    expect(new Set(loops).size).toBe(3);
    for (const path of loops) {
      expect(path).not.toMatch(/NaN|Infinity/);
      expect(path).not.toBe(getBezierPath({ sourceX: 0, sourceY: 0, targetX: 0, targetY: 0 })[0]);
    }
  });
});

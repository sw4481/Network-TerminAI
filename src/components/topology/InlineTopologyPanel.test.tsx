/**
 * Plan 13 Phase 2 Task 2.3 — InlineTopologyPanel tests.
 *
 * The panel is display-only, so we exercise it by feeding store-shaped
 * `TopologyNode[]` / `TopologyEdge[]` props directly — no need to spin
 * up the zustand store. The `ResizeObserver` / `DOMMatrixReadOnly`
 * polyfills ReactFlow needs are installed globally in `src/test-setup.ts`.
 */
import { Position, type EdgeProps } from "@xyflow/react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { InlineTopologyPanel } from "./InlineTopologyPanel";
import { NeighborEdge } from "./NeighborEdge";
import type { TopologyEdge, TopologyNode } from "../../lib/topology";

const SOURCE = "device:r1";

function makeNodes(): TopologyNode[] {
  return [
    {
      graph_id: "g1",
      device_ref: SOURCE,
      device_kind: "ssh",
      label: "R1",
      vendor: "cisco",
      mgmt_ip: "10.0.0.1",
    },
    {
      graph_id: "g1",
      device_ref: "device:r2",
      device_kind: "discovered",
      label: "R2",
      vendor: "cisco",
      mgmt_ip: "10.0.0.2",
    },
    {
      graph_id: "g1",
      device_ref: "device:r3",
      device_kind: "discovered",
      label: "R3",
      vendor: "juniper",
      mgmt_ip: "10.0.0.3",
    },
    {
      graph_id: "g1",
      device_ref: "device:r4",
      device_kind: "discovered",
      label: "R4",
      vendor: undefined, // → unknown
    },
  ];
}

function makeEdges(): TopologyEdge[] {
  return [
    {
      graph_id: "g1",
      a_device_ref: SOURCE,
      a_port: "Gi0/1",
      b_device_ref: "device:r2",
      b_port: "Gi0/2",
      protocol: "cdp",
      captured_at: 1,
    },
    {
      graph_id: "g1",
      a_device_ref: SOURCE,
      a_port: "Gi0/3",
      b_device_ref: "device:r3",
      b_port: "ge-0/0/1",
      protocol: "lldp",
      captured_at: 2,
    },
  ];
}

describe("InlineTopologyPanel", () => {
  it("renders one node per immediate neighbor plus the source, with vendor data attributes", () => {
    render(
      <InlineTopologyPanel
        storeNodes={makeNodes()}
        storeEdges={makeEdges()}
        sourceDeviceRef={SOURCE}
        onNeighborClick={() => {}}
      />,
    );

    const nodes = screen.getAllByTestId("topology-node");
    // Source (R1) + R2 + R3 = 3. R4 is in the store but has no edge to
    // the source, so it must be filtered out.
    expect(nodes).toHaveLength(3);

    const byVendor = nodes.map((n) => n.getAttribute("data-vendor"));
    expect(byVendor).toContain("cisco");
    expect(byVendor).toContain("juniper");
    // R4 (unknown) should NOT appear.
    expect(byVendor).not.toContain("unknown");
  });

  it("fires onNeighborClick with the clicked neighbor node", () => {
    const onNeighborClick = vi.fn();
    render(
      <InlineTopologyPanel
        storeNodes={makeNodes()}
        storeEdges={makeEdges()}
        sourceDeviceRef={SOURCE}
        onNeighborClick={onNeighborClick}
      />,
    );

    // Find the R2 node by its rendered label and click it.
    const r2Label = screen.getByText("R2");
    const r2Node = r2Label.closest('[data-testid="topology-node"]');
    expect(r2Node).not.toBeNull();
    fireEvent.click(r2Node!);

    expect(onNeighborClick).toHaveBeenCalledTimes(1);
    const arg = onNeighborClick.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ id: "device:r2" });
    expect(arg?.data).toMatchObject({ label: "R2", vendor: "cisco" });
  });

  it("renders the empty state when no edges touch the source", () => {
    render(
      <InlineTopologyPanel
        storeNodes={makeNodes()}
        storeEdges={[]}
        sourceDeviceRef={SOURCE}
        onNeighborClick={() => {}}
      />,
    );

    expect(screen.getByTestId("topology-inline-empty")).toBeInTheDocument();
    expect(screen.getByText(/No neighbors discovered yet/i)).toBeInTheDocument();
    expect(screen.queryAllByTestId("topology-node")).toHaveLength(0);
  });

  it("marks the source node with data-vendor and the source modifier class", () => {
    render(
      <InlineTopologyPanel
        storeNodes={makeNodes()}
        storeEdges={makeEdges()}
        sourceDeviceRef={SOURCE}
        onNeighborClick={() => {}}
      />,
    );
    const r1Label = screen.getByText("R1");
    const r1Node = r1Label.closest(
      '[data-testid="topology-node"]',
    ) as HTMLElement | null;
    expect(r1Node).not.toBeNull();
    expect(r1Node!.getAttribute("data-vendor")).toBe("cisco");
    expect(r1Node!.className).toMatch(/neighbor-node--source/);
  });

  it("renders edges with data-protocol attribute matching their protocol", () => {
    // ReactFlow's edge pipeline gates rendering on node `getBoundingClientRect`
    // / handle bounds, neither of which jsdom provides — so spinning up
    // the full panel here exercises ReactFlow's layout pass instead of
    // the contract we care about. We instead mount the custom edge
    // component directly inside an SVG host (the same way ReactFlow
    // does internally) and assert the `<path data-protocol>` contract.
    // The end-to-end "edges render under <ReactFlow>" path is covered
    // by the Phase 2.6 Playwright spec running in real Chromium.
    function renderEdge(protocol: "cdp" | "lldp") {
      const props: EdgeProps = {
        id: `e-${protocol}`,
        source: "a",
        target: "b",
        sourceX: 0,
        sourceY: 0,
        targetX: 100,
        targetY: 100,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: { protocol },
        selected: false,
        animated: false,
        label: undefined,
        labelStyle: undefined,
        labelShowBg: undefined,
        labelBgStyle: undefined,
        labelBgPadding: undefined,
        labelBgBorderRadius: undefined,
        style: undefined,
        sourceHandleId: null,
        targetHandleId: null,
        markerStart: undefined,
        markerEnd: undefined,
        pathOptions: undefined,
        interactionWidth: undefined,
      } as unknown as EdgeProps;
      const { container } = render(
        <svg>
          <NeighborEdge {...props} />
        </svg>,
      );
      return container;
    }
    const cdp = renderEdge("cdp");
    const lldp = renderEdge("lldp");
    const cdpPath = cdp.querySelector("path[data-protocol]");
    const lldpPath = lldp.querySelector("path[data-protocol]");
    expect(cdpPath).not.toBeNull();
    expect(lldpPath).not.toBeNull();
    expect(cdpPath?.getAttribute("data-protocol")).toBe("cdp");
    expect(lldpPath?.getAttribute("data-protocol")).toBe("lldp");
  });

  it("renders the expand button only when onExpand is provided", () => {
    const onExpand = vi.fn();
    const { rerender } = render(
      <InlineTopologyPanel
        storeNodes={makeNodes()}
        storeEdges={makeEdges()}
        sourceDeviceRef={SOURCE}
        onNeighborClick={() => {}}
      />,
    );
    expect(
      screen.queryByLabelText("Expand to full topology tab"),
    ).not.toBeInTheDocument();

    rerender(
      <InlineTopologyPanel
        storeNodes={makeNodes()}
        storeEdges={makeEdges()}
        sourceDeviceRef={SOURCE}
        onNeighborClick={() => {}}
        onExpand={onExpand}
      />,
    );
    const btn = screen.getByLabelText("Expand to full topology tab");
    fireEvent.click(btn);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

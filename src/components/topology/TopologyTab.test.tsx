/**
 * Plan 13 Phase 4 Task 4.2 — TopologyTab tests.
 *
 * The store is hydrated via `useTopologyStore.setState(...)` so we can
 * exercise filter / inspector / clear behavior without a live Tauri
 * backend. Tauri's invoke is mocked at the module level (the store's
 * load/refresh actions resolve to no-ops in jsdom).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { TopologyTab } from "./TopologyTab";
import { useTopologyStore } from "../../state/topologyStore";
import {
  GLOBAL_GRAPH_ID,
  type TopologyEdge,
  type TopologyNode,
} from "../../lib/topology";

function makeNodes(): TopologyNode[] {
  return [
    {
      graph_id: GLOBAL_GRAPH_ID,
      device_ref: "device:r1",
      device_kind: "ssh",
      label: "R1",
      vendor: "cisco",
      platform: "iosxe",
      mgmt_ip: "10.0.0.1",
    },
    {
      graph_id: GLOBAL_GRAPH_ID,
      device_ref: "device:r2",
      device_kind: "ssh",
      label: "R2",
      vendor: "cisco",
      platform: "iosxe",
      mgmt_ip: "10.0.0.2",
    },
    {
      graph_id: GLOBAL_GRAPH_ID,
      device_ref: "device:j1",
      device_kind: "netconf",
      label: "J1",
      vendor: "juniper",
      platform: "junos",
      mgmt_ip: "10.0.0.10",
    },
  ];
}

function makeEdges(): TopologyEdge[] {
  return [
    {
      graph_id: GLOBAL_GRAPH_ID,
      a_device_ref: "device:r1",
      a_port: "Gi0/1",
      b_device_ref: "device:r2",
      b_port: "Gi0/2",
      protocol: "cdp",
      captured_at: 1,
    },
    {
      graph_id: GLOBAL_GRAPH_ID,
      a_device_ref: "device:r2",
      a_port: "Gi0/3",
      b_device_ref: "device:j1",
      b_port: "ge-0/0/1",
      protocol: "lldp",
      captured_at: 2,
    },
  ];
}

function resetStore(opts?: {
  nodes?: TopologyNode[];
  edges?: TopologyEdge[];
}) {
  // Replace loadGraphs/refresh with no-ops so the initial-mount effect
  // doesn't clobber whatever nodes/edges we seed for the test. clearGraph
  // stays on the real action by default — individual tests can override.
  useTopologyStore.setState({
    graphs: [],
    currentGraphId: GLOBAL_GRAPH_ID,
    nodes: opts?.nodes ?? [],
    edges: opts?.edges ?? [],
    loading: false,
    error: null,
    autoRefreshIntervalMs: null,
    loadGraphs: async () => {},
    refresh: async () => {},
  });
}

describe("TopologyTab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    // The TopologyTab mounts the store's loadGraphs + refresh on init.
    // Stub both Tauri commands so the cascading invoke calls resolve to
    // empty-but-well-formed payloads instead of `undefined`/`[]`.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "topology_list_graphs") return Promise.resolve([]);
      if (cmd === "topology_get_graph") {
        return Promise.resolve({
          graph: {
            id: GLOBAL_GRAPH_ID,
            name: "Global",
            created_at: 0,
            updated_at: 0,
          },
          nodes: [],
          edges: [],
        });
      }
      return Promise.resolve(null);
    });
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the empty state when no nodes exist", async () => {
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });
    expect(screen.getByTestId("topology-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("topology-inspector")).not.toBeInTheDocument();
  });

  it("selects topology modes with keyboard-complete tab semantics", async () => {
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    const neighbors = screen.getByRole("tab", { name: "Neighbors" });
    const topolograph = screen.getByRole("tab", { name: "Topolograph" });
    expect(neighbors.getAttribute("aria-controls")).toBeTruthy();
    expect(neighbors).toHaveAttribute("aria-selected", "true");
    expect(topolograph.getAttribute("aria-controls")).toBeTruthy();
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).toBeInTheDocument();
    }

    topolograph.focus();
    fireEvent.keyDown(topolograph, { key: "ArrowRight" });

    expect(screen.getByRole("tab", { name: "Spanning Tree" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Spanning Tree" })).toHaveAttribute("aria-selected", "true");
    const spanningTree = screen.getByRole("tab", { name: "Spanning Tree" });
    expect(spanningTree).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id);
  });

  it("keeps tab IDs, panels, and arrow-key focus scoped to each mounted instance", async () => {
    const { container } = render(<><TopologyTab tabId="tab-one" /><TopologyTab tabId="tab-two" /></>);
    const instances = screen.getAllByTestId("topology-tab");
    const first = within(instances[0]);
    const second = within(instances[1]);
    const ids = Array.from(container.querySelectorAll("[role=tab]")).map((tab) => tab.id);

    expect(new Set(ids).size).toBe(ids.length);

    const firstTopolograph = first.getByRole("tab", { name: "Topolograph" });
    firstTopolograph.focus();
    fireEvent.keyDown(firstTopolograph, { key: "ArrowRight" });

    expect(first.getByRole("tab", { name: "Spanning Tree" })).toHaveFocus();
    expect(second.getByRole("tab", { name: "Spanning Tree" })).not.toHaveFocus();
    const firstPanel = first.getByRole("tabpanel");
    expect(first.getByRole("tab", { name: "Spanning Tree" })).toHaveAttribute("aria-controls", firstPanel.id);
  });

  it("renders the Neighbors control-room landmarks and toolbar hierarchy", async () => {
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    const workspace = screen.getByRole("region", {
      name: "Neighbors topology workspace",
    });
    expect(workspace).toHaveClass("topology-tab__workspace");
    expect(
      within(workspace).getByRole("heading", {
        level: 2,
        name: "Network neighbors",
      }),
    ).toBeInTheDocument();

    const toolbar = within(workspace).getByRole("toolbar", {
      name: "Topology toolbar",
    });
    const primaryActions = within(toolbar).getByRole("group", {
      name: "Discovery and refresh",
    });
    const secondaryActions = within(toolbar).getByRole("group", {
      name: "Graph output and cleanup",
    });
    expect(
      within(primaryActions).getByRole("button", { name: "Discover devices" }),
    ).toHaveClass("topology-toolbar__primary");
    expect(
      within(secondaryActions).getByRole("button", { name: "Clear graph" }),
    ).toHaveClass("topology-toolbar__danger");

    expect(within(workspace).getByTestId("topology-navigation-rail")).toHaveClass(
      "topology-tab__rail",
    );
    expect(within(workspace).getByRole("region", { name: "Topology canvas" }))
      .toHaveAttribute("data-state", "empty");
    expect(within(workspace).getByTestId("topology-workspace-body")).toHaveClass(
      "topology-tab__body--inspector-closed",
    );
  });

  it("exposes populated canvas and inspector layout states without changing node actions", async () => {
    resetStore({ nodes: makeNodes(), edges: makeEdges() });
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    const workspace = screen.getByRole("region", {
      name: "Neighbors topology workspace",
    });
    const canvas = within(workspace).getByRole("region", {
      name: "Topology canvas",
    });
    const body = within(workspace).getByTestId("topology-workspace-body");
    expect(canvas).toHaveAttribute("data-state", "populated");
    expect(body).toHaveClass("topology-tab__body--inspector-closed");

    const r1Inner = within(workspace)
      .getAllByTestId("topology-node")
      .find((node) => node.textContent?.includes("R1"));
    expect(r1Inner).toBeDefined();
    fireEvent.click(r1Inner!.closest(".react-flow__node") ?? r1Inner!);

    expect(await within(workspace).findByTestId("topology-inspector"))
      .toBeInTheDocument();
    expect(body).toHaveClass("topology-tab__body--inspector-open");

    fireEvent.click(
      within(workspace).getByRole("button", { name: "Close inspector" }),
    );
    expect(within(workspace).queryByTestId("topology-inspector"))
      .not.toBeInTheDocument();
    expect(body).toHaveClass("topology-tab__body--inspector-closed");
  });

  it("renders ReactFlow nodes when seeded with topology data", async () => {
    resetStore({ nodes: makeNodes(), edges: makeEdges() });
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });
    // The empty placeholder must be gone.
    expect(screen.queryByTestId("topology-empty")).not.toBeInTheDocument();
    // The toolbar + filter tree should be present.
    expect(screen.getByTestId("topology-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("topology-filter-tree")).toBeInTheDocument();
    // ReactFlow renders our custom nodes — assert at least the seeded count.
    const rfNodes = screen.getAllByTestId("topology-node");
    expect(rfNodes.length).toBe(3);
  });

  it("filter tree hides nodes whose vendor is unchecked", async () => {
    resetStore({ nodes: makeNodes(), edges: makeEdges() });
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    // Sanity: cisco nodes are present at start.
    expect(
      screen.getAllByTestId("topology-node").filter(
        (n) => n.getAttribute("data-vendor") === "cisco",
      ).length,
    ).toBe(2);

    // Uncheck cisco — model: empty Set → materialize all → remove cisco.
    const ciscoBox = screen.getByTestId("topology-filter-vendor-cisco");
    await act(async () => {
      fireEvent.click(ciscoBox);
    });

    const remaining = screen.queryAllByTestId("topology-node");
    expect(
      remaining.filter((n) => n.getAttribute("data-vendor") === "cisco").length,
    ).toBe(0);
    // Juniper survives.
    expect(
      remaining.filter((n) => n.getAttribute("data-vendor") === "juniper").length,
    ).toBe(1);
  });

  it("opens the inspector when a node is clicked", async () => {
    resetStore({ nodes: makeNodes(), edges: makeEdges() });
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    expect(screen.queryByTestId("topology-inspector")).not.toBeInTheDocument();

    // ReactFlow's node renderer wraps each NeighborNode in an outer
    // .react-flow__node. Click the outer wrapper of the R1 node so
    // ReactFlow's onNodeClick fires (rather than just the inner div).
    const r1Inner = screen
      .getAllByTestId("topology-node")
      .find((n) => n.textContent?.includes("R1"));
    expect(r1Inner).toBeDefined();
    const wrapper = r1Inner!.closest(".react-flow__node") ?? r1Inner!;
    await act(async () => {
      fireEvent.click(wrapper as Element);
    });

    const inspector = await screen.findByTestId("topology-inspector");
    expect(inspector).toBeInTheDocument();
    expect(inspector.textContent).toMatch(/R1/);
  });

  it("opens the inspector when a focused node is activated with Enter or Space", async () => {
    resetStore({ nodes: makeNodes(), edges: makeEdges() });
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    const r1 = screen
      .getAllByTestId("topology-node")
      .find((node) => node.textContent?.includes("R1"));
    expect(r1).toBeDefined();

    r1!.focus();
    fireEvent.keyDown(r1!, { key: "Enter" });
    expect(await screen.findByTestId("topology-inspector")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    r1!.focus();
    fireEvent.keyDown(r1!, { key: " " });
    expect(await screen.findByTestId("topology-inspector")).toBeInTheDocument();
  });

  it("calls clearGraph when the user confirms the destructive dialog", async () => {
    resetStore({ nodes: makeNodes(), edges: makeEdges() });
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => true);
    const clearSpy = vi.fn().mockResolvedValue(undefined);
    useTopologyStore.setState({ clearGraph: clearSpy });

    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    const clearBtn = screen.getByTestId("topology-toolbar-clear");
    await act(async () => {
      fireEvent.click(clearBtn);
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith(GLOBAL_GRAPH_ID);
  });

  it("does NOT call clearGraph when the confirm dialog is cancelled", async () => {
    resetStore({ nodes: makeNodes(), edges: makeEdges() });
    vi.spyOn(window, "confirm").mockImplementation(() => false);
    const clearSpy = vi.fn().mockResolvedValue(undefined);
    useTopologyStore.setState({ clearGraph: clearSpy });

    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    const clearBtn = screen.getByTestId("topology-toolbar-clear");
    await act(async () => {
      fireEvent.click(clearBtn);
    });

    expect(clearSpy).not.toHaveBeenCalled();
  });

  it("auto-refreshes on the configured interval and stops when set to null", async () => {
    vi.useFakeTimers();
    try {
      resetStore({ nodes: [], edges: [] });
      const refreshSpy = vi.fn().mockResolvedValue(undefined);
      useTopologyStore.setState({
        refresh: refreshSpy,
        autoRefreshIntervalMs: 30000,
      });

      await act(async () => {
        render(<TopologyTab tabId="tab-test" />);
      });

      // The initial-mount effect calls loadGraphs().then(refresh()), which
      // adds an unrelated call to the spy. Reset it so we count only
      // timer-driven calls from this point on.
      refreshSpy.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(30000);
      });
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(30000);
      });
      expect(refreshSpy).toHaveBeenCalledTimes(2);

      // Switching the interval to null must clear the timer.
      await act(async () => {
        useTopologyStore.setState({ autoRefreshIntervalMs: null });
      });
      refreshSpy.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(60000);
      });
      expect(refreshSpy).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filter collapses to empty Set when user re-checks the previously unchecked vendor", async () => {
    // Seed two cisco nodes + one juniper node so we have multiple vendors.
    resetStore({ nodes: makeNodes(), edges: makeEdges() });
    await act(async () => {
      render(<TopologyTab tabId="tab-test" />);
    });

    // Initially: vendors Set is empty (== "show all"), so all 3 nodes render.
    expect(screen.getAllByTestId("topology-node").length).toBe(3);

    // Uncheck cisco — toggle materializes the Set with all-but-cisco.
    const ciscoBox = screen.getByTestId("topology-filter-vendor-cisco");
    await act(async () => {
      fireEvent.click(ciscoBox);
    });

    // Cisco nodes are filtered out; juniper survives.
    const afterUncheck = screen.queryAllByTestId("topology-node");
    expect(
      afterUncheck.filter((n) => n.getAttribute("data-vendor") === "cisco")
        .length,
    ).toBe(0);
    expect(
      afterUncheck.filter((n) => n.getAttribute("data-vendor") === "juniper")
        .length,
    ).toBe(1);

    // Re-check cisco. Now the Set would contain {cisco, juniper}, but since
    // size === options.size === 2 the filter tree collapses back to empty.
    await act(async () => {
      fireEvent.click(ciscoBox);
    });

    // All 3 nodes should be visible again — empty Set == "show all".
    expect(screen.getAllByTestId("topology-node").length).toBe(3);
  });
});

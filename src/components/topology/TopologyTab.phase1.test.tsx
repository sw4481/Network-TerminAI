import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import type { ReactFlowProps } from "@xyflow/react";
const invokeMock = vi.fn();
let flowProps: ReactFlowProps;
let mounts = 0;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@xyflow/react", async (original) => ({
  ...await original<typeof import("@xyflow/react")>(),
  ReactFlow: (props: ReactFlowProps) => {
    flowProps = props;
    const [instance] = useState(() => ++mounts);
    useEffect(() => {}, []);
    return <div data-testid="flow" data-instance={instance}>{props.nodes?.map((node) => <div key={node.id} data-testid={`map-${node.id}`} data-x={node.position.x} data-y={node.position.y}>{String(node.data.label)}</div>)}</div>;
  },
}));
import { TopologyTab } from "./TopologyTab";
import { useTopologyStore } from "../../state/topologyStore";
import { GLOBAL_GRAPH_ID, type DiscoveryRun, type TopologyNode } from "../../lib/topology";
const actions = useTopologyStore.getState();
const graph = (id: string, name = id) => ({ id, name, created_at: 0, updated_at: 0 });
const discoveryReport = (status: string, graphId = GLOBAL_GRAPH_ID): DiscoveryRun => ({
  run_id: "fixture-run", graph_id: graphId, state: "completed", max_depth: 0,
  devices: [{ connection_id: "one", host: "192.0.2.1", depth: 0, status,
    captures: status === "partial" ? [{ protocol: "cdp", status: "completed", records: 0 }, { protocol: "lldp", status: "failed", records: 0, error: "Capture failed" }] : status === "unsupported" ? [] : [{ protocol: "cdp", status: "completed", records: 0 }],
    error: status === "unsupported" ? "Unsupported fixture" : null,
  }],
  not_dialed: [], additional_not_dialed: 0, nodes_processed: 0, edges_processed: 0,
  parser_admission_ms: 0, parser_reply_ms: 0,
});
const nodes: TopologyNode[] = [
  { graph_id: GLOBAL_GRAPH_ID, device_ref: "r1", device_kind: "ssh", label: "R1", vendor: "cisco", platform: "iosxe" },
  { graph_id: GLOBAL_GRAPH_ID, device_ref: "j1", device_kind: "ssh", label: "J1", vendor: "juniper", platform: "junos" },
];
beforeEach(() => {
  mounts = 0;
  invokeMock.mockReset();
  useTopologyStore.setState({ ...actions, graphs: [graph(GLOBAL_GRAPH_ID, "Global"), graph("lab", "Lab")], currentGraphId: GLOBAL_GRAPH_ID,
    nodes, edges: [], positions: [{ device_ref: "r1", x: 40, y: 50 }], layoutVersion: 0, layoutError: null, error: null, loading: false,
    loadGraphs: async () => {}, refresh: async () => {}, autoRefreshIntervalMs: null,
  });
  invokeMock.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("keeps primary actions visible and secondary tools collapsed until requested", () => {
  render(<TopologyTab tabId="workspace" />);
  expect(screen.getByRole("button", { name: "Discover devices" })).toBeVisible();
  expect(screen.getByLabelText("Graph")).toBeVisible();
  const tools = screen.getByText("Graph tools").closest("details")!;
  const interchange = screen.getByText("Import & export").closest("details")!;
  expect(tools).not.toHaveAttribute("open");
  expect(interchange).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("Graph tools"));
  expect(within(tools).getByRole("button", { name: "Clear graph" })).toBeVisible();
  fireEvent.click(screen.getByText("Import & export"));
  expect(within(interchange).getByRole("button", { name: "Export PNG" })).toBeVisible();
  expect(within(interchange).getByText(/Collection source\/freshness stays local/)).toBeInTheDocument();
});

it("collapses long collection details but surfaces capture issues outside them", () => {
  const report = discoveryReport("partial");
  report.not_dialed = Array.from({ length: 100 }, (_, index) => ({ reference: `peer-${index}`, reason: "No exact saved host match" }));
  useTopologyStore.setState({ discoveryRun: report });
  render(<TopologyTab tabId="workspace" />);
  const region = screen.getByRole("region", { name: "Discovery run" });
  expect(within(region).getByRole("status")).toHaveTextContent("Discovery completed");
  const warning = within(region).getByRole("alert");
  expect(warning).toHaveTextContent("1 capture issue");
  expect(warning.closest("details")).toBeNull();
  const details = within(region).getByText("Device outcomes and neighbors not dialed").closest("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(within(region).getByText(/Processed node rows: 0/).closest("details")).toBe(details);
  fireEvent.click(within(region).getByText("Device outcomes and neighbors not dialed"));
  expect(within(details).getByText(/Capture failed/)).toBeVisible();
  const skipped = within(details).getByText("Neighbors not dialed (100)").closest("details")!;
  expect(skipped).not.toHaveAttribute("open");
});

it("hides and restores filters without clearing selection or unmounting the graph", () => {
  render(<TopologyTab tabId="workspace" />);
  fireEvent.click(screen.getByTestId("topology-filter-vendor-cisco"));
  expect(screen.queryByTestId("map-r1")).not.toBeInTheDocument();
  const canvas = screen.getByRole("region", { name: "Topology canvas" });
  fireEvent.click(screen.getByRole("button", { name: "Hide filters" }));
  expect(screen.getByTestId("topology-navigation-rail")).not.toBeVisible();
  expect(screen.getByRole("region", { name: "Topology canvas" })).toBe(canvas);
  fireEvent.click(screen.getByRole("button", { name: "Show filters" }));
  expect(screen.getByTestId("topology-filter-vendor-cisco")).not.toBeChecked();
  expect(screen.getByTestId("map-j1")).toBeVisible();
});

it("exposes graph selection and named creation without late creation changing selection", async () => {
  let resolve!: (value: ReturnType<typeof graph>) => void;
  const pending = new Promise<ReturnType<typeof graph>>((done) => { resolve = done; });
  invokeMock.mockImplementation((command: string) => command === "topology_create_graph" ? pending : Promise.resolve(command === "topology_discovery_status" ? null : { graph: graph("lab"), nodes: [], edges: [], positions: [] }));
  render(<TopologyTab tabId="phase1" />);
  fireEvent.change(screen.getByLabelText("Graph name"), { target: { value: "New map" } });
  fireEvent.click(screen.getByRole("button", { name: "Create graph" }));
  fireEvent.change(screen.getByLabelText("Graph"), { target: { value: "lab" } });
  await act(async () => resolve(graph("new", "New map")));
  expect(screen.getByLabelText("Graph")).toHaveValue("lab");
  expect(screen.getByRole("option", { name: "New map" })).toBeInTheDocument();
});

it("uses durable positions and never repositions survivors when filtering or refreshing", async () => {
  render(<TopologyTab tabId="phase1" />);
  expect(screen.getByTestId("map-r1")).toHaveAttribute("data-x", "40");
  const before = screen.getByTestId("map-j1").getAttribute("data-x");
  const instance = screen.getByTestId("flow").getAttribute("data-instance");
  fireEvent.click(screen.getByTestId("topology-filter-vendor-cisco"));
  expect(screen.getByTestId("map-j1")).toHaveAttribute("data-x", before!);
  await act(async () => useTopologyStore.setState({ nodes: [...nodes, { ...nodes[1], device_ref: "a0", label: "New neighbor" }] }));
  expect(screen.getByTestId("map-j1")).toHaveAttribute("data-x", before!);
  fireEvent.click(screen.getByTestId("topology-filter-platform-junos"));
  expect(screen.queryByTestId("map-j1")).not.toBeInTheDocument();
  expect(screen.getByTestId("flow")).toHaveAttribute("data-instance", instance!);
});

it("preserves the existing initial radial fallback when no positions have been retained or saved", () => {
  useTopologyStore.setState({ nodes: Array.from({ length: 8 }, (_, index) => ({ ...nodes[0], device_ref: `r${index}`, label: `r${index}` })), positions: [] });
  render(<TopologyTab tabId="phase1" />);
  expect(screen.getByTestId("map-r1")).toHaveAttribute("data-x", "156");
  expect(screen.getByTestId("map-r1")).toHaveAttribute("data-y", "-156");
});

it("places newly inserted nodes in free space without moving retained or saved nodes", async () => {
  const retained = ["b", "c"].map((device_ref) => ({ ...nodes[0], device_ref, label: device_ref }));
  useTopologyStore.setState({ nodes: retained, positions: [] });
  render(<TopologyTab tabId="phase1" />);
  const before = new Map(flowProps.nodes!.map((node) => [node.id, { ...node.position }]));
  await act(async () => useTopologyStore.setState({ nodes: [{ ...nodes[0], device_ref: "a", label: "a" }, ...retained] }));
  for (const node of flowProps.nodes!.filter((node) => node.id !== "a")) expect(node.position).toEqual(before.get(node.id));
  const added = flowProps.nodes!.find((node) => node.id === "a")!;
  for (const position of before.values()) {
    expect(Math.abs(added.position.x - position.x) >= 200 || Math.abs(added.position.y - position.y) >= 160).toBe(true);
  }
  const occupied = { ...added.position };
  await act(async () => useTopologyStore.setState({ positions: [{ device_ref: "b", ...occupied }], nodes: [...retained, { ...nodes[0], device_ref: "a", label: "a" }, { ...nodes[0], device_ref: "d", label: "d" }] }));
  const saved = flowProps.nodes!.find((node) => node.id === "b")!;
  expect(saved.position).toEqual(occupied);
  const newest = flowProps.nodes!.find((node) => node.id === "d")!;
  for (const node of flowProps.nodes!.filter((node) => node.id !== "d")) {
    expect(Math.abs(newest.position.x - node.position.x) >= 200 || Math.abs(newest.position.y - node.position.y) >= 160).toBe(true);
  }
});

it("moves focus into discovery, traps Tab, and restores the opener after Escape", async () => {
  invokeMock.mockImplementation(async (command) => command === "ssh_list_connections" ? [] : null);
  render(<TopologyTab tabId="phase1" />);
  const opener = screen.getByRole("button", { name: "Discover devices" });
  opener.focus();
  await act(async () => fireEvent.click(opener));
  const dialog = screen.getByRole("dialog", { name: "Discover topology" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  const first = dialog.querySelector<HTMLButtonElement>("button")!;
  const last = screen.getByRole("button", { name: "Cancel" });
  expect(Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0)).toEqual([first, screen.getByLabelText("Destination graph"), screen.getByLabelText("Collection method"), screen.getByLabelText("Discovery scope"), screen.getByRole("checkbox", { name: "Include routing observations (BGP/OSPF/IS-IS/EIGRP)" }), last]);
  first.focus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Discover topology" })).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it("persists drag-stop through native layout and shows failures after refresh", async () => {
  invokeMock.mockImplementation(async (command) => {
    if (command === "topology_save_layout") throw new Error("disk full");
    return null;
  });
  render(<TopologyTab tabId="phase1" />);
  await act(async () => {
    flowProps.onNodesChange?.([{ id: "r1", type: "position", position: { x: 321, y: 123 }, dragging: true }]);
  });
  expect(screen.getByTestId("map-r1")).toHaveAttribute("data-x", "321");
  await act(async () => {
    const node = flowProps.nodes!.find((item) => item.id === "r1")!;
    flowProps.onNodeDragStop?.({} as never, node, [node]);
  });
  expect(invokeMock).toHaveBeenCalledWith("topology_save_layout", { graphId: GLOBAL_GRAPH_ID, positions: [{ device_ref: "r1", x: 321, y: 123 }] });
  expect(screen.getByRole("alert")).toHaveTextContent("Layout not saved");
  fireEvent.click(screen.getByRole("button", { name: "Refresh topology" }));
  expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  expect(screen.getByTestId("map-r1")).toHaveAttribute("data-x", "321");
});

it("projects duplicate-kind rows to one node and discloses conflicting metadata", () => {
  useTopologyStore.setState({ nodes: [...nodes, { ...nodes[0], device_kind: "discovered", label: "Conflicting" }] });
  render(<TopologyTab tabId="phase1" />);
  expect(screen.getAllByTestId("map-r1")).toHaveLength(1);
  expect(screen.getByText(/has conflicting metadata/)).toHaveTextContent("Conflicting");
});

it("only deliberately arranges or resets all nodes, including filtered-out nodes", async () => {
  render(<TopologyTab tabId="phase1" />);
  fireEvent.click(screen.getByTestId("topology-filter-vendor-cisco"));
  fireEvent.click(screen.getByRole("button", { name: "Arrange" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("topology_save_layout", { graphId: GLOBAL_GRAPH_ID, positions: expect.arrayContaining([expect.objectContaining({ device_ref: "r1" }), expect.objectContaining({ device_ref: "j1" })]) }));
  fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("topology_reset_layout", { graphId: GLOBAL_GRAPH_ID }));
});

it("ignores old drag-stop callbacks after same-graph reselection", async () => {
  render(<TopologyTab tabId="phase1" />);
  const old = flowProps;
  const node = old.nodes!.find((item) => item.id === "r1")!;
  await act(async () => {
    await useTopologyStore.getState().selectGraph(GLOBAL_GRAPH_ID);
    useTopologyStore.setState({ nodes });
  });
  await act(async () => old.onNodeDragStop?.({} as never, { ...node, position: { x: 999, y: 999 } }, []));
  expect(invokeMock).not.toHaveBeenCalledWith("topology_save_layout", expect.anything());
});

it("treats inherited-object names as literal device references", () => {
  useTopologyStore.setState({ nodes: [{ ...nodes[0], device_ref: "__proto__" }], positions: [] });
  render(<TopologyTab tabId="phase1" />);
  expect(screen.getByTestId("map-__proto__")).toHaveAttribute("data-x", "0");
  expect(screen.getByTestId("map-__proto__")).toHaveAttribute("data-y", "0");
});

it("ignores connection responses from an earlier modal opening", async () => {
  let resolve!: (value: unknown[]) => void;
  const old = new Promise<unknown[]>((done) => { resolve = done; });
  let lists = 0;
  invokeMock.mockImplementation(async (command) => {
    if (command !== "ssh_list_connections") return null;
    if (++lists === 1) return old;
    return [{ id: "new", name: "Current saved device", host: "192.0.2.2", password_encrypted: "synthetic", vendor: "cisco", platform: "iosxe" }];
  });
  render(<TopologyTab tabId="phase1" />);
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  await screen.findByText("Current saved device");
  await act(async () => resolve([{ id: "old", name: "Obsolete saved device", host: "192.0.2.3" }]));
  expect(screen.queryByText("Obsolete saved device")).not.toBeInTheDocument();
  expect(screen.getByText("Current saved device")).toBeInTheDocument();
});

it.each(["partial", "completed"] as const)("renders %s with zero processed rows without inventing discovery counts", async (status) => {
  invokeMock.mockImplementation((command: string) => {
    if (command === "ssh_list_connections") return Promise.resolve([{ id: "one", name: "Supported fixture", host: "192.0.2.1", password_encrypted: "synthetic", vendor: "cisco", platform: "iosxe" }]);
    if (command === "topology_discovery_start") return Promise.resolve(discoveryReport(status));
    return Promise.resolve(undefined);
  });
  render(<TopologyTab tabId="phase1" />);
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  await screen.findByText("Supported fixture");
  fireEvent.click(screen.getByTestId("discovery-device-one").querySelector("input")!);
  fireEvent.click(screen.getByRole("button", { name: "Discover (1)" }));
  const outcome = await screen.findByRole("region", { name: "Discovery run" });
  expect(outcome).toHaveTextContent("Processed node rows: 0");
  expect(outcome).toHaveTextContent("not newly discovered counts");
  fireEvent.click(within(outcome).getByText("Device outcomes and neighbors not dialed"));
  expect(outcome).toHaveTextContent(`192.0.2.1 · depth 0 · ${status}`);
  expect(outcome).toHaveTextContent("cdp: completed (0 rows)");
  if (status === "partial") expect(outcome).toHaveTextContent("lldp: failed (0 rows) — Capture failed");
});

it("snapshots the modal destination and visibly distinguishes failed/partial from completed", async () => {
  invokeMock.mockImplementation((command: string) => {
    if (command === "ssh_list_connections") return Promise.resolve([{ id: "one", name: "Saved device", host: "192.0.2.1", password_encrypted: "synthetic", vendor: "juniper", platform: "junos" }]);
    if (command === "topology_discovery_start") return Promise.resolve(discoveryReport("unsupported", "lab"));
    return Promise.resolve(undefined);
  });
  render(<TopologyTab tabId="phase1" />);
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  await screen.findByText("Saved device");
  fireEvent.change(screen.getByLabelText("Destination graph"), { target: { value: "lab" } });
  fireEvent.click(screen.getByTestId("discovery-device-one").querySelector("input")!);
  fireEvent.click(screen.getByRole("button", { name: "Discover (1)" }));
  const outcome = await screen.findByRole("region", { name: "Discovery run" });
  fireEvent.click(within(outcome).getByText("Device outcomes and neighbors not dialed"));
  expect(outcome).toHaveTextContent("192.0.2.1 · depth 0 · unsupported — Unsupported fixture");
  expect(outcome).toHaveTextContent("Processed node rows: 0");
  expect(invokeMock).toHaveBeenCalledWith("topology_discovery_start", { request: expect.objectContaining({ graph_id: "lab" }) });
  expect(useTopologyStore.getState().currentGraphId).toBe(GLOBAL_GRAPH_ID);
  expect(outcome).not.toHaveTextContent("Discovery complete!");
});

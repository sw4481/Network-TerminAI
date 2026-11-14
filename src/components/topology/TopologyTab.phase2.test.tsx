import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactFlowProps } from "@xyflow/react";

const invokeMock = vi.fn();
let flow: ReactFlowProps;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@xyflow/react", async (original) => ({
  ...await original<typeof import("@xyflow/react")>(),
  ReactFlow: (props: ReactFlowProps) => {
    flow = props;
    return <div data-testid="phase2-flow">{props.nodes?.map((node) => <button key={node.id} data-testid={`node-${node.id}`} data-device-ref={node.id} onClick={() => (node.data.onActivate as () => void)()}>{String(node.data.label)}</button>)}</div>;
  },
}));
import { TopologyTab } from "./TopologyTab";
import { TopologyExport } from "../../lib/topologyExport";
import { useTopologyStore } from "../../state/topologyStore";
import { GLOBAL_GRAPH_ID, type TopologyEdge, type TopologyNode } from "../../lib/topology";

const initial = useTopologyStore.getState();
const node = (ref: string, kind: TopologyNode["device_kind"] = "ssh"): TopologyNode => ({
  graph_id: GLOBAL_GRAPH_ID, device_ref: ref, label: ref.toUpperCase(), device_kind: kind, vendor: "cisco", platform: "iosxe",
});
const edge = (a: string, b: string, port: string, protocol: TopologyEdge["protocol"] = "lldp"): TopologyEdge => ({
  graph_id: GLOBAL_GRAPH_ID, a_device_ref: a, a_port: port, b_device_ref: b, b_port: "Eth1", protocol, captured_at: 1_700_000_000,
});
const rows = [node("r1"), node("r2"), node("r3", "netconf"), node("isolated", "discovered")];
const links = [edge("r1", "r2", "Gi1"), edge("r1", "r2", "Gi2"), edge("r2", "r3", "Lo0", "bgp")];
const saveLayout = vi.fn().mockResolvedValue(true);
const select = (ref: string) => fireEvent.click(screen.getByTestId(`node-${ref}`));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  saveLayout.mockClear();
  useTopologyStore.setState({ ...initial, currentGraphId: GLOBAL_GRAPH_ID, nodes: rows, edges: links,
    positions: rows.map((row, i) => ({ device_ref: row.device_ref, x: 40 + i * 230, y: 30 })),
    layoutVersion: 0, layoutError: null, error: null, loading: false, graphs: [], autoRefreshIntervalMs: null,
    loadGraphs: async () => {}, refresh: async () => {}, saveLayout,
  });
});
afterEach(cleanup);

it("submits seeds-only by default without issuing legacy per-device collection", async () => {
  invokeMock.mockImplementation(async (command) => {
    if (command === "ssh_list_connections") return [{ id: "seed", name: "Seed", host: "192.0.2.1", port: 22, vendor: "cisco", platform: "iosxe", password_encrypted: "synthetic-present" }];
    if (command === "topology_discovery_start") return { run_id: "owned", graph_id: GLOBAL_GRAPH_ID, state: "running", max_depth: 0, devices: [], not_dialed: [], additional_not_dialed: 0, nodes_processed: 0, edges_processed: 0, parser_admission_ms: 0, parser_reply_ms: 0 };
    return null;
  });
  render(<TopologyTab tabId="phase4" />);
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  const dialog = await screen.findByRole("dialog", { name: "Discover topology" });
  await waitFor(() => expect(within(dialog).getByTestId("discovery-device-seed")).toBeInTheDocument());
  expect(within(dialog).getByRole("combobox", { name: "Discovery scope" })).toHaveValue("0");
  fireEvent.click(within(dialog).getByTestId("discovery-device-seed").querySelector("input")!);
  fireEvent.click(within(dialog).getByRole("button", { name: "Discover (1)" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("topology_discovery_start", { request: { graph_id: GLOBAL_GRAPH_ID, seed_ids: ["seed"], eligible_ids: ["seed"], passwords: {}, max_depth: 0, include_routing: false } }));
  expect(invokeMock.mock.calls.some(([command]) => command === "topology_discover_device")).toBe(false);
  expect(await screen.findByRole("button", { name: "Stop discovery" })).toBeInTheDocument();
});

it("requires explicit eligible follow-ups and clears temporary passwords on close", async () => {
  const start = vi.fn().mockResolvedValue(undefined);
  useTopologyStore.setState({ startDiscovery: start });
  invokeMock.mockImplementation(async (command) => command === "ssh_list_connections" ? ["seed", "peer"].map((id, i) => ({ id, name: id, host: `192.0.2.${i + 1}`, port: 22, vendor: "cisco", platform: "iosxe", password_encrypted: null })) : null);
  render(<TopologyTab tabId="phase4" />);
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  let dialog = await screen.findByRole("dialog", { name: "Discover topology" });
  await waitFor(() => expect(within(dialog).getByTestId("discovery-device-seed")).toBeInTheDocument());
  fireEvent.click(within(dialog).getByTestId("discovery-device-seed").querySelector("input")!);
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Discovery scope" }), { target: { value: "1" } });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Allow follow-up to peer" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Discover (1)" }));
  expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter temporary passwords");
  fireEvent.change(within(dialog).getByLabelText("Password for seed"), { target: { value: "synthetic-seed" } });
  fireEvent.change(within(dialog).getByLabelText("Password for peer"), { target: { value: "synthetic-peer" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Discover (1)" }));
  expect(start).toHaveBeenCalledWith({ graph_id: GLOBAL_GRAPH_ID, seed_ids: ["seed"], eligible_ids: ["seed", "peer"], passwords: { seed: "synthetic-seed", peer: "synthetic-peer" }, max_depth: 1, include_routing: false });
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  dialog = await screen.findByRole("dialog", { name: "Discover topology" });
  await waitFor(() => expect(within(dialog).getByTestId("discovery-device-seed")).toBeInTheDocument());
  expect(within(dialog).getByRole("combobox", { name: "Discovery scope" })).toHaveValue("0");
  expect(within(dialog).queryByLabelText("Password for seed")).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByTestId("discovery-device-seed").querySelector("input")!);
  expect(within(dialog).getByLabelText("Password for seed")).toHaveValue("");
});

it("recovers an app-owned run from another graph and stops by its run ID", async () => {
  const run = { run_id: "recovered", graph_id: "other-graph", state: "running", max_depth: 1, devices: [], not_dialed: [{ reference: "unsaved", reason: "No exact saved host match" }], additional_not_dialed: 0, nodes_processed: 1, edges_processed: 1, parser_admission_ms: 10, parser_reply_ms: 20 };
  invokeMock.mockImplementation(async (command) => command === "topology_discovery_cancel" ? { ...run, state: "cancelling" } : run);
  render(<TopologyTab tabId="phase4" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop discovery" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("topology_discovery_cancel", { runId: "recovered" }));
  expect(await screen.findByRole("button", { name: "Stopping and cleaning up…" })).toBeDisabled();
  expect(useTopologyStore.getState().currentGraphId).toBe(GLOBAL_GRAPH_ID);
  expect(screen.getByRole("region", { name: "Discovery run" })).toHaveTextContent("other-graph");
});

it("focuses one hop without altering stored nodes or coordinates and arranges all components", async () => {
  render(<TopologyTab tabId="phase2" />);
  const positions = flow.nodes!.map((item) => ({ id: item.id, ...item.position }));
  select("r1");
  fireEvent.click(screen.getByRole("button", { name: "Focus neighborhood" }));
  expect(flow.nodes!.map((item) => item.id).sort()).toEqual(["r1", "r2"]);
  expect(flow.edges).toHaveLength(2);
  expect(useTopologyStore.getState().nodes).toEqual(rows);
  fireEvent.click(screen.getByRole("button", { name: "Exit focus" }));
  expect(flow.nodes!.map((item) => ({ id: item.id, ...item.position }))).toEqual(positions);
  fireEvent.click(screen.getByRole("button", { name: "Arrange connected" }));
  await waitFor(() => expect(saveLayout).toHaveBeenCalledWith(GLOBAL_GRAPH_ID, expect.arrayContaining(rows.map((row) => expect.objectContaining({ device_ref: row.device_ref })))));
});

it("clears selection and focus on graph switch even when references are reused", async () => {
  render(<TopologyTab tabId="phase2" />);
  select("r1");
  fireEvent.click(screen.getByRole("button", { name: "Focus neighborhood" }));
  await act(async () => useTopologyStore.setState({ currentGraphId: "other", nodes: rows.map((row) => ({ ...row, graph_id: "other" })), edges: [] }));
  expect(screen.queryByRole("button", { name: "Exit focus" })).not.toBeInTheDocument();
  expect(screen.queryByTestId("topology-inspector")).not.toBeInTheDocument();
});

it("calls protocol-specific application openers and makes failures visible", async () => {
  const ssh = vi.fn().mockRejectedValue(new Error("Ambiguous saved SSH profiles"));
  const netconf = vi.fn().mockResolvedValue(undefined);
  render(<TopologyTab tabId="phase2" onOpenSshTab={ssh} onOpenNetconfTab={netconf} />);
  select("r1");
  fireEvent.click(screen.getByRole("button", { name: "Open SSH" }));
  await waitFor(() => expect(ssh).toHaveBeenCalledWith("r1"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Ambiguous saved SSH profiles");
  select("r3");
  fireEvent.click(screen.getByRole("button", { name: "Open NETCONF" }));
  await waitFor(() => expect(netconf).toHaveBeenCalledWith("r3"));
  expect(invokeMock).not.toHaveBeenCalledWith("device_lookup_by_ref", expect.anything());
});

it("resolves an unsaved node before offering the existing save flow", async () => {
  render(<TopologyTab tabId="phase2" />);
  select("isolated");
  fireEvent.click(screen.getByRole("button", { name: "Open or save neighbor" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("device_lookup_by_ref", { ref: "isolated" }));
  expect(await screen.findByTestId("save-neighbor-modal")).toBeInTheDocument();
});

it("does not let a late neighbor lookup open a modal in another graph", async () => {
  let resolve!: (value: null) => void;
  invokeMock.mockReturnValue(new Promise<null>((done) => { resolve = done; }));
  render(<TopologyTab tabId="phase2" />);
  select("isolated");
  fireEvent.click(screen.getByRole("button", { name: "Open or save neighbor" }));
  await act(async () => useTopologyStore.setState({ currentGraphId: "other", nodes: [], edges: [] }));
  await act(async () => resolve(null));
  expect(screen.queryByTestId("save-neighbor-modal")).not.toBeInTheDocument();
});

it("exposes parallel ports and timed logical evidence without claiming live reachability", () => {
  render(<TopologyTab tabId="phase2" />);
  select("r2");
  const inspector = screen.getByTestId("topology-inspector");
  expect(within(inspector).getAllByText("L2 observation", { exact: false })).toHaveLength(2);
  expect(within(inspector).getByText("Routing adjacency", { exact: false })).toBeInTheDocument();
  expect(inspector).toHaveTextContent("Gi1");
  expect(inspector).toHaveTextContent("Gi2");
  expect(inspector).toHaveTextContent("Reachability unverified");
  expect(inspector.querySelectorAll("time")).toHaveLength(3);
  const offsets = flow.edges!.filter((item) => item.source === "r1").map((item) => item.data?.offset);
  expect(new Set(offsets).size).toBe(2);
  fireEvent.click(screen.getByText("Link table (3)"));
  expect(screen.getByRole("table", { name: "Recorded link evidence" })).toHaveTextContent("Gi2");
});

it("keeps an in-flight opener guarded across selection and mode changes", async () => {
  let resolve!: () => void;
  const ssh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  render(<TopologyTab tabId="phase2" onOpenSshTab={ssh} />);
  select("r1");
  fireEvent.click(screen.getByRole("button", { name: "Open SSH" }));
  fireEvent.click(screen.getByRole("tab", { name: "Topolograph" }));
  fireEvent.click(screen.getByRole("tab", { name: "Neighbors" }));
  select("r1");
  expect(screen.getByRole("button", { name: "Open SSH" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Open SSH" }));
  expect(ssh).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  expect(screen.getByRole("button", { name: "Open SSH" })).toBeEnabled();
});

it("uses the saved reference rather than an advertised management IP", async () => {
  useTopologyStore.setState({ nodes: [{ ...node("switch.example.test"), mgmt_ip: "192.0.2.1" }] });
  const ssh = vi.fn().mockResolvedValue(undefined);
  render(<TopologyTab tabId="phase2" onOpenSshTab={ssh} />);
  select("switch.example.test");
  fireEvent.click(screen.getByRole("button", { name: "Open SSH" }));
  await waitFor(() => expect(ssh).toHaveBeenCalledWith("switch.example.test"));
});

it("focuses only anchor-incident links, not links between its peers", () => {
  useTopologyStore.setState({ edges: [edge("r1", "r2", "a"), edge("r1", "r3", "b"), edge("r2", "r3", "c")] });
  render(<TopologyTab tabId="phase2" />);
  select("r1");
  fireEvent.click(screen.getByRole("button", { name: "Focus neighborhood" }));
  expect(flow.nodes).toHaveLength(3);
  expect(flow.edges).toHaveLength(2);
  expect(flow.edges!.every((item) => item.source === "r1" || item.target === "r1")).toBe(true);
});

it("exports the complete filter result even while one-hop focus narrows the canvas", async () => {
  useTopologyStore.setState({ snapshotGraph: { id: GLOBAL_GRAPH_ID, name: "Global", created_at: 1, updated_at: 2 } });
  const save = vi.spyOn(TopologyExport, "saveJson").mockResolvedValue(false);
  try {
    render(<TopologyTab tabId="phase3-focus" />);
    select("r1");
    fireEvent.click(screen.getByRole("button", { name: "Focus neighborhood" }));
    expect(flow.nodes).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].nodes).toHaveLength(4);
    expect(save.mock.calls[0][0].edges).toHaveLength(3);
  } finally { save.mockRestore(); }
});

it("returns keyboard focus to the selected node after closing the inspector", () => {
  render(<TopologyTab tabId="phase2" />);
  select("r1");
  expect(screen.getByRole("button", { name: "Close inspector" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
  expect(screen.getByTestId("node-r1")).toHaveFocus();
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactFlowProps } from "@xyflow/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@xyflow/react", async (original) => ({
  ...await original<typeof import("@xyflow/react")>(),
  ReactFlow: (props: ReactFlowProps) => <div>{props.nodes?.map((node) => <button key={node.id} onClick={() => (node.data.onActivate as () => void)()}>{String(node.data.label)}</button>)}</div>,
}));
import { TopologyTab } from "./TopologyTab";
import { useTopologyStore } from "../../state/topologyStore";
import { TopologyExport } from "../../lib/topologyExport";
import type { CaptureEvidence, TopologyNode } from "../../lib/topology";

const evidence = (status: CaptureEvidence["status"] = "completed"): CaptureEvidence => ({
  source_ref: "source", protocol: "ospf", source_command: "show ip ospf neighbor", attempted_at: 1_700_000_100, status,
  observations: [true, false].map((in_latest_capture, i) => ({ captured_at: 1_700_000_000 - i * 100, in_latest_capture,
    record: { protocol: "ospf", local_port: "GigabitEthernet1", neighbor_name: i ? "peer-alias.example" : "peer-original.example", neighbor_port: "", neighbor_mgmt_ip: null, neighbor_platform: null, neighbor_vendor: null, capabilities: [],
      routing: { state: i ? "INIT" : "FULL/DR", established: !i, peer_address: "192.0.2.2", vrf: "blue", address_family: "ipv4", instance: "10", level: null, scope_supported: true },
    },
  })),
});
const sourceNode: TopologyNode = { graph_id: "lab", device_ref: "source", device_kind: "ssh", label: "Source" };

const initial = useTopologyStore.getState();
const graph = { id: "lab", name: "Lab", created_at: 1, updated_at: 2 };
const start = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  invokeMock.mockReset(); start.mockClear();
  invokeMock.mockImplementation(async (command) => command === "ssh_list_connections" ? [{ id: "seed", name: "Seed", host: "192.0.2.1", vendor: "cisco", platform: "iosxe", password_encrypted: null }] : null);
  useTopologyStore.setState({ ...initial, currentGraphId: "lab", graphs: [graph], snapshotGraph: graph,
    loadGraphs: async () => {}, refresh: async () => {}, refreshDiscovery: async () => {}, startDiscovery: start,
  });
});
afterEach(cleanup);

it("collapses collection and observation details while keeping status, history and actions available", () => {
  useTopologyStore.setState({ nodes: [sourceNode], captureEvidence: [evidence("failed")] });
  render(<TopologyTab tabId="inspector-disclosure" />);
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  const inspector = screen.getByTestId("topology-inspector");
  const summary = within(inspector).getByText(/Capture attempt: failed/).closest("summary")!;
  const capture = summary.parentElement!;
  expect(summary).toHaveTextContent("ospf");
  expect(summary).toHaveTextContent("2 observations");
  expect(summary).toHaveTextContent("historical/unconfirmed");
  expect(capture).not.toHaveAttribute("open");
  expect(within(inspector).getByRole("button", { name: "Close inspector" })).toHaveFocus();
  expect(within(inspector).getByRole("button", { name: "Open SSH" })).toBeVisible();
  expect(within(inspector).getByText("Reachability unverified")).toBeVisible();

  fireEvent.click(summary);
  expect(capture).toHaveAttribute("open");
  const peer = within(capture).getByText("peer-original.example").closest("summary")!;
  expect(peer).toHaveTextContent("Historical/unconfirmed");
  expect(peer.parentElement).not.toHaveAttribute("open");
  fireEvent.click(peer);
  expect(peer.parentElement).toHaveAttribute("open");
  expect(within(capture).getByText("Routing state: FULL/DR", { exact: false })).toBeVisible();
  expect(within(capture).getAllByText("VRF: blue", { exact: false })[0]).toBeVisible();
  fireEvent.click(summary);
  expect(capture).not.toHaveAttribute("open");
  expect(within(inspector).getByRole("button", { name: "Open SSH" })).toBeVisible();
});

it("collapses large neighbor groups and each edge without discarding unknown provenance", () => {
  useTopologyStore.setState({ nodes: [sourceNode, ...Array.from({ length: 200 }, (_, i) => ({ ...sourceNode, device_ref: `peer-${i}`, label: `Peer ${i}` }))], edges: Array.from({ length: 200 }, (_, i) => ({
    graph_id: "lab", a_device_ref: "source", a_port: `Gi${i}`, b_device_ref: `peer-${i}`, b_port: "Gi1", protocol: "lldp", captured_at: 1_700_000_000,
  })) });
  render(<TopologyTab tabId="inspector-neighbor-disclosure" />);
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  const inspector = screen.getByTestId("topology-inspector");
  const summary = within(inspector).getByText("lldp (200)").closest("summary")!;
  expect(summary.parentElement).not.toHaveAttribute("open");
  fireEvent.click(summary);
  expect(summary.parentElement).toHaveAttribute("open");
  const peer = within(summary.parentElement!).getByText("peer-199").closest("summary")!;
  expect(peer.parentElement).not.toHaveAttribute("open");
  fireEvent.click(peer);
  expect(peer.parentElement).toHaveAttribute("open");
  expect(within(peer.parentElement!).getByText("Source/freshness not recorded on this graph edge.")).toBeVisible();
  expect(within(peer.parentElement!).getByText(/L2 observation/)).toBeVisible();
});

it("shows source-owned original observations, routing scope and per-observation freshness rather than edge direction", async () => {
  const captures = [evidence(), { ...evidence(), source_ref: "elsewhere", source_command: "not from this node" }];
  useTopologyStore.setState({ nodes: [sourceNode, { ...sourceNode, device_ref: "peer", label: "Peer" }], captureEvidence: captures,
    edges: [{ graph_id: "lab", a_device_ref: "peer", a_port: "", b_device_ref: "source", b_port: "GigabitEthernet1", protocol: "ospf", captured_at: 1_700_000_000 }],
  });
  render(<TopologyTab tabId="phase5" />);
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  const inspector = screen.getByTestId("topology-inspector");
  expect(inspector).toHaveTextContent("show ip ospf neighbor");
  expect(inspector).not.toHaveTextContent("not from this node");
  expect(inspector).toHaveTextContent("peer-original.example");
  expect(inspector).toHaveTextContent("peer-alias.example");
  expect(inspector).toHaveTextContent("FULL/DR");
  expect(inspector).toHaveTextContent("INIT");
  expect(inspector).toHaveTextContent("Peer address (not management)");
  expect(inspector).toHaveTextContent("192.0.2.2");
  expect(inspector).toHaveTextContent("VRF: blue");
  expect(inspector).toHaveTextContent("Address family: ipv4");
  expect(inspector).toHaveTextContent("Instance: 10");
  expect(inspector).toHaveTextContent("Level: Unknown");
  expect(inspector).toHaveTextContent("Reported local interface (not physical attachment)");
  expect(within(inspector).getAllByText("Observed in latest capture — reachability unverified")).toHaveLength(1);
  expect(inspector).toHaveTextContent("Not observed in latest capture — historical/unconfirmed");
  expect(inspector).toHaveTextContent("Capture attempt: completed");
  expect(inspector.querySelector('time[datetime="2023-11-14T22:15:00.000Z"]')).not.toBeNull();
  expect(inspector.querySelector('time[datetime="2023-11-14T22:13:20.000Z"]')).not.toBeNull();
  await act(async () => useTopologyStore.setState({ captureEvidence: [evidence("failed")] }));
  expect(within(inspector).queryByText("Observed in latest capture — reachability unverified")).not.toBeInTheDocument();
  expect(inspector).toHaveTextContent("Historical/unconfirmed — latest capture not completed");
});

it.each(["incomplete", "failed", "unsupported"] as const)("never calls %s captures latest evidence even when retained rows have a latest flag", (status) => {
  const capture = evidence(status);
  capture.protocol = "isis";
  capture.source_command = "show isis neighbors";
  capture.observations[0].record.protocol = "isis";
  capture.observations[0].record.routing = { ...capture.observations[0].record.routing!, state: "Up", level: "L2" };
  useTopologyStore.setState({ nodes: [sourceNode], captureEvidence: [capture] });
  render(<TopologyTab tabId="phase5" />);
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  const inspector = screen.getByTestId("topology-inspector");
  expect(inspector).toHaveTextContent(`Capture attempt: ${status}`);
  expect(inspector).toHaveTextContent("Routing state: Up");
  expect(inspector).toHaveTextContent("Level: L2");
  expect(within(inspector).queryByText("Observed in latest capture — reachability unverified")).not.toBeInTheDocument();
  expect(inspector).toHaveTextContent("Historical/unconfirmed — latest capture not completed");
});

it("shows collected EIGRP peer, AS and local interface as logical routing evidence", () => {
  const capture = evidence();
  capture.protocol = "eigrp";
  capture.source_command = "show ip eigrp neighbors";
  capture.observations = [capture.observations[0]];
  const row = capture.observations[0].record;
  row.protocol = "eigrp";
  row.routing = { ...row.routing!, state: "up", vrf: "default", address_family: "ipv4 unicast", instance: "100" };
  useTopologyStore.setState({ nodes: [sourceNode], captureEvidence: [capture] });
  render(<TopologyTab tabId="eigrp-evidence" />);
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  const inspector = screen.getByTestId("topology-inspector");
  expect(inspector).toHaveTextContent("show ip eigrp neighbors");
  expect(inspector).toHaveTextContent("Routing state: up");
  expect(inspector).toHaveTextContent("Instance: 100");
  expect(inspector).toHaveTextContent("VRF: default");
  expect(inspector).toHaveTextContent("Peer address (not management)");
  expect(inspector).toHaveTextContent("192.0.2.2");
  expect(inspector).toHaveTextContent("Reported local interface (not physical attachment)");
  expect(inspector).toHaveTextContent("GigabitEthernet1");
});

it("keeps legacy source/freshness unknown and does not offer logical routing identifiers as management targets", () => {
  const ref = "routing:" + "a".repeat(64);
  useTopologyStore.setState({ nodes: [{ ...sourceNode, device_ref: ref, label: "Logical peer", device_kind: "discovered" }, { ...sourceNode, device_ref: "elsewhere", label: "Elsewhere" }],
    edges: [{ graph_id: "lab", a_device_ref: "elsewhere", a_port: "", b_device_ref: ref, b_port: "peer:192.0.2.2", protocol: "bgp", captured_at: 0 }],
  });
  render(<TopologyTab tabId="phase5" />);
  fireEvent.click(screen.getByRole("button", { name: "Logical peer" }));
  const inspector = screen.getByTestId("topology-inspector");
  expect(inspector).toHaveTextContent("Source/freshness not recorded on this graph edge");
  expect(inspector).toHaveTextContent("Routing state/scope unknown");
  expect(inspector).toHaveTextContent("Logical routing identifier — not a management target");
  expect(within(inspector).queryByRole("button", { name: "Open or save neighbor" })).not.toBeInTheDocument();
  expect(within(inspector).queryByRole("button", { name: "Open SSH" })).not.toBeInTheDocument();
});

it("shows the local-evidence export limitation and supplies a typed evidence-bearing snapshot to the export boundary", async () => {
  useTopologyStore.setState({ nodes: [sourceNode], captureEvidence: [evidence()] });
  const save = vi.spyOn(TopologyExport, "saveJson").mockResolvedValue(false);
  try {
    render(<TopologyTab tabId="phase5" />);
    expect(screen.getByText(/Collection source\/freshness stays local; exports contain graph observations/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].capture_evidence).toEqual([evidence()]);
  } finally { save.mockRestore(); }
});

it("opts into routing without changing depth, resets it and passwords on reopen, and retains keyboard trapping", async () => {
  render(<TopologyTab tabId="phase5" />);
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  let dialog = await screen.findByRole("dialog", { name: "Discover topology" });
  await waitFor(() => expect(within(dialog).getByTestId("discovery-device-seed")).toBeInTheDocument());
  const routing = within(dialog).getByRole("checkbox", { name: "Include routing observations (BGP/OSPF/IS-IS/EIGRP)" });
  expect(routing).not.toBeChecked();
  expect(dialog).toHaveTextContent("EIGRP collects IPv4 neighbors in the default VRF, not routes or the EIGRP topology table.");
  expect(dialog).toHaveTextContent("address-to-interface proof");
  fireEvent.click(routing);
  fireEvent.click(within(dialog).getByTestId("discovery-device-seed").querySelector("input")!);
  fireEvent.change(within(dialog).getByLabelText("Password for Seed"), { target: { value: "synthetic-only" } });
  const submit = within(dialog).getByRole("button", { name: "Discover (1)" });
  submit.focus(); fireEvent.keyDown(submit, { key: "Tab" });
  expect(within(dialog).getByTitle("Close")).toHaveFocus();
  fireEvent.click(submit);
  expect(start).toHaveBeenCalledWith({ graph_id: "lab", seed_ids: ["seed"], eligible_ids: ["seed"], passwords: { seed: "synthetic-only" }, max_depth: 0, include_routing: true });
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  dialog = await screen.findByRole("dialog", { name: "Discover topology" });
  await waitFor(() => expect(within(dialog).getByTestId("discovery-device-seed")).toBeInTheDocument());
  expect(within(dialog).getByRole("checkbox", { name: "Include routing observations (BGP/OSPF/IS-IS/EIGRP)" })).not.toBeChecked();
  fireEvent.click(within(dialog).getByTestId("discovery-device-seed").querySelector("input")!);
  expect(within(dialog).getByLabelText("Password for Seed")).toHaveValue("");
  fireEvent.change(within(dialog).getByLabelText("Password for Seed"), { target: { value: "synthetic-new" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Discover (1)" }));
  expect(start.mock.calls[1][0]).toMatchObject({ include_routing: false, max_depth: 0 });
});

it("selects explicit matching SNMP metadata without revealing values or sending SSH passwords", async () => {
  const oldMock = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "vault_unlocked_ids") return ["unlocked"];
    if (command === "vault_list_secrets") return [
      { id: "v3", label: "Synthetic v3", kind: "snmp_community", metadata: { format: "topology-snmp-v1", version: "3" } },
      { id: "v2", label: "Synthetic v2", kind: "snmp_community", metadata: { format: "topology-snmp-v1", version: "2c" } },
      { id: "legacy", label: "Legacy community", kind: "snmp_community", metadata: {} },
    ];
    return oldMock(command, args);
  });
  render(<TopologyTab tabId="snmp" />);
  fireEvent.click(screen.getByRole("button", { name: "Discover devices" }));
  const dialog = await screen.findByRole("dialog", { name: "Discover topology" });
  await waitFor(() => expect(within(dialog).getByTestId("discovery-device-seed")).toBeInTheDocument());
  fireEvent.click(within(dialog).getByTestId("discovery-device-seed").querySelector("input")!);
  fireEvent.change(within(dialog).getByLabelText("Password for Seed"), { target: { value: "synthetic-password" } });
  fireEvent.change(within(dialog).getByLabelText("Collection method"), { target: { value: "snmp_v3" } });
  await within(dialog).findByRole("option", { name: "Synthetic v3" });
  expect(within(dialog).queryByRole("option", { name: "Legacy community" })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("option", { name: "Synthetic v2" })).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Password for Seed")).not.toBeInTheDocument();
  expect(within(dialog).getByRole("checkbox", { name: "Include routing observations (BGP/OSPF/IS-IS/EIGRP)" })).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Unlocked SNMP profile"), { target: { value: "v3" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Discover (1)" }));
  expect(start).toHaveBeenCalledWith({ graph_id: "lab", seed_ids: ["seed"], eligible_ids: ["seed"], passwords: {}, max_depth: 0, include_routing: false, collection_mode: "snmp_v3", snmp_secret_id: "v3" });
  expect(invokeMock.mock.calls.some(([command]) => command === "vault_reveal_secret")).toBe(false);
});

it("shows unresolved SNMP provenance on failed captures and keeps subnet evidence explicitly unverified", () => {
  const routing = evidence();
  routing.observations[0].record.routing!.interface_association = { interface: "Gi1", local_address: "192.0.2.1", prefix_length: 30, source_command: "show ip interface", relationship: "same_subnet_unverified" };
  const snmp: CaptureEvidence = { source_ref: "source", protocol: "lldp", source_command: "snmp:lldp", attempted_at: 1_700_000_100, status: "failed", observations: [], snmp_observations: [{ captured_at: 1_700_000_100, in_latest_attempt: true, index: [1, 9, 2], neighbor_name: "SNMP peer", local_port_id: "9", local_port_description: "opaque", remote_port_id: "Gi2", remote_port_description: "remote", remote_port_subtype: 5, local_ifindex: null, mapping: null, reason: "unresolved_local_port", management_addresses: ["192.0.2.9"], management_indexes: [[1, 9, 2, 1, 4, 192, 0, 2, 9]] }] };
  snmp.snmp_observations!.push({ ...snmp.snmp_observations![0], neighbor_name: "Earlier SNMP peer", captured_at: 1_700_000_000, in_latest_attempt: false });
  useTopologyStore.setState({ nodes: [sourceNode], captureEvidence: [routing, snmp] });
  render(<TopologyTab tabId="evidence" />);
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  const inspector = screen.getByTestId("topology-inspector");
  expect(inspector).toHaveTextContent("Subnet-supported interface: Gi1");
  expect(inspector).toHaveTextContent("Same subnet only — direct session and physical attachment unverified");
  expect(inspector).toHaveTextContent("Subnet-supported interface: Unknown");
  expect(inspector).toHaveTextContent("snmp:lldp");
  const snmpCapture = within(inspector).getByText(/Capture attempt: failed/).closest("summary")!;
  expect(snmpCapture).toHaveTextContent("2 SNMP rows");
  expect(snmpCapture).toHaveTextContent("historical/unconfirmed");
  fireEvent.click(snmpCapture);
  const provenance = within(inspector).getByText("SNMP table provenance (2)");
  expect(provenance.parentElement).not.toHaveAttribute("open");
  fireEvent.click(provenance);
  expect(provenance.parentElement).toHaveAttribute("open");
  const row = within(inspector).getByText("SNMP peer").closest("summary")!;
  expect(row.parentElement).not.toHaveAttribute("open");
  fireEvent.click(row);
  expect(row.parentElement).toHaveAttribute("open");
  expect(within(inspector).getByText("Returned in latest attempt — table evidence only")).toBeVisible();
  expect(within(inspector).getByText("Retained from earlier attempt — historical/unconfirmed")).toBeVisible();
  expect(inspector).not.toHaveTextContent("No retained observations");
  expect(inspector).toHaveTextContent("unresolved_local_port");
  expect(inspector).toHaveTextContent("Table index: 1.9.2");
  expect(inspector).toHaveTextContent("Unresolved rows do not create graph links");
});

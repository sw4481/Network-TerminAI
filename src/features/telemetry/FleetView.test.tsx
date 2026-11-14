import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FleetView } from "./FleetView";
import {
  dashboardFixture,
  definition,
  page,
  row,
  bundledFixture,
} from "./dashboard.test-support";
import { telemetryApi } from "./api";
import { telemetryWorkspaces } from "./store";
import { sampleTime } from "./WidgetPanel";
afterEach(() => vi.restoreAllMocks());
it("aggregates routing rows only within each successful source across responding targets", async () => {
  const a = page("bgp_peers", [row("a", { state: "Established" })]);
  const b = page("bgp_peers", [
    row("b", { state: "Established" }),
    row("c", { state: "Idle" }),
  ]);
  b.metadata.target_id = "device-1";
  const { snap } = bundledFixture(["bgp_peers"], [a, b]);
  snap.targets = snap.targets.slice(0, 2);
  vi.mocked(telemetryWorkspaces.widget).mockImplementation(async (q) => ({
    workspace_id: "test",
    generation: 1,
    sequence: 1,
    revision: "source",
    value: q.target_id === "device-0" ? a : b,
  }));
  const view = render(
    <FleetView snapshot={snap} api={telemetryApi} workspaceId="test" />,
  );
  const routing = screen.getByRole("region", {
    name: "Fleet routing coverage",
  });
  expect(
    await within(routing).findByText("Established: 2, Idle: 1"),
  ).toBeVisible();
  expect(within(routing).getByText(/2 \/ 2 current targets/)).toBeVisible();
  view.rerender(
    <FleetView
      snapshot={{ ...snap, generation: 2, widgets: [] }}
      api={telemetryApi}
      workspaceId="test"
    />,
  );
  expect(
    within(routing).queryByText("Established: 2, Idle: 1"),
  ).not.toBeInTheDocument();
  expect(
    within(routing).getByText(/BGP peers: 0 \/ 2 current targets/),
  ).toBeVisible();
});
it("keeps stale CPU and failed memory visible with their own times and source coverage on a fresh target", async () => {
  const cpu = page("cpu"),
    memory = page("memory", []),
    ports = page("port_status", [
      row("p", { interface: "Gi0/1", status: "connected" }),
    ]);
  cpu.metadata.state = "stale";
  cpu.metadata.severity = "info";
  ports.metadata.severity = "info";
  cpu.metadata.observed_at_ms = 1699999000000;
  memory.metadata.state = "failed";
  memory.metadata.severity = "info";
  memory.metadata.last_success_at_ms = null;
  memory.metadata.diagnostics = [
    {
      code: "parse",
      message: "Memory parser rejected output",
      path: "",
      line: null,
      column: null,
    },
  ];
  const { snap } = bundledFixture(
    ["cpu", "memory", "port_status"],
    [cpu, memory, ports],
  );
  snap.targets = [snap.targets[0]];
  render(<FleetView snapshot={snap} api={telemetryApi} workspaceId="test" />);
  const table = screen.getByRole("table", { name: "Monitored devices" });
  const cpuCell = (await within(table).findByText("4 %")).closest("td")!;
  expect(within(cpuCell).getByText("Stale")).toBeVisible();
  expect(
    within(cpuCell).getByText(sampleTime(cpu.metadata.observed_at_ms)),
  ).toBeVisible();
  expect(
    within(table).getByText(/Memory parser rejected output/),
  ).toBeVisible();
  expect(screen.getByText("CPU current coverage: 0 / 1")).toBeVisible();
  expect(
    screen.getByText("Processor Pool current coverage: 0 / 1"),
  ).toBeVisible();
  expect(
    screen.getByText("Collection gaps").querySelector("strong"),
  ).toHaveTextContent("1");
  expect(
    within(table).queryByText("No attention observed"),
  ).not.toBeInTheDocument();
});
it("presents platform, observed-up ports, routing coverage, actual Local metrics and selected traffic", async () => {
  const pages = [
    page("port_status", [
      row("a", { interface: "Gi0/1", status: "connected" }),
      row("b", { interface: "Gi0/2", status: "notconnect" }),
    ]),
    page("interfaces", [
      row("a", { interface: "Gi0/1", link_state: "up", protocol_state: "up" }),
    ]),
    page("interface_traffic", [
      row("traffic", {
        interface: "Gi0/1",
        input_bit_s: 800,
        output_bit_s: null,
      }),
    ]),
    page("bgp_peers", [
      row("peer", { state: "Established", neighbor: "10.0.0.2" }),
    ]),
    page("ospf_neighbors", []),
    page("local_cpu", [
      row("total", { core: "total", usage: 17 }),
      row("core-0", { core: "0", usage: 80 }),
    ]),
    page("local_memory", [row("mem", { used_bytes: 250, total_bytes: 1000 })]),
  ];
  pages
    .filter((p) => p.metadata.widget_id.startsWith("local_"))
    .forEach((p) => (p.metadata.target_id = "local"));
  pages.find((p) => p.metadata.widget_id === "ospf_neighbors")!.metadata.state =
    "failed";
  const { snap } = bundledFixture(
    pages.map((p) => p.metadata.widget_id),
    pages,
  );
  snap.targets = [
    snap.targets[0],
    {
      ...snap.targets[0],
      target_id: "local",
      display_name: "Local PC",
      platform: null,
    },
  ];
  snap.series = [
    {
      target_id: "device-0",
      widget_id: "interface_traffic",
      row_key: "traffic",
      field: "input_bit_s",
      unit: "bit/s",
      point_count: 2,
    },
  ];
  vi.mocked(telemetryWorkspaces.series).mockResolvedValue({
    workspace_id: "test",
    generation: 1,
    sequence: 1,
    revision: "source",
    value: {
      points: [
        { at_ms: 1, value: 800, reason: null },
        { at_ms: 2, value: null, reason: "collection_gap" },
      ],
      next_after_ms: null,
    },
  });
  render(<FleetView snapshot={snap} api={telemetryApi} workspaceId="test" />);
  expect(await screen.findByText("IOSXE")).toBeVisible();
  expect(await screen.findByText(/1 up \/ 2 observed/)).toBeVisible();
  const routing = screen.getByRole("region", {
    name: "Fleet routing coverage",
  });
  expect(
    await within(routing).findByText(/BGP summary.*1 \/ 1 current targets/),
  ).toBeVisible();
  expect(
    within(routing).getByText(/OSPF neighbors.*0 \/ 1 current targets/),
  ).toBeVisible();
  const local = screen.getByRole("region", { name: "Local PC summary" });
  expect(await within(local).findByText("17 %")).toBeVisible();
  expect(within(local).getByText("250 B / 1000 B")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Interface detail target"), {
    target: { value: "device-0" },
  });
  await screen.findByRole("option", { name: "Gi0/1" });
  fireEvent.change(await screen.findByLabelText("Traffic interface"), {
    target: { value: "Gi0/1" },
  });
  expect(await screen.findByText(/input_bit_s.*bit\/s/)).toBeVisible();
  expect(
    screen.queryByRole("navigation", { name: "Device sections" }),
  ).not.toBeInTheDocument();
});
it("fleet_separates_condition_from_collection_failure", async () => {
  const d = definition(),
    p = page("cpu", [
      row("1", { cpu_5s_percent: 4 }),
      row("2", { cpu_5s_percent: 4 }),
    ]);
  const { snap } = dashboardFixture([d], [p]);
  snap.targets.push({
    ...snap.targets[0],
    target_id: "authoring",
    display_name: "Editor only",
    monitoring_selected: false,
  });
  render(<FleetView snapshot={snap} api={telemetryApi} workspaceId="test" />);
  const table = screen.getByRole("table", { name: "Monitored devices" });
  expect(within(table).getAllByRole("row")).toHaveLength(11);
  expect(screen.queryByText("Editor only")).not.toBeInTheDocument();
  expect(await screen.findByText("4 %")).toBeVisible();
  expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  expect(screen.getByText("Collection gaps")).toBeVisible();
  expect(screen.queryByText("Device down")).not.toBeInTheDocument();
});

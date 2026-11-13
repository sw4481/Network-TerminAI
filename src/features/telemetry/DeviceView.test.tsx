import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceView } from "./DeviceView";
import {
  dashboardFixture,
  definition,
  page,
  row,
  bundledFixture,
} from "./dashboard.test-support";
import { telemetryApi } from "./api";
import { telemetryWorkspaces } from "./store";
import { useDashboard } from "./useDashboard";
it("revokes a selected interface monitor action when the current source becomes incompatible", async () => {
  const d = {
    ...definition("interfaces"),
    view: {
      type: "table" as const,
      columns: [{ field: "interface", label: "Interface" }],
    },
  };
  const p = page("interfaces", [row("same", { interface: "Gi0/1" })]);
  const { snap, catalog } = dashboardFixture([d], [p]);
  const view = render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
      onMonitorInterfaces={vi.fn()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Select interface Gi0/1" }),
  );
  expect(
    await screen.findByRole("button", { name: "Monitor selected interface" }),
  ).toBeVisible();
  catalog.effective = {
    ...catalog.effective,
    revision: "custom",
    widgets: [{ ...d, fields: { interface: ["unrelated"] } }],
  };
  p.metadata.revision = "custom";
  view.rerender(
    <DeviceView
      snapshot={{ ...snap, generation: 2 }}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
      onMonitorInterfaces={vi.fn()}
    />,
  );
  await screen.findByText("Gi0/1");
  expect(
    screen.queryByRole("button", { name: "Monitor selected interface" }),
  ).not.toBeInTheDocument();
});
it("Overview preserves a successful empty interface inventory as an observed zero", async () => {
  const { snap } = bundledFixture(["interfaces"], [page("interfaces", [])]);
  render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(await screen.findByText(/0 observed interfaces/)).toBeVisible();
});
it("keeps Overview unavailable and empty traffic states explicit without inventing histories", async () => {
  const { snap } = bundledFixture(
    ["interfaces", "interface_traffic"],
    [
      page("interfaces", [
        row("port", { interface: "Gi0/1", link_state: "up" }),
      ]),
      page("interface_traffic", []),
    ],
  );
  const view = render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  await screen.findByText(/1 observed interfaces/);
  fireEvent.change(screen.getByLabelText("Traffic interface"), {
    target: { value: "Gi0/1" },
  });
  expect(
    screen.getByText("No declared retained traffic history available."),
  ).toBeVisible();
  expect(
    screen.getByText(
      "No unambiguous traffic observation for this exact interface.",
    ),
  ).toBeVisible();
  expect(telemetryWorkspaces.series).not.toHaveBeenCalled();
  view.rerender(
    <DeviceView
      snapshot={{ ...snap, widgets: [] }}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(
    await screen.findByText("Compatible interface inventory is unavailable."),
  ).toBeVisible();
});
it("Overview supplements its configured widgets with compatible interface inventory and declared uplink history", async () => {
  const { snap } = bundledFixture(
    ["interfaces", "interface_traffic"],
    [
      page("interfaces", [
        row("port", {
          interface: "Gi0/1",
          link_state: "up",
          protocol_state: "up",
        }),
      ]),
      page("interface_traffic", [
        row("traffic", {
          interface: "Gi0/1",
          input_bit_s: 80,
          output_bit_s: 40,
        }),
      ]),
    ],
  );
  snap.series = [
    {
      target_id: "device-0",
      widget_id: "interface_traffic",
      row_key: "traffic",
      field: "input_bit_s",
      unit: "bit/s",
      point_count: 1,
    },
  ];
  render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(await screen.findByText(/1 observed interfaces/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Traffic interface"), {
    target: { value: "Gi0/1" },
  });
  expect(await screen.findByText(/input_bit_s.*bit\/s/)).toBeVisible();
});
it("expires stopped retained histories when series summaries shrink and disappear without a widget change", async () => {
  const d = {
    ...definition(),
    history: { fields: ["cpu_5s_percent", "cpu_1m_percent"] },
  };
  const p = page();
  p.metadata.state = "stopped";
  const { snap } = dashboardFixture([d], [p]);
  snap.running = false;
  snap.series = [
    {
      target_id: "device-0",
      widget_id: "cpu",
      row_key: "1",
      field: "cpu_5s_percent",
      unit: "%",
      point_count: 2,
    },
  ];
  snap.series.push({ ...snap.series[0], field: "cpu_1m_percent" });
  vi.mocked(telemetryWorkspaces.series).mockResolvedValue({
    workspace_id: "test",
    generation: 1,
    sequence: 1,
    revision: "source",
    value: {
      points: [
        { at_ms: 1, value: 4, reason: null },
        { at_ms: 2, value: 5, reason: null },
      ],
      next_after_ms: null,
    },
  });
  const view = renderHook(
    ({ snapshot }) =>
      useDashboard(
        { snapshot, api: telemetryApi, workspaceId: "test" },
        "device-0",
        "detail",
      ),
    { initialProps: { snapshot: snap } },
  );
  await waitFor(() =>
    expect(
      view.result.current.series.find(
        (s) => s.summary.field === "cpu_5s_percent",
      )?.series.points,
    ).toHaveLength(2),
  );
  vi.setSystemTime(new Date(1700003600000));
  vi.mocked(telemetryWorkspaces.series).mockResolvedValue({
    workspace_id: "test",
    generation: 1,
    sequence: 1,
    revision: "source",
    value: {
      points: [{ at_ms: 2, value: 5, reason: null }],
      next_after_ms: null,
    },
  });
  view.rerender({
    snapshot: {
      ...snap,
      sequence: 2,
      series: [{ ...snap.series[0], point_count: 1 }, snap.series[1]],
    },
  });
  await waitFor(() =>
    expect(
      view.result.current.series.find(
        (s) => s.summary.field === "cpu_5s_percent",
      )?.series.points,
    ).toHaveLength(1),
  );
  expect(telemetryWorkspaces.series).toHaveBeenCalledTimes(3);
  expect(
    view.result.current.series.find((s) => s.summary.field === "cpu_1m_percent")
      ?.series.points,
  ).toHaveLength(2);
  view.rerender({ snapshot: { ...snap, sequence: 3, series: [] } });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.series).toEqual([]);
  expect(view.result.current.widgets[0]?.page.rows).toHaveLength(1);
  expect(telemetryWorkspaces.widget).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
it("does not promote incompatible previous-source rows to interface inventory when an ID is restored", async () => {
  const { snap, catalog } = bundledFixture(
    ["interfaces"],
    [page("interfaces", [row("one", { interface: "unrelated object" })])],
  );
  const builtin = catalog.builtin.widgets.interfaces;
  const original = {
    ...builtin,
    source: {
      kind: "ssh" as const,
      commands: { iosxe: "show unrelated objects" },
      templates: { iosxe: "custom.objects" },
    },
    fields: { interface: ["unrelated_label"] },
    view: {
      type: "table" as const,
      columns: [{ field: "interface", label: "Original label" }],
    },
  };
  catalog.effective = {
    ...catalog.effective,
    widgets: [original],
    templates: {
      ...catalog.effective.templates,
      "custom.objects": {
        id: "custom.objects",
        platform: "iosxe",
        command: "show unrelated objects",
        text: "",
        sha256: "custom",
      },
    },
  };
  catalog.effective.layouts[0].sections[0].rows = [
    [{ widget: "interfaces", span: 12 }],
  ];
  const view = render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
      onMonitorInterfaces={vi.fn()}
    />,
  );
  await screen.findByText("unrelated object");
  catalog.effective = {
    ...catalog.effective,
    revision: "restored",
    widgets: [builtin],
  };
  view.rerender(
    <DeviceView
      snapshot={{ ...snap, generation: 2 }}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
      onMonitorInterfaces={vi.fn()}
    />,
  );
  await screen.findByText(/Previous source observation/);
  expect(
    screen.queryByRole("button", { name: /Select interface/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/1 observed interfaces/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Monitor selected interface" }),
  ).not.toBeInTheDocument();
});
afterEach(() => vi.restoreAllMocks());
it("keeps cached previous-source tables without interpreting current histories under that definition", async () => {
  const d = { ...definition(), history: { fields: ["cpu_5s_percent"] } };
  const { snap, catalog } = dashboardFixture([d], [page()]);
  snap.series = [
    {
      target_id: "device-0",
      widget_id: "cpu",
      row_key: "1",
      field: "cpu_5s_percent",
      unit: "%",
      point_count: 1,
    },
  ];
  const view = render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  await screen.findByText("4");
  vi.mocked(telemetryWorkspaces.series).mockClear();
  catalog.effective = { ...catalog.effective, revision: "changed" };
  view.rerender(
    <DeviceView
      snapshot={{ ...snap, generation: 2 }}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(
    await screen.findByText(
      "Previous source observation; showing its original definition.",
    ),
  ).toBeVisible();
  expect(telemetryWorkspaces.series).not.toHaveBeenCalled();
});
it("reads a repeated effective layout widget once so its read key cannot cancel itself", async () => {
  const d = definition();
  const { snap } = dashboardFixture(
    [d],
    [page()],
    [
      {
        id: "overview",
        title: "Overview",
        rows: [
          [
            { widget: "cpu", span: 6 },
            { widget: "cpu", span: 6 },
          ],
        ],
      },
    ],
  );
  render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(await screen.findAllByText("4")).toHaveLength(2);
  expect(telemetryWorkspaces.widget).toHaveBeenCalledTimes(1);
});
it("device_keeps_protocol_and_vrf_context", async () => {
  const d = {
    ...definition("routing"),
    title: "OSPF neighbors",
    view: {
      type: "table" as const,
      columns: [
        { field: "vrf", label: "VRF" },
        { field: "state", label: "State" },
      ],
    },
  };
  const { snap } = dashboardFixture(
    [d],
    [page("routing", [row("1", { vrf: "CORP", state: "2-Way" })])],
    [
      {
        id: "routing",
        title: "Routing",
        rows: [[{ widget: "routing", span: 12 }]],
      },
    ],
  );
  render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(await screen.findByText("CORP")).toBeVisible();
  expect(screen.getByText("2-Way")).toBeVisible();
  expect(screen.queryByText("default")).not.toBeInTheDocument();
});
it("port_layout_comes_from_inventory", async () => {
  const d = {
    ...definition("interfaces"),
    key: ["interface"],
    view: {
      type: "table" as const,
      columns: [
        { field: "interface", label: "Interface" },
        { field: "input_errors", label: "Errors" },
      ],
    },
  };
  const { snap } = dashboardFixture(
    [d],
    [
      page(
        "interfaces",
        Array.from({ length: 24 }, (_, i) =>
          row(String(i), { interface: `Gi1/0/${i + 1}`, input_errors: null }),
        ),
      ),
    ],
    [
      {
        id: "interfaces",
        title: "Interfaces",
        rows: [[{ widget: "interfaces", span: 12 }]],
      },
    ],
  );
  const view = render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(
    await screen.findAllByRole("button", { name: /Select interface Gi/ }),
  ).toHaveLength(24);
  fireEvent.click(
    screen.getByRole("button", { name: "Select interface Gi1/0/24" }),
  );
  expect(screen.getByText("Selected interface: Gi1/0/24")).toBeVisible();
  view.rerender(
    <DeviceView
      snapshot={{ ...snap, widgets: [] }}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(await screen.findByText(/Gi1\/0\/24 is unavailable/)).toBeVisible();
});
it("retains STP Blocking as native informational condition and filters MAC list membership", async () => {
  const interfaces = {
    ...definition("interfaces"),
    key: ["interface"],
    view: {
      type: "table" as const,
      columns: [{ field: "interface", label: "Interface" }],
    },
  };
  const mac = {
    ...definition("mac_table"),
    fields: { interfaces: ["interfaces"], mac: ["mac"] },
    view: {
      type: "table" as const,
      columns: [
        { field: "mac", label: "MAC" },
        { field: "interfaces", label: "Interfaces" },
      ],
    },
  };
  const stp = {
    ...definition("stp_ports"),
    fields: { state: ["state"] },
    view: {
      type: "table" as const,
      columns: [{ field: "state", label: "State" }],
    },
  };
  const { snap } = dashboardFixture(
    [interfaces, mac, stp],
    [
      page("interfaces", [row("one", { interface: "Gi0/1" })]),
      page("mac_table", [
        row("m1", { mac: "aa:01", interfaces: '["Gi0/1"]' }),
        row("m2", { mac: "aa:10", interfaces: '["Gi0/10"]' }),
      ]),
      page("stp_ports", [row("stp", { state: "Blocking" })]),
    ],
  );
  render(
    <DeviceView
      snapshot={snap}
      api={telemetryApi}
      workspaceId="test"
      targetId="device-0"
    />,
  );
  expect(await screen.findByText("Blocking")).toBeVisible();
  expect(
    screen.getByText("Blocking").closest("[data-severity]"),
  ).toHaveAttribute("data-severity", "ok");
  fireEvent.click(
    screen.getByRole("button", { name: "Select interface Gi0/1" }),
  );
  expect(await screen.findByText("aa:01")).toBeVisible();
  expect(screen.queryByText("aa:10")).not.toBeInTheDocument();
});

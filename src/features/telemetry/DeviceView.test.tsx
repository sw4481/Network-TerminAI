import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceView } from "./DeviceView";
import {
  dashboardFixture,
  definition,
  page,
  row,
} from "./dashboard.test-support";
import { telemetryApi } from "./api";
import { telemetryWorkspaces } from "./store";
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

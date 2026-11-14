import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LocalPcView } from "./LocalPcView";
import {
  dashboardFixture,
  definition,
  page,
  row,
} from "./dashboard.test-support";
import { telemetryApi } from "./api";
import { telemetryWorkspaces } from "./store";
import type { WidgetPage } from "./types";
afterEach(() => vi.restoreAllMocks());
it("keeps Local tables, filters and charts mounted while a new observation is loading", async () => {
  const d = {
    ...definition("local_cpu"),
    source: { kind: "local" as const, collector: "local.cpu" as const },
    history: { fields: ["cpu_5s_percent"] },
  };
  const p = page(d.widget, [
    row("total", { label: "retained", cpu_5s_percent: 12 }),
  ]);
  p.metadata.target_id = "local";
  const { snap, catalog } = dashboardFixture([d], [p]);
  catalog.effective.layouts[0].platforms = [];
  snap.series = [
    {
      target_id: "local",
      widget_id: d.widget,
      row_key: "total",
      field: "cpu_5s_percent",
      unit: "%",
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
        { at_ms: 1, value: 12, reason: null },
        { at_ms: 2, value: 13, reason: null },
      ],
      next_after_ms: null,
    },
  });
  const view = render(
    <LocalPcView snapshot={snap} api={telemetryApi} workspaceId="test" />,
  );
  const table = await screen.findByRole("table", { name: d.title });
  await waitFor(() =>
    expect(
      screen.queryByText("Loading current observations…"),
    ).not.toBeInTheDocument(),
  );
  const chart = screen.getByRole("figure");
  const filter = screen.getByRole("searchbox", { name: `Filter ${d.title}` });
  fireEvent.change(filter, { target: { value: "retained" } });
  const scroll = table.closest<HTMLDivElement>(".telemetry-table-scroll")!;
  scroll.scrollTop = 75;
  const updated: WidgetPage = {
    ...p,
    metadata: {
      ...p.metadata,
      observed_at_ms: p.metadata.observed_at_ms! + 5000,
      last_success_at_ms: p.metadata.last_success_at_ms! + 5000,
    },
    rows: [row("total", { label: "retained", cpu_5s_percent: 24 })],
  };
  let finishWidget!: (
    value: Awaited<ReturnType<typeof telemetryWorkspaces.widget>>,
  ) => void;
  vi.mocked(telemetryWorkspaces.widget).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWidget = resolve;
      }),
  );
  let finishSeries!: (
    value: Awaited<ReturnType<typeof telemetryWorkspaces.series>>,
  ) => void;
  vi.mocked(telemetryWorkspaces.series).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSeries = resolve;
      }),
  );
  view.rerender(
    <LocalPcView
      snapshot={{
        ...snap,
        sequence: 2,
        widgets: [updated.metadata],
        series: [{ ...snap.series[0], point_count: 3 }],
      }}
      api={telemetryApi}
      workspaceId="test"
    />,
  );
  expect(screen.getByRole("table", { name: d.title })).toBe(table);
  expect(screen.getByRole("figure")).toBe(chart);
  expect(filter).toHaveValue("retained");
  expect(scroll.scrollTop).toBe(75);
  expect(screen.getByText(/^Stale/)).toBeVisible();
  await act(async () => {
    finishWidget({
      workspace_id: "test",
      generation: 1,
      sequence: 2,
      revision: "source",
      value: updated,
    });
  });
  expect(await screen.findByText("24")).toBeVisible();
  expect(screen.getByRole("table", { name: d.title })).toBe(table);
  expect(screen.getByRole("figure")).toBe(chart);
  await act(async () => {
    finishSeries({
      workspace_id: "test",
      generation: 1,
      sequence: 2,
      revision: "source",
      value: {
        points: [
          { at_ms: 1, value: 12, reason: null },
          { at_ms: 2, value: 13, reason: null },
          { at_ms: 3, value: 24, reason: null },
        ],
        next_after_ms: null,
      },
    });
  });
  await waitFor(() =>
    expect(
      screen.queryByText("Loading current observations…"),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("table", { name: d.title })).toBe(table);
  expect(screen.getByRole("figure")).toBe(chart);
  expect(filter).toHaveValue("retained");
  expect(scroll.scrollTop).toBe(75);
  view.rerender(
    <LocalPcView
      snapshot={{ ...snap, sequence: 3, widgets: [], series: [] }}
      api={telemetryApi}
      workspaceId="test"
    />,
  );
  expect(screen.queryByRole("table", { name: d.title })).not.toBeInTheDocument();
  expect(screen.queryByRole("figure")).not.toBeInTheDocument();
  view.rerender(
    <LocalPcView snapshot={snap} api={telemetryApi} workspaceId="test" />,
  );
  expect(await screen.findByRole("table", { name: d.title })).toBeVisible();
  vi.mocked(telemetryApi.catalog).mockImplementationOnce(
    () => new Promise(() => {}),
  );
  view.rerender(
    <LocalPcView
      snapshot={{ ...snap, generation: 2 }}
      api={telemetryApi}
      workspaceId="test"
    />,
  );
  expect(
    screen.queryByRole("table", { name: d.title }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("figure")).not.toBeInTheDocument();
});
it("loads exactly the rendered Local section and falls back after the active section is removed", async () => {
  const a = {
    ...definition("local_cpu"),
    source: { kind: "local" as const, collector: "local.cpu" as const },
  };
  const b = {
    ...definition("local_memory"),
    source: { kind: "local" as const, collector: "local.memory" as const },
  };
  const pages = [
    page(a.widget, [row("a", { cpu_5s_percent: 12 })]),
    page(b.widget, [row("b", { cpu_5s_percent: 34 })]),
  ];
  pages.forEach((p) => (p.metadata.target_id = "local"));
  const first = {
    id: "first",
    title: "Processor section",
    rows: [[{ widget: a.widget, span: 12 }]],
  };
  const second = {
    id: "second",
    title: "Memory section",
    rows: [[{ widget: b.widget, span: 12 }]],
  };
  const { snap, catalog } = dashboardFixture([a, b], pages, [first, second]);
  catalog.effective.layouts[0].platforms = [];
  const view = render(
    <LocalPcView snapshot={snap} api={telemetryApi} workspaceId="test" />,
  );
  expect(await screen.findByText("12")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "local_memory" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Memory section" }));
  expect(await screen.findByText("34")).toBeVisible();
  catalog.effective = {
    ...catalog.effective,
    revision: "new",
    layouts: [{ ...catalog.effective.layouts[0], sections: [first] }],
  };
  view.rerender(
    <LocalPcView
      snapshot={{ ...snap, generation: 2 }}
      api={telemetryApi}
      workspaceId="test"
    />,
  );
  expect(await screen.findByText("12")).toBeVisible();
});
it("local_renders_unavailable_metrics_without_zero", async () => {
  const d = {
    ...definition("local_network"),
    source: { kind: "local" as const, collector: "local.network" as const },
    view: {
      type: "table" as const,
      columns: [{ field: "received_bytes", label: "Received", unit: "B" }],
    },
  };
  const p = page("local_network", [row("en0", { received_bytes: null })]);
  p.metadata.target_id = "local";
  p.metadata.state = "stopped";
  const { snap, catalog } = dashboardFixture([d], [p]);
  catalog.effective.layouts[0].layout = "local_pc";
  catalog.effective.layouts[0].platforms = [];
  snap.targets = [
    {
      ...snap.targets[0],
      target_id: "local",
      display_name: "Local PC",
      platform: null,
      state: "stopped",
    },
  ];
  render(<LocalPcView snapshot={snap} api={telemetryApi} workspaceId="test" />);
  expect(await screen.findByText("Unknown")).toBeVisible();
  expect(screen.queryByText("0 B")).not.toBeInTheDocument();
  expect(screen.queryByText(/utilization/i)).not.toBeInTheDocument();
  expect(screen.getAllByText(/Stopped/)[0]).toBeVisible();
  expect(screen.getAllByText(/2023/)[0]).toBeVisible();
});

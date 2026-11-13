import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LocalPcView } from "./LocalPcView";
import {
  dashboardFixture,
  definition,
  page,
  row,
} from "./dashboard.test-support";
import { telemetryApi } from "./api";
afterEach(() => vi.restoreAllMocks());
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

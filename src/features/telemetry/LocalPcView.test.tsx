import { render, screen } from "@testing-library/react";
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

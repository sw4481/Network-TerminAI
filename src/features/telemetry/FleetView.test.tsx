import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FleetView } from "./FleetView";
import {
  dashboardFixture,
  definition,
  page,
  row,
} from "./dashboard.test-support";
import { telemetryApi } from "./api";
afterEach(() => vi.restoreAllMocks());
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

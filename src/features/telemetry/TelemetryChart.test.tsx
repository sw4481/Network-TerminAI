import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { TelemetryChart, chartPoints } from "./TelemetryChart";
it("clamps the exact table page after retention shrinks while preserving a valid page", () => {
  const points = Array.from({ length: 250 }, (_, i) => ({ at_ms: 1700000000000 + i * 1000, value: i, reason: null }));
  const view = render(<TelemetryChart series={{ points, next_after_ms: null }} unit="" title="CPU" />);
  fireEvent.click(screen.getByText("Recorded display values"));
  fireEvent.click(screen.getByRole("button", { name: "Next values" }));
  expect(within(screen.getByRole("table")).getByText("100")).toBeVisible();
  view.rerender(<TelemetryChart series={{ points: points.slice(0, 150), next_after_ms: null }} unit="" title="CPU" />);
  expect(within(screen.getByRole("table")).getByText("100")).toBeVisible();
  view.rerender(<TelemetryChart series={{ points: points.slice(0, 10), next_after_ms: null }} unit="" title="CPU" />);
  expect(within(screen.getByRole("table")).getByText("9")).toBeVisible();
  expect(screen.getByRole("button", { name: "Previous values" })).toBeDisabled();
});
it("preserves finite time axes and null collection gaps with exact values", () => {
  const series = {
    points: [
      { at_ms: 1700000000000, value: 4, reason: null },
      { at_ms: 1700000005000, value: null, reason: "collection_gap" },
      { at_ms: 1700000010000, value: 8, reason: null },
    ],
    next_after_ms: null,
  };
  const renderedChartPoints = chartPoints(series.points);
  expect(renderedChartPoints.some((p) => p.value === null)).toBe(true);
  expect(renderedChartPoints.every((p) => Number.isFinite(p.at_ms))).toBe(true);
  render(<TelemetryChart series={series} unit="bit/s" title="Receive" />);
  expect(screen.getByText("collection_gap")).toBeInTheDocument();
  expect(
    screen.getByRole("table", { name: "Receive recorded display values" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("0 bit/s")).not.toBeInTheDocument();
});
it("caps chart points while preserving extrema and every discontinuity or refuses the plot", () => {
  const points = Array.from({ length: 5000 }, (_, i) => ({
    at_ms: i,
    value: i === 1234 ? 9999 : i % 2 ? null : 2,
    reason: null,
  }));
  expect(chartPoints(points)).toHaveLength(0);
  const continuous = points.map((p, i) => ({
    ...p,
    value: i === 1234 ? 9999 : 2,
  }));
  expect(chartPoints(continuous).length).toBeLessThanOrEqual(600);
  expect(chartPoints(continuous).some((p) => p.value === 9999)).toBe(true);
});
it("segments a resumed numeric observation without changing its exact value or time", () => {
  const points = [
    { at_ms: 1000, value: 4, reason: null },
    { at_ms: 2000, value: 8, reason: "Collection resumed after monitoring stopped" },
  ];
  expect(chartPoints(points)).toEqual([points[0], { ...points[1], value: null }, points[1]]);
  render(<TelemetryChart series={{ points, next_after_ms: null }} unit="B" title="Memory" />);
  fireEvent.click(screen.getByText("Recorded display values"));
  expect(within(screen.getByRole("table")).getByText("8")).toBeVisible();
  expect(screen.getByText("Collection resumed after monitoring stopped")).toBeVisible();
  expect(chartPoints(Array.from({ length: 400 }, (_, i) => ({ at_ms: i, value: i, reason: "Collection resumed after collection failed" })))).toHaveLength(0);
});

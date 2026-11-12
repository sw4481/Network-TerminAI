import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TelemetryChart, chartPoints } from "./TelemetryChart";
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
    screen.getByRole("table", { name: "Receive exact retained values" }),
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

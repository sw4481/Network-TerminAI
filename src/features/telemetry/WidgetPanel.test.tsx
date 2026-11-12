import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { WidgetPanel } from "./WidgetPanel";
import { definition, page, row } from "./dashboard.test-support";
it("yaml_columns_thresholds_and_chart_units_drive_rendering", () => {
  const d = {
    ...definition(),
    view: {
      type: "table" as const,
      columns: [
        { field: "cpu_5s_percent", label: "Custom processor", unit: "%" },
      ],
    },
    alerts: [
      {
        field: "cpu_5s_percent",
        op: "gt" as const,
        value: 80,
        severity: "alert" as const,
        message: "Threshold configured",
      },
    ],
  };
  const p = page("cpu", [row("1", { cpu_5s_percent: null })]);
  p.metadata.severity = "warn";
  p.metadata.diagnostics = [
    {
      code: "threshold",
      message: "Native threshold observed",
      path: "cpu",
      line: null,
      column: null,
    },
  ];
  render(
    <WidgetPanel
      definition={d}
      page={p}
      series={{ points: [], next_after_ms: null }}
    />,
  );
  expect(
    screen.getByRole("columnheader", { name: "Custom processor (%)" }),
  ).toBeVisible();
  expect(screen.getByText("Unknown")).toBeVisible();
  expect(screen.getByText("Native threshold observed")).toBeVisible();
  expect(screen.getByText("Attention")).toBeVisible();
});
it("renders every declared chart field with its actual retained unit", () => {
  const d = {
    ...definition(),
    view: {
      type: "chart" as const,
      series: [
        { field: "rx", label: "Receive", unit: "bit/s" },
        { field: "tx", label: "Transmit", unit: "bit/s" },
      ],
    },
  };
  render(
    <WidgetPanel
      definition={d}
      page={page()}
      series={{ points: [], next_after_ms: null }}
      histories={[
        {
          field: "rx",
          unit: "bit/s",
          series: { points: [], next_after_ms: null },
        },
        {
          field: "tx",
          unit: "bit/s",
          series: { points: [], next_after_ms: null },
        },
      ]}
    />,
  );
  expect(screen.getByText("Receive (bit/s)")).toBeVisible();
  expect(screen.getByText("Transmit (bit/s)")).toBeVisible();
});
it("does not round an unsigned aggregate outside JavaScript exact integer range", () => {
  const d = {
    ...definition(),
    view: {
      type: "stat" as const,
      field: "counter",
      label: "Counter sum",
      aggregation: "sum" as const,
    },
  };
  const p = page("cpu", [
    {
      key: "1",
      fields: { counter: { kind: "unsigned", value: "9007199254740991" } },
    },
    { key: "2", fields: { counter: { kind: "unsigned", value: "2" } } },
  ]);
  render(
    <WidgetPanel
      definition={d}
      page={p}
      series={{ points: [], next_after_ms: null }}
    />,
  );
  expect(screen.getByText("Unknown")).toBeVisible();
});
it("first stat preserves the actual first text value without requiring numeric later rows", () => {
  const d = {
    ...definition(),
    view: {
      type: "stat" as const,
      field: "hostname",
      label: "Hostname",
      aggregation: "first" as const,
    },
  };
  render(
    <WidgetPanel
      definition={d}
      page={page("cpu", [
        row("1", { hostname: "Core router" }),
        row("2", { hostname: null }),
      ])}
      series={{ points: [], next_after_ms: null }}
    />,
  );
  expect(screen.getByText("Core router")).toBeVisible();
});

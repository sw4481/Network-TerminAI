import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import type {
  AuthoringCatalog,
  MetricRow,
  TelemetrySnapshot,
  WidgetDefinition,
  WidgetPage,
} from "./types";
import { telemetryWorkspaces } from "./store";
import { telemetryApi } from "./api";

export const row = (
  key: string,
  fields: Record<string, string | number | null>,
): MetricRow => ({
  key,
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      v === null
        ? { kind: "missing", reason: "not_available" }
        : typeof v === "number"
          ? { kind: "number", value: v }
          : { kind: "text", value: v },
    ]),
  ),
});
export const definition = (widget = "cpu"): WidgetDefinition => ({
  widget,
  title: widget,
  source: {
    kind: "ssh",
    commands: { iosxe: "show processes cpu" },
    templates: { iosxe: "cpu" },
  },
  interval: 30,
  key: ["pid"],
  fields: { cpu_5s_percent: ["cpu"], interface: ["interface"] },
  view: {
    type: "table",
    columns: [{ field: "cpu_5s_percent", label: "CPU", unit: "%" }],
  },
});
export const snapshot = (): TelemetrySnapshot => ({
  workspace_id: "test",
  generation: 1,
  sequence: 1,
  running: true,
  targets: Array.from({ length: 10 }, (_, i) => ({
    target_id: `device-${i}`,
    display_name: `Switch ${i + 1}`,
    platform: "iosxe",
    monitoring_selected: true,
    state: i === 9 ? "failed" : "fresh",
    last_success_at_ms: 1700000000000,
    diagnostics: [],
  })),
  widgets: [],
  series: [],
  diagnostics: [],
});
export const page = (
  widget = "cpu",
  rows = [row("1", { cpu_5s_percent: "4" })],
): WidgetPage => ({
  metadata: {
    workspace_id: "test",
    target_id: "device-0",
    widget_id: widget,
    revision: "source",
    generation: 1,
    observed_at_ms: 1700000000000,
    last_success_at_ms: 1700000000000,
    state: "fresh",
    severity: "ok",
    units: { cpu_5s_percent: "%" },
    row_count: rows.length,
    diagnostics: [],
  },
  rows,
  next_offset: null,
});
export function dashboardFixture(
  definitions: WidgetDefinition[],
  pages: WidgetPage[],
  sections = [
    {
      id: "overview",
      title: "Overview",
      rows: definitions.map((d) => [{ widget: d.widget, span: 12 }]),
    },
  ],
) {
  const snap = snapshot();
  snap.widgets = pages.map((p) => p.metadata);
  const catalog: AuthoringCatalog = {
    effective: {
      revision: "source",
      widgets: definitions,
      layouts: [{ layout: "device", platforms: ["iosxe"], sections }],
      templates: {
        cpu: {
          id: "cpu",
          command: "show processes cpu",
          platform: "iosxe",
          text: "template",
          sha256: "hash",
        },
      },
    },
    own: {
      scope: { device: "device-0" },
      widgets_yaml: "",
      layouts_yaml: "",
      templates: {},
      expected_revision: "global",
    },
    inherited: { widgets: {}, layouts: {}, templates: {} },
    builtin: {
      widgets: Object.fromEntries(definitions.map((d) => [d.widget, d])),
      layouts: {},
      templates: {
        cpu: {
          id: "cpu",
          command: "show processes cpu",
          platform: "iosxe",
          text: "template",
          sha256: "hash",
        },
      },
    },
    origins: { widgets: {}, layouts: {}, templates: {} },
  };
  vi.spyOn(telemetryApi, "catalog").mockImplementation(async () => ({
    workspace_id: "test",
    generation: 1,
    sequence: 1,
    revision: "global",
    value: structuredClone(catalog),
  }));
  vi.spyOn(telemetryWorkspaces, "read").mockImplementation(
    async (_id, _key, request) => request(),
  );
  vi.spyOn(telemetryWorkspaces, "widget").mockImplementation(async (query) => ({
    workspace_id: "test",
    generation: 1,
    sequence: 1,
    revision: "source",
    value: pages.find((p) => p.metadata.widget_id === query.widget_id)!,
  }));
  vi.spyOn(telemetryWorkspaces, "series").mockResolvedValue({
    workspace_id: "test",
    generation: 1,
    sequence: 1,
    revision: "source",
    value: { points: [], next_after_ms: null },
  });
  return { snap, catalog };
}
export function bundledFixture(
  ids: string[],
  pages: WidgetPage[],
  sectionId = "overview",
) {
  const assets = `${process.cwd()}/src-tauri/telemetry/`;
  const definitions = (
    load(readFileSync(`${assets}widgets.yaml`, "utf8")) as {
      widgets: WidgetDefinition[];
    }
  ).widgets.filter((d) => ids.includes(d.widget));
  const fixture = dashboardFixture(definitions, pages, [
    { id: sectionId, title: sectionId, rows: [] },
  ]);
  const manifest = JSON.parse(
    readFileSync(`${assets}catalog.json`, "utf8"),
  ) as {
    templates: {
      id: string;
      command: string;
      platform: "ios" | "iosxe";
      sha256: string;
    }[];
  };
  const templates = Object.fromEntries(
    manifest.templates.map((t) => [t.id, { ...t, text: "" }]),
  );
  fixture.catalog.effective.templates = templates;
  fixture.catalog.builtin.templates = templates;
  return fixture;
}

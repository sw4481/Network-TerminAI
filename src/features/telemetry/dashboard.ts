import type { TelemetryApi } from "./api";
import { telemetryWorkspaces, type TelemetryWorkspaceStore } from "./store";
import type {
  AuthoringCatalog,
  MetricRow,
  MetricValue,
  SeriesPage,
  SeriesSummary,
  TemplateAsset,
  WidgetDefinition,
  WidgetPage,
} from "./types";
export const metricNumber = (value: MetricValue | undefined): number | null =>
  value?.kind === "number" && Number.isFinite(value.value)
    ? value.value
    : value?.kind === "unsigned" &&
        /^\d+$/.test(value.value) &&
        Number.isSafeInteger(Number(value.value))
      ? Number(value.value)
      : null;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
export function compatibleDefinition(
  actual: WidgetDefinition,
  builtin: WidgetDefinition,
  templates: Record<string, TemplateAsset>,
  originals: Record<string, TemplateAsset>,
) {
  const semantics = (d: WidgetDefinition) => ({
    source: d.source,
    key: d.key,
    fields: d.fields,
    rates: d.rates ?? {},
    deltas: d.deltas ?? {},
    computes: d.computes ?? {},
  });
  if (canonical(semantics(actual)) !== canonical(semantics(builtin)))
    return false;
  if (actual.source.kind === "ssh")
    for (const id of Object.values(actual.source.templates))
      if (
        !id ||
        !templates[id] ||
        templates[id].sha256 !== originals[id]?.sha256 ||
        templates[id].command !== originals[id]?.command ||
        templates[id].platform !== originals[id]?.platform
      )
        return false;
  const units = (d: WidgetDefinition) =>
    Object.fromEntries(
      (d.view.type === "chart"
        ? d.view.series
        : d.view.type === "kv" || d.view.type === "table"
          ? d.view.columns
          : []
      ).map((c) => [c.field, c.unit ?? null]),
    );
  const a = units(actual),
    b = units(builtin);
  return Object.keys(b).every((field) => a[field] === b[field]);
}
export function semanticWidget(
  catalog: AuthoringCatalog,
  id: string,
): WidgetDefinition | undefined {
  const builtin = catalog.builtin.widgets[id];
  if (!builtin) return;
  const matches = catalog.effective.widgets.filter((d) =>
    compatibleDefinition(
      d,
      builtin,
      catalog.effective.templates,
      catalog.builtin.templates,
    ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export function repeatedTotal(rows: MetricRow[], field: string): number | null {
  if (!rows.length) return null;
  const numbers = rows.map((r) => metricNumber(r.fields[field]));
  const first = numbers[0];
  return first !== null &&
    first >= 0 &&
    first <= 100 &&
    numbers.every((v) => v === first)
    ? first
    : null;
}
export function processorPool(rows: MetricRow[]): number | null {
  if (rows.length !== 1) return null;
  const used = metricNumber(rows[0].fields.used_bytes),
    total = metricNumber(rows[0].fields.total_bytes);
  return used !== null &&
    total !== null &&
    total > 0 &&
    used >= 0 &&
    used <= total
    ? (used / total) * 100
    : null;
}
export function interfaceMember(
  value: MetricValue | undefined,
  selected: string,
): boolean {
  if (value?.kind !== "text") return false;
  try {
    const list: unknown = JSON.parse(value.value);
    return (
      Array.isArray(list) &&
      list.every((v) => typeof v === "string") &&
      list.includes(selected)
    );
  } catch {
    return false;
  }
}
export class DashboardReader {
  constructor(
    private readonly api: TelemetryApi,
    private readonly owner: TelemetryWorkspaceStore = telemetryWorkspaces,
  ) {}
  catalog(workspaceId: string, targetId: string, key: string) {
    return this.owner.read(workspaceId, key, () =>
      this.api.catalog(
        workspaceId,
        targetId === "local" ? "local" : { device: targetId },
      ),
    );
  }
  async widget(
    workspaceId: string,
    targetId: string,
    widgetId: string,
    revision: string,
  ): Promise<WidgetPage> {
    let offset = 0,
      previous: WidgetPage["metadata"] | undefined;
    const rows: MetricRow[] = [];
    while (true) {
      const { value } = await this.owner.widget(
        {
          workspace_id: workspaceId,
          target_id: targetId,
          widget_id: widgetId,
          offset,
          limit: 1000,
        },
        revision,
        previous,
      );
      if (
        previous &&
        (value.metadata.generation !== previous.generation ||
          value.metadata.revision !== previous.revision ||
          value.metadata.observed_at_ms !== previous.observed_at_ms)
      )
        throw new Error("Telemetry table changed; reload");
      rows.push(...value.rows);
      previous = value.metadata;
      if (value.next_offset === null) {
        if (rows.length !== previous.row_count)
          throw new Error("Telemetry table is incomplete; reload");
        return { ...value, rows };
      }
      if (value.next_offset <= offset || rows.length > 10000)
        throw new Error("Telemetry table cursor is invalid");
      offset = value.next_offset;
    }
  }
  async series(
    workspaceId: string,
    summary: SeriesSummary,
    revision: string,
  ): Promise<SeriesPage> {
    const points: SeriesPage["points"] = [];
    let after: number | null = null;
    while (true) {
      const { value } = await this.owner.series(
        {
          workspace_id: workspaceId,
          target_id: summary.target_id,
          widget_id: summary.widget_id,
          row_key: summary.row_key,
          field: summary.field,
          after_ms: after,
          limit: 1000,
        },
        revision,
      );
      if (
        value.points.some(
          (p, i) =>
            !Number.isFinite(p.at_ms) ||
            (i
              ? value.points[i - 1].at_ms >= p.at_ms
              : after !== null && after >= p.at_ms),
        )
      )
        throw new Error("Telemetry series changed; reload");
      points.push(...value.points);
      if (value.next_after_ms === null) return { points, next_after_ms: null };
      if (
        !value.points.length ||
        value.next_after_ms !== value.points[value.points.length - 1].at_ms
      )
        throw new Error("Telemetry series cursor is invalid");
      after = value.next_after_ms;
    }
  }
}

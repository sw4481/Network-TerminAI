import { useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  MetricRow,
  MetricValue,
  WidgetDefinition,
  WidgetPage,
  SeriesPage,
  ViewField,
} from "./types";
import { TelemetryChart } from "./TelemetryChart";
import { metricNumber } from "./dashboard";

export const metricText = (value: MetricValue | undefined) =>
  !value || value.kind === "missing" ? "Unknown" : String(value.value);
const missingReason = (value: MetricValue | undefined) =>
  value?.kind === "missing" ? value.reason : undefined;
export const collectionLabel = (state: string) =>
  ({
    fresh: "Fresh",
    stale: "Stale",
    stopped: "Stopped",
    collecting: "Collecting",
    failed: "Collection failed",
    unsupported: "Unsupported",
    not_configured: "Not configured",
  })[state] ?? state;
export const conditionLabel = (severity: string) =>
  ({
    ok: "No attention observed",
    info: "Informational",
    warn: "Attention",
    alert: "Alert",
  })[severity] ?? "Unknown";
export const sampleTime = (time: number | null) =>
  time === null ? "No successful sample" : new Date(time).toLocaleString();

export function MetricTable({
  rows,
  columns,
  title,
  onSelect,
  selectedKey,
}: {
  rows: MetricRow[];
  columns: ViewField[];
  title: string;
  onSelect?: (row: MetricRow) => void;
  selectedKey?: string;
}) {
  const [filter, setFilter] = useState("");
  const parent = useRef<HTMLDivElement>(null);
  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        Object.values(r.fields).some((v) =>
          metricText(v).toLowerCase().includes(filter.toLowerCase()),
        ),
      ),
    [rows, filter],
  );
  const defs = useMemo<ColumnDef<MetricRow>[]>(
    () =>
      columns.map((c) => ({
        id: c.field,
        header: `${c.label}${c.unit ? ` (${c.unit})` : ""}`,
        cell: ({ row }) => (
          <span title={missingReason(row.original.fields[c.field])}>
            {metricText(row.original.fields[c.field])}
          </span>
        ),
      })),
    [columns],
  );
  const table = useReactTable({
    data: filtered,
    columns: defs,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.key,
  });
  const virtual = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 36,
    overscan: 8,
    enabled: filtered.length > 100,
  });
  const items = virtual.getVirtualItems();
  const rendered =
    filtered.length > 100
      ? items.map((item) => ({
          item,
          row: table.getRowModel().rows[item.index],
        }))
      : table.getRowModel().rows.map((row) => ({ row, item: null }));
  return (
    <>
      <label className="telemetry-filter">
        Filter {title}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          type="search"
        />
      </label>
      <p className="telemetry-muted">
        {filtered.length} of {rows.length} retained rows
      </p>
      <div className="telemetry-table-scroll" ref={parent}>
        <table aria-label={title}>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {onSelect && <th>Select</th>}
                {group.headers.map((h) => (
                  <th key={h.id} scope="col">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {items.length > 0 && items[0].start > 0 && (
              <tr aria-hidden="true">
                <td
                  style={{ height: items[0].start }}
                  colSpan={columns.length + (onSelect ? 1 : 0)}
                />
              </tr>
            )}
            {rendered.map(({ row }) => (
              <tr
                key={row.id}
                aria-selected={onSelect ? selectedKey === row.id : undefined}
              >
                {onSelect && (
                  <td>
                    <button
                      aria-label={`Select interface ${metricText(row.original.fields.interface)}`}
                      onClick={() => onSelect(row.original)}
                    >
                      Select
                    </button>
                  </td>
                )}
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {items.length > 0 && (
              <tr aria-hidden="true">
                <td
                  style={{
                    height: Math.max(
                      0,
                      virtual.getTotalSize() -
                        (items[items.length - 1]?.end ?? 0),
                    ),
                  }}
                  colSpan={columns.length + (onSelect ? 1 : 0)}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
export function WidgetPanel({
  definition,
  page,
  series,
  histories,
  onSelect,
  selectedKey,
}: {
  definition: WidgetDefinition;
  page: WidgetPage;
  series: SeriesPage;
  histories?: { field: string; unit: string; series: SeriesPage }[];
  onSelect?: (row: MetricRow) => void;
  selectedKey?: string;
}) {
  const view = definition.view;
  const field = view.type === "stat" ? view.field : null;
  const numbers = field
    ? page.rows
        .map((r) => metricNumber(r.fields[field]))
        .filter((v): v is number => v !== null)
    : [];
  let stat: string | number | null = null;
  if (view.type === "stat") {
    if (view.aggregation === "count") stat = page.rows.length;
    else if (view.aggregation === "first" && field) {
      const first = page.rows[0]?.fields[field];
      if (first && first.kind !== "missing") stat = metricText(first);
    } else if (numbers.length && numbers.length === page.rows.length)
      stat =
        view.aggregation === "min"
          ? Math.min(...numbers)
          : view.aggregation === "max"
            ? Math.max(...numbers)
            : numbers.reduce((a, b) => a + b, 0) /
              (view.aggregation === "mean" ? numbers.length : 1);
    const sum = numbers.reduce((a, b) => a + b, 0);
    if (
      typeof stat === "number" &&
      (!Number.isFinite(stat) ||
        (field &&
          page.rows.some((r) => r.fields[field]?.kind === "unsigned") &&
          (view.aggregation === "sum" || view.aggregation === "mean"
            ? !Number.isSafeInteger(sum)
            : !Number.isSafeInteger(stat))))
    )
      stat = null;
  }
  return (
    <section className="telemetry-panel" data-severity={page.metadata.severity}>
      <header>
        <h3>{definition.title}</h3>
        <span>
          {collectionLabel(page.metadata.state)} ·{" "}
          <span>{conditionLabel(page.metadata.severity)}</span>
        </span>
      </header>
      <p className="telemetry-muted">
        Observed{" "}
        <time dateTime={new Date(page.metadata.observed_at_ms).toISOString()}>
          {sampleTime(page.metadata.observed_at_ms)}
        </time>{" "}
        · Last success {sampleTime(page.metadata.last_success_at_ms)}
      </p>
      {page.metadata.diagnostics.map((d, i) => (
        <p className="telemetry-diagnostic" key={i}>
          {d.message}
        </p>
      ))}
      {view.type === "table" ? (
        <MetricTable
          title={definition.title}
          columns={view.columns}
          rows={page.rows}
          onSelect={onSelect}
          selectedKey={selectedKey}
        />
      ) : view.type === "kv" ? (
        <div className="telemetry-kv">
          {page.rows.map((r) => (
            <dl key={r.key}>
              {view.columns.map((c) => (
                <div key={c.field}>
                  <dt>
                    {c.label}
                    {c.unit ? ` (${c.unit})` : ""}
                  </dt>
                  <dd title={missingReason(r.fields[c.field])}>
                    {metricText(r.fields[c.field])}
                  </dd>
                </div>
              ))}
            </dl>
          ))}
        </div>
      ) : view.type === "stat" ? (
        <div className="telemetry-stat">
          <span>{view.label}</span>
          <strong>
            {stat ?? "Unknown"}
            {stat !== null && field && page.metadata.units[field]
              ? ` ${page.metadata.units[field]}`
              : ""}
          </strong>
        </div>
      ) : view.type === "chart" ? (
        view.series.map((field, index) => {
          const history = histories?.find((h) => h.field === field.field);
          return (
            <TelemetryChart
              key={field.field}
              title={field.label}
              unit={history?.unit ?? field.unit ?? ""}
              series={
                history?.series ??
                (!histories && index === 0
                  ? series
                  : { points: [], next_after_ms: null })
              }
            />
          );
        })
      ) : null}
    </section>
  );
}

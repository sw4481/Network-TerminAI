import { useState, type CSSProperties } from "react";
import {
  semanticWidget,
  interfaceMember,
  successfulObservation,
} from "./dashboard";
import {
  useDashboard,
  type DashboardProps,
  type LoadedSeries,
  type LoadedWidget,
} from "./useDashboard";
import { WidgetPanel, collectionLabel, metricText } from "./WidgetPanel";
import { TelemetryChart } from "./TelemetryChart";
import { InterfaceTraffic } from "./InterfaceTraffic";
import type { LayoutSection, MetricRow } from "./types";

export function ConfiguredSection({
  section,
  definitions,
  widgets,
  series,
  onSelect,
  selectedKey,
  selectedInterface,
  selectableWidgetId,
  historyRows,
  onHistoryRow,
}: {
  section: LayoutSection;
  definitions: { widget: string; title: string }[];
  widgets: LoadedWidget[];
  series: LoadedSeries[];
  onSelect?: (widget: LoadedWidget, row: MetricRow) => void;
  selectedKey?: string;
  selectedInterface?: string;
  selectableWidgetId?: string;
  historyRows?: Record<string, string>;
  onHistoryRow?: (widgetId: string, rowKey: string) => void;
}) {
  return (
    <div className="telemetry-layout">
      {section.rows.map((row, i) => (
        <div className="telemetry-layout-row" key={i}>
          {row.map((entry, j) => {
            const widget = widgets.find(
              (w) => w.definition.widget === entry.widget,
            );
            const definition = definitions.find(
              (d) => d.widget === entry.widget,
            );
            let page = widget?.page;
            if (page && selectedInterface) {
              if (widget?.definition.fields.local_interface)
                page = {
                  ...page,
                  rows: page.rows.filter(
                    (r) =>
                      metricText(r.fields.local_interface) ===
                      selectedInterface,
                  ),
                };
              else if (widget?.definition.fields.interfaces)
                page = {
                  ...page,
                  rows: page.rows.filter((r) =>
                    interfaceMember(r.fields.interfaces, selectedInterface),
                  ),
                };
            }
            const histories = series.filter(
              (s) => s.summary.widget_id === entry.widget,
            );
            return (
              <div
                key={`${entry.widget}:${j}`}
                className="telemetry-layout-cell"
                style={{ "--telemetry-span": entry.span } as CSSProperties}
              >
                {widget && page ? (
                  <>
                    {widget.previousSource && (
                      <p className="telemetry-notice">
                        Previous source observation; showing its original
                        definition.
                      </p>
                    )}
                    {histories.length > 0 &&
                      page.rows.length > 1 &&
                      onHistoryRow && (
                        <label className="telemetry-filter">
                          History row for {widget.definition.title}
                          <select
                            value={
                              historyRows?.[entry.widget] ??
                              histories[0].summary.row_key
                            }
                            onChange={(e) =>
                              onHistoryRow(entry.widget, e.target.value)
                            }
                          >
                            {page.rows.map((r, i) => (
                              <option key={r.key} value={r.key}>
                                {metricText(
                                  r.fields.interface ??
                                    r.fields.label ??
                                    r.fields.core ??
                                    r.fields.mount ??
                                    r.fields.name ??
                                    r.fields.pid,
                                )}{" "}
                                (row {i + 1})
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    <WidgetPanel
                      definition={widget.definition}
                      page={page}
                      series={
                        histories[0]?.series ?? {
                          points: [],
                          next_after_ms: null,
                        }
                      }
                      histories={histories.map((h) => ({
                        field: h.summary.field,
                        unit: h.unit,
                        series: h.series,
                      }))}
                      onSelect={
                        onSelect &&
                        widget.definition.widget === selectableWidgetId
                          ? (row) => onSelect(widget, row)
                          : undefined
                      }
                      selectedKey={selectedKey}
                    />
                    {widget.definition.view.type !== "chart" &&
                      histories.map((s) => (
                        <TelemetryChart
                          key={`${s.summary.row_key}:${s.summary.field}`}
                          series={s.series}
                          unit={s.unit}
                          title={`${widget.definition.title} · ${s.summary.field} · ${metricText(page.rows.find((r) => r.key === s.summary.row_key)?.fields.interface ?? page.rows.find((r) => r.key === s.summary.row_key)?.fields.label)}`}
                        />
                      ))}
                  </>
                ) : (
                  <section className="telemetry-panel">
                    <header>
                      <h3>
                        {definition?.title ?? "Unavailable widget definition"}
                      </h3>
                    </header>
                    <p>No compatible retained observation available.</p>
                  </section>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
export function DeviceView(
  props: DashboardProps & {
    targetId?: string;
    onMonitorInterfaces?: (targetId: string, interfaces: string[]) => void;
  },
) {
  const { snapshot, targetId = "", onMonitorInterfaces } = props;
  const target = snapshot.targets.find((t) => t.target_id === targetId);
  const [sectionId, setSection] = useState("");
  const [historyRows, setHistoryRows] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<{
    targetId: string;
    widgetId: string;
    key: string;
    label: string;
  } | null>(null);
  const selected = selection?.targetId === targetId ? selection : null;
  const data = useDashboard(
    props,
    targetId,
    "detail",
    sectionId,
    selected?.label,
    historyRows,
  );
  const layouts =
    data.catalog?.effective.layouts.filter(
      (l) => target?.platform && l.platforms.includes(target.platform),
    ) ?? [];
  const sections = layouts.flatMap((l) => l.sections);
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const observedSource =
    data.catalog &&
    (semanticWidget(data.catalog, "interfaces") ??
      semanticWidget(data.catalog, "port_status"));
  const interfaceWidget = data.widgets.find(
    (w) =>
      w.definition.widget === observedSource?.widget &&
      !w.previousSource &&
      successfulObservation(w.page),
  );
  const selectedRow =
    interfaceWidget?.definition.widget === selected?.widgetId
      ? interfaceWidget?.page.rows.find((r) => r.key === selected?.key)
      : undefined;
  const ports = interfaceWidget?.page.rows ?? [];
  if (!target)
    return (
      <section>
        <h2>Device</h2>
        <p>Select a saved IOS or IOS-XE target to inspect its observations.</p>
      </section>
    );
  return (
    <section aria-label="Device dashboard">
      <h2>{target.display_name}</h2>
      <p className="telemetry-muted">
        {target.platform?.toUpperCase()} · {collectionLabel(target.state)}
      </p>
      <nav aria-label="Device sections" className="telemetry-section-nav">
        {sections.map((s, i) => (
          <button
            key={`${s.id}:${i}`}
            aria-pressed={section?.id === s.id}
            onClick={() => setSection(s.id)}
          >
            {s.title}
          </button>
        ))}
      </nav>
      {selected && (
        <p className="telemetry-notice">
          {selectedRow || data.loading
            ? `Selected interface: ${selected.label}`
            : `Selected interface ${selected.label} is unavailable in this observation.`}{" "}
          <button onClick={() => setSelection(null)}>Clear interface</button>
          {selectedRow && onMonitorInterfaces && (
            <button
              onClick={() => onMonitorInterfaces(targetId, [selected.label])}
            >
              Monitor selected interface
            </button>
          )}
        </p>
      )}
      {interfaceWidget && (
        <p className="telemetry-muted">
          {ports.length} observed interfaces from {observedSource?.title};
          physical port capacity is unavailable.
        </p>
      )}
      {data.errors.map((e, i) => (
        <p role="status" key={i}>
          {e}
        </p>
      ))}
      {data.loading && <p role="status">Loading current observations…</p>}
      {section && (
        <ConfiguredSection
          section={section}
          definitions={data.catalog?.effective.widgets ?? []}
          widgets={data.widgets}
          series={data.series}
          historyRows={historyRows}
          onHistoryRow={(id, key) =>
            setHistoryRows({ ...historyRows, [id]: key })
          }
          selectedKey={selected?.key}
          selectedInterface={selected?.label}
          selectableWidgetId={interfaceWidget?.definition.widget}
          onSelect={(widget, row) => {
            setHistoryRows({});
            setSelection({
              targetId,
              widgetId: widget.definition.widget,
              key: row.key,
              label: metricText(row.fields.interface),
            });
          }}
        />
      )}
      {section?.id === "overview" && (
        <InterfaceTraffic
          data={data}
          selected={selected?.label ?? ""}
          onSelect={(label) => {
            const row = ports.find(
              (r) => metricText(r.fields.interface) === label,
            );
            setHistoryRows({});
            setSelection(
              row && interfaceWidget
                ? {
                    targetId,
                    widgetId: interfaceWidget.definition.widget,
                    key: row.key,
                    label,
                  }
                : null,
            );
          }}
        />
      )}
      {!data.loading && !sections.length && (
        <p>No device layout is configured.</p>
      )}
    </section>
  );
}

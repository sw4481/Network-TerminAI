import { semanticWidget, successfulObservation } from "./dashboard";
import { TelemetryChart } from "./TelemetryChart";
import { collectionLabel, metricText, sampleTime } from "./WidgetPanel";
import type { useDashboard } from "./useDashboard";

export function InterfaceTraffic({
  data,
  selected,
  onSelect,
}: {
  data: ReturnType<typeof useDashboard>;
  selected: string;
  onSelect: (value: string) => void;
}) {
  const source =
    data.catalog &&
    (semanticWidget(data.catalog, "interfaces") ??
      semanticWidget(data.catalog, "port_status"));
  const inventory = data.widgets.find(
    (w) => w.definition.widget === source?.widget && !w.previousSource,
  );
  const trafficSource =
    data.catalog && semanticWidget(data.catalog, "interface_traffic");
  const traffic = data.widgets.find(
    (w) => w.definition.widget === trafficSource?.widget && !w.previousSource,
  );
  const ports = successfulObservation(inventory?.page)
    ? inventory!.page.rows
    : [];
  const names = new Map<string, number>();
  ports.forEach((r) => {
    const name = metricText(r.fields.interface);
    names.set(name, (names.get(name) ?? 0) + 1);
  });
  const matches = ports.filter(
    (r) => metricText(r.fields.interface) === selected,
  );
  const rows =
    traffic?.page.rows.filter(
      (r) => metricText(r.fields.interface) === selected,
    ) ?? [];
  const histories =
    matches.length === 1 && rows.length === 1
      ? data.series.filter(
          (s) =>
            s.summary.widget_id === traffic?.definition.widget &&
            s.summary.row_key === rows[0].key,
        )
      : [];
  return (
    <section
      className="telemetry-panel"
      aria-label="Selected interface traffic"
    >
      <header>
        <h3>Selected interface traffic</h3>
      </header>
      <label className="telemetry-filter">
        Traffic interface
        <select value={selected} onChange={(e) => onSelect(e.target.value)}>
          <option value="">Select an observed interface</option>
          {ports.map((r) => {
            const label = metricText(r.fields.interface);
            const ambiguous = names.get(label) !== 1;
            return (
              <option key={r.key} value={label} disabled={ambiguous}>
                {label}
                {ambiguous ? " (ambiguous)" : ""}
              </option>
            );
          })}
        </select>
      </label>
      {traffic && (
        <p className="telemetry-muted">
          {traffic.definition.title}:{" "}
          {collectionLabel(traffic.page.metadata.state)} ·{" "}
          {sampleTime(traffic.page.metadata.observed_at_ms)}
        </p>
      )}
      {!inventory && !data.loading && (
        <p>Compatible interface inventory is unavailable.</p>
      )}
      {selected && matches.length !== 1 && (
        <p>
          Selected interface {selected} is unavailable or ambiguous in this
          observation.
        </p>
      )}
      {selected && matches.length === 1 && rows.length !== 1 && (
        <p>No unambiguous traffic observation for this exact interface.</p>
      )}
      {!selected && (
        <p>Select an observed interface to inspect its retained traffic.</p>
      )}
      {selected && histories.length === 0 && (
        <p>No declared retained traffic history available.</p>
      )}
      {histories.map((s) => (
        <TelemetryChart
          key={s.summary.field}
          series={s.series}
          unit={s.unit}
          title={`${selected} · ${s.summary.field}`}
        />
      ))}
    </section>
  );
}

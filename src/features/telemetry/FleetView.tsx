import { useCallback, useEffect, useState } from "react";
import {
  semanticWidget,
  repeatedTotal,
  processorPool,
  successfulObservation,
  metricNumber,
} from "./dashboard";
import {
  useDashboard,
  type DashboardProps,
  type LoadedWidget,
} from "./useDashboard";
import {
  collectionLabel,
  conditionLabel,
  metricText,
  sampleTime,
} from "./WidgetPanel";
import type { TargetStatus, TelemetrySnapshot } from "./types";
import { InterfaceTraffic } from "./InterfaceTraffic";

const protocolIds = [
  "bgp_peers",
  "bgp_vrf_peers",
  "ospf_neighbors",
  "eigrp_neighbors",
];
const reportScope = (snapshot: TelemetrySnapshot, targetId: string) =>
  JSON.stringify([
    snapshot.generation,
    snapshot.widgets.filter((w) => w.target_id === targetId),
  ]);
const current = (w: LoadedWidget | undefined) =>
  successfulObservation(w?.page) && w?.page.metadata.state === "fresh";
const rowCounts = (w: LoadedWidget) =>
  w.page.rows.reduce<Record<string, number>>((counts, row) => {
    const state = w.definition.fields.state
      ? metricText(row.fields.state)
      : "observed rows";
    counts[state] = (counts[state] ?? 0) + 1;
    return counts;
  }, {});
const countText = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([state, count]) => `${state}: ${count}`)
    .join(", ");
const states = (w: LoadedWidget) =>
  !successfulObservation(w.page)
    ? collectionLabel(w.page.metadata.state)
    : !w.definition.fields.state
      ? `${w.page.rows.length} observed rows`
      : w.page.rows.length === 0
        ? "0 observed rows"
        : countText(rowCounts(w));
interface TargetReport {
  scope: string;
  cpu: boolean;
  memory: boolean;
  ports: boolean;
  protocols: {
    id: string;
    title: string;
    current: boolean;
    counts: Record<string, number>;
  }[];
}
function SourceValue({
  widget,
  children,
}: {
  widget?: LoadedWidget;
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      {widget && (
        <span className="telemetry-muted">
          <br />
          <span>{collectionLabel(widget.page.metadata.state)}</span>
          <br />
          <time>{sampleTime(widget.page.metadata.observed_at_ms)}</time>
        </span>
      )}
    </>
  );
}
function FleetTarget({
  target,
  onSelect,
  onReport,
  ...props
}: DashboardProps & {
  target: TargetStatus;
  onSelect?: () => void;
  onReport: (id: string, value: TargetReport | null) => void;
}) {
  const data = useDashboard(props, target.target_id, "fleet");
  const semantic = (id: string) => {
    const d = data.catalog && semanticWidget(data.catalog, id);
    return data.widgets.find(
      (w) => w.definition.widget === d?.widget && !w.previousSource,
    );
  };
  const cpu = semantic("cpu"),
    memory = semantic("memory"),
    ports = semantic("port_status") ?? semantic("interfaces");
  const cpuValue = successfulObservation(cpu?.page)
    ? repeatedTotal(cpu!.page.rows, "cpu_5s_percent")
    : null;
  const memoryValue = successfulObservation(memory?.page)
    ? processorPool(memory!.page.rows)
    : null;
  const protocols = protocolIds.map((id) => ({ id, widget: semantic(id) }));
  const scope = reportScope(props.snapshot, target.target_id);
  const report: TargetReport = {
    scope,
    cpu: props.snapshot.running && current(cpu) && cpuValue !== null,
    memory: props.snapshot.running && current(memory) && memoryValue !== null,
    ports: props.snapshot.running && !!current(ports),
    protocols: protocols
      .filter((p): p is { id: string; widget: LoadedWidget } => !!p.widget)
      .map(({ id, widget }) => ({
        id,
        title: widget.definition.title,
        current: props.snapshot.running && !!current(widget),
        counts: successfulObservation(widget.page) ? rowCounts(widget) : {},
      })),
  };
  const reportKey = JSON.stringify(report);
  useEffect(() => {
    onReport(target.target_id, report);
    return () => onReport(target.target_id, null);
  }, [onReport, target.target_id, reportKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const summaries = props.snapshot.widgets.filter(
    (w) => w.target_id === target.target_id,
  );
  const severity = summaries.some((w) => w.severity === "alert")
    ? "alert"
    : summaries.some((w) => w.severity === "warn")
      ? "warn"
      : summaries.some((w) => w.severity === "ok")
        ? "ok"
        : "info";
  const upField = ports?.definition.fields.status ? "status" : "link_state";
  const up = ports?.page.rows.filter(
    (r) =>
      metricText(r.fields[upField]).toLowerCase() ===
      (upField === "status" ? "connected" : "up"),
  ).length;
  const knownStates =
    ports?.page.rows.filter(
      (r) =>
        r.fields[upField]?.kind === "text" &&
        metricText(r.fields[upField]) !== "",
    ).length ?? 0;
  const diagnostics = summaries.flatMap((w) =>
    w.diagnostics.map(
      (d) =>
        `${data.catalog?.effective.widgets.find((def) => def.widget === w.widget_id)?.title ?? "Widget"}: ${d.message}`,
    ),
  );
  return (
    <tr>
      <td>
        <button onClick={onSelect}>{target.display_name}</button>
      </td>
      <td>{target.platform?.toUpperCase() ?? "Unknown"}</td>
      <td>
        {collectionLabel(target.state)}
        {summaries
          .filter((w) => !["fresh", "stopped"].includes(w.state))
          .map((w) => (
            <div key={w.widget_id}>
              {data.catalog?.effective.widgets.find(
                (d) => d.widget === w.widget_id,
              )?.title ?? "Widget"}
              : {collectionLabel(w.state)}
            </div>
          ))}
      </td>
      <td>{conditionLabel(severity)}</td>
      <td>
        <SourceValue widget={cpu}>
          {cpuValue !== null ? `${cpuValue} %` : "Unknown"}
        </SourceValue>
      </td>
      <td>
        <SourceValue widget={memory}>
          {memoryValue !== null
            ? `${Number(memoryValue.toFixed(1))} %`
            : "Unknown"}
        </SourceValue>
      </td>
      <td>
        <SourceValue widget={ports}>
          {successfulObservation(ports?.page)
            ? `${knownStates === ports!.page.rows.length ? up : "Unknown"} up / ${ports!.page.rows.length} observed (${ports!.definition.title}); state coverage ${knownStates} / ${ports!.page.rows.length}`
            : "Unknown"}
        </SourceValue>
      </td>
      <td>
        {protocols.some((p) => p.widget)
          ? protocols.map(
              ({ id, widget }) =>
                widget && (
                  <div key={id}>
                    {widget.definition.title}:{" "}
                    <SourceValue widget={widget}>{states(widget)}</SourceValue>
                  </div>
                ),
            )
          : "Unknown"}
      </td>
      <td>
        <time>{sampleTime(target.last_success_at_ms)}</time>
        {diagnostics.map((d, i) => (
          <p key={i}>{d}</p>
        ))}
        {data.errors.length > 0 && (
          <details>
            <summary>Source unavailable</summary>
            {data.errors.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </details>
        )}
      </td>
    </tr>
  );
}
function LocalSummary(props: DashboardProps) {
  const data = useDashboard(props, "local", "local-summary");
  const semantic = (id: string) => {
    const d = data.catalog && semanticWidget(data.catalog, id);
    return data.widgets.find(
      (w) => w.definition.widget === d?.widget && !w.previousSource,
    );
  };
  const cpu = semantic("local_cpu"),
    memory = semantic("local_memory");
  const totals =
    cpu?.page.rows.filter((r) => metricText(r.fields.core) === "total") ?? [];
  const usage =
    successfulObservation(cpu?.page) && totals.length === 1
      ? metricNumber(totals[0].fields.usage)
      : null;
  const memoryRow =
    successfulObservation(memory?.page) && memory?.page.rows.length === 1
      ? memory.page.rows[0]
      : undefined;
  return (
    <section className="telemetry-panel" aria-label="Local PC summary">
      <header>
        <h3>Local PC</h3>
      </header>
      <p>
        Overall CPU:{" "}
        <SourceValue widget={cpu}>
          <strong>{usage === null ? "Unknown" : `${usage} %`}</strong>
        </SourceValue>
      </p>
      <p>
        Memory:{" "}
        <SourceValue widget={memory}>
          <strong>
            {memoryRow
              ? `${metricText(memoryRow.fields.used_bytes)} B / ${metricText(memoryRow.fields.total_bytes)} B`
              : "Unknown"}
          </strong>
        </SourceValue>
      </p>
      {data.errors.map((e, i) => (
        <p role="status" key={i}>
          {e}
        </p>
      ))}
    </section>
  );
}
function FleetTraffic(props: DashboardProps & { targetId: string }) {
  const [selected, setSelected] = useState("");
  const data = useDashboard(
    props,
    props.targetId,
    "traffic",
    undefined,
    selected,
  );
  return (
    <>
      <InterfaceTraffic
        data={data}
        selected={selected}
        onSelect={setSelected}
      />
      {data.errors.map((e, i) => (
        <p role="status" key={i}>
          {e}
        </p>
      ))}
    </>
  );
}
export function FleetView(
  props: DashboardProps & { onSelectTarget?: (targetId: string) => void },
) {
  const selected = props.snapshot.targets.filter(
    (t) => t.platform && t.monitoring_selected,
  );
  const [interfaceTarget, setInterfaceTarget] = useState("");
  const [reports, setReports] = useState<Record<string, TargetReport>>({});
  const onReport = useCallback(
    (id: string, value: TargetReport | null) =>
      setReports((old) => {
        if (value === null) {
          if (!old[id]) return old;
          const next = { ...old };
          delete next[id];
          return next;
        }
        return JSON.stringify(old[id]) === JSON.stringify(value)
          ? old
          : { ...old, [id]: value };
      }),
    [],
  );
  const currentReports = selected.flatMap((t) => {
    const report = reports[t.target_id];
    return report?.scope === reportScope(props.snapshot, t.target_id)
      ? [report]
      : [];
  });
  const reporting = selected.filter(
    (t) => props.snapshot.running && t.state === "fresh",
  ).length;
  const attention = selected.filter((t) =>
    props.snapshot.widgets.some(
      (w) =>
        w.target_id === t.target_id && ["warn", "alert"].includes(w.severity),
    ),
  ).length;
  const gaps = selected.filter(
    (t) =>
      [
        "failed",
        "stale",
        "unsupported",
        "not_configured",
        "collecting",
      ].includes(t.state) ||
      props.snapshot.widgets.some(
        (w) =>
          w.target_id === t.target_id &&
          [
            "failed",
            "stale",
            "unsupported",
            "not_configured",
            "collecting",
          ].includes(w.state),
      ),
  ).length;
  return (
    <section aria-label="Fleet dashboard">
      <h2>Fleet</h2>
      <div className="telemetry-coverage">
        <div>
          Selected network targets<strong>{selected.length}</strong>
          <span>Explicit monitoring selection</span>
        </div>
        <div>
          Current reporting
          <strong>
            {reporting} / {selected.length}
          </strong>
          <span>Fresh target collection</span>
        </div>
        <div>
          Observation attention<strong>{attention}</strong>
          <span>Native warning or alert observations</span>
        </div>
        <div>
          Collection gaps<strong>{gaps}</strong>
          <span>Collection state; device condition stays separate</span>
        </div>
      </div>
      <p className="telemetry-muted">
        CPU current coverage: {currentReports.filter((r) => r.cpu).length} /{" "}
        {selected.length}
      </p>
      <p className="telemetry-muted">
        Processor Pool current coverage:{" "}
        {currentReports.filter((r) => r.memory).length} / {selected.length}
      </p>
      <p className="telemetry-muted">
        Interface current coverage:{" "}
        {currentReports.filter((r) => r.ports).length} / {selected.length}
      </p>
      <div className="telemetry-main-grid">
        <section className="telemetry-panel">
          <header>
            <h3>Monitored devices</h3>
            <span>{selected.length} selected</span>
          </header>
          <p className="telemetry-muted">
            CPU: consistent device total. Memory: Processor Pool usage. Values
            retain their collection state and sample time.
          </p>
          <div className="telemetry-table-scroll">
            <table aria-label="Monitored devices">
              <thead>
                <tr>
                  {[
                    "Device",
                    "Platform",
                    "Collection",
                    "Observation",
                    "CPU (5s)",
                    "Processor Pool",
                    "Observed interfaces",
                    "Routing by source",
                    "Last success",
                  ].map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selected.map((target) => (
                  <FleetTarget
                    key={target.target_id}
                    {...props}
                    target={target}
                    onReport={onReport}
                    onSelect={() => props.onSelectTarget?.(target.target_id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {!selected.length && (
            <p>Choose saved network targets, then Start monitoring.</p>
          )}
        </section>
        <aside>
          <section
            className="telemetry-panel"
            aria-label="Fleet routing coverage"
          >
            <header>
              <h3>Routing across targets</h3>
            </header>
            {protocolIds.map((id) => {
              const sources = currentReports.flatMap((r) =>
                r.protocols.filter((p) => p.id === id),
              );
              const usable = sources.filter((p) => p.current);
              const counts: Record<string, number> = {};
              usable.forEach((source) =>
                Object.entries(source.counts).forEach(([state, count]) => {
                  counts[state] = (counts[state] ?? 0) + count;
                }),
              );
              return (
                <div key={id} className="telemetry-routing-source">
                  <p>
                    {sources[0]?.title ??
                      {
                        bgp_peers: "BGP peers",
                        bgp_vrf_peers: "BGP VRF peers",
                        ospf_neighbors: "OSPF neighbors",
                        eigrp_neighbors: "EIGRP neighbors",
                      }[id]}
                    : {usable.length} / {selected.length} current targets
                  </p>
                  {usable.length ? (
                    <p>{countText(counts) || "0 observed rows"}</p>
                  ) : (
                    <p>No current compatible observation.</p>
                  )}
                </div>
              );
            })}
            <p className="telemetry-muted">
              Sources remain separate. Configured-peer totals are unknown.
            </p>
          </section>
          <section className="telemetry-panel">
            <header>
              <h3>Observations</h3>
            </header>
            {selected.flatMap((t) =>
              t.diagnostics.map((d, i) => (
                <p key={`${t.target_id}:${i}`}>
                  {t.display_name}: {d.message}
                </p>
              )),
            )}
            {props.snapshot.diagnostics.map((d, i) => (
              <p key={i}>{d.message}</p>
            ))}
            <p className="telemetry-muted">
              Stopped and stale values are retained observations; missing values
              do not contribute zero.
            </p>
          </section>
          {props.snapshot.targets.some(
            (t) => t.target_id === "local" && t.monitoring_selected,
          ) ? (
            <LocalSummary {...props} />
          ) : (
            <section className="telemetry-panel" aria-label="Local PC summary">
              <header>
                <h3>Local PC</h3>
              </header>
              <p>Local monitoring is not selected.</p>
            </section>
          )}
        </aside>
      </div>
      {selected.length > 0 && (
        <section>
          <label className="telemetry-filter">
            Interface detail target
            <select
              value={interfaceTarget}
              onChange={(e) => setInterfaceTarget(e.target.value)}
            >
              <option value="">Select a target</option>
              {selected.map((t) => (
                <option key={t.target_id} value={t.target_id}>
                  {t.display_name}
                </option>
              ))}
            </select>
          </label>
          {selected.some((t) => t.target_id === interfaceTarget) && (
            <FleetTraffic
              key={interfaceTarget}
              {...props}
              targetId={interfaceTarget}
            />
          )}
        </section>
      )}
    </section>
  );
}

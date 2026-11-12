import { useState } from "react";
import { semanticWidget, repeatedTotal, processorPool } from "./dashboard";
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
import type { TargetStatus } from "./types";
import { DeviceView } from "./DeviceView";

function FleetTarget({
  target,
  onSelect,
  ...props
}: DashboardProps & { target: TargetStatus; onSelect?: () => void }) {
  const data = useDashboard(props, target.target_id, "fleet");
  const semantic = (id: string): LoadedWidget | undefined => {
    const d = data.catalog && semanticWidget(data.catalog, id);
    return data.widgets.find(
      (w) => w.definition.widget === d?.widget && !w.previousSource,
    );
  };
  const cpu = semantic("cpu"),
    memory = semantic("memory"),
    ports = semantic("port_status") ?? semantic("interfaces");
  const cpuValue = cpu ? repeatedTotal(cpu.page.rows, "cpu_5s_percent") : null,
    memoryValue = memory ? processorPool(memory.page.rows) : null;
  const protocols = [
    "bgp_peers",
    "bgp_vrf_peers",
    "ospf_neighbors",
    "eigrp_neighbors",
  ]
    .map((id) => semantic(id))
    .filter((w): w is LoadedWidget => !!w);
  const usable = (w: LoadedWidget | undefined) =>
    w && ["fresh", "stale", "stopped"].includes(w.page.metadata.state);
  const attention = props.snapshot.widgets
    .filter((w) => w.target_id === target.target_id)
    .map((w) => w.severity);
  const severity = attention.includes("alert")
    ? "alert"
    : attention.includes("warn")
      ? "warn"
      : attention.length
        ? "ok"
        : "info";
  return (
    <tr>
      <td>
        <button onClick={onSelect}>{target.display_name}</button>
      </td>
      <td>{collectionLabel(target.state)}</td>
      <td>{conditionLabel(severity)}</td>
      <td>{usable(cpu) && cpuValue !== null ? `${cpuValue} %` : "Unknown"}</td>
      <td>
        {usable(memory) && memoryValue !== null
          ? `${Number(memoryValue.toFixed(1))} %`
          : "Unknown"}
      </td>
      <td>
        {usable(ports)
          ? `${ports!.page.rows.length} (${ports!.definition.title})`
          : "Unknown"}
      </td>
      <td>
        {protocols.length
          ? protocols.map((w) => (
              <div key={w.definition.widget}>
                {w.definition.title}:{" "}
                {usable(w)
                  ? Object.entries(
                      w.page.rows.reduce<Record<string, number>>(
                        (counts, row) => {
                          const state = metricText(row.fields.state);
                          counts[state] = (counts[state] ?? 0) + 1;
                          return counts;
                        },
                        {},
                      ),
                    )
                      .map(([state, count]) => `${state}: ${count}`)
                      .join(", ")
                  : collectionLabel(w.page.metadata.state)}
              </div>
            ))
          : "Unknown"}
      </td>
      <td>
        <time>{sampleTime(target.last_success_at_ms)}</time>
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
export function FleetView(
  props: DashboardProps & { onSelectTarget?: (targetId: string) => void },
) {
  const selected = props.snapshot.targets.filter(
    (t) => t.platform && t.monitoring_selected,
  );
  const [interfaceTarget, setInterfaceTarget] = useState("");
  const reporting = selected.filter(
    (t) => props.snapshot.running && t.state === "fresh",
  ).length;
  const attention = selected.filter((t) =>
    props.snapshot.widgets.some(
      (w) =>
        w.target_id === t.target_id && ["warn", "alert"].includes(w.severity),
    ),
  ).length;
  const gaps = selected.filter((t) =>
    ["failed", "stale", "unsupported", "not_configured"].includes(t.state),
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
            <p>
              Routing counts cover observed rows per source. Configured-peer
              totals are unknown.
            </p>
            <p className="telemetry-muted">
              Stopped and stale values are retained observations; missing values
              do not contribute zero.
            </p>
          </section>
          <section className="telemetry-panel">
            <header>
              <h3>Local PC</h3>
            </header>
            <p>
              {props.snapshot.targets.find((t) => t.target_id === "local")
                ? collectionLabel(
                    props.snapshot.targets.find((t) => t.target_id === "local")!
                      .state,
                  )
                : "Local monitoring is not selected"}
            </p>
            <p className="telemetry-muted">
              Inspect actual host metrics in Local PC.
            </p>
          </section>
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
          {interfaceTarget && (
            <DeviceView {...props} targetId={interfaceTarget} />
          )}
        </section>
      )}
    </section>
  );
}

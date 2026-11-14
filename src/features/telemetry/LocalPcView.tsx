import { useState } from "react";
import { ConfiguredSection } from "./DeviceView";
import { useDashboard, type DashboardProps } from "./useDashboard";
import { collectionLabel } from "./WidgetPanel";

export function LocalPcView(props: DashboardProps) {
  const [sectionId, setSection] = useState("");
  const [historyRows, setHistoryRows] = useState<Record<string, string>>({});
  const data = useDashboard(
    props,
    "local",
    "detail",
    sectionId,
    undefined,
    historyRows,
  );
  const target = props.snapshot.targets.find((t) => t.target_id === "local");
  const sections =
    data.catalog?.effective.layouts
      .filter((l) => !l.platforms.length)
      .flatMap((l) => l.sections) ?? [];
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  return (
    <section aria-label="Local PC dashboard">
      <h2>This computer</h2>
      <p className="telemetry-muted">
        Read-only OS collectors · Rolling hour in memory ·{" "}
        {target
          ? collectionLabel(target.state)
          : "Local monitoring is not selected"}
      </p>
      {sections.length > 1 && (
        <nav aria-label="Local sections" className="telemetry-section-nav">
          {sections.map((s) => (
            <button
              key={s.id}
              aria-pressed={s.id === section?.id}
              onClick={() => setSection(s.id)}
            >
              {s.title}
            </button>
          ))}
        </nav>
      )}
      {data.errors.map((e, i) => (
        <p role="status" key={i}>
          {e}
        </p>
      ))}
      {data.loading && <p role="status">Loading current observations…</p>}
      {data.catalogError && <button onClick={data.reload}>Retry observations</button>}
      {section && (
        <ConfiguredSection
          key={section.id}
          section={section}
          definitions={data.catalog?.effective.widgets ?? []}
          widgets={data.widgets}
          series={data.series}
          historyRows={historyRows}
          onHistoryRow={(id, key) =>
            setHistoryRows({ ...historyRows, [id]: key })
          }
        />
      )}
      {!data.loading && !data.catalogError && !sections.length && (
        <p>No Local PC layout is configured.</p>
      )}
    </section>
  );
}

import { useEffect, useId, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SeriesPage, SeriesPoint } from "./types";

export function chartPoints(points: SeriesPoint[]): SeriesPoint[] {
  const finite = points
    .filter((p) => Number.isFinite(p.at_ms))
    .flatMap((p) => {
      const point = { ...p, value: p.value !== null && Number.isFinite(p.value) ? p.value : null };
      return point.value !== null && point.reason?.startsWith("Collection resumed after ")
        ? [{ ...point, value: null }, point]
        : [point];
    });
  if (finite.length <= 600) return finite;
  const keep = new Set([0, finite.length - 1]);
  finite.forEach((p, i) => {
    if (p.value === null) {
      keep.add(i);
      if (i) keep.add(i - 1);
      if (i + 1 < finite.length) keep.add(i + 1);
    }
  });
  if (keep.size > 600) return [];
  const buckets = Math.floor((600 - keep.size) / 2);
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * finite.length) / buckets),
      end = Math.floor(((b + 1) * finite.length) / buckets);
    let min = start,
      max = start;
    for (let i = start; i < end; i++) {
      if ((finite[i].value ?? Infinity) < (finite[min].value ?? Infinity))
        min = i;
      if ((finite[i].value ?? -Infinity) > (finite[max].value ?? -Infinity))
        max = i;
    }
    keep.add(min);
    keep.add(max);
  }
  return [...keep].sort((a, b) => a - b).map((i) => finite[i]);
}
export function TelemetryChart({
  series,
  unit,
  title,
}: {
  series: SeriesPage;
  unit: string;
  title: string;
}) {
  const id = useId(),
    [offset, setOffset] = useState(0),
    points = chartPoints(series.points);
  const lastOffset = Math.floor(Math.max(0, series.points.length - 1) / 100) * 100;
  const pageOffset = Math.min(offset, lastOffset);
  useEffect(() => setOffset((previous) => Math.min(previous, lastOffset)), [lastOffset]);
  const start = points[0]?.at_ms,
    end = points[points.length - 1]?.at_ms;
  const domain: [number, number] =
    start !== undefined && end !== undefined
      ? start === end
        ? [start - 1000, end + 1000]
        : [start, end]
      : [0, 1];
  const slice = series.points.slice(pageOffset, pageOffset + 100);
  return (
    <figure className="telemetry-chart" aria-labelledby={id}>
      <figcaption id={id}>
        {title}
        {unit ? ` (${unit})` : ""}
      </figcaption>
      <p className="telemetry-muted">
        Retained observations; gaps remain unavailable. {series.points.length}{" "}
        display points. History values may round; latest tables preserve exact source counters.
      </p>
      {points.length ? (
        <div
          className="telemetry-chart-plot"
          role="img"
          aria-label={`${title}, time axis, ${unit || "no declared unit"}; collection gaps break the line`}
        >
          <ResponsiveContainer width="100%" height={210} minWidth={0}>
            <LineChart
              data={points}
              margin={{ left: 12, right: 20, top: 12, bottom: 8 }}
            >
              <CartesianGrid
                stroke="var(--border-default)"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="at_ms"
                type="number"
                scale="time"
                domain={domain}
                tickFormatter={(v) => new Date(v).toLocaleTimeString()}
                stroke="var(--text-secondary)"
              />
              <YAxis
                stroke="var(--text-secondary)"
                width={65}
                unit={unit}
                domain={["auto", "auto"]}
              />
              <Tooltip
                labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                contentStyle={{
                  background: "var(--surface-2)",
                  borderColor: "var(--border-strong)",
                  color: "var(--text-primary)",
                }}
              />
              <Legend />
              <Line
                name={title}
                dataKey="value"
                type="linear"
                stroke="var(--accent)"
                dot={points.length < 60 ? { r: 2 } : false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p>
          {series.points.length
            ? "Too many discontinuities to plot within 600 points. Inspect exact values below."
            : "No retained series available."}
        </p>
      )}
      <details>
        <summary>Recorded display values</summary>
        <div className="telemetry-table-scroll">
          <table aria-label={`${title} recorded display values`}>
            <thead>
              <tr>
                <th>Observed</th>
                <th>Value{unit ? ` (${unit})` : ""}</th>
                  <th>Gap or unavailable reason</th>
              </tr>
            </thead>
            <tbody>
              {slice.map((p, i) => (
                <tr key={`${p.at_ms}:${i}`}>
                  <td>
                    <time dateTime={new Date(p.at_ms).toISOString()}>
                      {new Date(p.at_ms).toLocaleString()}
                    </time>
                  </td>
                  <td>{p.value === null ? "Unknown" : p.value}</td>
                  <td>{p.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          disabled={!pageOffset}
          onClick={() => setOffset(Math.max(0, pageOffset - 100))}
        >
          Previous values
        </button>
        <button
          disabled={pageOffset + 100 >= series.points.length}
          onClick={() => setOffset(pageOffset + 100)}
        >
          Next values
        </button>
      </details>
    </figure>
  );
}

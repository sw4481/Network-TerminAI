import { useId } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ResolvedCanvasCard } from "../../lib/copilotCanvas";

const numericTickCount = 5;
const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumSignificantDigits: 3 });
const numericTick = (value: number) => {
  const text = compactNumber.format(value);
  return text.length <= 12 ? text : value.toExponential(2);
};
const categoryTick = (value: string | number) => String(value).length > 16 ? `${String(value).slice(0, 15)}…` : String(value);

export function CanvasChart({ card }: { card: Extract<ResolvedCanvasCard, { type: "chart" }> }) {
  const helpId = useId();
  const { form, x_label, y_label, points } = card.metadata;
  const Chart = form === "bar" ? BarChart : LineChart;
  // Unique ordinal categories keep duplicate labels distinct in Recharts' axis tooltip lookup.
  const data = points.map((point, category) => ({ category, value: point.value }));
  const domain = points.reduce<[number, number]>(([min, max], point) => [Math.min(min, point.value), Math.max(max, point.value)], [0, 0]);
  if (domain[0] === domain[1]) domain[1] = 1;
  const span = domain[1] - domain[0];
  // Recharts' automatic tick step must not overflow or round to zero.
  if (!Number.isFinite(span) || span / (numericTickCount - 1) === 0)
    return <p role="note" className="canvas-muted">Chart range cannot be plotted safely; exact source values are shown below.</p>;
  return <div className="canvas-chart" role="region" aria-label={`${card.title} chart`} aria-describedby={helpId}>
    <p className="canvas-chart-axis">{y_label}</p>
    <ResponsiveContainer width="100%" height={260} minWidth={0}>
      <Chart data={data} accessibilityLayer aria-label={`${card.title}: ${y_label} by ${x_label}`} aria-describedby={helpId} margin={{ top: 12, right: 24, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border-default)" />
        <XAxis dataKey="category" type="category" allowDuplicatedCategory tickFormatter={category => categoryTick(points[Number(category)]?.label ?? "")} tick={{ fill: "var(--text-secondary)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--border-default)" }} minTickGap={20} />
        <YAxis type="number" domain={domain} tickCount={numericTickCount} tickFormatter={numericTick} tick={{ fill: "var(--text-secondary)", fontSize: 11 }} tickLine={false} axisLine={false} width={58} />
        <ReferenceLine y={0} stroke="var(--border-default)" />
        <Tooltip labelFormatter={category => points[Number(category)]?.label ?? ""} isAnimationActive={false} cursor={{ stroke: "var(--border-default)", fill: "var(--surface-2)" }} contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border-default)", borderRadius: 6, color: "var(--text-primary)", whiteSpace: "normal", overflowWrap: "anywhere", maxWidth: 240 }} labelStyle={{ color: "var(--text-secondary)" }} itemStyle={{ color: "var(--text-primary)" }} />
        {form === "bar"
          ? <Bar dataKey="value" name={y_label} fill="var(--accent)" maxBarSize={24} isAnimationActive={false} />
          : <Line dataKey="value" name={y_label} type="linear" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dot={{ r: 4, fill: "var(--accent)", stroke: "var(--surface-1)", strokeWidth: 2 }} activeDot={{ r: 5, fill: "var(--accent)", stroke: "var(--surface-1)", strokeWidth: 2 }} isAnimationActive={false} />}
      </Chart>
    </ResponsiveContainer>
    <p className="canvas-chart-axis canvas-chart-x-axis">{x_label}</p>
    <p id={helpId} className="canvas-muted">Supplied order; no time interval inferred. Tab to the chart; use Left and Right arrows to inspect values. Exact labels and values are in the source table below.</p>
  </div>;
}

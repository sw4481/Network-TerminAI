import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasCard } from "./CanvasCard";
import { CanvasReferenceResolver, type CanvasCard as SourceCard, type EvidenceSnapshot, type ResolvedCanvasCard } from "../../lib/copilotCanvas";

type ChartCard = Extract<ResolvedCanvasCard, { type: "chart" }>;
const points = [{ label: "Duplicate", value: 0 }, { label: "Duplicate", value: -2.5 }, { label: 1, value: 4.25 }, { label: "1", value: 8 }];
function card(form: "bar" | "line", values = points): ChartCard {
  return { card_id: "chart", workspace_id: "w1", run_id: "r1", created_at: "2026-10-27T10:00:00Z", title: "Exact supplied values", type: "chart", source_refs: [], metadata: { form, x_label: "Device", y_label: "CRC", points: values } };
}

// Give the real Recharts renderer deterministic dimensions; no chart components are mocked.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.id === "recharts_measurement_span" ? (this.textContent?.length ?? 0) * 6 : 600;
    const height = this.id === "recharts_measurement_span" ? 14 : 300;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() {} };
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function plot() {
  const region = screen.getByRole("region", { name: "Exact supplied values chart" });
  return within(region).getByRole("application", { name: "Exact supplied values: CRC by Device" });
}

describe("Canvas quantitative chart adapter", () => {
  it.each([null, false, NaN, Infinity, -Infinity, 0])("leaves numeric trust-boundary validation with the existing resolver: %s", value => {
    const source: EvidenceSnapshot = { evidence_id: "e1", workspace_id: "w1", run_id: "r1", call_id: "call1", collected_at: "2026-10-27T10:00:00Z", source: { helper: "synthetic.read" }, origin: "observed", complete: true, limitation: null, parent_refs: [], calculation: null, data: { label: "Only", value } };
    const candidate: SourceCard = { ...card("bar"), source_refs: [{ evidence_id: "e1", path: "" }], metadata: { form: "bar", x_label: "Device", y_label: "CRC", points: [{ label: { evidence_id: "e1", path: "/label" }, value: { evidence_id: "e1", path: "/value" } }] } };
    const result = new CanvasReferenceResolver([source]).resolveCard(candidate);
    expect(result.ok).toBe(value === 0);
    if (result.ok && result.card.type === "chart") expect(result.card.metadata.points).toEqual([{ label: "Only", value: 0 }]);
  });
  it.each(["bar", "line"] as const)("renders an accessible real %s plot without changing source values or order", form => {
    const original = card(form);
    const before = JSON.stringify(original);
    render(<CanvasCard card={original} />);
    const svg = plot();
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg).toHaveAttribute("tabindex", "0");
    expect(svg.querySelector(".recharts-cartesian-grid")).not.toBeNull();
    expect(screen.getByText(/Supplied order; no time interval inferred/)).toBeInTheDocument();
    expect(screen.getByText(/Tab to the chart; use Left and Right arrows/)).toBeInTheDocument();
    const source = screen.getByRole("region", { name: "Exact supplied values source values" });
    expect(source).toHaveAttribute("tabindex", "0");
    const rows = within(source).getAllByRole("row");
    expect(rows.map(row => [...row.children].map(cell => cell.textContent))).toEqual([
      ["Device", "CRC"], ["Duplicate", "0"], ["Duplicate", "-2.5"], ["1", "4.25"], ["1", "8"],
    ]);
    expect(svg.querySelector(".recharts-legend-wrapper")).toBeNull();
    expect(screen.queryByText(/adapter unavailable|pending Task 6/)).toBeNull();
    expect(JSON.stringify(original)).toBe(before);
  });

  it("keeps duplicate and typed labels at separate categorical positions and negative bars below zero", () => {
    render(<CanvasCard card={card("bar")} />);
    const svg = plot();
    const bars = [...svg.querySelectorAll(".recharts-bar-rectangle path")];
    // Zero has no area, so Recharts correctly omits its path rather than inventing a minimum bar.
    expect(bars).toHaveLength(points.filter(point => point.value !== 0).length);
    expect(new Set(bars.map(bar => bar.getAttribute("x"))).size).toBe(bars.length);
    bars.forEach(bar => expect(Number(bar.getAttribute("width"))).toBeLessThanOrEqual(24));
    expect(Number(bars[0].getAttribute("height"))).toBeLessThan(0);
    expect(Number(bars[0].getAttribute("y"))).toBeGreaterThan(Number(bars[1].getAttribute("y")));
    expect(svg.querySelectorAll(".recharts-reference-line")).toHaveLength(1);
  });

  it("uses unsmoothed lines, visible ringed dots and separate positions for every supplied point", () => {
    render(<CanvasCard card={card("line")} />);
    const svg = plot();
    const line = svg.querySelector(".recharts-line-curve")!;
    expect(line).toHaveAttribute("stroke-width", "2");
    expect(line.getAttribute("d")).not.toMatch(/[CQ]/);
    const dots = [...svg.querySelectorAll(".recharts-line-dot")];
    expect(dots).toHaveLength(points.length);
    expect(new Set(dots.map(dot => dot.getAttribute("cx"))).size).toBe(points.length);
    dots.forEach(dot => {
      expect(Number(dot.getAttribute("r"))).toBeGreaterThanOrEqual(4);
      expect(dot).toHaveAttribute("stroke-width", "2");
      expect(dot).toHaveAttribute("stroke", "var(--surface-1)");
    });
  });

  it.each(["bar", "line"] as const)("exposes exact %s tooltip values through keyboard navigation", async form => {
    render(<CanvasCard card={card(form)} />);
    const svg = plot();
    await act(async () => svg.focus());
    const tooltip = await screen.findByRole("status");
    expect(tooltip).toHaveTextContent("Duplicate");
    expect(tooltip).toHaveTextContent("CRC");
    expect(tooltip).toHaveTextContent("0");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    await waitFor(() => expect(tooltip).toHaveTextContent("-2.5"));
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    await waitFor(() => expect(tooltip).toHaveTextContent("4.25"));
  });

  it.each(["bar", "line"] as const)("renders singleton, all-zero and all-negative %s data without inventing points", form => {
    const { rerender } = render(<CanvasCard card={card(form, [{ label: "Only", value: 3.5 }])} />);
    const count = () => plot().querySelectorAll(form === "bar" ? ".recharts-bar-rectangle path" : ".recharts-line-dot").length;
    expect(count()).toBe(1);
    if (form === "line") expect(plot().querySelector(".recharts-line-curve")).toBeNull();
    for (const values of [[{ label: "A", value: 0 }, { label: "B", value: 0 }], [{ label: "A", value: -2.5 }, { label: "B", value: -1 }]]) {
      rerender(<CanvasCard card={card(form, values)} />);
      expect(count()).toBe(form === "bar" ? values.filter(point => point.value !== 0).length : values.length);
      expect(plot().querySelector(".recharts-yAxis")).toHaveTextContent("0");
      expect(plot().innerHTML).not.toMatch(/NaN|Infinity/);
    }
  });

  it.each([1e-308, 1e308])("keeps numeric axis tick text bounded for valid extreme magnitude %s", value => {
    render(<CanvasCard card={card("line", [{ label: "Only", value }])} />);
    const ticks = [...plot().querySelectorAll(".recharts-yAxis text")];
    expect(ticks.length).toBeGreaterThan(0);
    ticks.forEach(tick => expect(tick.textContent!.length).toBeLessThanOrEqual(16));
    expect(within(screen.getByRole("region", { name: "Exact supplied values source values" })).getByRole("cell")).toHaveTextContent(String(value));
  });

  it.each(["bar", "line"] as const)("falls back honestly before %s tick generation when the finite rough step underflows", form => {
    const { rerender, container } = render(<CanvasCard card={card(form, [{ label: "Only", value: Number.MIN_VALUE }])} />);
    for (const value of [Number.MIN_VALUE, -Number.MIN_VALUE, 2 * Number.MIN_VALUE]) {
      rerender(<CanvasCard card={card(form, [{ label: "Only", value }])} />);
      expect(container.querySelector("svg")).toBeNull();
      expect(screen.getByRole("note")).toHaveTextContent("Chart range cannot be plotted safely; exact source values are shown below.");
      expect(within(screen.getByRole("region", { name: "Exact supplied values source values" })).getByRole("cell")).toHaveTextContent(String(value));
    }
  });

  it.each(["bar", "line"] as const)("falls back honestly when finite %s values overflow the numeric plotting span", form => {
    const values = [{ label: "Minimum", value: -1e308 }, { label: "Maximum", value: 1e308 }];
    const { container } = render(<CanvasCard card={card(form, values)} />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("Chart range cannot be plotted safely; exact source values are shown below.");
    const source = screen.getByRole("region", { name: "Exact supplied values source values" });
    expect(within(source).getAllByRole("row").map(row => [...row.children].map(cell => cell.textContent))).toEqual([
      ["Device", "CRC"], ["Minimum", "-1e+308"], ["Maximum", "1e+308"],
    ]);
  });

  it.each(["bar", "line"] as const)("keeps an inspected %s chart safe when a later render supplies fewer points", async form => {
    const { rerender } = render(<CanvasCard card={card(form)} />);
    await act(async () => plot().focus());
    for (let index = 0; index < 3; index++) fireEvent.keyDown(plot(), { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("8"));
    rerender(<CanvasCard card={card(form, [{ label: "Only", value: 1 }])} />);
    expect(screen.getByRole("table")).toHaveTextContent("Only");
    expect(plot()).toBeInTheDocument();
  });

  it.each(["bar", "line"] as const)("keeps hostile %s labels as inert text in axes, source table and keyboard tooltip", async form => {
    const hostile = '<img src=x onerror=alert(1)><script>throw 1</script>';
    const value = card(form, [{ label: hostile, value: -0.125 }, { label: "__proto__", value: 1 }]);
    value.title = hostile;
    value.metadata.x_label = hostile;
    value.metadata.y_label = hostile;
    const { container } = render(<CanvasCard card={value} />);
    const svg = container.querySelector('svg[role="application"]')!;
    act(() => (svg as SVGElement).focus());
    const tooltip = await screen.findByRole("status");
    expect(tooltip).toHaveTextContent(hostile);
    expect(tooltip).toHaveTextContent("-0.125");
    expect(screen.getByRole("table")).toHaveTextContent(hostile);
    expect(container.querySelector("img, script, foreignObject, a")).toBeNull();
  });
});

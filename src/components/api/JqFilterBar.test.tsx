import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { JqFilterBar } from "./JqFilterBar";
import { applyFilter } from "./jsonFilter";

describe("applyFilter (jsonFilter)", () => {
  it("passthrough for empty / whitespace filters", () => {
    const r = applyFilter("   ", { a: 1 });
    expect(r.kind).toBe("empty");
    if (r.kind === "empty") expect(r.value).toEqual({ a: 1 });
  });

  it("extracts an array of values via $[*].id", () => {
    const r = applyFilter("$[*].id", [{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.value).toEqual([1, 2, 3]);
  });

  it("unwraps single-element results", () => {
    const r = applyFilter("$.name", { name: "meraki" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.value).toBe("meraki");
  });

  it("accepts $-less shorthand", () => {
    const r = applyFilter("name", { name: "meraki" });
    if (r.kind === "ok") expect(r.value).toBe("meraki");
  });

  it("invalid expression → error result, not a throw", () => {
    // A script-filter with a syntax error throws inside jsonpath-plus.
    // Our wrapper must catch it and return a structured error.
    const r = applyFilter("$[?(!!!)", [{ x: 3 }]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toBeTruthy();
  });
});

describe("JqFilterBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the current value", () => {
    render(
      <JqFilterBar value="$.foo" onChange={() => {}} />,
    );
    const input = screen.getByTestId("api-jq-filter") as HTMLInputElement;
    expect(input.value).toBe("$.foo");
  });

  it("debounces onChange by 150ms", () => {
    const onChange = vi.fn();
    render(<JqFilterBar value="" onChange={onChange} />);
    const input = screen.getByTestId("api-jq-filter");
    fireEvent.change(input, { target: { value: "$" } });
    fireEvent.change(input, { target: { value: "$." } });
    fireEvent.change(input, { target: { value: "$.foo" } });
    // Before the debounce timer elapses, nothing has fired.
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("$.foo");
  });

  it("renders the error prop as red border + tooltip text", () => {
    render(
      <JqFilterBar
        value="$.foo"
        onChange={() => {}}
        error="syntax error"
      />,
    );
    const input = screen.getByTestId("api-jq-filter");
    // jsdom normalizes inline hex colors to rgb(). Assert via the computed
    // style component rather than the exact string.
    const border = (input as HTMLElement).style.border;
    expect(border).toContain("var(--status-danger)");
    expect(screen.getByTestId("api-jq-filter-error").textContent).toContain(
      "syntax error",
    );
  });

  it("clear button resets draft and fires onChange('')", () => {
    const onChange = vi.fn();
    render(<JqFilterBar value="$.foo" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("api-jq-filter-clear"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});

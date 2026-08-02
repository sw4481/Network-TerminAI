import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArrayTableView } from "./ArrayTableView";

describe("ArrayTableView", () => {
  it("shows the empty-array placeholder", () => {
    render(<ArrayTableView rows={[]} />);
    expect(screen.getByTestId("api-table-empty")).toBeDefined();
  });

  it("shows the non-object placeholder when array has only scalars", () => {
    render(<ArrayTableView rows={[1, 2, 3]} />);
    expect(screen.getByTestId("api-table-not-objects")).toBeDefined();
  });

  it("renders every row with a header row of union keys", () => {
    render(
      <ArrayTableView
        rows={[
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ]}
      />,
    );
    expect(screen.getByTestId("api-table-header-id")).toBeDefined();
    expect(screen.getByTestId("api-table-header-name")).toBeDefined();
    expect(screen.getByTestId("api-table-row-0")).toBeDefined();
    expect(screen.getByTestId("api-table-row-1")).toBeDefined();
  });

  it("union of keys includes columns that appear only on some rows", () => {
    render(
      <ArrayTableView
        rows={[
          { id: 1, name: "a" },
          { id: 2, status: "online" },
        ]}
      />,
    );
    expect(screen.getByTestId("api-table-header-id")).toBeDefined();
    expect(screen.getByTestId("api-table-header-name")).toBeDefined();
    expect(screen.getByTestId("api-table-header-status")).toBeDefined();
  });

  it("renders missing cells as an em-dash", () => {
    const { container } = render(
      <ArrayTableView
        rows={[
          { id: 1, name: "a" },
          { id: 2 },
        ]}
      />,
    );
    // The second row's `name` cell should show "—".
    expect(container.textContent).toContain("—");
  });

  it("sorts alphanumerically when header is clicked", () => {
    render(
      <ArrayTableView
        rows={[
          { id: 3, name: "c" },
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ]}
      />,
    );
    // Clicking name header (strings sort via default alphanumeric fn).
    const nameHeader = screen.getByTestId("api-table-header-name");
    fireEvent.click(nameHeader);
    let rows = document.querySelectorAll("[data-testid^='api-table-row-']");
    // Rows render as id-then-name (e.g. "1a"), so just match the id order.
    expect(rows[0].textContent).toContain("1");
    expect(rows[1].textContent).toContain("2");
    expect(rows[2].textContent).toContain("3");
    // Second click reverses order.
    fireEvent.click(nameHeader);
    rows = document.querySelectorAll("[data-testid^='api-table-row-']");
    expect(rows[0].textContent).toContain("3");
    expect(rows[1].textContent).toContain("2");
    expect(rows[2].textContent).toContain("1");
  });

  it("complex (nested) cell values are rendered as compact JSON", () => {
    const { container } = render(
      <ArrayTableView
        rows={[{ id: 1, coords: { lat: 37, lng: -122 } }]}
      />,
    );
    expect(container.textContent).toContain('{"lat":37');
  });

  it("calls onCellContext when the cell is right-clicked", () => {
    const cb = vi.fn();
    render(
      <ArrayTableView
        rows={[{ id: 1, name: "first" }]}
        onCellContext={cb}
      />,
    );
    // Find the name cell and right-click the inner span.
    const cells = screen.getAllByTestId(/api-table-cell-name/);
    fireEvent.contextMenu(cells[0]);
    expect(cb).toHaveBeenCalledOnce();
    const [value, column, row] = cb.mock.calls[0];
    expect(value).toBe("first");
    expect(column).toBe("name");
    expect(row).toEqual({ id: 1, name: "first" });
  });

  it(
    "tolerates a 10k-row array without crashing",
    () => {
      const rows = Array.from({ length: 10_000 }, (_, i) => ({
        id: i,
        kind: i % 2 === 0 ? "even" : "odd",
      }));
      const t0 = performance.now();
      render(<ArrayTableView rows={rows} />);
      const dt = performance.now() - t0;
      // Generous: shared CI runners are variable; this is a crash guard, not a benchmark.
      expect(dt).toBeLessThan(10_000);
      // Spot-check the first and last rows.
      expect(screen.getByTestId("api-table-row-0")).toBeDefined();
      expect(screen.getByTestId("api-table-row-9999")).toBeDefined();
    },
    15_000,
  );
});

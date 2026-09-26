import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CellStatusChip } from "./CellStatusChip";

describe("CellStatusChip", () => {
  it("renders pending state with default label", () => {
    render(<CellStatusChip status="pending" />);
    const chip = screen.getByTestId("cell-status-chip");
    expect(chip.dataset.status).toBe("pending");
    expect(chip).toHaveTextContent("pending");
  });

  it("renders running with role status and aria-label", () => {
    render(<CellStatusChip status="running" />);
    const chip = screen.getByTestId("cell-status-chip");
    expect(chip).toHaveAttribute("aria-label", "Currently running");
  });

  it("renders awaiting_approval label as 'awaiting approval'", () => {
    render(<CellStatusChip status="awaiting_approval" />);
    expect(screen.getByTestId("cell-status-chip")).toHaveTextContent("awaiting approval");
  });

  it("renders idle as pending", () => {
    render(<CellStatusChip status="idle" />);
    expect(screen.getByTestId("cell-status-chip").dataset.status).toBe("pending");
  });

  it("each status produces a distinct status data attribute", () => {
    const statuses: Array<"pending" | "running" | "passed" | "failed" | "skipped" | "awaiting_approval"> = [
      "pending",
      "running",
      "passed",
      "failed",
      "skipped",
      "awaiting_approval",
    ];
    for (const s of statuses) {
      const { unmount } = render(<CellStatusChip status={s} />);
      expect(screen.getByTestId("cell-status-chip").dataset.status).toBe(s);
      unmount();
    }
  });
});

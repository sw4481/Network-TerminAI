import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScheduleEditor } from "./ScheduleEditor";

describe("ScheduleEditor", () => {
  it("submits the cron expression on click", () => {
    const onSubmit = vi.fn();
    render(<ScheduleEditor onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId("schedule-submit"));
    expect(onSubmit).toHaveBeenCalled();
    const expr = onSubmit.mock.calls[0][0];
    expect(typeof expr).toBe("string");
    expect(expr.split(/\s+/).length).toBeGreaterThanOrEqual(5);
  });

  it("rejects malformed cron with an inline error", () => {
    const onSubmit = vi.fn();
    render(<ScheduleEditor onSubmit={onSubmit} onCancel={() => {}} />);
    const input = screen.getByTestId("schedule-cron") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bogus" } });
    fireEvent.click(screen.getByTestId("schedule-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/cron expression must have/i)).toBeInTheDocument();
  });
});

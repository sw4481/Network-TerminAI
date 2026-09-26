/**
 * Plan 12 Phase 5 Task 5.4 — AgentSourcesBadge tests.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentSourcesBadge } from "./AgentSourcesBadge";

describe("AgentSourcesBadge", () => {
  it("renders singular `1 doc` when count is 1", () => {
    render(<AgentSourcesBadge count={1} isOpen={false} onOpen={() => {}} />);
    expect(screen.getByText(/Sources · 1 doc$/)).toBeInTheDocument();
  });

  it("renders plural `N docs` when count > 1", () => {
    render(<AgentSourcesBadge count={3} isOpen={false} onOpen={() => {}} />);
    expect(screen.getByText(/Sources · 3 docs$/)).toBeInTheDocument();
  });

  it("renders down caret when collapsed", () => {
    render(<AgentSourcesBadge count={2} isOpen={false} onOpen={() => {}} />);
    const badge = screen.getByTestId("agent-sources-badge");
    expect(badge.textContent).toContain("▾");
    expect(badge.textContent).not.toContain("▴");
  });

  it("renders up caret + open suffix when isOpen is true", () => {
    render(<AgentSourcesBadge count={2} isOpen={true} onOpen={() => {}} />);
    const badge = screen.getByTestId("agent-sources-badge");
    expect(badge.textContent).toContain("▴");
    expect(badge.textContent).toContain("open");
  });

  it("sets aria-pressed to true when open", () => {
    render(<AgentSourcesBadge count={2} isOpen={true} onOpen={() => {}} />);
    expect(screen.getByTestId("agent-sources-badge")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("sets aria-pressed to false when closed", () => {
    render(<AgentSourcesBadge count={2} isOpen={false} onOpen={() => {}} />);
    expect(screen.getByTestId("agent-sources-badge")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("calls onOpen with the button element on click", () => {
    const onOpen = vi.fn();
    render(<AgentSourcesBadge count={2} isOpen={false} onOpen={onOpen} />);
    const btn = screen.getByTestId("agent-sources-badge");
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(btn);
  });

  it("applies the open modifier class when isOpen is true", () => {
    render(<AgentSourcesBadge count={1} isOpen={true} onOpen={() => {}} />);
    expect(screen.getByTestId("agent-sources-badge")).toHaveClass(
      "agent-sources-badge--open",
    );
  });
});

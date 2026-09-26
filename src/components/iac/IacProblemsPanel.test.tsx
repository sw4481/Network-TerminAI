import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { IacProblemsPanel } from "./IacProblemsPanel";

const diag = {
  line: 4,
  column: 2,
  severity: "error" as const,
  message: "Invalid expression",
  source: "terraform fmt",
};

describe("IacProblemsPanel", () => {
  it("renders the error count and a diagnostic row", () => {
    render(<IacProblemsPanel diagnostics={[diag]} linters={[]} onJumpTo={() => {}} />);
    expect(screen.getByText(/1 error/i)).toBeInTheDocument();
    expect(screen.getByText(/Invalid expression/)).toBeInTheDocument();
  });

  it("calls onJumpTo with line/column when a row is clicked", () => {
    const onJumpTo = vi.fn();
    render(<IacProblemsPanel diagnostics={[diag]} linters={[]} onJumpTo={onJumpTo} />);
    fireEvent.click(screen.getByTestId("iac-problem-0"));
    expect(onJumpTo).toHaveBeenCalledWith(4, 2);
  });

  it("shows honest linter status when a linter was skipped", () => {
    render(
      <IacProblemsPanel
        diagnostics={[]}
        linters={[
          { name: "terraform validate", ran: false, available: true, reason: "not initialized" },
        ]}
        onJumpTo={() => {}}
      />,
    );
    expect(screen.getByText(/terraform validate/)).toBeInTheDocument();
    expect(screen.getByText("skipped — not initialized")).toBeInTheDocument();
  });

  it("preserves the no-linters wording", () => {
    render(<IacProblemsPanel diagnostics={[]} linters={[]} onJumpTo={() => {}} />);

    expect(screen.getByText("No linters ran.")).toBeInTheDocument();
  });

  it("claims clean when one linter ran and another was skipped", () => {
    render(
      <IacProblemsPanel
        diagnostics={[]}
        linters={[
          { name: "terraform fmt", ran: true, available: true, reason: null },
          { name: "terraform validate", ran: false, available: true, reason: "not initialized" },
        ]}
        onJumpTo={() => {}}
      />,
    );

    expect(screen.getByText("No issues found.")).toBeInTheDocument();
    expect(screen.getByText("skipped — not initialized")).toBeInTheDocument();
  });

  it("only claims clean when at least one linter actually ran with no findings", () => {
    render(
      <IacProblemsPanel
        diagnostics={[]}
        linters={[{ name: "terraform fmt", ran: true, available: true, reason: null }]}
        onJumpTo={() => {}}
      />,
    );
    expect(screen.getByText(/No issues/i)).toBeInTheDocument();
  });
});

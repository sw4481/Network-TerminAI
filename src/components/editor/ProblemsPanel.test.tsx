import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProblemsPanel } from "./ProblemsPanel";

describe("ProblemsPanel", () => {
  it("renders exact counts and severity labels", () => {
    render(
      <ProblemsPanel
        diagnostics={[
          {
            line: 7,
            column: 3,
            endColumn: 8,
            severity: "error",
            message: "Unexpected exit",
            source: "cisco-structural",
            code: "unmatched-exit",
          },
          {
            line: 9,
            column: 1,
            severity: "warning",
            message: "Captured prompt",
            source: "cisco-structural",
            code: "cli-prompt",
          },
          {
            line: 12,
            column: 2,
            severity: "info",
            message: "Informational finding",
            source: "guardrails",
          },
        ]}
        statuses={[{ name: "Structural", state: "ready", reason: null }]}
        onJumpTo={() => {}}
      />,
    );

    expect(screen.getByText(/1 error, 2 warnings/i)).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("warning")).toBeInTheDocument();
    expect(screen.getByText("info")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /error: cisco-structural, line 7, column 3: Unexpected exit/i,
      }),
    ).toBeInTheDocument();
  });

  it("jumps to a one-based location on mouse activation", () => {
    const onJumpTo = vi.fn();
    render(
      <ProblemsPanel
        diagnostics={[
          {
            line: 7,
            column: 3,
            endColumn: 8,
            severity: "error",
            message: "Unexpected exit",
            source: "cisco-structural",
            code: "unmatched-exit",
          },
        ]}
        statuses={[{ name: "Structural", state: "ready", reason: null }]}
        onJumpTo={onJumpTo}
      />,
    );

    fireEvent.click(screen.getByTestId("problem-0"));
    expect(onJumpTo).toHaveBeenCalledWith(7, 3);
  });

  it("does not claim clean when a provider is unavailable", () => {
    render(
      <ProblemsPanel
        diagnostics={[]}
        statuses={[
          {
            name: "Guardrails",
            state: "unavailable",
            reason: "local classifier unavailable",
          },
        ]}
        onJumpTo={() => {}}
      />,
    );

    expect(screen.queryByText(/No issues found/i)).not.toBeInTheDocument();
    expect(screen.getByText(/local classifier unavailable/)).toBeInTheDocument();
  });

  it("renders running and idle provider statuses separately", () => {
    render(
      <ProblemsPanel
        diagnostics={[]}
        statuses={[
          { name: "Structural", state: "running", reason: null },
          { name: "Guardrails", state: "idle", reason: "waiting for content" },
        ]}
        onJumpTo={() => {}}
      />,
    );

    expect(screen.getByTestId("problem-status-Structural")).toHaveTextContent("running");
    expect(screen.getByTestId("problem-status-Guardrails")).toHaveTextContent(
      "idle — waiting for content",
    );
  });

  it("collapses and expands the problem list", () => {
    render(
      <ProblemsPanel
        diagnostics={[
          {
            line: 2,
            column: 1,
            severity: "warning",
            message: "Captured prompt",
            source: "cisco-structural",
          },
        ]}
        statuses={[]}
        onJumpTo={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Problems/ }));
    expect(screen.queryByTestId("problem-0")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Problems/ }));
    expect(screen.getByTestId("problem-0")).toBeInTheDocument();
  });

  it("supports keyboard activation for a problem row", () => {
    const onJumpTo = vi.fn();
    render(
      <ProblemsPanel
        diagnostics={[
          {
            line: 2,
            column: 1,
            severity: "warning",
            message: "Captured prompt",
            source: "cisco-structural",
            code: "cli-prompt",
          },
        ]}
        statuses={[]}
        onJumpTo={onJumpTo}
      />,
    );

    fireEvent.keyDown(screen.getByTestId("problem-0"), { key: "Enter" });
    expect(onJumpTo).toHaveBeenCalledWith(2, 1);
  });
});

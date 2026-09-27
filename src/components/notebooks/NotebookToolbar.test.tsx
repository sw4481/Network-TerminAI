import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NotebookToolbar } from "./NotebookToolbar";

describe("NotebookToolbar", () => {
  function setup(overrides: Partial<Parameters<typeof NotebookToolbar>[0]> = {}) {
    const props = {
      status: "idle" as const,
      canResumeFromFailure: false,
      onRun: vi.fn(),
      onStop: vi.fn(),
      onResume: vi.fn(),
      ...overrides,
    };
    render(<NotebookToolbar {...props} />);
    return props;
  }

  it("idle: only Run is enabled", () => {
    setup();
    expect(screen.getByTestId("toolbar-run")).not.toBeDisabled();
    expect(screen.getByTestId("toolbar-stop")).toBeDisabled();
    expect(screen.getByTestId("toolbar-resume")).toBeDisabled();
  });

  it("running: Stop is enabled, Run is disabled", () => {
    setup({ status: "running" });
    expect(screen.getByTestId("toolbar-run")).toBeDisabled();
    expect(screen.getByTestId("toolbar-stop")).not.toBeDisabled();
  });

  it("failed + canResumeFromFailure: Resume is enabled", () => {
    setup({ status: "failed", canResumeFromFailure: true });
    expect(screen.getByTestId("toolbar-resume")).not.toBeDisabled();
  });

  it("clicking Run fires onRun", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("toolbar-run"));
    expect(props.onRun).toHaveBeenCalledTimes(1);
  });

  it("clicking Stop fires onStop while running", () => {
    const props = setup({ status: "running" });
    fireEvent.click(screen.getByTestId("toolbar-stop"));
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it("clicking Resume fires onResume when failed", () => {
    const props = setup({ status: "failed", canResumeFromFailure: true });
    fireEvent.click(screen.getByTestId("toolbar-resume"));
    expect(props.onResume).toHaveBeenCalledTimes(1);
  });
});

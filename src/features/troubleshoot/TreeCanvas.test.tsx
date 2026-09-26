import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const emitMock = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => emitMock(event, payload),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { TreeCanvas } from "./TreeCanvas";
import { ControlBar } from "./ControlBar";
import { AwaitingUserModal } from "./AwaitingUserModal";
import { ConclusionBanner } from "./ConclusionBanner";
import { useTroubleshootStore } from "./store";

function seedRun(opts: {
  runId?: string;
  status?: "running" | "paused" | "completed" | "failed";
  awaiting?: boolean;
}) {
  const runId = opts.runId ?? "r1";
  useTroubleshootStore.getState().reset();
  useTroubleshootStore.getState().applyStepEvent({
    run_id: runId,
    step: {
      step_id: "check_state",
      idx: 0,
      status: "passed",
      result_json: { session_state: "Idle (Admin)" },
    },
    step_type: "command",
  });
  useTroubleshootStore.getState().applyStepEvent({
    run_id: runId,
    step: {
      step_id: "branch_state",
      idx: 1,
      status: "passed",
      result_json: { matched: "Idle (Admin)" },
    },
    step_type: "branch",
  });
  if (opts.awaiting) {
    useTroubleshootStore.getState().applyStepEvent({
      run_id: runId,
      step: {
        step_id: "approve_debug",
        idx: 2,
        status: "awaiting_user",
        result_json: { prompt: "Run debug ip bgp updates? (Tier-1)" },
      },
      step_type: "command",
    });
  }
  useTroubleshootStore.getState().applyStatusEvent({
    run_id: runId,
    status: opts.status ?? "running",
  });
  useTroubleshootStore.getState().setActiveRun(runId);
}

beforeEach(() => {
  invokeMock.mockReset();
  useTroubleshootStore.getState().reset();
});

describe("TreeCanvas", () => {
  it("renders the empty state when there is no active run", () => {
    render(<TreeCanvas />);
    expect(screen.getByTestId("tb-canvas-empty")).toBeInTheDocument();
  });

  it("renders one StepNode per step with status chip", () => {
    seedRun({});
    render(<TreeCanvas />);
    expect(screen.getByTestId("tb-step-node-check_state")).toBeInTheDocument();
    expect(screen.getByTestId("tb-step-node-branch_state")).toBeInTheDocument();
    // Status chip readable
    const node = screen.getByTestId("tb-step-node-check_state");
    expect(node.getAttribute("data-status")).toBe("passed");
  });

  it("renders an awaiting_user chip when the run pauses for input", () => {
    seedRun({ awaiting: true, status: "paused" });
    render(<TreeCanvas />);
    const awaitingNode = screen.getByTestId("tb-step-node-approve_debug");
    expect(awaitingNode.getAttribute("data-status")).toBe("awaiting_user");
  });
});

describe("ControlBar", () => {
  it("disables Pause when no run is active", () => {
    render(<ControlBar />);
    expect(
      (screen.getByTestId("tb-control-pause") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("invokes pause_run when Pause is clicked on a running run", async () => {
    seedRun({ status: "running" });
    invokeMock.mockResolvedValue(undefined);
    render(<ControlBar />);
    const pauseBtn = screen.getByTestId("tb-control-pause");
    expect((pauseBtn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(pauseBtn);
    });
    expect(invokeMock).toHaveBeenCalledWith("pause_run", { runId: "r1" });
  });

  it("only enables Resume when status is paused", () => {
    seedRun({ status: "paused" });
    render(<ControlBar />);
    expect(
      (screen.getByTestId("tb-control-resume") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("tb-control-pause") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables Cancel on terminal status", () => {
    seedRun({ status: "completed" });
    render(<ControlBar />);
    expect(
      (screen.getByTestId("tb-control-cancel") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("AwaitingUserModal", () => {
  it("does not render when there is no pending prompt", () => {
    seedRun({ status: "running" });
    render(<AwaitingUserModal />);
    expect(screen.queryByTestId("tb-aw-modal")).toBeNull();
  });

  it("renders with the prompt text when awaiting_user is set", () => {
    seedRun({ awaiting: true, status: "paused" });
    render(<AwaitingUserModal />);
    expect(screen.getByTestId("tb-aw-modal")).toBeInTheDocument();
    expect(screen.getByTestId("tb-aw-modal-prompt").textContent).toContain(
      "debug ip bgp updates",
    );
  });

  it("calls answer_prompt on Confirm", async () => {
    seedRun({ awaiting: true, status: "paused" });
    invokeMock.mockResolvedValue(undefined);
    render(<AwaitingUserModal />);
    fireEvent.change(screen.getByTestId("tb-aw-modal-input"), {
      target: { value: "yes" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("tb-aw-modal-confirm"));
    });
    expect(invokeMock).toHaveBeenCalledWith("answer_prompt", {
      runId: "r1",
      answer: "yes",
    });
  });

  it("Cancel clears the prompt locally without invoking the backend", () => {
    seedRun({ awaiting: true, status: "paused" });
    render(<AwaitingUserModal />);
    fireEvent.click(screen.getByTestId("tb-aw-modal-cancel"));
    expect(screen.queryByTestId("tb-aw-modal")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("ConclusionBanner", () => {
  it("does not render while the run is still running", () => {
    seedRun({ status: "running" });
    render(<ConclusionBanner />);
    expect(screen.queryByTestId("tb-conclusion-banner")).toBeNull();
  });

  it("renders the banner with all four conclusion fields on completed", () => {
    seedRun({ status: "completed" });
    useTroubleshootStore.getState().applyConclusionEvent({
      run_id: "r1",
      conclusion: {
        root_cause: "BGP neighbor administratively shut",
        confidence: "high",
        suggested_fix: "no neighbor 10.0.0.5 shutdown",
        evidence: ["step 0", "step 1"],
      },
    });
    render(<ConclusionBanner />);
    expect(screen.getByTestId("tb-conclusion-root-cause").textContent).toBe(
      "BGP neighbor administratively shut",
    );
    expect(screen.getByTestId("tb-conclusion-confidence").textContent).toBe(
      "high",
    );
    expect(screen.getByTestId("tb-conclusion-fix").textContent).toContain(
      "no neighbor 10.0.0.5 shutdown",
    );
    expect(screen.getByTestId("tb-conclusion-evidence-0").textContent).toBe(
      "step 0",
    );
  });

  it("Open editor emits the Tauri menu:troubleshoot_editor event", () => {
    emitMock.mockClear();
    seedRun({ status: "failed" });
    useTroubleshootStore.getState().applyConclusionEvent({
      run_id: "r1",
      conclusion: {
        root_cause: "interface down",
        confidence: "high",
        suggested_fix: "no shutdown",
        evidence: [],
      },
    });
    render(<ConclusionBanner />);
    fireEvent.click(screen.getByTestId("tb-conclusion-open-editor"));
    expect(emitMock).toHaveBeenCalledWith("menu:troubleshoot_editor", {
      runId: "r1",
    });
  });

  it("Dismiss hides the banner without affecting run state", () => {
    seedRun({ status: "completed" });
    useTroubleshootStore.getState().applyConclusionEvent({
      run_id: "r1",
      conclusion: {
        root_cause: "x",
        confidence: "low",
        suggested_fix: "y",
        evidence: [],
      },
    });
    render(<ConclusionBanner />);
    fireEvent.click(screen.getByTestId("tb-conclusion-dismiss"));
    expect(screen.queryByTestId("tb-conclusion-banner")).toBeNull();
    expect(useTroubleshootStore.getState().runs["r1"].conclusion).not.toBeNull();
  });
});

/**
 * Plan 15 Phase 4 — ControlBar.
 *
 * Buttons: Pause, Resume, Skip, Cancel, Mark Root Cause. Disabled state
 * is derived from the active run's status. Skip is a frontend-only
 * stub (no backend command exists) — it dispatches a CustomEvent so a
 * future Phase 6 task can wire it in without changing this surface.
 */
import { useState } from "react";
import {
  selectActiveRun,
  selectOrderedSteps,
  useTroubleshootStore,
} from "./store";
import "./ControlBar.css";

export function ControlBar() {
  const activeRun = useTroubleshootStore(selectActiveRun);
  const pauseRun = useTroubleshootStore((s) => s.pauseRun);
  const resumeRun = useTroubleshootStore((s) => s.resumeRun);
  const cancelRun = useTroubleshootStore((s) => s.cancelRun);
  const markRootCause = useTroubleshootStore((s) => s.markRootCause);
  const [busy, setBusy] = useState<null | "pause" | "resume" | "cancel" | "mark">(
    null,
  );

  const status = activeRun?.status ?? null;
  const runId = activeRun?.runId ?? null;
  const isTerminal = status === "completed" || status === "failed";
  const canPause = !!runId && status === "running";
  const canResume = !!runId && status === "paused";
  const canCancel = !!runId && !isTerminal;

  const orderedSteps = selectOrderedSteps(activeRun);
  const lastStep =
    orderedSteps.length > 0 ? orderedSteps[orderedSteps.length - 1] : null;

  const guard = async <T,>(
    label: typeof busy,
    fn: () => Promise<T>,
  ): Promise<void> => {
    if (!runId) return;
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      console.warn("[troubleshoot] action failed", label, e);
    } finally {
      setBusy(null);
    }
  };

  const onSkip = () => {
    document.dispatchEvent(
      new CustomEvent("troubleshoot:skip_requested", {
        detail: { runId, stepIdx: lastStep?.idx ?? null },
      }),
    );
  };

  const onMark = async () => {
    if (!runId || !lastStep) return;
    const note = window.prompt(
      `Note for root-cause on step ${lastStep.step_ref}:`,
      "",
    );
    if (note == null || note.trim() === "") return;
    await guard("mark", () => markRootCause(runId, lastStep.idx, note.trim()));
  };

  const onCancel = async () => {
    if (!runId) return;
    if (!window.confirm("Cancel run? Pending steps will be marked skipped.")) {
      return;
    }
    await guard("cancel", () => cancelRun(runId));
  };

  return (
    <div className="tb-control-bar" data-testid="tb-control-bar">
      <span className="tb-control-status" data-testid="tb-control-status">
        {status ?? "no run"}
      </span>
      <button
        type="button"
        className="tb-control-btn"
        onClick={() => guard("pause", () => pauseRun(runId!))}
        disabled={!canPause || busy === "pause"}
        data-testid="tb-control-pause"
      >
        ⏸ Pause
      </button>
      <button
        type="button"
        className="tb-control-btn"
        data-variant="primary"
        onClick={() => guard("resume", () => resumeRun(runId!))}
        disabled={!canResume || busy === "resume"}
        data-testid="tb-control-resume"
      >
        ▶ Resume
      </button>
      <button
        type="button"
        className="tb-control-btn"
        onClick={onSkip}
        disabled={!runId || isTerminal}
        data-testid="tb-control-skip"
      >
        ⏭ Skip
      </button>
      <button
        type="button"
        className="tb-control-btn"
        onClick={onMark}
        disabled={!runId || !lastStep || busy === "mark"}
        data-testid="tb-control-mark"
      >
        📌 Mark RC
      </button>
      <span className="tb-control-spacer" />
      <button
        type="button"
        className="tb-control-btn"
        data-variant="danger"
        onClick={onCancel}
        disabled={!canCancel || busy === "cancel"}
        data-testid="tb-control-cancel"
      >
        ⊘ Cancel
      </button>
    </div>
  );
}

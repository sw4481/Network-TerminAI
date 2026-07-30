/**
 * Plan 15 Phase 4 — AwaitingUserModal.
 *
 * Mounted whenever the active run has a `pendingPrompt`. Confirm calls
 * `answer_prompt`; the engine keeps the run paused (per Phase 2's
 * security invariant) — the operator must press Resume on the
 * ControlBar to continue. The modal makes that contract explicit.
 *
 * ESC = Cancel (clears the modal but does NOT call `answer_prompt`).
 * Enter = Confirm.
 */
import { useEffect, useRef, useState } from "react";
import {
  selectActiveRun,
  useTroubleshootStore,
  type RunState,
} from "./store";
import "./AwaitingUserModal.css";

export function AwaitingUserModal() {
  const activeRun = useTroubleshootStore(selectActiveRun);
  const answerPrompt = useTroubleshootStore((s) => s.answerPrompt);
  const [answer, setAnswer] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Prefill / reset whenever the pending prompt changes.
  useEffect(() => {
    setAnswer("");
    if (activeRun?.pendingPrompt) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [activeRun?.pendingPrompt?.stepId]);

  if (!activeRun || !activeRun.pendingPrompt) return null;

  const onCancel = () => {
    // Frontend-only dismiss — the run remains paused on the backend
    // until either Resume or another answer arrives. We clear the
    // pending prompt locally so the modal closes; the next `step_update`
    // event with status=awaiting_user will resurface it.
    useTroubleshootStore.setState((state) => {
      const run = state.runs[activeRun.runId];
      if (!run) return state;
      return {
        runs: {
          ...state.runs,
          [activeRun.runId]: { ...run, pendingPrompt: null },
        },
      };
    });
  };

  const onConfirm = async () => {
    setSubmitting(true);
    try {
      await answerPrompt(activeRun.runId, answer.trim() || "approved");
    } catch (e) {
      console.warn("[troubleshoot] answer_prompt failed", e);
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void onConfirm();
    }
  };

  return (
    <div
      className="tb-aw-modal-overlay"
      role="dialog"
      aria-modal="true"
      data-testid="tb-aw-modal-overlay"
      onClick={(e) => {
        // Clicking on the overlay (but not the panel) cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="tb-aw-modal"
        data-testid="tb-aw-modal"
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <div className="tb-aw-modal-title">
          Run paused — operator input required
        </div>
        <div className="tb-aw-modal-body">
          <div>
            <strong>Step:</strong>{" "}
            <code data-testid="tb-aw-modal-step">
              {activeRun.pendingPrompt.stepId}
            </code>
          </div>
          <div data-testid="tb-aw-modal-prompt">
            {activeRun.pendingPrompt.prompt}
          </div>
          <label>
            Answer (optional — defaults to "approved"):
            <input
              ref={inputRef}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              data-testid="tb-aw-modal-input"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>
            Confirming captures your answer and keeps the run paused. Press
            Resume on the control bar to continue execution.
          </div>
        </div>
        <div className="tb-aw-modal-actions">
          <button
            type="button"
            className="tb-aw-modal-btn"
            onClick={onCancel}
            data-testid="tb-aw-modal-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="tb-aw-modal-btn"
            data-variant="primary"
            onClick={() => void onConfirm()}
            disabled={submitting}
            data-testid="tb-aw-modal-confirm"
          >
            {submitting ? "…" : "Confirm ▸"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Test-only helper to stub a pending prompt onto an arbitrary run. */
export function _seedPromptForTests(run: RunState, prompt: string) {
  return {
    ...run,
    pendingPrompt: { stepId: "test_step", prompt },
  } satisfies RunState;
}

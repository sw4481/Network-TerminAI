/**
 * Plan 15 Phase 4 — ConclusionBanner.
 *
 * Visible only when the active run is in a terminal state with a
 * conclusion populated. Mirrors the four guaranteed fields from
 * `narrator_bridge::produce_conclusion` (root_cause, confidence,
 * suggested_fix, evidence[]).
 */
import { useState } from "react";
import { emit } from "@tauri-apps/api/event";
import {
  selectActiveRun,
  useTroubleshootStore,
} from "./store";
import "./ConclusionBanner.css";

export function ConclusionBanner() {
  const activeRun = useTroubleshootStore(selectActiveRun);
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (!activeRun) return null;
  const status = activeRun.status;
  const isTerminal = status === "completed" || status === "failed";
  if (!isTerminal) return null;
  if (!activeRun.conclusion) return null;
  if (dismissed === activeRun.runId) return null;

  const c = activeRun.conclusion;

  return (
    <div
      className="tb-conclusion"
      data-status={status}
      data-testid="tb-conclusion-banner"
    >
      <div className="tb-conclusion-header">
        <span className="tb-conclusion-headline">
          {status === "completed" ? "✓" : "✗"}{" "}
          {status === "completed" ? "Completed" : "Failed"} ·{" "}
          <strong>root cause:</strong>{" "}
          <span data-testid="tb-conclusion-root-cause">{c.root_cause}</span>
        </span>
        <span
          className="tb-conclusion-confidence"
          data-confidence={c.confidence}
          data-testid="tb-conclusion-confidence"
        >
          {c.confidence}
        </span>
      </div>
      <div className="tb-conclusion-row">
        <strong>Suggested fix:</strong>
        <code data-testid="tb-conclusion-fix">{c.suggested_fix}</code>
      </div>
      {c.evidence.length > 0 && (
        <div className="tb-conclusion-row">
          <strong>Evidence:</strong>
          <span className="tb-conclusion-evidence">
            {c.evidence.map((e, i) => (
              <span
                key={`${e}-${i}`}
                className="tb-conclusion-evidence-pill"
                data-testid={`tb-conclusion-evidence-${i}`}
              >
                {e}
              </span>
            ))}
          </span>
        </div>
      )}
      <div className="tb-conclusion-actions">
        <button
          type="button"
          className="tb-conclusion-btn"
          onClick={() =>
            emit("menu:troubleshoot_editor", {
              runId: activeRun.runId,
            }).catch((err) =>
              console.error("[ConclusionBanner] Failed to open editor:", err),
            )
          }
          data-testid="tb-conclusion-open-editor"
        >
          Open editor
        </button>
        <button
          type="button"
          className="tb-conclusion-btn"
          onClick={() => setDismissed(activeRun.runId)}
          data-testid="tb-conclusion-dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

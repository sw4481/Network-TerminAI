/**
 * Plan 15 Phase 4 — StepNode card rendered inside the @xyflow/react canvas.
 *
 * Receives the StoredStep through `data` (xyflow's contract for custom
 * node types). Emits a CustomEvent on the document when the operator
 * clicks "Jump to narration" so the NarrationPanel can scroll into view
 * — the panel listens for this on mount.
 */
import { Handle, Position } from "@xyflow/react";
import type { StepStatus, StepType, StoredStep } from "./api";
import "./StepNode.css";

export interface StepNodeData extends Record<string, unknown> {
  step: StoredStep;
  selected?: boolean;
}

const TYPE_ICON: Record<StepType, string> = {
  command: "▶",
  assertion: "⚖",
  branch: "⤥",
  narration: "✎",
  user_prompt: "?",
  unknown: "•",
};

function summarizeResult(result: unknown): string {
  if (result == null) return "—";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean")
    return String(result);
  if (typeof result === "object") {
    // Best-effort 1-line: prefer "session_state" / "next_step_id" /
    // "answer" / first scalar value.
    const obj = result as Record<string, unknown>;
    for (const key of [
      "session_state",
      "answer",
      "next_step_id",
      "summary",
      "matched",
    ]) {
      const v = obj[key];
      if (typeof v === "string") return `${key} = ${v}`;
      if (typeof v === "number" || typeof v === "boolean")
        return `${key} = ${String(v)}`;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        return `${k} = ${String(v)}`;
      }
    }
    return JSON.stringify(obj).slice(0, 80);
  }
  return String(result);
}

const STATUS_LABELS: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  awaiting_user: "Awaiting",
};

export function StepNode({ data }: { data: StepNodeData }) {
  const { step, selected } = data;

  const onJump = () => {
    document.dispatchEvent(
      new CustomEvent("troubleshoot:jump-narration", {
        detail: { stepId: step.step_ref, idx: step.idx },
      }),
    );
  };

  return (
    <div
      className="tb-step-node"
      data-testid={`tb-step-node-${step.step_ref}`}
      data-status={step.status}
      data-selected={selected ? "true" : "false"}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="tb-step-node-header">
        <span className="tb-step-node-id">{step.step_ref}</span>
        <span className="tb-step-node-chip" data-status={step.status}>
          {STATUS_LABELS[step.status]}
        </span>
      </div>
      <div className="tb-step-node-meta">
        <span className="tb-step-node-icon" aria-hidden>
          {TYPE_ICON[step.step_type] ?? "•"}
        </span>
        <span>{step.step_type}</span>
      </div>
      <div className="tb-step-node-summary">{summarizeResult(step.result_json)}</div>
      <button
        type="button"
        className="tb-step-node-jump"
        onClick={onJump}
        data-testid={`tb-step-jump-${step.step_ref}`}
      >
        Jump to narration ↦
      </button>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

import type { CellStatus } from "../../lib/runnableNotebook";
import "./CellStatusChip.css";

const LABELS: Record<CellStatus, string> = {
  pending: "pending",
  running: "running",
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  awaiting_approval: "awaiting approval",
};

const ARIA: Record<CellStatus, string> = {
  pending: "Pending",
  running: "Currently running",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  awaiting_approval: "Awaiting approval",
};

interface Props {
  status: CellStatus | "idle";
}

export function CellStatusChip({ status }: Props) {
  const s = status === "idle" ? "pending" : status;
  return (
    <span
      className={`cell-status-chip status-${s}`}
      role="status"
      aria-label={ARIA[s]}
      data-testid="cell-status-chip"
      data-status={s}
    >
      {LABELS[s]}
    </span>
  );
}

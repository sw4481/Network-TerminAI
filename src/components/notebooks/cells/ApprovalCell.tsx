import { CellStatusChip } from "../CellStatusChip";
import type { CellStatus } from "../../../lib/runnableNotebook";

interface Props {
  content: string;
  status: CellStatus | "idle";
  isAwaiting: boolean;
  onApprove: () => void;
  onCancel?: () => void;
}

export function ApprovalCell({ content, status, isAwaiting, onApprove, onCancel }: Props) {
  return (
    <div
      className={`notebook-cell approval-cell ${isAwaiting ? "is-awaiting" : ""}`}
      data-testid="cell-approval"
      tabIndex={0}
    >
      <div className="cell-row-header">
        <span className="cell-type-tag">approval</span>
        <CellStatusChip status={status} />
      </div>
      <div className="cell-approval-body">{content}</div>
      {isAwaiting && (
        <div className="cell-approval-actions">
          <button
            type="button"
            className="btn-continue"
            onClick={onApprove}
            data-testid="approval-continue"
          >
            Continue
          </button>
          {onCancel && (
            <button
              type="button"
              className="btn-cancel"
              onClick={onCancel}
              data-testid="approval-cancel"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

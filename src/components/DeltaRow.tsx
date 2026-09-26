import type { ClassifiedDelta } from "../lib/changeVerify";
import { SeverityChip } from "./SeverityChip";
import "./DeltaRow.css";

interface DeltaRowProps {
  delta: ClassifiedDelta;
  onApprove: () => void;
}

export function DeltaRow({ delta, onApprove }: DeltaRowProps) {
  const showApproveButton = delta.severity !== "green";

  return (
    <div className="delta-row">
      <div className="delta-row-header">
        <SeverityChip severity={delta.severity} />
        <span className="delta-path">{delta.path}</span>
      </div>
      <div className="delta-change">
        <span className="delta-before">{JSON.stringify(delta.before)}</span>
        <span className="delta-arrow">→</span>
        <span className="delta-after">{JSON.stringify(delta.after)}</span>
      </div>
      <div className="delta-footer">
        <span className="delta-message">{delta.message}</span>
        {showApproveButton && (
          <button type="button" className="delta-approve-btn" onClick={onApprove}>
            Approve
          </button>
        )}
      </div>
    </div>
  );
}

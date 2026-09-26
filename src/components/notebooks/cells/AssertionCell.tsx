import { CellStatusChip } from "../CellStatusChip";
import type { AssertionSpec, CellStatus } from "../../../lib/runnableNotebook";

interface Props {
  spec: AssertionSpec;
  status: CellStatus | "idle";
  error?: string;
}

export function AssertionCell({ spec, status, error }: Props) {
  return (
    <div className="notebook-cell assertion-cell" data-testid="cell-assertion">
      <div className="cell-row-header">
        <span className="cell-type-tag">assertion</span>
        <CellStatusChip status={status} />
      </div>
      <div className="assertion-spec">
        <div className="assertion-row">
          <span className="assertion-label">command</span>
          <code>{spec.command}</code>
        </div>
        <div className="assertion-row">
          <span className="assertion-label">jsonpath</span>
          <code>{spec.jsonpath}</code>
        </div>
        <div className="assertion-row">
          <span className="assertion-label">{spec.op}</span>
          <code>{JSON.stringify(spec.expected)}</code>
        </div>
      </div>
      {status === "failed" && error && (
        <div className="cell-error" role="alert">
          <strong>actual:</strong> {error}
        </div>
      )}
    </div>
  );
}

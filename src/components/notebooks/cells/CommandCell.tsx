import { CellStatusChip } from "../CellStatusChip";
import type { CellStatus } from "../../../lib/runnableNotebook";

interface Props {
  content: string;
  status: CellStatus | "idle";
  error?: string;
}

export function CommandCell({ content, status, error }: Props) {
  return (
    <div className="notebook-cell command-cell" data-testid="cell-command">
      <div className="cell-row-header">
        <span className="cell-type-tag">command</span>
        <CellStatusChip status={status} />
      </div>
      <pre className="cell-command-body">{content}</pre>
      {error && (
        <div className="cell-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

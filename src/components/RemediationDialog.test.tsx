import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RemediationDialog } from "./RemediationDialog";
import type { DriftReport } from "../lib/drift";

vi.mock("./editor/MonacoEditor", () => ({
  MonacoEditor: ({ value }: { value: string }) => (
    <div data-testid="mock-monaco">{value}</div>
  ),
}));

const reportWithDiff: DriftReport = {
  id: "r1",
  template_id: "t1",
  device_id: "d1",
  device_kind: "ssh",
  status: "drift",
  severity: "destructive",
  diff_patch: {
    status: "drift",
    severity: "destructive",
    stats: { additions: 1, deletions: 1, blocks_changed: 1 },
    blocks: [
      {
        block_path: "interface Lo0",
        severity: "destructive",
        changes: [
          { tag: "insert", line: " description WAN" },
          { tag: "delete", line: " description LAN" },
        ],
      },
    ],
  },
  error_msg: null,
  captured_at: 0,
};

describe("RemediationDialog", () => {
  it("renders the dialog with patch lines", () => {
    render(<RemediationDialog report={reportWithDiff} onClose={() => {}} />);
    expect(screen.getByTestId("remediation-dialog")).toBeInTheDocument();
  });

  it("disables push until the user approves", () => {
    render(<RemediationDialog report={reportWithDiff} onClose={() => {}} />);
    const push = screen.getByTestId("remediation-push") as HTMLButtonElement;
    expect(push).toBeDisabled();
    const approve = screen.getByTestId("remediation-approve");
    fireEvent.click(approve);
    expect(push).not.toBeDisabled();
  });
});

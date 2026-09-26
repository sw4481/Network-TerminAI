import { useMemo } from "react";
import type { ReportSummary, ExpectedDelta, ClassifiedDelta } from "../lib/changeVerify";
import { SeverityChip } from "./SeverityChip";
import { DeltaRow } from "./DeltaRow";
import { useChangeVerifyStore } from "../state/changeVerifyStore";
import "./ChangeReportView.css";

interface ChangeReportViewProps {
  report: ReportSummary;
  reportId: string;
}

export function ChangeReportView({ report, reportId }: ChangeReportViewProps) {
  const appendApproval = useChangeVerifyStore(s => s.appendApproval);

  // Group deltas by command
  const deltasByCommand = useMemo(() => {
    const groups = new Map<string, ClassifiedDelta[]>();
    for (const delta of report.deltas) {
      if (!groups.has(delta.command)) {
        groups.set(delta.command, []);
      }
      groups.get(delta.command)!.push(delta);
    }
    return groups;
  }, [report.deltas]);

  const handleApprove = async (delta: ClassifiedDelta) => {
    const pathSegments = delta.path.replace(/^\//, "").split("/");
    const lastSeg = pathSegments[pathSegments.length - 1] ?? delta.path;

    const approval: ExpectedDelta = {
      command_substring: delta.command.slice(0, Math.min(40, delta.command.length)),
      path_substring: pathSegments.length >= 2 ? pathSegments[pathSegments.length - 2] : lastSeg,
      note: "approved by user",
    };

    await appendApproval(reportId, approval);
  };

  return (
    <div className="change-report-view">
      <div className="report-summary">
        <SeverityChip severity="red" count={report.counts.red} />
        <SeverityChip severity="yellow" count={report.counts.yellow} />
        <SeverityChip severity="green" count={report.counts.green} />
      </div>

      {report.notes && (
        <div className="report-notes">
          <strong>Change Notes:</strong>
          <p>{report.notes}</p>
        </div>
      )}

      <div className="report-deltas">
        {Array.from(deltasByCommand.entries()).map(([command, cmdDeltas]) => (
          <details key={command} className="delta-group" open>
            <summary className="delta-group-header">
              <span className="delta-group-command">{command}</span>
              <span className="delta-group-count">{cmdDeltas.length} changes</span>
            </summary>
            <div className="delta-group-body">
              {cmdDeltas.map((delta, idx) => (
                <DeltaRow
                  key={`${delta.path}-${idx}`}
                  delta={delta}
                  onApprove={() => handleApprove(delta)}
                />
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

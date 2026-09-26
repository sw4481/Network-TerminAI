import { useState } from "react";
import "./ProblemsPanel.css";

export type ProblemDiagnostic = {
  line: number;
  column: number;
  endColumn?: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
  code?: string;
};

export type ProblemStatus = {
  name: string;
  state: "ready" | "running" | "unavailable" | "idle";
  reason: string | null;
  statusText?: string;
};

type Props = {
  diagnostics: ProblemDiagnostic[];
  statuses: ProblemStatus[];
  onJumpTo: (line: number, column: number) => void;
  title?: string;
  clean?: boolean;
  emptyMessage?: string;
};

export function ProblemsPanel({
  diagnostics,
  statuses,
  onJumpTo,
  title = "Problems",
  clean,
  emptyMessage = "No providers ran.",
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity !== "error");
  const pendingStatuses = statuses.filter((status) => status.state !== "ready");
  const isClean = clean ?? (
    diagnostics.length === 0 &&
    statuses.length > 0 &&
    statuses.every((status) => status.state === "ready")
  );
  const summary =
    `${errors.length} error${errors.length === 1 ? "" : "s"}` +
    `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`;

  return (
    <div className="problems-panel" data-testid="problems-panel">
      <button
        type="button"
        className={`problems-panel-header ${errors.length > 0 ? "has-errors" : ""}`}
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <span>{title} ({summary})</span>
      </button>
      {!collapsed && (
        <div className="problems-panel-list">
          {diagnostics.map((diagnostic, index) => (
            <button
              type="button"
              key={index}
              className={`problem-row ${diagnostic.severity}`}
              onClick={() => onJumpTo(diagnostic.line, diagnostic.column)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onJumpTo(diagnostic.line, diagnostic.column);
                }
              }}
              aria-label={`${diagnostic.severity}: ${diagnostic.source}, line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`}
              data-testid={`problem-${index}`}
            >
              <span className="problem-severity">{diagnostic.severity}</span>
              <span className="problem-where">L{diagnostic.line}</span>
              <span className="problem-message">{diagnostic.message}</span>
              <span className="problem-source">{diagnostic.source}</span>
              <span aria-hidden="true" data-testid={`iac-problem-${index}`} />
            </button>
          ))}

          {isClean && <div className="problem-row clean">No issues found.</div>}

          {pendingStatuses.length > 0 && (
            <div className="problems-panel-statuses">
              {pendingStatuses.map((status) => (
                <div
                  key={status.name}
                  className={`problem-status ${status.state}`}
                  data-testid={`problem-status-${status.name}`}
                >
                  <span className="problem-status-name">{status.name}</span>
                  <span className="problem-status-reason">
                    {status.statusText ?? status.state}
                    {status.reason ? ` — ${status.reason}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {diagnostics.length === 0 && statuses.length === 0 && (
            <div className="problem-row empty">{emptyMessage}</div>
          )}
        </div>
      )}
    </div>
  );
}

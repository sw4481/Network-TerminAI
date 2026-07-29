import { useState } from "react";
import type { LintDiagnostic, LinterStatus } from "../../lib/tauri";

type Props = {
  diagnostics: LintDiagnostic[];
  linters: LinterStatus[];
  onJumpTo: (line: number, column: number) => void;
};

/**
 * Collapsible "Problems" panel for the IaC Studio. Mirrors the troubleshoot
 * PlaybookEditor diagnostics panel. Honest by design: it only says "No issues"
 * when a linter actually ran; skipped/unavailable linters are listed with their
 * reason so an empty list never masquerades as a guaranteed-clean file.
 */
export function IacProblemsPanel({ diagnostics, linters, onJumpTo }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity !== "error");
  const anyRan = linters.some((l) => l.ran);
  const skipped = linters.filter((l) => !l.ran);

  const summary =
    `${errors.length} error${errors.length === 1 ? "" : "s"}` +
    `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`;

  return (
    <div className="iac-studio-problems" data-testid="iac-studio-problems">
      <div
        className={`iac-studio-problems-header ${errors.length > 0 ? "has-errors" : ""}`}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span>{collapsed ? "▸" : "▾"}</span>
        <span>Problems ({summary})</span>
      </div>
      {!collapsed && (
        <div className="iac-studio-problems-list">
          {diagnostics.map((d, i) => (
            <div
              key={i}
              className={`iac-studio-problem-row ${d.severity}`}
              onClick={() => onJumpTo(d.line, d.column)}
              data-testid={`iac-problem-${i}`}
            >
              <span className="iac-studio-problem-where">L{d.line}</span>
              <span className="iac-studio-problem-msg">{d.message}</span>
              <span className="iac-studio-problem-source">{d.source}</span>
            </div>
          ))}

          {diagnostics.length === 0 && anyRan && (
            <div className="iac-studio-problem-row clean">No issues found.</div>
          )}

          {skipped.length > 0 && (
            <div className="iac-studio-problems-linters">
              {skipped.map((l) => (
                <div key={l.name} className="iac-studio-linter-status" data-testid={`iac-linter-${l.name}`}>
                  <span className="iac-studio-linter-name">{l.name}</span>
                  <span className="iac-studio-linter-reason">
                    {l.available ? "skipped" : "unavailable"}
                    {l.reason ? ` — ${l.reason}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {diagnostics.length === 0 && !anyRan && skipped.length === 0 && (
            <div className="iac-studio-problem-row">No linters ran.</div>
          )}
        </div>
      )}
    </div>
  );
}

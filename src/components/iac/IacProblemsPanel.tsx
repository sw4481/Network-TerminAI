import type { LintDiagnostic, LinterStatus } from "../../lib/tauri";
import { ProblemsPanel, type ProblemStatus } from "../editor/ProblemsPanel";

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
  const statuses: ProblemStatus[] = linters.map((linter) => ({
    name: linter.name,
    state: linter.ran ? "ready" : linter.available ? "idle" : "unavailable",
    reason: linter.reason,
    statusText: linter.ran ? undefined : linter.available ? "skipped" : "unavailable",
  }));

  return (
    <div data-testid="iac-studio-problems">
      <ProblemsPanel
        diagnostics={diagnostics}
        statuses={statuses}
        onJumpTo={onJumpTo}
        clean={diagnostics.length === 0 && linters.some((linter) => linter.ran)}
        emptyMessage="No linters ran."
      />
    </div>
  );
}

import { useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { AiProposal } from "../../state/iacStudioStore";
import "./IacAiPanel.css";

export function IacDiffPreview({
  original,
  proposal,
  language,
  onAccept,
  onReject,
}: {
  original: string;
  proposal: AiProposal;
  language: string;
  onAccept: () => void;
  onReject: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onReject();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onReject]);

  const v = proposal.validation;
  // Honest validation note: never imply the code is valid when the linter was
  // skipped (binary absent). Mirrors the Phase B linter-honesty rule.
  const note =
    v.skipped || v.valid === null
      ? `syntax not validated${v.error ? ` (${v.error})` : " (terraform/ansible not available)"}`
      : v.valid
        ? "syntax validated ✓"
        : `syntax check failed: ${v.error ?? "unknown error"}`;

  return (
    <div className="iac-diff-overlay" data-testid="iac-diff-overlay" role="dialog" aria-modal="true" aria-label="AI Diff Preview">
      <div className="iac-diff-modal">
        <div className="iac-diff-header">
          <span className="iac-diff-title">AI Diff Preview — {proposal.filename}</span>
          <span className="iac-diff-validation">{note}</span>
        </div>
        {proposal.explanation && <p className="iac-diff-explanation">{proposal.explanation}</p>}
        <div className="iac-diff-body">
          <DiffEditor
            original={original}
            modified={proposal.code}
            language={language}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollbar: { verticalScrollbarSize: 10, useShadows: false },
              overviewRulerLanes: 0,
              scrollBeyondLastLine: false,
            }}
            theme="vs-dark"
          />
        </div>
        <div className="iac-diff-actions">
          <button onClick={onReject} data-testid="iac-diff-reject" className="iac-diff-reject">
            Reject
          </button>
          <button onClick={onAccept} data-testid="iac-diff-accept" className="iac-diff-accept">
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

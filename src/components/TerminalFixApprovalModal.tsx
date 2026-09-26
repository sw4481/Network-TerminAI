import { useEffect, useMemo, useState } from "react";
import type { TerminalFixBatch, TerminalFixPreview } from "../lib/tauri";
import "./IaCApprovalModal.css";

type Props = {
  preview: TerminalFixPreview | null;
  onReviewEdit: (batch: TerminalFixBatch) => void;
  onApprove: (batch: TerminalFixBatch) => void;
  onReject: () => void;
};

const lines = (value: string) =>
  value.split("\n").map((line) => line.trim()).filter(Boolean);

const batchFromPreview = (preview: TerminalFixPreview): TerminalFixBatch => ({
  summary: preview.summary,
  commands: preview.commands,
  verification_commands: preview.verification_commands,
  rollback_commands: preview.rollback_commands,
});

export function TerminalFixApprovalModal({
  preview,
  onReviewEdit,
  onApprove,
  onReject,
}: Props) {
  const [summary, setSummary] = useState("");
  const [commands, setCommands] = useState("");
  const [verification, setVerification] = useState("");
  const [rollback, setRollback] = useState("");

  useEffect(() => {
    if (!preview) return;
    setSummary(preview.summary);
    setCommands(preview.commands.join("\n"));
    setVerification(preview.verification_commands.join("\n"));
    setRollback(preview.rollback_commands.join("\n"));
  }, [preview?.digest]);

  const draft = useMemo<TerminalFixBatch>(() => ({
    summary: summary.trim(),
    commands: lines(commands),
    verification_commands: lines(verification),
    rollback_commands: lines(rollback),
  }), [summary, commands, verification, rollback]);

  if (!preview) return null;
  const changed = JSON.stringify(draft) !== JSON.stringify(batchFromPreview(preview));
  const target = preview.target.displayName || preview.target.backendPtyId;

  return (
    <div className="iac-approval-overlay" role="dialog" aria-modal="true">
      <div className="iac-approval-modal terminal-fix-approval">
        <header className="iac-approval-header">
          <span className="iac-approval-warning">⚠️</span>
          <h2>Review switch fix</h2>
          <span className="iac-approval-badge tier-high">{preview.highest_tier}</span>
        </header>

        <div className="iac-approval-context">
          <div><span className="iac-approval-label">Locked target</span><strong>{target}</strong></div>
          <div><span className="iac-approval-label">PTY</span><code>{preview.target.backendPtyId}</code></div>
        </div>

        <label className="terminal-fix-field">
          Summary
          <input value={summary} onChange={(event) => setSummary(event.target.value)} />
        </label>
        <label className="terminal-fix-field">
          Fix commands
          <textarea value={commands} onChange={(event) => setCommands(event.target.value)} rows={4} />
        </label>
        <div className="terminal-fix-tiers">
          {preview.per_command_tiers.map((item) => (
            <div key={`${item.command}-${item.tier}`}><code>{item.command}</code><strong>{item.tier}</strong></div>
          ))}
        </div>
        <label className="terminal-fix-field">
          Automatic verification (Tier 0)
          <textarea value={verification} onChange={(event) => setVerification(event.target.value)} rows={3} />
        </label>
        <label className="terminal-fix-field">
          Rollback plan (requires separate approval)
          <textarea value={rollback} onChange={(event) => setRollback(event.target.value)} rows={3} />
        </label>

        <footer className="iac-approval-actions">
          <button className="iac-approval-cancel" onClick={onReject}>Reject</button>
          {changed ? (
            <button
              className="iac-approval-proceed"
              disabled={!draft.summary || draft.commands.length === 0}
              onClick={() => onReviewEdit(draft)}
            >
              Review edited batch
            </button>
          ) : (
            <button className="iac-approval-proceed" onClick={() => onApprove(draft)}>
              Approve exact batch
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

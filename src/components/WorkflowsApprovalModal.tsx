import { useEffect, useRef, type RefObject } from "react";
import type { IaCClassification } from "../lib/tauri";
import "./IaCApprovalModal.css";

export type WorkflowsApprovalRequest = {
  tier: IaCClassification["tier"];
  method: string;
  path: string;
  organizationId: string;
  params: Record<string, unknown>;
  rationale: string;
};

export function WorkflowsApprovalModal({
  request,
  onApprove,
  onDeny,
  returnFocusRef,
}: {
  request: WorkflowsApprovalRequest;
  onApprove: () => void;
  onDeny: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".iac-approval-cancel")?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);

  return (
    <div
      ref={dialogRef}
      className="iac-approval-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflows-approval-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDeny();
          return;
        }
        if (event.key !== "Tab") return;
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className={`iac-approval-modal tier-${request.tier}`}>
        <header className="iac-approval-header">
          <h2 id="workflows-approval-title">Cisco Workflows change requires approval</h2>
          <span className={`iac-approval-badge tier-${request.tier}`}>{request.tier.toUpperCase()}</span>
        </header>
        <div className="iac-approval-context">
          <div><span className="iac-approval-label">HTTP method</span><code>{request.method}</code></div>
          <div><span className="iac-approval-label">Path</span><code>{request.path}</code></div>
          <div><span className="iac-approval-label">Organization ID</span><code>{request.organizationId}</code></div>
          <div>
            <span className="iac-approval-label">Exact tool arguments</span>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(request.params, null, 2)}</pre>
          </div>
          <div><span className="iac-approval-label">Rationale</span><span>{request.rationale || "No rationale supplied."}</span></div>
        </div>
        <footer className="iac-approval-actions">
          <button type="button" className="iac-approval-cancel" onClick={onDeny}>Deny</button>
          <button type="button" className="iac-approval-proceed" onClick={onApprove}>Approve exact change</button>
        </footer>
      </div>
    </div>
  );
}

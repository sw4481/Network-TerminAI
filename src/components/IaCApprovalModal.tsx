import { useMemo, useState } from "react";
import "./IaCApprovalModal.css";

export type IaCBlastRadius = "low" | "medium" | "high" | "critical" | "destructive";

export interface IaCResourceChange {
  resourceType: string;
  resourceName: string;
  resourceId?: string;
}

export interface IaCApprovalRequest {
  command: string;
  workingDir: string;
  gitBranch: string;
  blastRadius: IaCBlastRadius;
  plannedChanges: {
    toCreate: IaCResourceChange[];
    toUpdate: IaCResourceChange[];
    toDestroy: IaCResourceChange[];
  };
}

interface IaCApprovalModalProps {
  request: IaCApprovalRequest | null;
  onApprove: () => void;
  onCancel: () => void;
}

const PRODUCTION_BRANCHES = new Set(["main", "master"]);

/** critical/destructive require a typed confirmation before Proceed enables. */
function requiresTypedConfirm(tier: IaCBlastRadius): boolean {
  return tier === "critical" || tier === "destructive";
}

function ResourceList({
  title,
  action,
  changes,
}: {
  title: string;
  action: "create" | "update" | "destroy";
  changes: IaCResourceChange[];
}) {
  if (changes.length === 0) return null;
  return (
    <details open className={`iac-approval-section action-${action}`}>
      <summary>
        {title} ({changes.length})
      </summary>
      <ul>
        {changes.map((c, i) => (
          <li key={`${c.resourceType}.${c.resourceName}.${i}`}>
            <code>
              {c.resourceType}.{c.resourceName}
            </code>
            {c.resourceId ? <span className="iac-approval-rid">{c.resourceId}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function IaCApprovalModal({ request, onApprove, onCancel }: IaCApprovalModalProps) {
  const [typed, setTyped] = useState("");

  const needsConfirm = request ? requiresTypedConfirm(request.blastRadius) : false;
  const onProductionBranch = request
    ? PRODUCTION_BRANCHES.has(request.gitBranch.trim().toLowerCase())
    : false;
  const proceedEnabled = useMemo(() => {
    if (!request) return false;
    if (!needsConfirm) return true;
    return typed.trim() === request.command.trim();
  }, [request, needsConfirm, typed]);

  if (!request) return null;

  return (
    <div className="iac-approval-overlay" role="dialog" aria-modal="true">
      <div className={`iac-approval-modal tier-${request.blastRadius}`}>
        <header className="iac-approval-header">
          <span className="iac-approval-warning">⚠️</span>
          <h2>IaC operation requires approval</h2>
          <span className={`iac-approval-badge tier-${request.blastRadius}`}>
            {request.blastRadius.toUpperCase()}
          </span>
        </header>

        <div className="iac-approval-context">
          <div>
            <span className="iac-approval-label">Command</span>
            <code className="iac-approval-command">{request.command}</code>
          </div>
          <div>
            <span className="iac-approval-label">Directory</span>
            <span>{request.workingDir}</span>
          </div>
          <div>
            <span className="iac-approval-label">Branch</span>
            <span>{request.gitBranch}</span>
            {onProductionBranch ? (
              <span className="iac-approval-branch-warning" data-testid="iac-branch-warning">
                production branch — changes affect live infrastructure
              </span>
            ) : null}
          </div>
        </div>

        <div className="iac-approval-changes">
          <ResourceList title="Create" action="create" changes={request.plannedChanges.toCreate} />
          <ResourceList title="Update" action="update" changes={request.plannedChanges.toUpdate} />
          <ResourceList title="Destroy" action="destroy" changes={request.plannedChanges.toDestroy} />
        </div>

        {needsConfirm ? (
          <div className="iac-approval-typed">
            <label>
              This is a high-risk operation. Type <code>{request.command}</code> to confirm:
            </label>
            <input
              data-testid="iac-typed-confirm"
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
          </div>
        ) : null}

        <footer className="iac-approval-actions">
          <button className="iac-approval-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="iac-approval-proceed" disabled={!proceedEnabled} onClick={onApprove}>
            Proceed with apply
          </button>
        </footer>
      </div>
    </div>
  );
}

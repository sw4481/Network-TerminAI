import { useEffect, useMemo, useState } from "react";
import "./BlastRadius.css";
import type { ImpactSummary } from "./TypedConfirmModal";

export interface MaintenanceWindow {
  id: string;
  label: string;
  startsAt: number; // unix seconds
  endsAt: number;
}

export interface MaintenanceWindowModalProps {
  command: string;
  reasoning: string;
  vendor: string;
  platform: string;
  /** Currently-known maintenance windows the user can pick from. */
  windows?: MaintenanceWindow[];
  /** Optional impact summary. */
  impact?: ImpactSummary | null;
  onProceed: (resolution: { mode: "window"; windowId: string } | { mode: "override"; reason: string }) => void;
  onCancel: () => void;
}

const MIN_REASON_CHARS = 20;

/**
 * Tier-3 service-affecting confirmation. Requires either a selected
 * maintenance window OR an admin-override checkbox + ≥20 char reason.
 */
export function MaintenanceWindowModal({
  command,
  reasoning,
  vendor,
  platform,
  windows = [],
  impact,
  onProceed,
  onCancel,
}: MaintenanceWindowModalProps) {
  const [selectedWindow, setSelectedWindow] = useState<string | null>(null);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const canProceed = useMemo(() => {
    if (selectedWindow) return true;
    if (overrideEnabled && overrideReason.trim().length >= MIN_REASON_CHARS) return true;
    return false;
  }, [selectedWindow, overrideEnabled, overrideReason]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const handleProceed = () => {
    if (selectedWindow) {
      onProceed({ mode: "window", windowId: selectedWindow });
    } else if (overrideEnabled && overrideReason.trim().length >= MIN_REASON_CHARS) {
      onProceed({ mode: "override", reason: overrideReason.trim() });
    }
  };

  return (
    <div className="br-overlay" data-testid="br-overlay-tier3">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="br-tier3-title"
        className="br-modal"
        style={{ minWidth: 560 }}
      >
        <div className="br-header">
          <span id="br-tier3-title" className="br-title">
            Service-affecting change — maintenance window or admin override
          </span>
          <span className="br-tier-badge tier-3">Tier 3</span>
        </div>
        <div className="br-body">
          <div className="br-reasoning">
            <strong>Why this is gated:</strong> {reasoning}
          </div>
          <code className="br-cmd">{command}</code>
          <div style={{ fontSize: 11.5, color: "#8a8d94", marginBottom: 10 }}>
            Target: {vendor}/{platform}
          </div>

          <div style={{ fontSize: 11.5, color: "#8a8d94", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Maintenance windows
          </div>
          <ul className="br-mw-list" data-testid="br-mw-list">
            {windows.length === 0 ? (
              <li className="br-mw-empty">No maintenance windows scheduled.</li>
            ) : (
              windows.map((w) => (
                <li
                  key={w.id}
                  className={selectedWindow === w.id ? "selected" : ""}
                  onClick={() => {
                    setSelectedWindow(w.id);
                    setOverrideEnabled(false);
                  }}
                  data-testid={`br-mw-${w.id}`}
                >
                  <strong>{w.label}</strong>
                  <span style={{ marginLeft: 8, color: "#8a8d94", fontSize: 11.5 }}>
                    {new Date(w.startsAt * 1000).toLocaleString()} →{" "}
                    {new Date(w.endsAt * 1000).toLocaleString()}
                  </span>
                </li>
              ))
            )}
          </ul>

          <div className="br-override">
            <label>
              <input
                type="checkbox"
                checked={overrideEnabled}
                onChange={(e) => {
                  setOverrideEnabled(e.target.checked);
                  if (e.target.checked) setSelectedWindow(null);
                }}
                data-testid="br-override-toggle"
              />{" "}
              Admin override (no maintenance window)
            </label>
            {overrideEnabled && (
              <textarea
                placeholder={`Reason (min ${MIN_REASON_CHARS} characters)…`}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                data-testid="br-override-reason"
              />
            )}
          </div>

          {impact && (
            <div className="br-impact" data-testid="br-impact">
              <h4>Predicted impact</h4>
              {impact.topology_available ? (
                <>
                  {impact.affected_neighbors.length > 0 && (
                    <ul>
                      {impact.affected_neighbors.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                  {impact.notes.map((n, i) => (
                    <div key={i}>{n}</div>
                  ))}
                </>
              ) : (
                <div className="br-impact-fallback">
                  {impact.notes?.[0] ??
                    "Topology data not available — classification based on command pattern only."}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="br-footer">
          <button className="br-btn" onClick={onCancel} data-testid="br-cancel">
            Cancel
          </button>
          <button
            className="br-btn danger"
            disabled={!canProceed}
            onClick={handleProceed}
            data-testid="br-proceed"
          >
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
}

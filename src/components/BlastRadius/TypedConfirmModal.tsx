import { useEffect, useMemo, useState } from "react";
import "./BlastRadius.css";

export interface TypedConfirmModalProps {
  command: string;
  reasoning: string;
  vendor: string;
  platform: string;
  /** Optional shortened phrase the user is asked to type instead of the
   *  full command (e.g. `shutdown ge-0/0/5`). Defaults to the full command. */
  challenge?: string;
  /** Optional impact summary; if absent, shows the topology-unavailable
   *  fallback. */
  impact?: ImpactSummary | null;
  tier?: "T2" | "Ambiguous";
  onProceed: () => void;
  onCancel: () => void;
}

export interface ImpactSummary {
  affected_neighbors: string[];
  affected_prefixes: string[];
  notes: string[];
  topology_available: boolean;
}

export function TypedConfirmModal({
  command,
  reasoning,
  vendor,
  platform,
  challenge,
  impact,
  tier = "T2",
  onProceed,
  onCancel,
}: TypedConfirmModalProps) {
  const isAmbiguous = tier === "Ambiguous";
  const titleId = isAmbiguous ? "br-ambiguous-title" : "br-tier2-title";
  const expected = (challenge ?? command).trim();
  const [typed, setTyped] = useState("");
  const valid = useMemo(() => typed.trim() === expected, [typed, expected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && valid) {
        e.preventDefault();
        onProceed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [valid, onProceed, onCancel]);

  return (
    <div className="br-overlay" data-testid="br-overlay-tier2">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="br-modal"
        style={{ minWidth: 520 }}
      >
        <div className="br-header">
          <span id={titleId} className="br-title">
            Forwarding-affecting change — type to confirm
          </span>
          <span className={`br-tier-badge ${isAmbiguous ? "tier-amb" : "tier-2"}`}>
            {isAmbiguous ? "Ambiguous" : "Tier 2"}
          </span>
        </div>
        <div className="br-body">
          <div className="br-reasoning">{reasoning}</div>
          <code className="br-cmd">{command}</code>
          <div className="br-typed-hint">
            Type <code>{expected}</code> to enable Proceed:
          </div>
          <input
            autoFocus
            className={"br-typed-input" + (typed.length > 0 && !valid ? " invalid" : "")}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            data-testid="br-typed-input"
            aria-label="Type the command to confirm"
          />
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 6 }}>
            Target: {vendor}/{platform}
          </div>
          <div className="br-impact" data-testid="br-impact">
            <h4>Predicted impact</h4>
            {impact && impact.topology_available ? (
              <>
                {impact.affected_neighbors.length > 0 && (
                  <ul>
                    {impact.affected_neighbors.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
                {impact.affected_prefixes.length > 0 && (
                  <ul>
                    {impact.affected_prefixes.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
                {impact.notes.length > 0 && (
                  <ul>
                    {impact.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="br-impact-fallback">
                {impact?.notes?.[0] ??
                  "Topology data not available — classification based on command pattern only."}
              </div>
            )}
          </div>
        </div>
        <div className="br-footer">
          <button className="br-btn" onClick={onCancel} data-testid="br-cancel">
            Cancel
          </button>
          <button
            className="br-btn danger"
            disabled={!valid}
            onClick={onProceed}
            data-testid="br-proceed"
          >
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
}

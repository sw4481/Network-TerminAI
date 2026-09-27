import { useEffect, useRef } from "react";
import "./BlastRadius.css";

export interface OneClickModalProps {
  command: string;
  reasoning: string;
  vendor: string;
  platform: string;
  onProceed: () => void;
  onCancel: () => void;
}

/**
 * Tier-1 one-click confirmation. Centered card with two buttons. Enter
 * proceeds; Esc cancels. Dialog role + aria-modal for a11y.
 */
export function OneClickModal({
  command,
  reasoning,
  vendor,
  platform,
  onProceed,
  onCancel,
}: OneClickModalProps) {
  const proceedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    proceedRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onProceed();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onProceed, onCancel]);

  return (
    <div className="br-overlay" data-testid="br-overlay-tier1">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="br-tier1-title"
        className="br-modal"
      >
        <div className="br-header">
          <span id="br-tier1-title" className="br-title">
            Confirm change
          </span>
          <span className="br-tier-badge tier-1">Tier 1</span>
        </div>
        <div className="br-body">
          <div className="br-reasoning">{reasoning}</div>
          <code className="br-cmd">{command}</code>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
            Target: {vendor}/{platform}
          </div>
        </div>
        <div className="br-footer">
          <button className="br-btn" onClick={onCancel} data-testid="br-cancel">
            Cancel
          </button>
          <button
            ref={proceedRef}
            className="br-btn primary"
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

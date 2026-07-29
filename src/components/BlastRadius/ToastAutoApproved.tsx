import { useEffect, useState } from "react";
import "./BlastRadius.css";

/**
 * Tier-0 auto-approve indicator. Renders a brief bottom-right toast that
 * fades after `durationMs` (default 1500ms). No buttons — this is purely
 * informational; the command has already been sent.
 */
export function ToastAutoApproved({
  command,
  durationMs = 1500,
  onDismissed,
}: {
  command: string;
  durationMs?: number;
  onDismissed?: () => void;
}) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => {
      setVisible(false);
      onDismissed?.();
    }, durationMs);
    return () => clearTimeout(t);
  }, [durationMs, onDismissed]);

  if (!visible) return null;
  return (
    <div
      className="br-toast"
      role="status"
      aria-live="polite"
      data-testid="br-toast-auto-approved"
    >
      Auto-approved: <code>{command}</code>
    </div>
  );
}

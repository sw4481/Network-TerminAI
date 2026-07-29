import { useEffect, useState } from "react";
import { getSidecarStatus, type SidecarStatus } from "../lib/tauri";

/**
 * Plan 00 / Task 3.3 — thin status chip that polls `get_sidecar_status`
 * every 10s and shows 🟢 running / 🔴 stopped. Sits next to the existing
 * FTP chip in the footer.
 */
export function SidecarStatusChip() {
  const [status, setStatus] = useState<SidecarStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getSidecarStatus();
        if (!cancelled) setStatus(s);
      } catch {
        /* ignore — if the core isn't up we have bigger problems than
         * this chip; UI stays in the "stopped" state until recovery. */
      }
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const running = status?.running === true;
  const age =
    status?.last_seen != null && typeof status.now === "number"
      ? formatAge(status.now - status.last_seen)
      : "?";
  const title = running
    ? `Sidecar v${status?.version ?? "?"} — pid ${status?.pid ?? "?"}, last seen ${age} ago`
    : "Sidecar is not responding — AI features will be unavailable";

  return (
    <div
      className={`status-pill ${running ? "running" : "stopped"}`}
      title={title}
      style={{ cursor: "default" }}
    >
      <span className="status-dot" />
      <span className="status-label">
        Sidecar: {running ? `v${status?.version ?? "?"}` : "down"}
      </span>
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

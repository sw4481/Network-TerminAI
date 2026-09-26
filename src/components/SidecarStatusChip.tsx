import { useEffect, useState } from "react";
import { getSidecarStatus, type SidecarStatus } from "../lib/tauri";

const STARTUP_GRACE_MS = 10_000;
const STARTUP_POLL_MS = 1_000;
const RUNNING_POLL_MS = 10_000;

/**
 * Plan 00 / Task 3.3 — thin status chip that polls `get_sidecar_status`
 * every 10s and shows 🟢 running / 🔴 stopped. Sits next to the existing
 * FTP chip in the footer.
 */
export function SidecarStatusChip() {
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [startupGraceExpired, setStartupGraceExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    const graceTimer = window.setTimeout(() => {
      if (!cancelled) setStartupGraceExpired(true);
    }, STARTUP_GRACE_MS);

    const tick = async () => {
      let nextPollMs = STARTUP_POLL_MS;
      try {
        const s = await getSidecarStatus();
        if (!cancelled) {
          setStatus(s);
          if (s.running) {
            setStartupGraceExpired(true);
            nextPollMs = RUNNING_POLL_MS;
          }
        }
      } catch {
        /* ignore — if the core isn't up we have bigger problems than
         * this chip; UI stays in the "stopped" state until recovery. */
      } finally {
        if (!cancelled) {
          pollTimer = window.setTimeout(tick, nextPollMs);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(graceTimer);
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, []);

  const running = status?.running === true;
  const starting = !running && !startupGraceExpired;
  const age =
    status?.last_seen != null && typeof status.now === "number"
      ? formatAge(status.now - status.last_seen)
      : "?";
  const title = starting
    ? "Sidecar is starting and waiting for its first heartbeat"
    : running
      ? `Sidecar v${status?.version ?? "?"} — pid ${status?.pid ?? "?"}, last seen ${age} ago`
      : "Sidecar is not responding — AI features will be unavailable";

  return (
    <div
      className={`status-pill ${running ? "running" : starting ? "starting" : "stopped"}`}
      title={title}
      role="status"
      aria-label="Sidecar status"
      aria-live="polite"
      style={{ cursor: "default" }}
    >
      <span className="status-dot" aria-hidden="true" />
      <span className="status-label">
        Sidecar: {starting ? "starting" : running ? `v${status?.version ?? "?"}` : "down"}
      </span>
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

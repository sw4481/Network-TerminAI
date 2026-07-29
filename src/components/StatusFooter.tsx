import { useEffect, useRef, useState } from "react";
import {
  ftpStatus,
  ftpStart,
  ftpStop,
  ftpEventsTail,
  ftpEventsStream,
  type FtpStatus,
  type FtpEvent,
} from "../lib/tauri";
import { SidecarStatusChip } from "./SidecarStatusChip";
import { TftpStatusPill } from "./TftpStatusPill";
import { UpdateStatusPill } from "./UpdateStatusPill";
import AgentToolbelt from "./AgentToolbelt";

export function StatusFooter() {
  const [status, setStatus] = useState<FtpStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<FtpEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Poll status every few seconds so the pill stays in sync if the server
  // gets stopped/started from elsewhere.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await ftpStatus();
        if (!cancelled) setStatus(s);
      } catch {
        /* ignore */
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Subscribe to the live event stream once on mount.
  useEffect(() => {
    let aborted = false;
    ftpEventsStream((e) => {
      if (aborted) return;
      setEvents((prev) => [...prev.slice(-199), e]);
    }).catch(() => {});
    // Seed with recent events on open (once).
    ftpEventsTail(100)
      .then((rows) => setEvents(rows))
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, []);

  // Click-outside to close the popover.
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  const running = status?.running === true;
  const connCount = countActiveConnections(events);

  const handleToggle = async () => {
    setBusy(true);
    try {
      const s = running ? await ftpStop() : await ftpStart();
      setStatus(s);
    } catch {
      /* status poll will recover */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="status-footer">
      <SidecarStatusChip />
      <button
        type="button"
        className={`status-pill ${running ? "running" : "stopped"}`}
        onClick={() => setOpen((v) => !v)}
        title={running ? "FTP running — click for live activity" : "FTP stopped — click to start"}
      >
        <span className="status-dot" />
        <span className="status-label">
          FTP:{" "}
          {running
            ? `${status?.bindAddress ?? ""}${
                connCount > 0 ? ` · ${connCount} active` : ""
              }`
            : "stopped"}
        </span>
      </button>

      {open && (
        <div className="status-popover" ref={popoverRef}>
          <div className="status-popover-header">
            <span>FTP Server</span>
            <button
              type="button"
              className={running ? "stop-mini" : "start-mini"}
              onClick={handleToggle}
              disabled={busy}
            >
              {running ? "■ Stop" : "▶ Start"}
            </button>
          </div>

          {status?.lastError && (
            <div className="status-popover-error">
              Last error: {status.lastError}
            </div>
          )}

          <div className="status-popover-body">
            {events.length === 0 ? (
              <p className="muted" style={{ padding: 10 }}>
                No activity yet.
              </p>
            ) : (
              <ul className="status-event-list">
                {events.slice(-120).map((ev) => (
                  <li key={ev.id} className={`status-event ${kindClass(ev.kind)}`}>
                    <span className="status-event-ts">{fmtTime(ev.ts)}</span>
                    <span className="status-event-kind">{ev.kind}</span>
                    {ev.username && (
                      <span className="status-event-user">{ev.username}</span>
                    )}
                    <span className="status-event-detail">
                      {ev.path || ev.detail || ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <TftpStatusPill />
      <UpdateStatusPill />
      <AgentToolbelt />
    </div>
  );
}

function fmtTime(ms: number): string {
  try {
    const d = new Date(ms);
    return d.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function kindClass(kind: string): string {
  switch (kind) {
    case "error":
      return "error";
    case "login":
    case "logout":
      return "presence";
    case "stor":
    case "retr":
      return "transfer";
    default:
      return "";
  }
}

/** Approximate active connection count = (login count) - (logout count) in the
 * tail window. This is an event-based heuristic — accurate enough for a status pill. */
function countActiveConnections(events: FtpEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.kind === "login") n++;
    else if (e.kind === "logout") n = Math.max(0, n - 1);
  }
  return n;
}

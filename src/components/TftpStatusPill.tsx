import { useEffect, useRef, useState } from "react";
import {
  tftpStatus,
  tftpStart,
  tftpStop,
  tftpEventsTail,
  type TftpStatus,
  type TftpEvent,
} from "../lib/tauri";

/**
 * Bottom-status-bar pill for the TFTP server, mirroring the FTP pill in
 * StatusFooter. Polls tftpStatus() for the running/stopped color + label, and
 * (unlike FTP, which has an event *stream*) polls tftpEventsTail() for the
 * popover activity list — TFTP has no push channel because the elevated helper
 * runs out-of-process.
 */
export function TftpStatusPill() {
  const [status, setStatus] = useState<TftpStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TftpEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Poll status every few seconds so the pill stays in sync if the server is
  // started/stopped from the Settings tab or dies on its own.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await tftpStatus();
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

  // Poll recent events only while the popover is open (no push stream for TFTP).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const rows = await tftpEventsTail(120);
        if (!cancelled) setEvents(rows);
      } catch {
        /* ignore */
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open]);

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
  const hasError = !running && !!status?.lastError;

  const handleToggle = async () => {
    setBusy(true);
    try {
      // Note: starting on port < 1024 triggers the macOS admin prompt.
      const s = running ? await tftpStop() : await tftpStart();
      setStatus(s);
    } catch {
      /* status poll will recover */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`status-pill ${running ? "running" : hasError ? "error" : "stopped"}`}
        onClick={() => setOpen((v) => !v)}
        title={
          running
            ? "TFTP running — click for live activity"
            : hasError
              ? `TFTP error: ${status?.lastError}`
              : "TFTP stopped — click to start"
        }
      >
        <span className="status-dot" />
        <span className="status-label">
          TFTP:{" "}
          {running
            ? `${status?.bindAddress ?? ""}${status?.elevated ? " · elevated" : ""}`
            : hasError
              ? "error"
              : "stopped"}
        </span>
      </button>

      {open && (
        <div className="status-popover" ref={popoverRef}>
          <div className="status-popover-header">
            <span>TFTP Server</span>
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
                    {ev.clientIp && (
                      <span className="status-event-user">{ev.clientIp}</span>
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
    </>
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
    case "write":
    case "read":
      return "transfer";
    default:
      return "";
  }
}

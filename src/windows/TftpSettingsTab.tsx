import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  tftpConfigGet,
  tftpConfigSet,
  tftpStatus,
  tftpStart,
  tftpStop,
  tftpEventsTail,
  type TftpConfig,
  type TftpStatus,
  type TftpEvent,
} from "../lib/tauri";

export function TftpSettingsTab({ visible }: { visible: boolean }) {
  const [config, setConfig] = useState<TftpConfig | null>(null);
  const [status, setStatus] = useState<TftpStatus | null>(null);
  const [events, setEvents] = useState<TftpEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async (cancelled?: { current: boolean }) => {
    try {
      const [c, s, e] = await Promise.all([
        tftpConfigGet(),
        tftpStatus(),
        tftpEventsTail(200),
      ]);
      if (!cancelled?.current) {
        setConfig(c);
        setStatus(s);
        setEvents(e);
      }
    } catch (e) {
      if (!cancelled?.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  // Poll status + events while the tab is visible (works for in-process AND
  // the elevated helper, which can't push over an in-process channel).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const cancelledRef = { current: false };
    load(cancelledRef);
    pollRef.current = setInterval(async () => {
      try {
        const [s, e] = await Promise.all([tftpStatus(), tftpEventsTail(200)]);
        if (!cancelled) {
          setStatus(s);
          setEvents(e);
        }
      } catch {
        /* transient — ignore */
      }
    }, 1500);
    return () => {
      cancelled = true;
      cancelledRef.current = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [visible]);

  const handleSaveConfig = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      await tftpConfigSet(config);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await tftpStart());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await tftpStop());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleBrowseRoot = async () => {
    if (!config) return;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose TFTP root directory",
        defaultPath: config.rootDir || undefined,
      });
      if (typeof picked === "string" && picked.length > 0) {
        setConfig({ ...config, rootDir: picked });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!config) {
    return (
      <div className="tab-content">
        <h2>TFTP Server</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <div className="tab-header">
        <h2>TFTP Server</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusPill status={status} />
          {status?.running ? (
            <button className="secondary" onClick={handleStop} disabled={busy}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={handleStart} disabled={busy}>
              Start
            </button>
          )}
        </div>
      </div>

      <p className="muted" style={{ marginBottom: 16 }}>
        Anonymous UDP TFTP server for pushing/pulling configs and images to lab gear.
        Port 69 requires a one-time macOS admin prompt when you start it.
      </p>

      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      )}

      {!status?.running && status?.lastError && (
        <div className="error-message" data-testid="tftp-last-error">
          <strong>Server error:</strong> {status.lastError}
        </div>
      )}

      <h3 style={{ marginTop: 8 }}>Server configuration</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="form-group">
          <label>Bind host</label>
          <input
            type="text"
            value={config.bindHost}
            onChange={(e) => setConfig({ ...config, bindHost: e.target.value })}
            placeholder="0.0.0.0"
          />
          <small className="hint">0.0.0.0 = all interfaces (for lab gear)</small>
        </div>
        <div className="form-group">
          <label>Port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={config.bindPort}
            onChange={(e) =>
              setConfig({ ...config, bindPort: Number(e.target.value) || 69 })
            }
          />
          <small className="hint">
            69 = standard TFTP (prompts for admin). ≥ 1024 runs without a prompt.
          </small>
        </div>
        <div className="form-group" style={{ gridColumn: "1 / -1" }}>
          <label>Root directory</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={config.rootDir}
              onChange={(e) => setConfig({ ...config, rootDir: e.target.value })}
              placeholder="Default: ~/.ccie-terminal/tftp"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="secondary"
              onClick={handleBrowseRoot}
              style={{ whiteSpace: "nowrap" }}
            >
              📁 Browse
            </button>
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={config.readOnly}
            onChange={(e) => setConfig({ ...config, readOnly: e.target.checked })}
          />
          Read-only (reject uploads)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={config.autoStart}
            onChange={(e) => setConfig({ ...config, autoStart: e.target.checked })}
          />
          Auto-start (persisted; not yet auto-run at boot)
        </label>
      </div>
      <div className="form-actions" style={{ marginTop: 4 }}>
        <button className="primary" onClick={handleSaveConfig} disabled={busy}>
          Save configuration
        </button>
      </div>

      <h3 style={{ marginTop: 24 }}>Activity</h3>
      {events.length === 0 ? (
        <p className="muted">No transfers yet. Point a device at this server to see activity.</p>
      ) : (
        <div className="servers-list" data-testid="tftp-feed">
          {events.map((ev) => (
            <div key={ev.id} className="server-item" style={{ padding: "6px 10px" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12 }}>
                <span className="transport-badge">{ev.kind}</span>
                <code style={{ flex: 1 }}>{ev.path ?? "—"}</code>
                <span className="muted">{ev.clientIp ?? ""}</span>
                {ev.detail && <span className="muted">{ev.detail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: TftpStatus | null }) {
  const running = status?.running === true;
  const errored = !running && !!status?.lastError;
  const label = running
    ? `Running${status?.elevated ? " · elevated" : ""} · ${status?.bindAddress ?? ""}`
    : errored
      ? "Error"
      : "Stopped";
  const dot = running ? "var(--status-success)" : errored ? "var(--text-primary)" : "var(--text-muted)";
  return (
    <span
      className="tftp-pill"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        background: running ? "var(--status-danger-surface)" : errored ? "var(--status-danger-surface)" : "var(--surface-3)",
        color: running ? "var(--status-success)" : errored ? "var(--status-danger)" : "var(--text-secondary)",
        border: `1px solid ${running ? "var(--status-danger)" : errored ? "var(--status-danger)" : "var(--border-default)"}`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dot,
          boxShadow: running ? "0 0 6px var(--status-success)" : errored ? "0 0 6px var(--status-danger-surface)" : "none",
        }}
      />
      {label}
    </span>
  );
}

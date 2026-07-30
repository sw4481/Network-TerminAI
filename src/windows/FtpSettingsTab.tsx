import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ftpConfigGet,
  ftpConfigSet,
  ftpStatus,
  ftpStart,
  ftpStop,
  ftpUsersList,
  ftpUsersCreate,
  ftpUsersUpdate,
  ftpUsersDelete,
  type FtpConfig,
  type FtpUser,
  type FtpStatus,
} from "../lib/tauri";

export function FtpSettingsTab({ visible }: { visible: boolean }) {
  const [config, setConfig] = useState<FtpConfig | null>(null);
  const [status, setStatus] = useState<FtpStatus | null>(null);
  const [users, setUsers] = useState<FtpUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Create-user form
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newHomeDir, setNewHomeDir] = useState("");
  const [newReadOnly, setNewReadOnly] = useState(false);

  const load = async () => {
    try {
      const [c, s, u] = await Promise.all([
        ftpConfigGet(),
        ftpStatus(),
        ftpUsersList(),
      ]);
      setConfig(c);
      setStatus(s);
      setUsers(u);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (visible) load();
  }, [visible]);

  const handleSaveConfig = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      await ftpConfigSet(config);
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
      const s = await ftpStart();
      setStatus(s);
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
      const s = await ftpStop();
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateUser = async () => {
    if (!newUsername.trim() || !newPassword) {
      setError("Username and password required");
      return;
    }
    setError(null);
    try {
      await ftpUsersCreate({
        username: newUsername.trim(),
        password: newPassword,
        homeDir: newHomeDir.trim() || null,
        readOnly: newReadOnly,
      });
      setNewUsername("");
      setNewPassword("");
      setNewHomeDir("");
      setNewReadOnly(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteUser = async (id: string, username: string) => {
    if (!confirm(`Delete FTP user "${username}"? Their home directory will NOT be deleted.`)) return;
    try {
      await ftpUsersDelete(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleEnabled = async (u: FtpUser) => {
    try {
      await ftpUsersUpdate({ id: u.id, enabled: !u.enabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleReadOnly = async (u: FtpUser) => {
    try {
      await ftpUsersUpdate({ id: u.id, readOnly: !u.readOnly });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleResetPassword = async (u: FtpUser) => {
    const pw = prompt(`New password for ${u.username}:`);
    if (!pw) return;
    try {
      await ftpUsersUpdate({ id: u.id, password: pw });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Open the native folder picker. Returns the selected absolute path, or null if cancelled. */
  const pickDirectory = async (opts: {
    title?: string;
    startPath?: string;
  }): Promise<string | null> => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: opts.title ?? "Select folder",
        defaultPath: opts.startPath || undefined,
      });
      if (typeof picked === "string" && picked.length > 0) return picked;
      return null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const handleBrowseNewHome = async () => {
    const picked = await pickDirectory({ title: "Choose home directory for new user" });
    if (picked) setNewHomeDir(picked);
  };

  const handleBrowseExistingHome = async (u: FtpUser) => {
    const picked = await pickDirectory({
      title: `Choose new home directory for ${u.username}`,
      startPath: u.homeDir,
    });
    if (!picked) return;
    try {
      await ftpUsersUpdate({ id: u.id, homeDir: picked });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!config) {
    return (
      <div className="tab-content">
        <h2>FTP Server</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <div className="tab-header">
        <h2>FTP Server</h2>
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
        Embedded FTP server for transferring images/configs to lab gear. Each user is
        chroot-jailed to their home directory on login.
      </p>

      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* --- Config --- */}
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
              setConfig({ ...config, bindPort: Number(e.target.value) || 2121 })
            }
          />
          <small className="hint">
            macOS requires root for ports &lt; 1024 — use 2121 for dev.
          </small>
        </div>
        <div className="form-group">
          <label>Passive port min</label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={config.passiveMin}
            onChange={(e) =>
              setConfig({ ...config, passiveMin: Number(e.target.value) || 49152 })
            }
          />
        </div>
        <div className="form-group">
          <label>Passive port max</label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={config.passiveMax}
            onChange={(e) =>
              setConfig({ ...config, passiveMax: Number(e.target.value) || 49200 })
            }
          />
        </div>
        <div className="form-group" style={{ gridColumn: "1 / -1" }}>
          <label>Greeting banner</label>
          <input
            type="text"
            value={config.greeting}
            onChange={(e) => setConfig({ ...config, greeting: e.target.value })}
          />
        </div>
      </div>
      <div className="form-actions" style={{ marginTop: 4 }}>
        <button className="primary" onClick={handleSaveConfig} disabled={busy}>
          Save configuration
        </button>
      </div>

      {/* --- Users --- */}
      <h3 style={{ marginTop: 24 }}>Users</h3>
      <div
        className="ftp-user-create"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 2fr auto auto",
          gap: 8,
          alignItems: "end",
          marginBottom: 16,
          padding: 12,
          background: "var(--surface-chrome)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
        }}
      >
        <div className="form-group" style={{ margin: 0 }}>
          <label>Username</label>
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="ciscoadmin"
          />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Password</label>
          <input
            type="text"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="(plaintext for MVP)"
          />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Home dir (optional)</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={newHomeDir}
              onChange={(e) => setNewHomeDir(e.target.value)}
              placeholder="Default: ~/.ccie-terminal/ftp/<username>"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="secondary"
              onClick={handleBrowseNewHome}
              title="Browse for a folder"
              style={{ whiteSpace: "nowrap" }}
            >
              📁 Browse
            </button>
          </div>
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
            marginBottom: 6,
            whiteSpace: "nowrap",
          }}
        >
          <input
            type="checkbox"
            checked={newReadOnly}
            onChange={(e) => setNewReadOnly(e.target.checked)}
          />
          Read-only
        </label>
        <button className="primary" onClick={handleCreateUser} style={{ marginBottom: 4 }}>
          Add user
        </button>
      </div>

      {users.length === 0 ? (
        <p className="muted">No users yet. Add one above.</p>
      ) : (
        <div className="servers-list">
          {users.map((u) => (
            <div key={u.id} className="server-item">
              <div className="server-header">
                <div className="server-name">
                  <strong>{u.username}</strong>
                  {!u.enabled && <span className="transport-badge">disabled</span>}
                  {u.readOnly && <span className="transport-badge">read-only</span>}
                </div>
                <div className="server-actions">
                  <button onClick={() => handleToggleEnabled(u)}>
                    {u.enabled ? "Disable" : "Enable"}
                  </button>
                  <button onClick={() => handleToggleReadOnly(u)}>
                    {u.readOnly ? "Make writable" : "Make read-only"}
                  </button>
                  <button onClick={() => handleResetPassword(u)}>Reset pwd</button>
                  <button
                    className="delete-btn"
                    onClick={() => handleDeleteUser(u.id, u.username)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="server-details">
                <div className="detail-row">
                  <span className="label">Home:</span>
                  <code style={{ flex: 1 }}>{u.homeDir}</code>
                  <button
                    type="button"
                    onClick={() => handleBrowseExistingHome(u)}
                    title="Change home directory"
                    style={{ marginLeft: 8, fontSize: 11 }}
                  >
                    📁 Change
                  </button>
                </div>
                <div className="detail-row">
                  <span className="label">Password:</span>
                  <code>{u.password}</code>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: FtpStatus | null }) {
  const running = status?.running === true;
  return (
    <span
      className="ftp-pill"
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
        background: running ? "color-mix(in srgb, var(--status-success) 18%, var(--surface-1))" : "var(--surface-3)",
        color: running ? "var(--status-success)" : "var(--text-secondary)",
        border: `1px solid ${running ? "var(--status-success)" : "var(--border-default)"}`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: running ? "var(--status-success)" : "var(--text-muted)",
          boxShadow: running ? "0 0 6px var(--status-success)" : "none",
        }}
      />
      {running
        ? `Running · ${status?.bindAddress ?? ""}`
        : "Stopped"}
    </span>
  );
}

import { useEffect, useState } from "react";
import {
  proxmoxGetConfig,
  proxmoxSaveConfig,
  proxmoxTestConnection,
  type ProxmoxConfig,
} from "../../lib/tauri";
import "./ProxmoxSettingsTab.css";

type StatusKind = "ok" | "err" | "info";

export function ProxmoxSettingsTab() {
  const [cfg, setCfg] = useState<ProxmoxConfig>({
    host: "",
    port: 8006,
    user: "root@pam",
    tokenName: "",
    tokenValue: "",
    password: "",
    verifySsl: false,
  });
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    proxmoxGetConfig()
      .then((c) => {
        if (c) setCfg((prev) => ({ ...prev, ...c }));
      })
      .catch(() => {});
  }, []);

  const set = <K extends keyof ProxmoxConfig>(key: K, value: ProxmoxConfig[K]) =>
    setCfg((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setSaving(true);
    setStatus({ kind: "info", text: "Saving…" });
    try {
      await proxmoxSaveConfig(cfg);
      setStatus({ kind: "ok", text: "Saved. Available to all agents." });
    } catch (e) {
      setStatus({ kind: "err", text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!cfg.host.trim()) {
      setStatus({ kind: "err", text: "Enter a host before testing." });
      return;
    }
    setTesting(true);
    setStatus({ kind: "info", text: "Testing connection…" });
    try {
      const res = await proxmoxTestConnection(cfg);
      setStatus({ kind: res.ok ? "ok" : "err", text: res.message });
    } catch (e) {
      setStatus({ kind: "err", text: `Test failed: ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="pve-tab">
      <div className="pve-header">
        <h3>Proxmox VE</h3>
        <p className="pve-subtitle">
          Connection details for the bundled Proxmox tool, available to every agent.
          Stored locally like your AI provider key. Use an API token when possible;
          password is a fallback.
        </p>
      </div>

      <div className="pve-section">
        <div className="pve-section-label">Connection</div>
        <div className="pve-grid">
          <div className="pve-field">
            <label htmlFor="pve-host">Host</label>
            <input
              id="pve-host"
              type="text"
              value={cfg.host}
              onChange={(e) => set("host", e.target.value)}
              placeholder="proxmox.example.test"
            />
          </div>
          <div className="pve-field">
            <label htmlFor="pve-port">Port</label>
            <input
              id="pve-port"
              type="number"
              value={cfg.port}
              onChange={(e) => set("port", Number(e.target.value))}
            />
          </div>
          <div className="pve-field pve-field--full">
            <label htmlFor="pve-user">User</label>
            <input
              id="pve-user"
              type="text"
              value={cfg.user}
              onChange={(e) => set("user", e.target.value)}
              placeholder="root@pam"
            />
          </div>
        </div>
      </div>

      <div className="pve-section">
        <div className="pve-section-label">Authentication</div>
        <div className="pve-grid">
          <div className="pve-field">
            <label htmlFor="pve-token-name">
              Token name <span className="pve-hint">(recommended)</span>
            </label>
            <input
              id="pve-token-name"
              type="text"
              value={cfg.tokenName}
              onChange={(e) => set("tokenName", e.target.value)}
              placeholder="e.g. automation"
            />
          </div>
          <div className="pve-field">
            <label htmlFor="pve-token-value">
              Token value <span className="pve-hint">(recommended)</span>
            </label>
            <input
              id="pve-token-value"
              type="password"
              value={cfg.tokenValue}
              onChange={(e) => set("tokenValue", e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div className="pve-field pve-field--full">
            <label htmlFor="pve-password">
              Password <span className="pve-hint">(fallback if no token)</span>
            </label>
            <input
              id="pve-password"
              type="password"
              value={cfg.password}
              onChange={(e) => set("password", e.target.value)}
              placeholder="••••••••"
            />
          </div>
        </div>
        <label className="pve-check">
          <input
            type="checkbox"
            checked={!!cfg.verifySsl}
            onChange={(e) => set("verifySsl", e.target.checked)}
          />
          Verify TLS certificate
        </label>
      </div>

      <div className="pve-actions">
        <button className="pve-btn pve-btn--primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="pve-btn" onClick={test} disabled={testing} aria-busy={testing}>
          {testing ? "Testing…" : "Test connection"}
        </button>
      </div>

      {status && (
        <div className={`pve-status pve-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

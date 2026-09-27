import { useState, useEffect } from 'react';
import {
  splunkGetConfig,
  splunkSaveConfig,
  splunkTestConnection,
  type SplunkConfig,
} from '../../lib/tauri';
import './SplunkSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function SplunkSettingsTab() {
  const [cfg, setCfg] = useState<SplunkConfig>({
    host: '',
    port: 8089,
    token: '',
    username: '',
    password: '',
    verifySsl: false,
  });

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    splunkGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    if (!cfg.host.trim()) {
      setStatus({ kind: 'err', text: 'Enter a host before testing.' });
      return;
    }
    if (!cfg.token.trim() && !cfg.username.trim()) {
      setStatus({ kind: 'err', text: 'Provide a token or a username/password.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await splunkTestConnection(cfg);
      setStatus({ kind: res.ok ? 'ok' : 'err', text: res.message });
    } catch (e) {
      setStatus({ kind: 'err', text: `Test failed: ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await splunkSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="splunk-tab">
      <div className="splunk-header">
        <h2>Cisco Splunk</h2>
        <p className="splunk-subtitle">
          Configure connection to Splunk Enterprise for searching logs and events
          with SPL, inspecting indexes, and reviewing saved searches and alerts.
          The Splunk agent reaches the management REST API (port 8089 by default)
          with these credentials.
        </p>
      </div>

      <div className="splunk-section">
        <h3>Connection</h3>
        <div className="splunk-grid">
          <label htmlFor="splunk-host">Host</label>
          <input
            id="splunk-host"
            type="text"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="splunk.example.com"
          />
          <div className="splunk-field-desc splunk-field--full">
            Splunk hostname or IP (without https://).
          </div>

          <label htmlFor="splunk-port">Port</label>
          <input
            id="splunk-port"
            type="number"
            value={cfg.port}
            onChange={(e) =>
              setCfg({ ...cfg, port: parseInt(e.target.value, 10) || 8089 })
            }
            placeholder="8089"
          />
          <div className="splunk-field-desc splunk-field--full">
            Splunk management API port (default 8089).
          </div>
        </div>
      </div>

      <div className="splunk-section">
        <h3>Authentication</h3>
        <div className="splunk-grid">
          <label htmlFor="splunk-token">Token</label>
          <input
            id="splunk-token"
            type="password"
            value={cfg.token}
            onChange={(e) => setCfg({ ...cfg, token: e.target.value })}
            placeholder="Splunk authentication token (optional)"
          />
          <div className="splunk-field-desc splunk-field--full">
            A Splunk authentication token (Settings → Tokens in Splunk). Preferred
            when set. Leave blank to use username/password instead.
          </div>

          <label htmlFor="splunk-username">Username</label>
          <input
            id="splunk-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="admin"
          />

          <label htmlFor="splunk-password">Password</label>
          <input
            id="splunk-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />

          <div className="splunk-field-desc splunk-field--full">
            Used only when no token is provided (HTTP Basic auth).
          </div>
        </div>
      </div>

      <div className="splunk-section">
        <h3>TLS</h3>
        <div className="splunk-grid">
          <label htmlFor="splunk-verify-ssl" className="splunk-checkbox-label">
            <input
              id="splunk-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
            />
            Verify SSL certificates
          </label>
          <div className="splunk-field-desc splunk-field--full">
            Leave unchecked for the self-signed certificate Splunk ships with by
            default (not recommended for production).
          </div>
        </div>
      </div>

      <div className="splunk-actions">
        <button onClick={save} disabled={saving} className="splunk-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="splunk-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`splunk-status splunk-status--${status.kind}`}>
          {status.text}
        </div>
      )}
    </div>
  );
}

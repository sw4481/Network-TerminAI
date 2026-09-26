import { useState, useEffect } from 'react';
import {
  catalystCenterGetConfig,
  catalystCenterSaveConfig,
  catalystCenterTestConnection,
  type CatalystCenterConfig,
} from '../../lib/tauri';
import './CatalystCenterSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function CatalystCenterSettingsTab() {
  const [cfg, setCfg] = useState<CatalystCenterConfig>({
    host: '',
    username: '',
    password: '',
    verifySsl: false,
  });

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    catalystCenterGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    if (!cfg.host.trim()) {
      setStatus({ kind: 'err', text: 'Enter a host before testing.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await catalystCenterTestConnection(cfg);
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
      await catalystCenterSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cc-tab">
      <div className="cc-header">
        <h2>Cisco Catalyst Center</h2>
        <p className="cc-subtitle">
          Configure connection to Cisco Catalyst Center (formerly DNA Center) for
          inspecting devices, sites, topology, and health. The Catalyst Center
          agent reaches the Intent API with these credentials.
        </p>
      </div>

      <div className="cc-section">
        <h3>Connection</h3>
        <div className="cc-grid">
          <label htmlFor="cc-host">Host</label>
          <input
            id="cc-host"
            type="text"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="your-server-ip"
          />
          <div className="cc-field-desc cc-field--full">
            Catalyst Center hostname or IP (without https://).
          </div>
        </div>
      </div>

      <div className="cc-section">
        <h3>Authentication</h3>
        <div className="cc-grid">
          <label htmlFor="cc-username">Username</label>
          <input
            id="cc-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="admin"
          />

          <label htmlFor="cc-password">Password</label>
          <input
            id="cc-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />

          <div className="cc-field-desc cc-field--full">
            A Catalyst Center user account with API access (ROLE_PERMISSION as
            needed for the resources you query).
          </div>
        </div>
      </div>

      <div className="cc-section">
        <h3>TLS</h3>
        <div className="cc-grid">
          <label htmlFor="cc-verify-ssl" className="cc-checkbox-label">
            <input
              id="cc-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
            />
            Verify SSL certificates
          </label>
          <div className="cc-field-desc cc-field--full">
            Leave unchecked for the self-signed certificate Catalyst Center ships
            with by default (not recommended for production).
          </div>
        </div>
      </div>

      <div className="cc-actions">
        <button onClick={save} disabled={saving} className="cc-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="cc-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`cc-status cc-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

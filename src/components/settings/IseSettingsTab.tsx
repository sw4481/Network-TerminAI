import { useState, useEffect } from 'react';
import {
  iseGetConfig,
  iseSaveConfig,
  iseTestConnection,
  type IseConfig,
} from '../../lib/tauri';
import './IseSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function IseSettingsTab() {
  const [cfg, setCfg] = useState<IseConfig>({
    host: '',
    username: '',
    password: '',
    verifySsl: false,
  });

  const [status, setStatus] = useState<{
    kind: StatusKind;
    text: string;
  } | null>(null);

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load config on mount
  useEffect(() => {
    iseGetConfig().then((config) => {
      if (config) {
        setCfg(config);
      }
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
      const res = await iseTestConnection(cfg);
      setStatus({
        kind: res.ok ? 'ok' : 'err',
        text: res.message,
      });
    } catch (e) {
      setStatus({
        kind: 'err',
        text: `Test failed: ${String(e)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await iseSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ise-tab">
      <div className="ise-header">
        <h2>Cisco Identity Services Engine</h2>
        <p className="ise-subtitle">
          Configure connection to Cisco ISE for managing network devices,
          endpoints, identity groups, TrustSec SGTs, and live sessions. The ISE
          agent reaches the ERS (9060), OpenAPI (443), and MnT (443) surfaces
          with these credentials.
        </p>
      </div>

      <div className="ise-section">
        <h3>Connection</h3>
        <div className="ise-grid">
          <label htmlFor="ise-host">Host</label>
          <input
            id="ise-host"
            type="text"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="ise.example.com"
          />
          <div className="ise-field-desc ise-field--full">
            ISE admin node hostname or IP (without https://). ERS must be enabled
            (Admin → System → Settings → API Settings → ERS).
          </div>
        </div>
      </div>

      <div className="ise-section">
        <h3>Authentication</h3>
        <div className="ise-grid">
          <label htmlFor="ise-username">Username</label>
          <input
            id="ise-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="admin"
          />

          <label htmlFor="ise-password">Password</label>
          <input
            id="ise-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />

          <div className="ise-field-desc ise-field--full">
            An ISE admin account with ERS/API access permissions.
          </div>
        </div>
      </div>

      <div className="ise-section">
        <h3>TLS</h3>
        <div className="ise-grid">
          <label htmlFor="ise-verify-ssl" className="ise-checkbox-label">
            <input
              id="ise-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) =>
                setCfg({ ...cfg, verifySsl: e.target.checked })
              }
            />
            Verify SSL certificates
          </label>
          <div className="ise-field-desc ise-field--full">
            Leave unchecked for the self-signed certificates ISE ships with by
            default (not recommended for production).
          </div>
        </div>
      </div>

      <div className="ise-actions">
        <button onClick={save} disabled={saving} className="ise-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={test}
          disabled={testing}
          className="ise-btn-secondary"
        >
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`ise-status ise-status--${status.kind}`}>
          {status.text}
        </div>
      )}
    </div>
  );
}

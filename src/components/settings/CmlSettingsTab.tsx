import { useState, useEffect } from 'react';
import {
  cmlGetConfig,
  cmlSaveConfig,
  cmlTestConnection,
  type CmlConfig,
} from '../../lib/tauri';
import './CmlSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function CmlSettingsTab() {
  const [cfg, setCfg] = useState<CmlConfig>({
    host: '',
    username: '',
    password: '',
    verifySsl: false,
  });

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    cmlGetConfig().then((config) => {
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
      const res = await cmlTestConnection(cfg);
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
      await cmlSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cml-tab">
      <div className="cml-header">
        <h2>Cisco Modeling Labs</h2>
        <p className="cml-subtitle">
          Configure connection to Cisco Modeling Labs (CML) for inspecting and
          operating simulation labs, nodes, and topologies. The CML agent reaches
          the /api/v0 REST API with these credentials.
        </p>
      </div>

      <div className="cml-section">
        <h3>Connection</h3>
        <div className="cml-grid">
          <label htmlFor="cml-host">Host</label>
          <input
            id="cml-host"
            type="text"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="your-server-ip"
          />
          <div className="cml-field-desc cml-field--full">
            CML server hostname or IP (without https://).
          </div>
        </div>
      </div>

      <div className="cml-section">
        <h3>Authentication</h3>
        <div className="cml-grid">
          <label htmlFor="cml-username">Username</label>
          <input
            id="cml-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="admin"
          />

          <label htmlFor="cml-password">Password</label>
          <input
            id="cml-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />

          <div className="cml-field-desc cml-field--full">
            A CML user account with API access.
          </div>
        </div>
      </div>

      <div className="cml-section">
        <h3>TLS</h3>
        <div className="cml-grid">
          <label htmlFor="cml-verify-ssl" className="cml-checkbox-label">
            <input
              id="cml-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
            />
            Verify SSL certificates
          </label>
          <div className="cml-field-desc cml-field--full">
            Leave unchecked for the self-signed certificate CML ships with by
            default (not recommended for production).
          </div>
        </div>
      </div>

      <div className="cml-actions">
        <button onClick={save} disabled={saving} className="cml-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="cml-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`cml-status cml-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

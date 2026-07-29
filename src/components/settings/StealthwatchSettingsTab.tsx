import { useState, useEffect } from 'react';
import {
  stealthwatchGetConfig,
  stealthwatchSaveConfig,
  stealthwatchTestConnection,
  type StealthwatchConfig,
} from '../../lib/tauri';
import './StealthwatchSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function StealthwatchSettingsTab() {
  const [cfg, setCfg] = useState<StealthwatchConfig>({
    host: '',
    username: '',
    password: '',
    verifySsl: true,
  });

  const [status, setStatus] = useState<{
    kind: StatusKind;
    text: string;
  } | null>(null);

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load config on mount
  useEffect(() => {
    stealthwatchGetConfig().then((config) => {
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
      const res = await stealthwatchTestConnection(cfg);
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
      await stealthwatchSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sw-tab">
      <div className="sw-header">
        <h2>Cisco Stealthwatch Enterprise</h2>
        <p className="sw-subtitle">
          Configure connection to Stealthwatch Management Console (SMC) for
          security event analysis and threat detection
        </p>
      </div>

      <div className="sw-section">
        <h3>Connection</h3>
        <div className="sw-grid">
          <label htmlFor="sw-host">Host</label>
          <input
            id="sw-host"
            type="text"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="smc.example.com"
          />
          <div className="sw-field-desc sw-field--full">
            Stealthwatch Management Console hostname or IP (without https://)
          </div>
        </div>
      </div>

      <div className="sw-section">
        <h3>Authentication</h3>
        <div className="sw-grid">
          <label htmlFor="sw-username">Username</label>
          <input
            id="sw-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="admin"
          />

          <label htmlFor="sw-password">Password</label>
          <input
            id="sw-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />

          <div className="sw-field-desc sw-field--full">
            User must have API access permissions in Stealthwatch
          </div>
        </div>
      </div>

      <div className="sw-section">
        <h3>TLS</h3>
        <div className="sw-grid">
          <label htmlFor="sw-verify-ssl" className="sw-checkbox-label">
            <input
              id="sw-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) =>
                setCfg({ ...cfg, verifySsl: e.target.checked })
              }
            />
            Verify SSL certificates
          </label>
          <div className="sw-field-desc sw-field--full">
            Uncheck for self-signed certificates (not recommended for
            production)
          </div>
        </div>
      </div>

      <div className="sw-actions">
        <button onClick={save} disabled={saving} className="sw-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={test}
          disabled={testing}
          className="sw-btn-secondary"
        >
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`sw-status sw-status--${status.kind}`}>
          {status.text}
        </div>
      )}
    </div>
  );
}

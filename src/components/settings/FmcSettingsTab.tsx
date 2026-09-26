import { useState, useEffect } from 'react';
import {
  fmcGetConfig,
  fmcSaveConfig,
  fmcTestConnection,
  type FmcConfig,
} from '../../lib/tauri';
import './FmcSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function FmcSettingsTab() {
  const [cfg, setCfg] = useState<FmcConfig>({
    host: '',
    username: '',
    password: '',
    domainUuid: '',
    verifySsl: false,
  });

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fmcGetConfig().then((config) => {
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
      const res = await fmcTestConnection(cfg);
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
      await fmcSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fmc-tab">
      <div className="fmc-header">
        <h2>Cisco Secure Firewall (FMC)</h2>
        <p className="fmc-subtitle">
          Configure connection to the Firewall Management Center for inspecting
          access policies, rules, network/port objects, and managed FTD devices.
          The FMC agent reaches the FMC REST API with these credentials.
        </p>
      </div>

      <div className="fmc-section">
        <h3>Connection</h3>
        <div className="fmc-grid">
          <label htmlFor="fmc-host">Host</label>
          <input
            id="fmc-host"
            type="text"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="fmc.example.com"
          />
          <div className="fmc-field-desc fmc-field--full">
            FMC hostname or IP (without https://).
          </div>
        </div>
      </div>

      <div className="fmc-section">
        <h3>Authentication</h3>
        <div className="fmc-grid">
          <label htmlFor="fmc-username">Username</label>
          <input
            id="fmc-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="apiuser"
          />

          <label htmlFor="fmc-password">Password</label>
          <input
            id="fmc-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />

          <label htmlFor="fmc-domain">Domain UUID</label>
          <input
            id="fmc-domain"
            type="text"
            value={cfg.domainUuid}
            onChange={(e) => setCfg({ ...cfg, domainUuid: e.target.value })}
            placeholder="(optional — defaults to Global)"
          />

          <div className="fmc-field-desc fmc-field--full">
            An FMC user with REST API access. Leave Domain UUID blank to use the
            default domain reported at login.
          </div>
        </div>
      </div>

      <div className="fmc-section">
        <h3>TLS</h3>
        <div className="fmc-grid">
          <label htmlFor="fmc-verify-ssl" className="fmc-checkbox-label">
            <input
              id="fmc-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
            />
            Verify SSL certificates
          </label>
          <div className="fmc-field-desc fmc-field--full">
            Leave unchecked for the self-signed certificate FMC ships with by
            default (not recommended for production).
          </div>
        </div>
      </div>

      <div className="fmc-actions">
        <button onClick={save} disabled={saving} className="fmc-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="fmc-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`fmc-status fmc-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

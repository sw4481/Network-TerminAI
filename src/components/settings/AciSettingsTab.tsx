import { useState, useEffect } from 'react';
import {
  aciGetConfig,
  aciSaveConfig,
  aciTestConnection,
  type AciConfig,
} from '../../lib/tauri';
import './AciSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function AciSettingsTab() {
  const [cfg, setCfg] = useState<AciConfig>({
    host: '',
    username: '',
    password: '',
    verifySsl: false,
  });

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    aciGetConfig().then((config) => {
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
      const res = await aciTestConnection(cfg);
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
      await aciSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aci-tab">
      <div className="aci-header">
        <h2>Cisco ACI (APIC)</h2>
        <p className="aci-subtitle">
          Configure connection to the Cisco APIC for inspecting and operating the
          ACI fabric — tenants, EPGs, bridge domains, VRFs, contracts, L3Outs,
          fabric health and faults. The ACI agent reaches the APIC REST API with
          these credentials.
        </p>
      </div>

      <div className="aci-section">
        <h3>Connection</h3>
        <div className="aci-grid">
          <label htmlFor="aci-host">Host</label>
          <input
            id="aci-host"
            type="text"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="sandboxapicdc.cisco.com"
          />
          <div className="aci-field-desc aci-field--full">
            APIC hostname or IP (without https://).
          </div>
        </div>
      </div>

      <div className="aci-section">
        <h3>Authentication</h3>
        <div className="aci-grid">
          <label htmlFor="aci-username">Username</label>
          <input
            id="aci-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="admin"
          />

          <label htmlFor="aci-password">Password</label>
          <input
            id="aci-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />

          <div className="aci-field-desc aci-field--full">
            An APIC user account with API access.
          </div>
        </div>
      </div>

      <div className="aci-section">
        <h3>TLS</h3>
        <div className="aci-grid">
          <label htmlFor="aci-verify-ssl" className="aci-checkbox-label">
            <input
              id="aci-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
            />
            Verify SSL certificates
          </label>
          <div className="aci-field-desc aci-field--full">
            Leave unchecked for the self-signed certificate the APIC ships with by
            default (not recommended for production).
          </div>
        </div>
      </div>

      <div className="aci-actions">
        <button onClick={save} disabled={saving} className="aci-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="aci-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`aci-status aci-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

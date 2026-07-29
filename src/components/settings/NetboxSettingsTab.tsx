import { useState, useEffect } from 'react';
import {
  netboxGetConfig,
  netboxSaveConfig,
  netboxTestConnection,
  type NetboxConfig,
} from '../../lib/tauri';
import './NetclawSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function NetboxSettingsTab() {
  const [cfg, setCfg] = useState<NetboxConfig>({
    url: '',
    token: '',
    verifySsl: false,
  });
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    netboxGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    if (!cfg.url.trim()) {
      setStatus({ kind: 'err', text: 'Enter a NetBox URL before testing.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await netboxTestConnection(cfg);
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
      await netboxSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="nc-tab">
      <div className="nc-header">
        <h2>NetBox</h2>
        <p className="nc-subtitle">
          Configure connection to NetBox — your DCIM/IPAM source of truth. The
          NetBox agent can query device inventory, IP space, and sites, and (with
          your approval) create or update records via an API token.
        </p>
      </div>

      <div className="nc-section">
        <h3>Connection</h3>
        <div className="nc-grid">
          <label htmlFor="netbox-url">URL</label>
          <input
            id="netbox-url"
            type="text"
            value={cfg.url}
            onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
            placeholder="https://netbox.example.com"
          />
          <div className="nc-field-desc nc-field--full">
            Full base URL of the NetBox instance (including https://).
          </div>
        </div>
      </div>

      <div className="nc-section">
        <h3>Authentication</h3>
        <div className="nc-grid">
          <label htmlFor="netbox-token">API token</label>
          <input
            id="netbox-token"
            type="password"
            value={cfg.token}
            onChange={(e) => setCfg({ ...cfg, token: e.target.value })}
          />
          <div className="nc-field-desc nc-field--full">
            A NetBox API token (Admin → API Tokens). Grant write scope only if you
            want the agent to update records; reads need only view permission.
          </div>
        </div>
      </div>

      <div className="nc-section">
        <h3>TLS</h3>
        <div className="nc-grid">
          <label htmlFor="netbox-verify-ssl" className="nc-checkbox-label">
            <input
              id="netbox-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
            />
            Verify SSL certificates
          </label>
          <div className="nc-field-desc nc-field--full">
            Leave unchecked for self-signed certificates.
          </div>
        </div>
      </div>

      <div className="nc-actions">
        <button onClick={save} disabled={saving} className="nc-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="nc-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`nc-status nc-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

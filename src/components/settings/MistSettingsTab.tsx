import { useState, useEffect } from 'react';
import {
  mistGetConfig,
  mistSaveConfig,
  mistTestConnection,
  type MistConfig,
} from '../../lib/tauri';
import './IseSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function MistSettingsTab() {
  const [cfg, setCfg] = useState<MistConfig>({
    region: 'global01',
    apiToken: '',
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
    mistGetConfig().then((config) => {
      if (config) {
        setCfg(config);
      }
    });
  }, []);

  const test = async () => {
    if (!cfg.apiToken.trim()) {
      setStatus({ kind: 'err', text: 'Enter an API Token before testing.' });
      return;
    }

    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });

    try {
      const res = await mistTestConnection(cfg);
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
      await mistSaveConfig(cfg);
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
        <h2>Juniper Mist</h2>
        <p className="ise-subtitle">
          Configure connection to Juniper Mist (cloud-managed Wireless / Wired /
          WAN Assurance) for org &amp; site discovery, device inventory, wireless
          clients, WLANs, and Assurance/SLE insights. Create an API token under
          your account settings (My Account → API Tokens) in the Mist dashboard,
          and pick the region/cloud your org lives on.
        </p>
      </div>

      <div className="ise-section">
        <h3>Region / Cloud</h3>
        <div className="ise-grid">
          <label htmlFor="mist-region">Region</label>
          <select
            id="mist-region"
            value={cfg.region}
            onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
          >
            <option value="global01">Global 01 (api.mist.com)</option>
            <option value="global02">Global 02 (api.gc1.mist.com)</option>
            <option value="global03">Global 03 (api.ac2.mist.com)</option>
            <option value="emea01">EMEA 01 (api.eu.mist.com)</option>
            <option value="emea02">EMEA 02 (api.gc3.mist.com)</option>
            <option value="apac01">APAC 01 (api.ac5.mist.com)</option>
          </select>
        </div>
      </div>

      <div className="ise-section">
        <h3>API Token</h3>
        <div className="ise-grid">
          <label htmlFor="mist-api-token">API Token</label>
          <input
            id="mist-api-token"
            type="password"
            value={cfg.apiToken}
            onChange={(e) => setCfg({ ...cfg, apiToken: e.target.value })}
            placeholder="Authorization: Token …"
          />
        </div>
      </div>

      <div className="ise-section">
        <h3>TLS</h3>
        <div className="ise-grid">
          <label htmlFor="mist-verify-ssl" className="ise-checkbox-label">
            <input
              id="mist-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
            />
            Verify SSL certificates
          </label>
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

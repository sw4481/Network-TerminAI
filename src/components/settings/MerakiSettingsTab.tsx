import { useState, useEffect } from 'react';
import {
  merakiGetConfig,
  merakiSaveConfig,
  merakiTestConnection,
  type MerakiConfig,
} from '../../lib/tauri';
import './MerakiSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function MerakiSettingsTab() {
  const [cfg, setCfg] = useState<MerakiConfig>({
    apiKey: '',
    orgId: '',
  });

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    merakiGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    if (!cfg.apiKey.trim()) {
      setStatus({ kind: 'err', text: 'Enter an API key before testing.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await merakiTestConnection(cfg);
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
      await merakiSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="meraki-tab">
      <div className="meraki-header">
        <h2>Cisco Meraki Dashboard</h2>
        <p className="meraki-subtitle">
          Configure access to the Meraki Dashboard API for inspecting
          organizations, networks, devices, clients, and link-layer topology. The
          Meraki agent and the Network Architect reach the Dashboard API with this
          key.
        </p>
      </div>

      <div className="meraki-section">
        <h3>Authentication</h3>
        <div className="meraki-grid">
          <label htmlFor="meraki-key">API Key</label>
          <input
            id="meraki-key"
            type="password"
            value={cfg.apiKey}
            onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
            placeholder="Meraki Dashboard API key"
          />

          <label htmlFor="meraki-org">Organization ID</label>
          <input
            id="meraki-org"
            type="text"
            value={cfg.orgId}
            onChange={(e) => setCfg({ ...cfg, orgId: e.target.value })}
            placeholder="(optional default scope)"
          />

          <div className="meraki-field-desc meraki-field--full">
            Generate a key in the Meraki Dashboard under My Profile → API access.
            The Organization ID is optional and only sets a default scope.
          </div>
        </div>
      </div>

      <div className="meraki-actions">
        <button onClick={save} disabled={saving} className="meraki-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="meraki-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`meraki-status meraki-status--${status.kind}`}>
          {status.text}
        </div>
      )}
    </div>
  );
}

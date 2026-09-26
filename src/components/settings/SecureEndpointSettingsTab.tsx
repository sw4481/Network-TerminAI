import { useState, useEffect } from 'react';
import {
  secureEndpointGetConfig,
  secureEndpointSaveConfig,
  secureEndpointTestConnection,
  type SecureEndpointConfig,
} from '../../lib/tauri';
import './IseSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function SecureEndpointSettingsTab() {
  const [cfg, setCfg] = useState<SecureEndpointConfig>({
    region: 'nam',
    authMode: 'v1_basic',
    clientId: '',
    apiKey: '',
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
    secureEndpointGetConfig().then((config) => {
      if (config) {
        setCfg(config);
      }
    });
  }, []);

  const test = async () => {
    if (!cfg.clientId.trim()) {
      setStatus({ kind: 'err', text: 'Enter a Client ID before testing.' });
      return;
    }

    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });

    try {
      const res = await secureEndpointTestConnection(cfg);
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
      await secureEndpointSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const keyLabel = cfg.authMode === 'v3_oauth' ? 'Client Secret' : 'API Key';

  return (
    <div className="ise-tab">
      <div className="ise-header">
        <h2>Cisco Secure Endpoint</h2>
        <p className="ise-subtitle">
          Configure connection to Cisco Secure Endpoint (AMP for Endpoints) for
          endpoint detection, host isolation, groups, policies, events,
          vulnerabilities, and file lists.
        </p>
      </div>

      <div className="ise-section">
        <h3>Region & API</h3>
        <div className="ise-grid">
          <label htmlFor="secure-endpoint-region">Region</label>
          <select
            id="secure-endpoint-region"
            value={cfg.region}
            onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
          >
            <option value="nam">North America (api.amp.cisco.com)</option>
            <option value="eu">Europe (api.eu.amp.cisco.com)</option>
            <option value="apjc">APJC (api.apjc.amp.cisco.com)</option>
          </select>

          <label htmlFor="secure-endpoint-auth-mode">Auth Mode</label>
          <select
            id="secure-endpoint-auth-mode"
            value={cfg.authMode}
            onChange={(e) => setCfg({ ...cfg, authMode: e.target.value })}
          >
            <option value="v1_basic">v1 — Basic auth (recommended)</option>
            <option value="v3_oauth">v3 — OAuth bearer (unverified)</option>
          </select>
        </div>
      </div>

      <div className="ise-section">
        <h3>Credentials</h3>
        <div className="ise-grid">
          <label htmlFor="secure-endpoint-client-id">Client ID</label>
          <input
            id="secure-endpoint-client-id"
            type="text"
            value={cfg.clientId}
            onChange={(e) => setCfg({ ...cfg, clientId: e.target.value })}
            placeholder="API client ID"
          />

          <label htmlFor="secure-endpoint-api-key">{keyLabel}</label>
          <input
            id="secure-endpoint-api-key"
            type="password"
            value={cfg.apiKey}
            onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
          />
        </div>
      </div>

      <div className="ise-section">
        <h3>TLS</h3>
        <div className="ise-grid">
          <label htmlFor="secure-endpoint-verify-ssl" className="ise-checkbox-label">
            <input
              id="secure-endpoint-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) =>
                setCfg({ ...cfg, verifySsl: e.target.checked })
              }
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

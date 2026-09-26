import { useState, useEffect } from 'react';
import {
  ciscoXdrGetConfig,
  ciscoXdrSaveConfig,
  ciscoXdrTestConnection,
  type CiscoXdrConfig,
} from '../../lib/tauri';
import './IseSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function CiscoXdrSettingsTab() {
  const [cfg, setCfg] = useState<CiscoXdrConfig>({
    region: 'nam',
    clientId: '',
    clientPassword: '',
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
    ciscoXdrGetConfig().then((config) => {
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
      const res = await ciscoXdrTestConnection(cfg);
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
      await ciscoXdrSaveConfig(cfg);
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
        <h2>Cisco XDR</h2>
        <p className="ise-subtitle">
          Configure connection to Cisco XDR (Extended Detection &amp; Response)
          for observable/IOC enrichment, text inspection, incident
          investigation, threat-response actions, and automation workflows.
          Generate an API client under Administration → API Clients in the XDR
          console (the client password is shown only once).
        </p>
      </div>

      <div className="ise-section">
        <h3>Region</h3>
        <div className="ise-grid">
          <label htmlFor="cisco-xdr-region">Region</label>
          <select
            id="cisco-xdr-region"
            value={cfg.region}
            onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
          >
            <option value="nam">North America (visibility.amp.cisco.com)</option>
            <option value="eu">Europe (visibility.eu.amp.cisco.com)</option>
            <option value="apjc">APJC (visibility.apjc.amp.cisco.com)</option>
          </select>
        </div>
      </div>

      <div className="ise-section">
        <h3>API Client Credentials</h3>
        <div className="ise-grid">
          <label htmlFor="cisco-xdr-client-id">Client ID</label>
          <input
            id="cisco-xdr-client-id"
            type="text"
            value={cfg.clientId}
            onChange={(e) => setCfg({ ...cfg, clientId: e.target.value })}
            placeholder="client-xxxxxxxx-xxxx-xxxx"
          />

          <label htmlFor="cisco-xdr-client-password">Client Password</label>
          <input
            id="cisco-xdr-client-password"
            type="password"
            value={cfg.clientPassword}
            onChange={(e) =>
              setCfg({ ...cfg, clientPassword: e.target.value })
            }
          />
        </div>
      </div>

      <div className="ise-section">
        <h3>TLS</h3>
        <div className="ise-grid">
          <label htmlFor="cisco-xdr-verify-ssl" className="ise-checkbox-label">
            <input
              id="cisco-xdr-verify-ssl"
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

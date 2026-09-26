import { useState, useEffect } from 'react';
import {
  grafanaGetConfig,
  grafanaSaveConfig,
  grafanaTestConnection,
  type GrafanaConfig,
} from '../../lib/tauri';
import './NetclawSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function GrafanaSettingsTab() {
  const [cfg, setCfg] = useState<GrafanaConfig>({
    url: '',
    token: '',
    verifySsl: false,
  });
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    grafanaGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    if (!cfg.url.trim()) {
      setStatus({ kind: 'err', text: 'Enter a Grafana URL before testing.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await grafanaTestConnection(cfg);
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
      await grafanaSaveConfig(cfg);
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
        <h2>Grafana</h2>
        <p className="nc-subtitle">
          Configure connection to a Grafana instance for dashboard search, data
          source discovery, and PromQL through the datasource proxy. The Grafana
          agent authenticates with a service-account / API token.
        </p>
      </div>

      <div className="nc-section">
        <h3>Connection</h3>
        <div className="nc-grid">
          <label htmlFor="grafana-url">URL</label>
          <input
            id="grafana-url"
            type="text"
            value={cfg.url}
            onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
            placeholder="https://grafana.example.com"
          />
          <div className="nc-field-desc nc-field--full">
            Full base URL of the Grafana instance (including https://).
          </div>
        </div>
      </div>

      <div className="nc-section">
        <h3>Authentication</h3>
        <div className="nc-grid">
          <label htmlFor="grafana-token">API token</label>
          <input
            id="grafana-token"
            type="password"
            value={cfg.token}
            onChange={(e) => setCfg({ ...cfg, token: e.target.value })}
          />
          <div className="nc-field-desc nc-field--full">
            A Grafana service-account token (Administration → Service accounts).
            Viewer scope is enough for read-only dashboard/metric queries.
          </div>
        </div>
      </div>

      <div className="nc-section">
        <h3>TLS</h3>
        <div className="nc-grid">
          <label htmlFor="grafana-verify-ssl" className="nc-checkbox-label">
            <input
              id="grafana-verify-ssl"
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

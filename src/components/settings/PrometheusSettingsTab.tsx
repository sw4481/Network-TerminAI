import { useState, useEffect } from 'react';
import {
  prometheusGetConfig,
  prometheusSaveConfig,
  prometheusTestConnection,
  type PrometheusConfig,
} from '../../lib/tauri';
import './NetclawSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function PrometheusSettingsTab() {
  const [cfg, setCfg] = useState<PrometheusConfig>({
    url: '',
    username: '',
    password: '',
    token: '',
    orgId: '',
    verifySsl: false,
  });
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    prometheusGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    if (!cfg.url.trim()) {
      setStatus({ kind: 'err', text: 'Enter a Prometheus URL before testing.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await prometheusTestConnection(cfg);
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
      await prometheusSaveConfig(cfg);
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
        <h2>Prometheus</h2>
        <p className="nc-subtitle">
          Configure a Prometheus endpoint for direct PromQL queries, metric
          discovery, and scrape-target health. Auth is optional — leave blank for
          an open instance, or set basic auth / a bearer token (Grafana Cloud,
          Thanos, Cortex) and an org ID for multi-tenant setups.
        </p>
      </div>

      <div className="nc-section">
        <h3>Connection</h3>
        <div className="nc-grid">
          <label htmlFor="prom-url">URL</label>
          <input
            id="prom-url"
            type="text"
            value={cfg.url}
            onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
            placeholder="http://prometheus.example.com:9090"
          />
          <div className="nc-field-desc nc-field--full">
            Base URL of the Prometheus HTTP API (including scheme and port).
          </div>
        </div>
      </div>

      <div className="nc-section">
        <h3>Authentication (optional)</h3>
        <div className="nc-grid">
          <label htmlFor="prom-username">Username</label>
          <input
            id="prom-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="(basic auth, optional)"
          />
          <label htmlFor="prom-password">Password</label>
          <input
            id="prom-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />
          <label htmlFor="prom-token">Bearer token</label>
          <input
            id="prom-token"
            type="password"
            value={cfg.token}
            onChange={(e) => setCfg({ ...cfg, token: e.target.value })}
            placeholder="(Grafana Cloud / Thanos / Cortex, optional)"
          />
          <label htmlFor="prom-org">Org ID</label>
          <input
            id="prom-org"
            type="text"
            value={cfg.orgId}
            onChange={(e) => setCfg({ ...cfg, orgId: e.target.value })}
            placeholder="(X-Scope-OrgID for multi-tenant, optional)"
          />
        </div>
      </div>

      <div className="nc-section">
        <h3>TLS</h3>
        <div className="nc-grid">
          <label htmlFor="prom-verify-ssl" className="nc-checkbox-label">
            <input
              id="prom-verify-ssl"
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

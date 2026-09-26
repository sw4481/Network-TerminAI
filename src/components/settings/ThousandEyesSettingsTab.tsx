import { useState, useEffect } from 'react';
import {
  thousandeyesGetConfig,
  thousandeyesSaveConfig,
  thousandeyesTestConnection,
  type ThousandEyesConfig,
} from '../../lib/tauri';
import './ThousandEyesSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function ThousandEyesSettingsTab() {
  const [cfg, setCfg] = useState<ThousandEyesConfig>({
    token: '',
    accountGroupId: '',
  });

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    thousandeyesGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    if (!cfg.token.trim()) {
      setStatus({ kind: 'err', text: 'Enter an API token before testing.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await thousandeyesTestConnection(cfg);
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
      await thousandeyesSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="thousandeyes-tab">
      <div className="thousandeyes-header">
        <h2>Cisco ThousandEyes</h2>
        <p className="thousandeyes-subtitle">
          Configure access to the ThousandEyes API (v7) for inspecting tests,
          agents, results, path visualization, dashboards and alerts. The
          ThousandEyes agent reaches the API with this Bearer token. Read-only.
        </p>
      </div>

      <div className="thousandeyes-section">
        <h3>Authentication</h3>
        <div className="thousandeyes-grid">
          <label htmlFor="te-token">API Token</label>
          <input
            id="te-token"
            type="password"
            value={cfg.token}
            onChange={(e) => setCfg({ ...cfg, token: e.target.value })}
            placeholder="OAuth Bearer token"
          />

          <label htmlFor="te-aid">Account Group ID</label>
          <input
            id="te-aid"
            type="text"
            value={cfg.accountGroupId}
            onChange={(e) => setCfg({ ...cfg, accountGroupId: e.target.value })}
            placeholder="(optional)"
          />

          <div className="thousandeyes-field-desc thousandeyes-field--full">
            Generate a token under ThousandEyes → Account Settings → Users →
            Profile. The Account Group ID is optional and scopes calls to one
            account group (sent as the <code>aid</code> query parameter).
          </div>
        </div>
      </div>

      <div className="thousandeyes-actions">
        <button onClick={save} disabled={saving} className="thousandeyes-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="thousandeyes-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`thousandeyes-status thousandeyes-status--${status.kind}`}>
          {status.text}
        </div>
      )}
    </div>
  );
}

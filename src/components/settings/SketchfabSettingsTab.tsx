import { useState, useEffect } from 'react';
import {
  sketchfabGetConfig,
  sketchfabSaveConfig,
  sketchfabTestConnection,
  type SketchfabConfig,
} from '../../lib/tauri';
import './NetclawSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function SketchfabSettingsTab() {
  const [cfg, setCfg] = useState<SketchfabConfig>({ apiKey: '' });
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    sketchfabGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await sketchfabTestConnection(cfg);
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
      await sketchfabSaveConfig(cfg);
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
        <h2>Sketchfab</h2>
        <p className="nc-subtitle">
          Optionally add a Sketchfab API token to search and download CC0-licensed
          3D models for network visualization. Search works without a key
          (rate-limited); a token lifts limits and is required for downloads.
        </p>
      </div>

      <div className="nc-section">
        <h3>Authentication</h3>
        <div className="nc-grid">
          <label htmlFor="sketchfab-key">API key</label>
          <input
            id="sketchfab-key"
            type="password"
            value={cfg.apiKey}
            onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
            placeholder="(optional)"
          />
          <div className="nc-field-desc nc-field--full">
            Your Sketchfab API token (Settings → Password &amp; API on sketchfab.com).
            Leave blank to use anonymous, rate-limited search only.
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

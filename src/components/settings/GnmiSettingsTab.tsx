import { useState, useEffect } from 'react';
import {
  gnmiGetConfig,
  gnmiSaveConfig,
  gnmiTestConnection,
  type GnmiTarget,
} from '../../lib/tauri';
import './GnmiSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

const VENDORS = ['cisco-iosxr', 'nokia', 'juniper', 'arista', ''];

function emptyTarget(): GnmiTarget {
  return {
    name: '',
    host: '',
    port: null,
    username: '',
    password: '',
    vendor: 'cisco-iosxr',
    skipVerify: true,
  };
}

export default function GnmiSettingsTab() {
  const [targets, setTargets] = useState<GnmiTarget[]>([]);
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    gnmiGetConfig().then((cfg) => {
      if (cfg && cfg.targets) setTargets(cfg.targets);
    });
  }, []);

  const update = (i: number, patch: Partial<GnmiTarget>) => {
    setTargets((ts) => ts.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  };

  const addTarget = () => setTargets((ts) => [...ts, emptyTarget()]);
  const removeTarget = (i: number) =>
    setTargets((ts) => ts.filter((_, idx) => idx !== i));

  const test = async () => {
    if (targets.length === 0) {
      setStatus({ kind: 'err', text: 'Add at least one target before testing.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection to first target…' });
    try {
      const res = await gnmiTestConnection({ targets });
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
      await gnmiSaveConfig({ targets });
      setStatus({ kind: 'ok', text: 'Targets saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="gnmi-tab">
      <div className="gnmi-header">
        <h2>gNMI</h2>
        <p className="gnmi-subtitle">
          Configure gNMI target devices. gNMI is multi-target gRPC telemetry and
          config — the gNMI agent addresses these devices by name. Port defaults:
          cisco-iosxr / nokia 57400, juniper 32767, arista 6030 (leave blank to use
          the vendor default).
        </p>
      </div>

      {targets.length === 0 && (
        <p className="gnmi-empty">No targets configured. Add one to get started.</p>
      )}

      {targets.map((t, i) => (
        <div className="gnmi-target" key={i}>
          <div className="gnmi-target-head">
            <span className="gnmi-target-title">
              {t.name || t.host || `Target ${i + 1}`}
            </span>
            <button
              className="gnmi-remove"
              onClick={() => removeTarget(i)}
              title="Remove target"
            >
              Remove
            </button>
          </div>
          <div className="gnmi-grid">
            <label>Name</label>
            <input
              type="text"
              value={t.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="xr-1"
            />

            <label>Host</label>
            <input
              type="text"
              value={t.host}
              onChange={(e) => update(i, { host: e.target.value })}
              placeholder="your-server-ip"
            />

            <label>Port</label>
            <input
              type="number"
              value={t.port ?? ''}
              onChange={(e) =>
                update(i, {
                  port: e.target.value ? Number(e.target.value) : null,
                })
              }
              placeholder="(vendor default)"
            />

            <label>Vendor</label>
            <select
              value={t.vendor}
              onChange={(e) => update(i, { vendor: e.target.value })}
            >
              {VENDORS.map((v) => (
                <option key={v || 'other'} value={v}>
                  {v || 'other'}
                </option>
              ))}
            </select>

            <label>Username</label>
            <input
              type="text"
              value={t.username}
              onChange={(e) => update(i, { username: e.target.value })}
              placeholder="admin"
            />

            <label>Password</label>
            <input
              type="password"
              value={t.password}
              onChange={(e) => update(i, { password: e.target.value })}
            />

            <label className="gnmi-checkbox-label">
              <input
                type="checkbox"
                checked={t.skipVerify}
                onChange={(e) => update(i, { skipVerify: e.target.checked })}
              />
              Skip TLS verification (labs only)
            </label>
          </div>
        </div>
      ))}

      <div className="gnmi-actions">
        <button onClick={addTarget} className="gnmi-btn-secondary">
          + Add Target
        </button>
        <button onClick={save} disabled={saving} className="gnmi-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="gnmi-btn-secondary">
          {testing ? 'Testing…' : 'Test First Target'}
        </button>
      </div>

      {status && (
        <div className={`gnmi-status gnmi-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

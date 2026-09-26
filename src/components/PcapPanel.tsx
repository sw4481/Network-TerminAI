import { useEffect, useState } from 'react';
import './PcapBlock.css';
import './PcapPanel.css';
import {
  captureList,
  type DeviceConn,
  type PcapCapture,
  type PcapTemplate,
} from '../lib/pcap';
import { PcapTemplateLibrary } from './PcapTemplateLibrary';
import { PcapQuickCaptureWizard } from './PcapQuickCaptureWizard';
import { PcapLocalCaptureForm } from './PcapLocalCaptureForm';
import { PcapBlock } from './PcapBlock';
import { sshDecryptPassword, sshListConnections, type SshConnection } from '../lib/sshConnections';

/**
 * Top-level Captures panel surfaced via the Captures menu (⌘⇧K).
 *
 * Three columns:
 *   1. Templates library (search + vendor filter)
 *   2. Quick-capture wizard pre-filled from the selected template + a
 *      saved-SSH-connection picker
 *   3. Active capture (PcapBlock) plus a list of recent captures
 */
export function PcapPanel() {
  const [source, setSource] = useState<'device' | 'local'>('device');
  const [template, setTemplate] = useState<PcapTemplate | null>(null);
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [resolvedConn, setResolvedConn] = useState<DeviceConn | null>(null);
  // Editable SSH password. Seeded from the saved connection (decrypted) when one
  // is selected, but the user can type/override it here — saved connections
  // often have no stored password, which is what causes "ssh auth failed".
  const [password, setPassword] = useState('');
  const [activeCaptureId, setActiveCaptureId] = useState<string | null>(null);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [recent, setRecent] = useState<PcapCapture[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reloadRecent = () => {
    captureList()
      .then((rows) => setRecent(rows.slice(0, 25)))
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    sshListConnections()
      .then(setConnections)
      .catch((e) => setError(String(e)));
    reloadRecent();
  }, []);

  // Resolve the selected connection to host/port/user and seed the password
  // field from the saved (decrypted) password if one exists.
  useEffect(() => {
    setResolvedConn(null);
    setPassword('');
    if (!selectedConnId) return;
    let cancelled = false;
    (async () => {
      try {
        const conn = connections.find((c) => c.id === selectedConnId);
        if (!conn) return;
        let saved = '';
        if (conn.password_encrypted) {
          saved = (await sshDecryptPassword(conn.password_encrypted)) ?? '';
        }
        if (cancelled) return;
        setPassword(saved);
        setResolvedConn({
          host: conn.host,
          port: conn.port ?? 22,
          username: conn.user ?? '',
          password: saved,
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedConnId, connections]);

  // Keep the resolved connection's password in sync with the editable field so
  // the capture uses whatever the user typed.
  useEffect(() => {
    setResolvedConn((prev) => (prev ? { ...prev, password } : prev));
  }, [password]);

  return (
    <div
      className={`pcap-panel${viewerExpanded ? ' pcap-panel-viewer-expanded' : ''}`}
      data-testid="pcap-panel"
    >
      <aside className="pcap-panel-col pcap-panel-templates">
        <div className="pcap-panel-col-header">Templates</div>
        <PcapTemplateLibrary
          onSelectTemplate={setTemplate}
          selectedId={template?.id ?? null}
        />
      </aside>

      <section className="pcap-panel-col pcap-panel-quick-capture">
        <div className="pcap-panel-col-header">Quick capture</div>
        <div className="pcap-panel-source-picker">
          <label>
            Source
            <select
              value={source}
              onChange={(event) => setSource(event.target.value as 'device' | 'local')}
              data-testid="pcap-source-select"
            >
              <option value="device">Device</option>
              <option value="local">This Computer</option>
            </select>
          </label>
        </div>
        {source === 'device' && <div className="pcap-panel-conn-picker">
          <label>
            Device
            <select
              value={selectedConnId ?? ''}
              onChange={(e) => setSelectedConnId(e.target.value || null)}
              data-testid="pcap-panel-conn-select"
            >
              <option value="">— choose a saved SSH connection —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.host})
                </option>
              ))}
            </select>
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                selectedConnId
                  ? 'SSH password for this device'
                  : 'choose a device first'
              }
              disabled={!selectedConnId}
              autoComplete="off"
              data-testid="pcap-panel-password"
            />
          </label>
        </div>}
        {source === 'device' ? (
          <PcapQuickCaptureWizard
            template={template}
            conn={resolvedConn}
            onStarted={(id) => {
              setActiveCaptureId(id);
              reloadRecent();
            }}
          />
        ) : (
          <PcapLocalCaptureForm
            onStarted={(id) => {
              setActiveCaptureId(id);
              reloadRecent();
            }}
          />
        )}
        {error && <div className="pcap-panel-error">{error}</div>}
      </section>

      <section className="pcap-panel-col pcap-panel-col-wide">
        <div className="pcap-panel-col-header pcap-panel-active-header">
          <span>
            Active capture
            {activeCaptureId && <span className="pcap-panel-id"> · {activeCaptureId.slice(0, 8)}</span>}
          </span>
          <button
            type="button"
            className="pcap-panel-expand-viewer"
            disabled={!activeCaptureId}
            aria-label={viewerExpanded ? 'Show setup' : 'Expand viewer'}
            aria-pressed={viewerExpanded}
            title={viewerExpanded ? 'Restore templates and capture setup' : 'Give the active capture the full panel width'}
            onClick={() => setViewerExpanded((expanded) => !expanded)}
          >
            {viewerExpanded ? 'Show setup' : 'Expand viewer'}
          </button>
        </div>
        {activeCaptureId ? (
          <div className="pcap-panel-active">
            <PcapBlock captureId={activeCaptureId} />
          </div>
        ) : (
          <div className="pcap-panel-empty">
            {source === 'device'
              ? 'Pick a template, choose a saved SSH connection, and click "Run capture".'
              : 'Choose a local interface and click "Run local capture".'}
          </div>
        )}

        <div className="pcap-panel-col-header pcap-panel-col-header-sub">
          Recent captures
        </div>
        <ul className="pcap-panel-recent">
          {recent.map((c) => (
            <li
              key={c.id}
              className={c.id === activeCaptureId ? 'selected' : ''}
              onClick={() => setActiveCaptureId(c.id)}
              data-testid={`pcap-panel-recent-${c.id}`}
            >
              <div className="pcap-panel-recent-row">
                <span className={`pcap-chip status-${c.status}`}>{c.status}</span>
                <span className="pcap-panel-recent-device">{c.device_ref}</span>
                <span className="pcap-panel-recent-iface">{c.interface}</span>
                {c.size_bytes != null && (
                  <span className="pcap-panel-recent-size">
                    {(c.size_bytes / 1024).toFixed(1)} KB
                  </span>
                )}
              </div>
            </li>
          ))}
          {recent.length === 0 && (
            <li className="pcap-panel-empty">No captures yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

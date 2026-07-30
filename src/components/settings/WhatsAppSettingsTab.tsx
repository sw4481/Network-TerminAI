import { useState, useEffect, useRef } from 'react';
import {
  whatsappGetConfig,
  whatsappSaveConfig,
  whatsappLink,
  whatsappUnlink,
  whatsappStatus,
  whatsappListGroups,
  type WhatsAppConfig,
  type WhatsAppStatus,
  type WhatsAppGroup,
} from '../../lib/tauri';
import { useAgentsStore } from '../../state/agentsStore';
import './IseSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

const SEVERITIES = ['critical', 'error', 'warning', 'info'] as const;

export default function WhatsAppSettingsTab() {
  const agents = useAgentsStore((s) => s.agents);

  const [cfg, setCfg] = useState<WhatsAppConfig>({
    enabled: false,
    defaultAgentId: 'network-architect',
    allowlist: [],
    notifySeverities: ['critical', 'error'],
    sessionDir: '',
    triggerKeyword: 'ccie',
    boundChatJid: '',
  });
  const [allowlistText, setAllowlistText] = useState('');

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState<WhatsAppStatus | null>(null);
  const [groups, setGroups] = useState<WhatsAppGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);

  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    whatsappGetConfig().then((c) => {
      if (c) {
        setCfg(c);
        setAllowlistText((c.allowlist || []).join('\n'));
      }
    });
    whatsappStatus().then(setLink).catch(() => {});
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const parseAllowlist = (text: string): string[] =>
    text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

  const save = async () => {
    setSaving(true);
    try {
      const next = { ...cfg, allowlist: parseAllowlist(allowlistText) };
      setCfg(next);
      await whatsappSaveConfig(next);
      setStatus({ kind: 'ok', text: 'Configuration saved.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const startStatusPoll = () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const s = await whatsappStatus();
        setLink(s);
        if (s.state === 'linked' || s.state === 'error') {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        /* keep polling */
      }
    }, 1500);
  };

  const doLink = async () => {
    // Persist first so the sidecar reads the current session dir + allowlist.
    await save();
    setStatus({ kind: 'info', text: 'Starting pairing — scan the QR with your phone…' });
    try {
      const s = await whatsappLink();
      setLink(s);
      startStatusPoll();
    } catch (e) {
      setStatus({ kind: 'err', text: `Link failed: ${String(e)}` });
    }
  };

  const doUnlink = async () => {
    try {
      const s = await whatsappUnlink();
      setLink(s);
      setStatus({ kind: 'info', text: 'Device unlinked.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Unlink failed: ${String(e)}` });
    }
  };

  const toggleSeverity = (sev: string) => {
    setCfg((c) => ({
      ...c,
      notifySeverities: c.notifySeverities.includes(sev)
        ? c.notifySeverities.filter((s) => s !== sev)
        : [...c.notifySeverities, sev],
    }));
  };

  const loadGroups = async () => {
    setLoadingGroups(true);
    try {
      const res = await whatsappListGroups();
      if (res.ok) {
        setGroups(res.groups);
        if (res.groups.length === 0) {
          setStatus({
            kind: 'info',
            text: 'No groups found. Create a group in WhatsApp (e.g. "CCIE Ops"), then refresh.',
          });
        }
      } else {
        setStatus({ kind: 'err', text: res.message || 'Could not list groups (link first).' });
      }
    } catch (e) {
      setStatus({ kind: 'err', text: `List groups failed: ${String(e)}` });
    } finally {
      setLoadingGroups(false);
    }
  };

  const linkState = link?.state ?? 'idle';

  return (
    <div className="ise-tab">
      <div className="ise-header">
        <h2>WhatsApp</h2>
        <p className="ise-subtitle">
          Connect a personal WhatsApp number (linked-device) so heartbeat alerts
          push to your phone and you can chat with your agents remotely. Scan the
          QR below with WhatsApp → Settings → Linked Devices. This uses an
          unofficial API — there is a small risk of the number being flagged;
          consider a secondary number. <strong>Full-trust</strong> is enabled:
          anyone on the allowlist can run <em>and change</em> your network from
          chat, so keep the allowlist tight.
        </p>
      </div>

      <div className="ise-section">
        <h3>Enable</h3>
        <div className="ise-grid">
          <label htmlFor="wa-enabled" className="ise-checkbox-label">
            <input
              id="wa-enabled"
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            />
            Enable the WhatsApp bridge
          </label>
        </div>
      </div>

      <div className="ise-section">
        <h3>Link Device</h3>
        <div className="ise-grid">
          <label>Status</label>
          <div>
            {linkState === 'linked'
              ? `✅ Linked${link?.me ? ` as ${link.me}` : ''}`
              : linkState === 'qr'
                ? '📱 Scan the QR code below'
                : linkState === 'starting'
                  ? 'Starting…'
                  : linkState === 'error'
                    ? `⚠️ ${link?.error ?? 'error'}`
                    : 'Not linked'}
          </div>
        </div>
        {linkState === 'qr' && link?.qr && link.qr.startsWith('data:') && (
          <div style={{ marginTop: 12 }}>
            <img
              src={link.qr}
              alt="WhatsApp pairing QR"
              width={220}
              height={220}
              style={{ background: 'var(--text-inverse)', padding: 8, borderRadius: 6 }}
            />
          </div>
        )}
        <div className="ise-actions" style={{ marginTop: 12 }}>
          <button onClick={doLink} className="ise-btn-primary">
            {linkState === 'linked' ? 'Re-link' : 'Link Device'}
          </button>
          {linkState === 'linked' && (
            <button onClick={doUnlink} className="ise-btn-secondary">
              Unlink
            </button>
          )}
        </div>
      </div>

      <div className="ise-section">
        <h3>Bind to Group (coexist with other bots)</h3>
        <p className="ise-subtitle">
          On a single WhatsApp account, every linked device receives every
          message — so another bot (e.g. Hermes) sees the same stream. Bind CCIE
          to a dedicated group so it only acts on — and sends alerts to — that
          group, ignoring your self-chat/DMs. Steps: create a group in WhatsApp
          (e.g. "CCIE Ops"), <strong>send any message in it</strong> (that's how
          CCIE discovers the group), then tap Refresh and pick it here. Leave as{' '}
          <em>Any chat</em> only if CCIE is the only bot on this number.
        </p>
        <div className="ise-grid">
          <label htmlFor="wa-group">Chat</label>
          <select
            id="wa-group"
            value={cfg.boundChatJid}
            onChange={(e) => setCfg({ ...cfg, boundChatJid: e.target.value })}
          >
            <option value="">Any chat (not scoped)</option>
            {/* Keep the currently-bound JID selectable even if not in the list yet. */}
            {cfg.boundChatJid &&
              !groups.some((g) => g.jid === cfg.boundChatJid) && (
                <option value={cfg.boundChatJid}>{cfg.boundChatJid}</option>
              )}
            {groups.map((g) => (
              <option key={g.jid} value={g.jid}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ise-actions" style={{ marginTop: 8 }}>
          <button
            onClick={loadGroups}
            disabled={loadingGroups || linkState !== 'linked'}
            className="ise-btn-secondary"
          >
            {loadingGroups ? 'Loading…' : 'Refresh Groups'}
          </button>
        </div>
      </div>

      <div className="ise-section">
        <h3>Allowlist</h3>
        <p className="ise-subtitle">
          One phone number per line (E.164, e.g. <code>15551234567</code>). Only
          these senders can drive agents. Empty = no one (fail-closed).
        </p>
        <div className="ise-grid">
          <label htmlFor="wa-allowlist">Numbers</label>
          <textarea
            id="wa-allowlist"
            rows={4}
            value={allowlistText}
            onChange={(e) => setAllowlistText(e.target.value)}
            placeholder="15551234567"
          />
        </div>
      </div>

      <div className="ise-section">
        <h3>Default Agent</h3>
        <p className="ise-subtitle">
          Used when a message has no <code>/agent-id</code> prefix.
        </p>
        <div className="ise-grid">
          <label htmlFor="wa-agent">Agent</label>
          <select
            id="wa-agent"
            value={cfg.defaultAgentId}
            onChange={(e) => setCfg({ ...cfg, defaultAgentId: e.target.value })}
          >
            {agents.length === 0 && (
              <option value={cfg.defaultAgentId}>{cfg.defaultAgentId}</option>
            )}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="ise-section">
        <h3>Trigger Keyword</h3>
        <p className="ise-subtitle">
          Used in <strong>shared chats</strong> only: there, CCIE handles just
          messages starting with this word (stripped before the agent runs),
          e.g. <code>ccie show version</code> — so it can coexist with another
          bot like Hermes. <strong>Inside the bound group above, the trigger is
          NOT required</strong> — every message is treated as a command (the
          word is still stripped if you type it), since that chat is CCIE-only.
        </p>
        <div className="ise-grid">
          <label htmlFor="wa-trigger">Keyword</label>
          <input
            id="wa-trigger"
            type="text"
            value={cfg.triggerKeyword}
            onChange={(e) => setCfg({ ...cfg, triggerKeyword: e.target.value })}
            placeholder="ccie"
          />
        </div>
      </div>

      <div className="ise-section">
        <h3>Alert Severities</h3>
        <p className="ise-subtitle">
          Heartbeat severities that push a WhatsApp alert (5-minute cooldown per
          heartbeat).
        </p>
        <div className="ise-grid">
          {SEVERITIES.map((sev) => (
            <label key={sev} className="ise-checkbox-label">
              <input
                type="checkbox"
                checked={cfg.notifySeverities.includes(sev)}
                onChange={() => toggleSeverity(sev)}
              />
              {sev}
            </label>
          ))}
        </div>
      </div>

      <div className="ise-actions">
        <button onClick={save} disabled={saving} className="ise-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {status && (
        <div className={`ise-status ise-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

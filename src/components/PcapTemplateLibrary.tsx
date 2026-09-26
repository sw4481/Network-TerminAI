import { useEffect, useMemo, useState } from 'react';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  type PcapTemplate,
} from '../lib/pcap';

interface PcapTemplateLibraryProps {
  onSelectTemplate: (t: PcapTemplate) => void;
  selectedId: string | null;
}

const VENDORS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'cisco', label: 'Cisco' },
  { id: 'juniper', label: 'Juniper' },
  { id: 'arista', label: 'Arista' },
];

// Platform options keyed by vendor — drives the device-kind builder downstream.
const PLATFORMS: Array<{ id: string; label: string; vendor: string }> = [
  { id: 'iosxe', label: 'Cisco IOS-XE', vendor: 'cisco' },
  { id: 'nxos', label: 'Cisco NX-OS', vendor: 'cisco' },
  { id: 'junos', label: 'Juniper Junos', vendor: 'juniper' },
  { id: 'eos', label: 'Arista EOS', vendor: 'arista' },
];

const EMPTY_DRAFT = {
  name: '',
  platform: 'iosxe',
  interface: '',
  acl: '',
  duration_s: 30,
};

export function PcapTemplateLibrary({
  onSelectTemplate,
  selectedId,
}: PcapTemplateLibraryProps) {
  const [templates, setTemplates] = useState<PcapTemplate[]>([]);
  const [vendor, setVendor] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [saving, setSaving] = useState(false);

  const reload = () => {
    listTemplates()
      .then(setTemplates)
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    reload();
  }, []);

  const saveDraft = async () => {
    const name = draft.name.trim();
    const iface = draft.interface.trim();
    if (!name || !iface) {
      setError('Template needs a name and an interface.');
      return;
    }
    const platform = PLATFORMS.find((p) => p.id === draft.platform);
    setSaving(true);
    setError(null);
    try {
      // id/builtin are set server-side (builtin forced false); send empty id.
      await createTemplate({
        id: '',
        name,
        vendor: platform?.vendor ?? 'cisco',
        platform: draft.platform,
        interface: iface,
        acl: draft.acl.trim() || null,
        duration_s: Math.min(3600, Math.max(5, draft.duration_s)),
        builtin: false,
      });
      setDraft({ ...EMPTY_DRAFT });
      setCreating(false);
      reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (vendor !== 'all' && t.vendor !== vendor) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.platform.toLowerCase().includes(q) ||
        (t.interface ?? '').toLowerCase().includes(q)
      );
    });
  }, [templates, vendor, query]);

  return (
    <div className="pcap-template-library" data-testid="pcap-template-library">
      <div className="pcap-template-toolbar">
        <div className="pcap-template-searchrow">
          <input
            type="search"
            placeholder="Search templates"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="pcap-template-search"
          />
          <button
            type="button"
            className="pcap-template-new"
            onClick={() => {
              setCreating((v) => !v);
              setError(null);
            }}
            data-testid="pcap-template-new"
          >
            {creating ? 'Cancel' : '+ New'}
          </button>
        </div>
        <div className="pcap-template-chips">
          {VENDORS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`chip${vendor === v.id ? ' active' : ''}`}
              onClick={() => setVendor(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {creating && (
        <form
          className="pcap-template-form"
          data-testid="pcap-template-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveDraft();
          }}
        >
          <label>
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="My WAN capture"
              data-testid="pcap-template-form-name"
            />
          </label>
          <label>
            Platform
            <select
              value={draft.platform}
              onChange={(e) => setDraft({ ...draft, platform: e.target.value })}
            >
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Interface
            <input
              value={draft.interface}
              onChange={(e) => setDraft({ ...draft, interface: e.target.value })}
              placeholder="GigabitEthernet0/0/1"
              data-testid="pcap-template-form-interface"
            />
          </label>
          <label>
            ACL / filter (optional)
            <input
              value={draft.acl}
              onChange={(e) => setDraft({ ...draft, acl: e.target.value })}
              placeholder="MGMT_ACL  or  host 10.1.1.1"
            />
          </label>
          <label>
            Duration: {draft.duration_s}s
            <input
              type="range"
              min={5}
              max={300}
              step={5}
              value={draft.duration_s}
              onChange={(e) =>
                setDraft({ ...draft, duration_s: Number(e.target.value) })
              }
            />
          </label>
          <button
            type="submit"
            className="pcap-template-save"
            disabled={saving || !draft.name.trim() || !draft.interface.trim()}
            data-testid="pcap-template-save"
          >
            {saving ? 'Saving…' : 'Save template'}
          </button>
        </form>
      )}
      {error && <div className="pcap-template-error">{error}</div>}
      <ul className="pcap-template-list">
        {filtered.map((t) => (
          <li
            key={t.id}
            className={selectedId === t.id ? 'selected' : ''}
            data-testid={`pcap-template-${t.id}`}
            onClick={() => onSelectTemplate(t)}
          >
            <div className="pcap-template-name">
              {t.name}
              {t.builtin && <span className="pcap-template-builtin">built-in</span>}
            </div>
            <div className="pcap-template-meta">
              {t.vendor} · {t.platform} · {t.interface ?? '<intf>'} ·{' '}
              {t.duration_s}s
            </div>
            {!t.builtin && (
              <button
                type="button"
                className="pcap-template-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteTemplate(t.id).then(reload).catch((err) => setError(String(err)));
                }}
                aria-label={`Delete template ${t.name}`}
              >
                ×
              </button>
            )}
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="pcap-template-empty">No templates match.</li>
        )}
      </ul>
    </div>
  );
}

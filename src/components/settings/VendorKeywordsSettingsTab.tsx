import { useState, useEffect } from 'react';
import {
  vendorKeywordDefaults,
  vendorKeywordsGet,
  vendorKeywordsSet,
  type VendorKeywordDefault,
} from '../../lib/tauri';
import './VendorKeywordsSettingsTab.css';

type StatusKind = 'ok' | 'err';

// Split a textarea value into a clean keyword list (comma or newline separated).
function parseKeywords(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

// Two keyword lists are equal (order-sensitive, already normalized).
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function VendorKeywordsSettingsTab() {
  const [defaults, setDefaults] = useState<VendorKeywordDefault[]>([]);
  // vendor id -> current textarea text
  const [text, setText] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [def, overrideJson] = await Promise.all([
          vendorKeywordDefaults(),
          vendorKeywordsGet(),
        ]);
        const vendors = def.vendors;
        setDefaults(vendors);
        let override: Record<string, string[]> = {};
        try {
          const parsed = JSON.parse(overrideJson || '{}');
          if (parsed && typeof parsed === 'object') override = parsed;
        } catch {
          override = {};
        }
        const initial: Record<string, string> = {};
        for (const v of vendors) {
          const list = Array.isArray(override[v.id]) ? override[v.id] : v.keywords;
          initial[v.id] = list.join(', ');
        }
        setText(initial);
      } catch (e) {
        setStatus({ kind: 'err', text: `Failed to load: ${String(e)}` });
      }
    })();
  }, []);

  const resetVendor = (v: VendorKeywordDefault) => {
    setText((t) => ({ ...t, [v.id]: v.keywords.join(', ') }));
  };

  const save = async () => {
    if (defaults.length === 0) {
      setStatus({ kind: 'err', text: 'Cannot save: vendor defaults failed to load.' });
      return;
    }
    setSaving(true);
    try {
      // Only include vendors whose list differs from their built-in default.
      const blob: Record<string, string[]> = {};
      for (const v of defaults) {
        const current = parseKeywords(text[v.id] ?? '');
        const defaultList = v.keywords.map((k) => k.trim().toLowerCase());
        if (!sameList(current, defaultList)) {
          blob[v.id] = current;
        }
      }
      await vendorKeywordsSet(JSON.stringify(blob));
      setStatus({ kind: 'ok', text: 'Vendor keywords saved.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="vkw-tab">
      <div className="vkw-header">
        <h2>Vendor Routing Keywords</h2>
        <p className="vkw-subtitle">
          The Network Architect routes a question to a platform by matching these
          keywords. Edits replace that vendor's built-in list and take effect on
          the next agent turn. Comma- or newline-separated; case-insensitive.
        </p>
      </div>

      {defaults.map((v) => (
        <div className="vkw-vendor" key={v.id}>
          <div className="vkw-vendor-head">
            <label htmlFor={`vkw-${v.id}`}>{v.display}</label>
            <button
              type="button"
              className="vkw-reset"
              onClick={() => resetVendor(v)}
            >
              Reset to defaults
            </button>
          </div>
          <textarea
            id={`vkw-${v.id}`}
            aria-label={v.display}
            rows={2}
            value={text[v.id] ?? ''}
            onChange={(e) => setText((t) => ({ ...t, [v.id]: e.target.value }))}
          />
        </div>
      ))}

      <div className="vkw-actions">
        <button onClick={save} disabled={saving || defaults.length === 0} className="vkw-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {status && (
        <div className={`vkw-status vkw-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  findingRules,
  findings,
  type PcapFindingRule,
  type PcapFindingsResult,
} from '../lib/pcap';

export const PCAP_FINDINGS_RULES_STORAGE_KEY = 'terminai.pcap.findings.rules.v1';

function storedRuleIds(rules: PcapFindingRule[]): string[] {
  const defaults = rules
    .filter((rule) => rule.enabled_by_default)
    .map((rule) => rule.rule_id);
  try {
    const raw = localStorage.getItem(PCAP_FINDINGS_RULES_STORAGE_KEY);
    if (raw == null) return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      return defaults;
    }
    const valid = new Set(rules.map((rule) => rule.rule_id));
    return parsed.filter((ruleId) => valid.has(ruleId));
  } catch {
    return defaults;
  }
}

interface PcapFindingsProps {
  captureId: string;
}

export function PcapFindings({ captureId }: PcapFindingsProps) {
  const [rules, setRules] = useState<PcapFindingRule[]>([]);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [result, setResult] = useState<PcapFindingsResult | null>(null);
  const [loadingRules, setLoadingRules] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingRules(true);
    findingRules()
      .then((next) => {
        if (cancelled) return;
        setRules(next);
        setEnabled(storedRuleIds(next));
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) setError(String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingRules(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabledSet = useMemo(() => new Set(enabled), [enabled]);

  const toggleRule = (ruleId: string) => {
    setEnabled((current) => {
      const next = current.includes(ruleId)
        ? current.filter((value) => value !== ruleId)
        : [...current, ruleId];
      localStorage.setItem(PCAP_FINDINGS_RULES_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setResult(null);
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await findings(captureId, enabled));
    } catch (caught) {
      setResult(null);
      setError(String(caught));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="pcap-findings" data-testid="pcap-findings">
      <aside className="pcap-findings-rules">
        <div className="pcap-findings-rules-header">
          <span>Built-in rules</span>
          <button
            type="button"
            onClick={() => {
              const all = rules.map((rule) => rule.rule_id);
              setEnabled(all);
              localStorage.setItem(PCAP_FINDINGS_RULES_STORAGE_KEY, JSON.stringify(all));
              setResult(null);
            }}
            disabled={loadingRules}
          >
            Enable all
          </button>
        </div>
        {rules.map((rule) => (
          <label key={rule.rule_id} title={rule.display_filter}>
            <input
              type="checkbox"
              checked={enabledSet.has(rule.rule_id)}
              onChange={() => toggleRule(rule.rule_id)}
            />
            <span className={`pcap-finding-severity severity-${rule.severity}`}>{rule.severity}</span>
            <span>{rule.title}</span>
          </label>
        ))}
        {loadingRules && <div className="pcap-loading">Loading fixed rules…</div>}
        <button
          type="button"
          className="pcap-findings-run"
          disabled={loadingRules || running}
          onClick={() => void run()}
          data-testid="pcap-findings-run"
        >
          {running ? 'Scanning with TShark…' : `Run findings (${enabled.length})`}
        </button>
      </aside>
      <section className="pcap-findings-results">
        {error && (
          <div className="pcap-error-banner" data-testid="pcap-findings-error">
            {error.includes('unsupported_filter')
              ? `Installed TShark does not support one of the built-in filters. ${error}`
              : error}
          </div>
        )}
        {!error && !running && !result && (
          <div className="pcap-loading">Choose the fixed rules to run, then start the deterministic scan.</div>
        )}
        {running && <div className="pcap-loading">Scanning at most the first 250,000 packets…</div>}
        {result?.scan_truncated && (
          <div className="pcap-size-warning">
            Scan stopped at {result.scan_limit.toLocaleString()} packets; counts may be incomplete.
          </div>
        )}
        {result && result.findings.length === 0 && (
          <div className="pcap-findings-empty">
            No enabled deterministic findings matched {result.scanned_packets.toLocaleString()} scanned packets.
          </div>
        )}
        {result?.findings.map((finding) => (
          <article className="pcap-finding-card" key={finding.rule_id}>
            <header>
              <span className={`pcap-finding-severity severity-${finding.severity}`}>{finding.severity}</span>
              <strong>{finding.title}</strong>
              <span>{finding.count.toLocaleString()} packet{finding.count === 1 ? '' : 's'}</span>
            </header>
            <code>{finding.display_filter}</code>
            <div className="pcap-finding-evidence">
              <table>
                <thead>
                  <tr><th>No.</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Length</th></tr>
                </thead>
                <tbody>
                  {finding.evidence.map((packet) => (
                    <tr key={`${finding.rule_id}-${packet.no}`}>
                      <td>{packet.no}</td><td>{packet.src ?? '—'}</td><td>{packet.dst ?? '—'}</td>
                      <td>{packet.protocol}</td><td>{packet.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {finding.evidence_truncated && <footer>Showing the first 20 evidence packets.</footer>}
          </article>
        ))}
      </section>
    </div>
  );
}

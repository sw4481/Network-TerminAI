import { useCallback, useEffect, useMemo, useState } from "react";
import {
  decisionsList,
  decisionsToCsv,
  type DecisionRow,
} from "../../lib/guardrails";
import "./RuleEditor.css";

const TIER_LABELS: Record<number, string> = {
  0: "T0",
  1: "T1",
  2: "T2",
  3: "T3",
};

const DECISIONS = [
  "any",
  "auto_approved",
  "confirmed",
  "typed_confirmed",
  "admin_override",
  "denied",
  "ambiguous",
];

export function DecisionLogView() {
  const [rows, setRows] = useState<DecisionRow[]>([]);
  const [tierFilter, setTierFilter] = useState<number | null>(null);
  const [decisionFilter, setDecisionFilter] = useState<string>("any");
  const [sessionFilter, setSessionFilter] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const r = await decisionsList({ limit: 500 });
      setRows(r);
    } catch (e) {
      console.error("decisionsList failed", e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (tierFilter !== null && r.tier !== tierFilter) return false;
      if (decisionFilter !== "any" && r.decision !== decisionFilter) return false;
      if (
        sessionFilter.trim() &&
        !r.session_id.toLowerCase().includes(sessionFilter.toLowerCase())
      )
        return false;
      return true;
    });
  }, [rows, tierFilter, decisionFilter, sessionFilter]);

  const handleExport = useCallback(() => {
    const csv = decisionsToCsv(filtered);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `guardrail-decisions-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <div className="rule-editor" data-testid="decision-log" style={{ gridTemplateColumns: "1fr" }}>
      <div className="rule-detail" style={{ gridTemplateRows: "auto 1fr auto" }}>
        <div className="rule-detail-header">
          <label>Tier</label>
          <select
            value={tierFilter === null ? "any" : String(tierFilter)}
            onChange={(e) =>
              setTierFilter(e.target.value === "any" ? null : parseInt(e.target.value, 10))
            }
            data-testid="dl-tier"
          >
            <option value="any">any</option>
            {[0, 1, 2, 3].map((t) => (
              <option key={t} value={t}>
                T{t}
              </option>
            ))}
          </select>
          <label>Decision</label>
          <select
            value={decisionFilter}
            onChange={(e) => setDecisionFilter(e.target.value)}
            data-testid="dl-decision"
          >
            {DECISIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <label>Session</label>
          <input
            type="text"
            value={sessionFilter}
            onChange={(e) => setSessionFilter(e.target.value)}
            placeholder="session id…"
            data-testid="dl-session"
          />
          <button onClick={() => void load()} data-testid="dl-refresh">
            Refresh
          </button>
          <button className="primary" onClick={handleExport} data-testid="dl-export-csv">
            Export CSV
          </button>
        </div>
        <div style={{ overflow: "auto", padding: "0 14px" }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <tr>
                <th style={{ padding: "6px 4px" }}>When</th>
                <th style={{ padding: "6px 4px" }}>Tier</th>
                <th style={{ padding: "6px 4px" }}>Decision</th>
                <th style={{ padding: "6px 4px" }}>Session</th>
                <th style={{ padding: "6px 4px" }}>Command</th>
                <th style={{ padding: "6px 4px" }}>Reasoning</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 16, color: "var(--text-secondary)" }}>
                    No decisions matching filters.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--border-default)" }} data-testid={`dl-row-${r.id}`}>
                    <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                      {new Date(r.decided_at * 1000).toLocaleString()}
                    </td>
                    <td style={{ padding: "6px 4px" }}>
                      <span className={`badge tier-${r.tier}`}>{TIER_LABELS[r.tier] ?? `T${r.tier}`}</span>
                    </td>
                    <td style={{ padding: "6px 4px" }}>{r.decision}</td>
                    <td
                      style={{
                        padding: "6px 4px",
                        maxWidth: 140,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={r.session_id}
                    >
                      {r.session_id}
                    </td>
                    <td
                      style={{
                        padding: "6px 4px",
                        fontFamily: "Menlo, monospace",
                        color: "var(--text-primary)",
                        maxWidth: 240,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={r.command}
                    >
                      {r.command}
                    </td>
                    <td style={{ padding: "6px 4px", color: "var(--text-primary)" }}>{r.reasoning}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="rule-footer">
          <span style={{ color: "var(--text-secondary)", fontSize: 11.5, marginRight: "auto" }}>
            {filtered.length} / {rows.length} rows
          </span>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { topolographAuditList, topolographConfigGet, topolographConfigSave, topolographTestConnection, type TopolographAuditEvent, type TopolographConfig, type TopolographConnectionReport } from "../../lib/tauri";

type ConnectionReport = TopolographConnectionReport;
type AuditEvent = TopolographAuditEvent;

const DEFAULT_CONFIG: TopolographConfig = { singletonId: "topolograph", enabled: false, baseUrl: "", apiKey: "", verifyTls: true, updatedAt: 0 };

function normalizeBaseUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid URL");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function safeFailure(reason?: unknown) {
  void reason;
  return "Topolograph operation failed. Check connector status and recent activity.";
}

export function TopolographSettingsTab() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshAudit = async () => {
    try { setAudit(await topolographAuditList()); } catch { /* preserve the last visible activity on refresh failure */ }
  };

  useEffect(() => {
    void Promise.all([topolographConfigGet(), topolographAuditList()])
      .then(([saved, events]) => { if (saved) setConfig(saved); setAudit(events); })
      .catch((reason) => setError(safeFailure(reason)));
  }, []);

  const save = async () => {
    setBusy("save"); setError(null);
    try {
      const normalized = { ...config, baseUrl: config.baseUrl.trim() ? normalizeBaseUrl(config.baseUrl) : "" };
      await topolographConfigSave(normalized);
      setConfig(normalized);
    } catch (reason) { setError(safeFailure(reason)); } finally { await refreshAudit(); setBusy(null); }
  };

  const testConnection = async () => {
    setBusy("test"); setError(null); setReport(null);
    try { setReport(await topolographTestConnection(config)); }
    catch (reason) { setError(safeFailure(reason)); } finally { await refreshAudit(); setBusy(null); }
  };

  const complete = config.enabled && Boolean(config.baseUrl.trim()) && Boolean(config.apiKey.trim());
  return <div className="tab-content" data-testid="topolograph-settings">
    <h2>Topolograph</h2>
    <p className="muted">Connect to an operator-managed private-LAN Topolograph deployment.</p>
    <label><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} /> Enable integration</label>
    <div className="form-group"><label htmlFor="topolograph-base-url">Base URL</label><input id="topolograph-base-url" value={config.baseUrl} placeholder="http://topolograph.local:8080" onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })} /></div>
    <div className="form-group"><label htmlFor="topolograph-api-key">API key</label><input id="topolograph-api-key" type="password" value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} /><p role="alert">Warning: this API key is stored unencrypted in TerminAI's local database.</p></div>
    <label><input type="checkbox" checked={config.verifyTls} onChange={(e) => setConfig({ ...config, verifyTls: e.target.checked })} /> Verify TLS certificates</label>
    {!config.verifyTls && <p role="alert">Warning: TLS verification is disabled. Use only on a trusted private network.</p>}
    <div className="button-row"><button onClick={() => void save()} disabled={busy !== null || (config.enabled && !config.apiKey.trim())} aria-busy={busy === "save"}>{busy === "save" ? "Saving…" : "Save"}</button><button onClick={() => void testConnection()} disabled={busy !== null || !complete} aria-busy={busy === "test"}>{busy === "test" ? "Testing connection…" : "Test Connection"}</button></div>
    {busy && <p role="status">{busy === "test" ? "Testing connection…" : "Saving settings…"}</p>}
    {!complete && <p className="muted" role="status">Enable the connector and enter a base URL and API key before testing.</p>}
    {error && <p role="alert">{error}</p>}
    {report && <section aria-label="Connection result" role="status"><p>{report.ok ? "Connected" : "Connection failed"}: {report.message}</p>{report.serverName && <p>{report.serverName}{report.serverVersion ? ` ${report.serverVersion}` : ""}</p>}{typeof report.latencyMs === "number" && <p>{report.latencyMs} ms</p>}{report.tools.length ? <p>{report.tools.join(", ")}</p> : null}{report.missingTools.length ? <p role="alert">Required tools missing: {report.missingTools.join(", ")}</p> : null}{report.unexpectedTools.length ? <p role="alert">Unexpected tools: {report.unexpectedTools.join(", ")}</p> : null}{report.stages.map((stage) => <p key={stage.name}>{stage.name.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())}: {stage.status}</p>)}{report.warnings.map((warning) => <p key={warning} role="alert">{warning}</p>)}</section>}
    <h3>Recent activity</h3>
    {audit.length === 0 ? <p className="muted">No Topolograph activity yet.</p> : <table><caption className="sr-only">Newest Topolograph activity</caption><thead><tr><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Outcome</th><th scope="col">Duration</th></tr></thead><tbody>{audit.map((event) => <tr key={event.id}><td>{event.action}</td><td>{event.targetLabel ?? "topolograph"}</td><td>{event.outcome}</td><td>{event.durationMs ?? 0} ms</td></tr>)}</tbody></table>}
    <details><summary>Operator setup guide</summary><div className="muted"><p>Supported tier: private localhost or private LAN only. On macOS or Linux, install Docker and Compose 2.24.4+, clone the upstream repository at commit <code>30fec81696bfb5e5edf87022c4b3a4d46483ca9b</code>, and apply an exposure-reducing override.</p><p>Pin the application image to <code>vadims06/topolograph:2.69.2</code> and MCP to <code>vadims06/topolograph-mcp-server:v1.3.1</code>. Generate non-default mode-0600 secrets, enable MCP mutations, and restrict authorized sources to this host. Apple Silicon may require linux/amd64 emulation.</p><p>Start and verify Compose, then create browser credentials and an API token. Enter the generated Topolograph token in the API key field and use Test Connection to verify it. Upgrades and backups remain operator-owned. Never use router forwarding, public DNS, or Internet exposure.</p><p role="alert">Warning: this API key is stored unencrypted in TerminAI's local database.</p></div></details>
  </div>;
}

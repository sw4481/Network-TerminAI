import { useEffect, useState } from "react";
import { pyatsListSupportedDevices, topolographAuditList, topolographConfigGet, topolographImportLsdbFromPyats, topolographTestConnection, topolographUploadLsdbFile, topolographUploadYamlFile, type PyatsDeviceSummary, type TopolographAuditEvent, type TopolographConfig, type TopolographConnectionReport, type TopolographPyatsLsdbImportRequest, type TopolographUploadResult } from "../../lib/tauri";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./TopologyIntegrationWorkspace.css";

type AuditEvent = TopolographAuditEvent;
type ConnectionReport = TopolographConnectionReport;
type UploadResult = TopolographUploadResult;
type TopolographState = "loading" | "disabled" | "incomplete" | "locked" | "failed" | "ready";
type PyatsCatalogState = "loading" | "ready" | "empty" | "error";
type LsdbProtocol = TopolographPyatsLsdbImportRequest["protocol"];

function formatAuditTime(occurredAt: number) {
  return new Date(occurredAt * 1000).toLocaleString();
}

function describeTopolographFailure(error: unknown): TopolographState {
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return code.includes("CONNECTOR_LOCKED") ? "locked" : "failed";
}

export function TopolographWorkspace() {
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [config, setConfig] = useState<TopolographConfig | null>(null);
  const [state, setState] = useState<TopolographState>("loading");
  const [busy, setBusy] = useState<"connection" | "lsdb" | "pyats" | "yaml" | "browser" | null>(null);
  const [protocol, setProtocol] = useState<LsdbProtocol>("ospf");
  const [pyatsDevices, setPyatsDevices] = useState<PyatsDeviceSummary[]>([]);
  const [pyatsCatalogState, setPyatsCatalogState] = useState<PyatsCatalogState>("loading");
  const [selectedPyatsDevice, setSelectedPyatsDevice] = useState("");
  const [latest, setLatest] = useState<{ label: string; result: ConnectionReport | UploadResult } | null>(null);
  const refreshAudit = async () => {
    try {
      setAudit(await topolographAuditList());
    } catch {
      // Activity history is diagnostic context; it must not block connector use.
    }
  };

  useEffect(() => {
    void Promise.all([topolographConfigGet(), refreshAudit()]).then(([saved]) => {
      setConfig(saved);
      setState((current) => current === "loading" ? (!saved || !saved.enabled ? "disabled" : !saved.baseUrl.trim() || !saved.secretId.trim() ? "incomplete" : "ready") : current);
    }).catch((error) => setState((current) => current === "loading" ? describeTopolographFailure(error) : current));
  }, []);

  useEffect(() => {
    void pyatsListSupportedDevices()
      .then((devices) => {
        const safeDevices = Array.isArray(devices) ? devices : [];
        setPyatsDevices(safeDevices);
        setSelectedPyatsDevice(safeDevices[0]?.name ?? "");
        setPyatsCatalogState(safeDevices.length > 0 ? "ready" : "empty");
      })
      .catch(() => setPyatsCatalogState("error"));
  }, []);

  const ready = state === "ready" && config !== null;
  const stateMessage = state === "loading" ? "Loading Topolograph configuration…" : state === "disabled" ? "Topolograph is disabled in Settings." : state === "incomplete" ? "Topolograph setup is incomplete. Select a base URL and Vault secret in Settings." : state === "locked" ? "Topolograph access is locked. Unlock the selected Vault secret in Settings." : state === "failed" ? "Topolograph status could not be loaded. Check Settings and recent activity." : "Ready for a native LSDB or YAML upload.";
  const test = async () => {
    if (!config) return;
    setBusy("connection");
    try { setLatest({ label: "Connection", result: await topolographTestConnection(config) }); }
    catch (error) { if (describeTopolographFailure(error) === "locked") setState("locked"); setLatest({ label: "Connection", result: { ok: false, message: "Connection failed. Check recent activity.", warnings: [], serverName: "", serverVersion: "", latencyMs: null, tools: [], missingTools: [], unexpectedTools: [], stages: [{ name: "connection", status: "failed" }] } }); }
    finally { await refreshAudit(); setBusy(null); }
  };
  const upload = async (kind: "lsdb" | "yaml") => {
    if (!ready) return;
    setBusy(kind);
    try {
      const path = await openDialog({ multiple: false, directory: false, title: kind === "lsdb" ? "Choose Topolograph LSDB text" : "Choose Topolograph YAML", filters: [kind === "lsdb" ? { name: "LSDB text", extensions: ["txt", "log"] } : { name: "Topolograph YAML", extensions: ["yaml", "yml"] }] });
      if (path === null) return;
      if (typeof path !== "string" || !path.startsWith("/")) { setLatest({ label: "Upload", result: { ok: false, message: "Choose an absolute native file path.", bytes: 0, warnings: [] } }); return; }
      const result = kind === "lsdb" ? await topolographUploadLsdbFile({ path, protocol }) : await topolographUploadYamlFile(path);
      setLatest({ label: kind === "lsdb" ? "LSDB upload" : "YAML upload", result });
    } catch (error) { if (describeTopolographFailure(error) === "locked") setState("locked"); setLatest({ label: "Upload", result: { ok: false, message: "Upload failed. Check recent activity.", bytes: 0, warnings: [] } }); }
    finally { await refreshAudit(); setBusy(null); }
  };
  const fetchFromSwitch = async () => {
    if (!ready || !selectedPyatsDevice || pyatsCatalogState !== "ready") return;
    setBusy("pyats");
    try {
      const result = await topolographImportLsdbFromPyats({
        device: selectedPyatsDevice,
        protocol,
        description: null,
      });
      setLatest({ label: "Switch fetch", result });
    } catch (error) {
      if (describeTopolographFailure(error) === "locked") setState("locked");
      setLatest({ label: "Switch fetch", result: { ok: false, message: "Fetch failed. Check recent activity.", bytes: 0, warnings: [] } });
    } finally {
      await refreshAudit();
      setBusy(null);
    }
  };
  const open = async () => {
    if (!config) return;
    setBusy("browser");
    try { await openUrl(config.baseUrl); }
    catch { setLatest({ label: "Browser", result: { ok: false, message: "Unable to open Topolograph. Check Settings.", warnings: [], serverName: "", serverVersion: "", latencyMs: null, tools: [], missingTools: [], unexpectedTools: [], stages: [{ name: "connection", status: "failed" }] } }); }
    finally { await refreshAudit(); setBusy(null); }
  };

  return (
    <section aria-label="Topolograph workspace" className="topology-integration" data-testid="topolograph-workspace" role="region">
      <header className="topology-integration__header">
        <div className="topology-integration__identity">
          <h2>Topolograph</h2>
          <p>Operator-managed graph service. TerminAI does not manage its containers.</p>
        </div>
        <p
          className={`topology-integration__state topology-integration__state--${state}`}
          data-testid={`topolograph-state-${state}`}
          role="status"
        >
          {stateMessage}
        </p>
        <div aria-label="Topolograph commands" className="topology-integration__actions" role="group">
          <button
            className="topology-integration__button topology-integration__button--secondary"
            onClick={() => void test()}
            disabled={!ready || busy !== null}
            aria-busy={busy === "connection"}
          >
            {busy === "connection" ? "Testing connection…" : "Test connection"}
          </button>
          <button
            className="topology-integration__button topology-integration__button--primary"
            onClick={() => void open()}
            disabled={!ready || busy !== null}
            aria-busy={busy === "browser"}
            aria-describedby="topolograph-external-note"
          >
            {busy === "browser" ? "Opening Topolograph…" : "Open Topolograph"}
          </button>
          <span className="topology-integration__external-note" id="topolograph-external-note">Opens in your external browser</span>
        </div>
      </header>

      <section aria-label="Topology data uploads" className="topology-integration__uploads">
        <div className="topology-integration__section-heading">
          <div>
            <h3>Upload topology data</h3>
            <p>Use the native file picker to send one supported topology source.</p>
          </div>
          <span>Local files only</span>
        </div>
        <div className="topology-integration__upload-grid">
          <div aria-label="LSDB upload" className="topology-integration__upload" role="group">
            <div>
              <h4>Link-state database</h4>
              <p>Choose a .txt or .log capture and identify its protocol.</p>
            </div>
            <label>
              <span>LSDB protocol</span>
              <select
                aria-label="LSDB protocol"
                value={protocol}
                disabled={!ready || busy !== null}
                onChange={(event) => setProtocol(event.target.value as LsdbProtocol)}
              >
                <option value="ospf">OSPF</option>
                <option value="ospfv3">OSPFv3</option>
                <option value="isis">IS-IS</option>
              </select>
            </label>
            <button
              className="topology-integration__button topology-integration__button--upload"
              onClick={() => void upload("lsdb")}
              disabled={!ready || busy !== null}
              aria-busy={busy === "lsdb"}
            >
              {busy === "lsdb" ? "Uploading LSDB…" : "Choose LSDB file"}
            </button>
            <div className="topology-integration__switch-source">
              <div>
                <strong>Saved pyATS testbed</strong>
                <p id="topolograph-pyats-source-note">Read-only collection from the saved pyATS testbed.</p>
              </div>
              <label>
                <span>pyATS device</span>
                <select
                  aria-label="pyATS device"
                  aria-describedby="topolograph-pyats-source-note"
                  value={selectedPyatsDevice}
                  disabled={!ready || busy !== null || pyatsCatalogState !== "ready"}
                  onChange={(event) => setSelectedPyatsDevice(event.target.value)}
                >
                  {pyatsCatalogState === "loading" ? <option value="">Loading devices…</option> : null}
                  {pyatsCatalogState === "empty" ? <option value="">No supported devices</option> : null}
                  {pyatsCatalogState === "error" ? <option value="">Devices unavailable</option> : null}
                  {pyatsDevices.map((device) => (
                    <option key={device.name} value={device.name}>{device.name} ({device.os})</option>
                  ))}
                </select>
              </label>
              <button
                className="topology-integration__button topology-integration__button--upload"
                onClick={() => void fetchFromSwitch()}
                disabled={!ready || busy !== null || pyatsCatalogState !== "ready" || !selectedPyatsDevice}
                aria-busy={busy === "pyats"}
              >
                {busy === "pyats" ? "Fetching from switch…" : "Fetch from switch"}
              </button>
              {pyatsCatalogState === "empty" ? <p className="topology-integration__source-state" role="status">No supported IOS-XE or NX-OS devices are saved.</p> : null}
              {pyatsCatalogState === "error" ? <p className="topology-integration__source-state is-failed" role="alert">Saved pyATS devices could not be loaded.</p> : null}
            </div>
          </div>
          <div aria-label="YAML upload" className="topology-integration__upload" role="group">
            <div>
              <h4>Topology definition</h4>
              <p>Choose a Topolograph .yaml or .yml definition.</p>
            </div>
            <button
              className="topology-integration__button topology-integration__button--upload"
              onClick={() => void upload("yaml")}
              disabled={!ready || busy !== null}
              aria-busy={busy === "yaml"}
            >
              {busy === "yaml" ? "Uploading YAML…" : "Choose YAML file"}
            </button>
          </div>
        </div>
      </section>

      <div className="topology-integration__operations">
        <section aria-label="Latest result" className="topology-integration__latest" role="status">
          <div className="topology-integration__section-heading">
            <h3>Latest result</h3>
            {latest ? <span className={latest.result.ok ? "is-success" : "is-failed"}>{latest.result.ok ? "Complete" : "Failed"}</span> : <span>Waiting</span>}
          </div>
          {latest ? (
            <div className="topology-integration__result-body">
              <p><strong>{latest.label}: </strong>{latest.result.ok ? latest.result.message : `Failed — ${latest.result.message}`}</p>
              {"bytes" in latest.result ? <p className="topology-integration__result-meta">{latest.result.bytes} bytes</p> : null}
              {latest.result.warnings.map((warning) => <p className="topology-integration__warning" key={warning} role="alert">{warning}</p>)}
            </div>
          ) : <p className="topology-integration__empty">No operation run yet.</p>}
        </section>

        <section aria-label="Recent activity" className="topology-integration__activity">
          <div className="topology-integration__section-heading">
            <h3>Recent activity</h3>
            <span>{audit.length} {audit.length === 1 ? "event" : "events"}</span>
          </div>
          {audit.length === 0 ? <p className="topology-integration__empty">No activity recorded.</p> : (
            <div className="topology-integration__table-wrap">
              <table>
                <caption className="sr-only">Newest Topolograph activity</caption>
                <thead><tr><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Outcome</th><th scope="col">Duration</th></tr></thead>
                <tbody>{audit.map((event) => <tr key={event.id}><td>{formatAuditTime(event.occurredAt)}</td><td>{event.action}</td><td>{event.targetLabel ?? "topolograph"}</td><td>{event.outcome}</td><td>{event.durationMs === undefined ? "—" : `${event.durationMs} ms`}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { pyatsListSupportedDevices, stpCollectNow, stpSettingsGet, stpSettingsSave, stpSnapshotList, topolographAuditList, topolographConfigGet, topolographImportLsdbFromPyats, topolographTestConnection, topolographUploadLsdbFile, topolographUploadYamlFile, type PyatsDeviceSummary, type StpDevice, type StpInstance, type StpLink, type StpPort, type StpSettings, type StpSnapshot, type TopolographAuditEvent, type TopolographConfig, type TopolographConnectionReport, type TopolographPyatsLsdbImportRequest, type TopolographUploadResult } from "../../lib/tauri";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "./StpWorkspace.css";
import "./TopologyIntegrationWorkspace.css";

type AuditEvent = TopolographAuditEvent;
type ConnectionReport = TopolographConnectionReport;
type UploadResult = TopolographUploadResult;
type TopolographState = "loading" | "disabled" | "incomplete" | "failed" | "ready";
type PyatsCatalogState = "loading" | "ready" | "empty" | "error";
type LsdbProtocol = TopolographPyatsLsdbImportRequest["protocol"];
type StpStatus = "complete" | "partial" | "failed";
type WorkspaceState = "loading" | "pyats" | "devices" | "platform" | "locked" | "error" | "no-baseline" | "ready";

function formatAuditTime(occurredAt: number) {
  return new Date(occurredAt * 1000).toLocaleString();
}

const STP_NODE_TYPES = { stp: StpNode };
const STP_EDGE_TYPES = { stp: StpLinkEdge };
const STP_FAILURE_STATES: Record<string, WorkspaceState> = {
  unsupported_platform: "platform",
  testbed_unavailable: "pyats",
  no_supported_devices: "devices",
  collection_active: "locked",
};

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9-]/g, "-");
}

function describeFailure(error: unknown): WorkspaceState {
  const code = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return STP_FAILURE_STATES[code] ?? "error";
}

function workspaceMessage(state: WorkspaceState) {
  switch (state) {
    case "pyats":
      return "pyATS testbed is unavailable. Configure pyATS before collecting STP evidence.";
    case "devices":
      return "No supported IOS-XE or NX-OS devices are available for STP collection.";
    case "platform":
      return "Spanning Tree collection is unavailable on Windows.";
    case "locked":
      return "STP collection is currently locked by another run.";
    case "error":
      return "Unable to load STP evidence. Try collecting a new snapshot.";
    case "no-baseline":
      return "No baseline yet. Configure pyATS and collect a snapshot.";
    default:
      return "";
  }
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
      setState((current) => current === "loading" ? (!saved || !saved.enabled ? "disabled" : !saved.baseUrl.trim() || !saved.apiKey.trim() ? "incomplete" : "ready") : current);
    }).catch(() => setState((current) => current === "loading" ? "failed" : current));
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
  const stateMessage = state === "loading" ? "Loading Topolograph configuration…" : state === "disabled" ? "Topolograph is disabled in Settings." : state === "incomplete" ? "Topolograph setup is incomplete. Enter a base URL and API key in Settings." : state === "failed" ? "Topolograph status could not be loaded. Check Settings and recent activity." : "Ready for a native LSDB or YAML upload.";
  const test = async () => {
    if (!config) return;
    setBusy("connection");
    try { setLatest({ label: "Connection", result: await topolographTestConnection(config) }); }
    catch { setLatest({ label: "Connection", result: { ok: false, message: "Connection failed. Check recent activity.", warnings: [], serverName: "", serverVersion: "", latencyMs: null, tools: [], missingTools: [], unexpectedTools: [], stages: [{ name: "connection", status: "failed" }] } }); }
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
    } catch { setLatest({ label: "Upload", result: { ok: false, message: "Upload failed. Check recent activity.", bytes: 0, warnings: [] } }); }
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
    } catch {
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

function statusBadge(status: StpStatus) {
  return <span className={`stp-badge stp-badge--${status}`}>{status}</span>;
}

type StpNodeData = {
  deviceId: string;
  neighborCount: number;
  platform: string;
  portCount: number;
  role: string;
};

function countLabel(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function StpNode({ data, selected }: NodeProps<Node<StpNodeData, "stp">>) {
  return (
    <div className={`stp-node${selected ? " stp-node--selected" : ""}`} data-testid={`stp-node-${safeId(data.deviceId)}`}>
      <Handle isConnectable={false} type="target" position={Position.Top} />
      <div className="stp-node__identity">
        <strong>{data.deviceId}</strong>
        <small>{data.platform}</small>
      </div>
      <span className="stp-node__role">{data.role}</span>
      <span className="stp-node__counts">
        {countLabel(data.portCount, "port")} · {countLabel(data.neighborCount, "neighbor")}
      </span>
      <Handle isConnectable={false} type="source" position={Position.Bottom} />
    </div>
  );
}

type StpEdgeData = { confidence: "confirmed" | "provisional" };

export function StpLinkEdge(props: EdgeProps<Edge<StpEdgeData, "stp">>) {
  const [path] = getBezierPath(props);
  const confidence = props.data?.confidence ?? "provisional";
  return (
    <g
      className={`stp-link stp-link--${confidence}`}
      data-confidence={confidence}
      data-testid={`stp-edge-${props.id}`}
    >
      <BaseEdge {...props} path={path} className={`stp-link__path stp-link__path--${confidence}`} />
    </g>
  );
}

type StpSummary = {
  blockedPorts: number;
  nonRootBridges: number;
  rootBridge: string | null;
  rootPorts: number;
  topologyChanges: number | null;
};

class StpInstanceViewModel {
  constructor(
    private readonly snapshot: StpSnapshot | null,
    readonly instanceId: string,
  ) {}

  get instances(): StpInstance[] {
    const instances = this.snapshot?.payload.instances ?? [];
    return this.instanceId === "all"
      ? instances
      : instances.filter((item) => item.id === this.instanceId);
  }

  get links(): StpLink[] {
    const links = this.snapshot?.payload.links ?? [];
    return this.instanceId === "all"
      ? links
      : links.filter((link) => link.instanceId === this.instanceId);
  }

  get ports(): StpPort[] {
    return this.instances.flatMap((item) => item.ports ?? []);
  }

  get devices(): StpDevice[] {
    const devices = this.snapshot?.payload.devices ?? [];
    if (this.instanceId === "all") return devices;
    const visibleIds = new Set([
      ...this.ports.map((port) => port.deviceId),
      ...this.links.flatMap((link) => link.remoteDeviceId === null
        ? [link.localDeviceId]
        : [link.localDeviceId, link.remoteDeviceId]),
    ]);
    if (devices.length === 1 && visibleIds.size === 0) return devices;
    return devices.filter((device) => visibleIds.has(device.deviceId));
  }

  instanceFor(deviceId: string): StpInstance | null {
    const matched = this.instances.find((item) =>
      item.ports.some((port) => port.deviceId === deviceId),
    );
    if (matched) return matched;
    if (this.devices.length === 1 && this.instances.length === 1) return this.instances[0];
    return null;
  }

  portsFor(deviceId: string): StpPort[] {
    return this.ports.filter((port) => port.deviceId === deviceId);
  }

  roleFor(deviceId: string): string {
    const item = this.instanceFor(deviceId);
    if (!item?.bridgeId || !item.rootId) return "Bridge role not reported";
    return item.bridgeId.trim().toLowerCase() === item.rootId.trim().toLowerCase()
      ? "Root bridge"
      : "Non-root bridge";
  }

  neighborCount(deviceId: string): number {
    const neighbors = new Set<string>();
    for (const link of this.links) {
      if (link.localDeviceId === deviceId && link.remoteDeviceId) neighbors.add(link.remoteDeviceId);
      if (link.remoteDeviceId === deviceId) neighbors.add(link.localDeviceId);
    }
    return neighbors.size;
  }

  remoteInterface(link: StpLink): string | null {
    if (!link.remoteDeviceId || !link.bidirectional) return null;
    return this.links.find((candidate) =>
      candidate !== link
      && candidate.bidirectional
      && candidate.localDeviceId === link.remoteDeviceId
      && candidate.remoteDeviceId === link.localDeviceId,
    )?.localInterface ?? null;
  }

  summary(): StpSummary {
    const rootBridge = this.instances.find((item) =>
      item.bridgeId
      && item.rootId
      && item.bridgeId.trim().toLowerCase() === item.rootId.trim().toLowerCase(),
    )?.bridgeId ?? this.instances.find((item) => item.rootId)?.rootId ?? null;
    const nonRootBridges = this.instances.filter((item) =>
      item.bridgeId
      && item.rootId
      && item.bridgeId.trim().toLowerCase() !== item.rootId.trim().toLowerCase(),
    ).length;
    const rootPorts = new Set(
      this.instances.flatMap((item) => item.rootPort
        && item.bridgeId?.trim().toLowerCase() !== item.rootId?.trim().toLowerCase()
        ? [`${item.ports[0]?.deviceId ?? item.bridgeId ?? item.id}:${item.rootPort}`]
        : []),
    );
    for (const port of this.ports.filter((item) => item.role?.toLowerCase() === "root")) {
      rootPorts.add(`${port.deviceId}:${port.interface}`);
    }
    const blockedPorts = new Set(this.ports.filter((port) => {
      const role = port.role?.toLowerCase() ?? "";
      const state = port.state?.toLowerCase() ?? "";
      return role === "alternate" || state === "blocked" || state === "blocking";
    }).map((port) => `${port.deviceId}:${port.interface}`)).size;
    const topologyCounts = this.instances
      .map((item) => item.topologyChangeCount)
      .filter((count): count is number => typeof count === "number");
    return {
      blockedPorts,
      nonRootBridges,
      rootBridge,
      rootPorts: rootPorts.size,
      topologyChanges: topologyCounts.length > 0
        ? topologyCounts.reduce((total, count) => total + count, 0)
        : null,
    };
  }
}

function instanceOptions(snapshot: StpSnapshot | null) {
  const options = new Map<string, StpInstance>();
  for (const item of snapshot?.payload.instances ?? []) {
    if (!options.has(item.id)) options.set(item.id, item);
  }
  return [...options.values()];
}

export function StpWorkspace() {
  const [snapshots, setSnapshots] = useState<StpSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instance, setInstance] = useState("all");
  const [settings, setSettings] = useState<StpSettings>({ singletonId: "stp", scheduleEnabled: false, intervalMinutes: 60, updatedAt: 0 });
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>("loading");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [inspectedDeviceId, setInspectedDeviceId] = useState<string | null>(null);
  const selected = snapshots.find((snapshot) => snapshot.id === selectedId) ?? null;
  const selectedFailure = selected?.status === "failed"
    ? describeFailure(selected.errorSummary ?? "")
    : null;
  const displayedState = selectedFailure ?? (
    workspaceState !== "ready" && workspaceState !== "loading" ? workspaceState : null
  );
  const options = instanceOptions(selected);
  const scope = useMemo(() => new StpInstanceViewModel(selected, instance), [selected, instance]);
  const nodes: Node<StpNodeData, "stp">[] = useMemo(() => scope.devices.map((device, index) => ({
    id: device.deviceId,
    type: "stp",
    position: { x: (index % 3) * 230, y: Math.floor(index / 3) * 140 },
    selected: device.deviceId === inspectedDeviceId,
    data: {
      deviceId: device.deviceId,
      neighborCount: scope.neighborCount(device.deviceId),
      platform: device.platform,
      portCount: scope.portsFor(device.deviceId).length,
      role: scope.roleFor(device.deviceId),
    },
  })), [inspectedDeviceId, scope]);
  const edges: Edge<StpEdgeData, "stp">[] = useMemo(() => scope.links
    .filter((link): link is StpLink & { remoteDeviceId: string } => typeof link.remoteDeviceId === "string")
    .map((link) => ({
      id: link.id ?? `${link.localDeviceId}-${link.remoteDeviceId}-${link.localInterface}`,
      source: link.localDeviceId,
      target: link.remoteDeviceId,
      type: "stp",
      data: { confidence: link.bidirectional ? "confirmed" : "provisional" },
    })), [scope]);
  const inspectedDevice = scope.devices.find((device) => device.deviceId === inspectedDeviceId)
    ?? scope.devices[0]
    ?? null;
  const inspectedInstance = inspectedDevice ? scope.instanceFor(inspectedDevice.deviceId) : null;
  const inspectedPorts = inspectedDevice ? scope.portsFor(inspectedDevice.deviceId) : [];
  const selectedSummary = scope.summary();

  useEffect(() => {
    void Promise.all([
      stpSnapshotList(),
      stpSettingsGet(),
    ])
      .then(([items, savedSettings]) => {
        setSnapshots(items);
        setSelectedId(items[0]?.id ?? null);
        setInstance(items[0]?.payload.instances?.[0]?.id ?? "all");
        setSettings(savedSettings);
        setWorkspaceState(items.length === 0 ? "no-baseline" : "ready");
      })
      .catch((error) => setWorkspaceState(describeFailure(error)));
  }, []);

  const saveSettings = async (next: StpSettings) => {
    const previous = settings;
    setSettings(next);
    setSavingSchedule(true);
    try {
      const saved = await stpSettingsSave(next);
      setSettings(saved);
    } catch (error) {
      setSettings(previous);
      setWorkspaceState(describeFailure(error));
    } finally {
      setSavingSchedule(false);
    }
  };

  const collect = async () => {
    setCollecting(true);
    try {
      const snapshot = await stpCollectNow();
      setSnapshots((items) => [snapshot, ...items.filter((item) => item.id !== snapshot.id)]);
      setSelectedId(snapshot.id);
      setInstance("all");
      setInspectedDeviceId(null);
      setWorkspaceState(snapshot.status === "failed" ? describeFailure(snapshot.errorSummary ?? "") : "ready");
    } catch (error) {
      setWorkspaceState(describeFailure(error));
    } finally {
      setCollecting(false);
    }
  };

  return (
    <section className="stp-workspace" data-testid="stp-workspace">
      <header className="stp-workspace__controls">
        <div className="stp-workspace__title">
          <h2>Spanning Tree</h2>
          <p className="muted">Observed STP evidence only.</p>
        </div>
        <div className="stp-workspace__commands">
          <button className="stp-workspace__collect" onClick={() => void collect()} disabled={collecting}>
            {collecting ? "Collecting…" : "Collect now"}
          </button>
          <label className="stp-workspace__schedule-toggle">
            <input
              aria-label="Schedule collection"
              checked={settings.scheduleEnabled}
              disabled={savingSchedule}
              type="checkbox"
              onChange={(event) => void saveSettings({ ...settings, scheduleEnabled: event.target.checked })}
            />
            Schedule collection
          </label>
          <label className="stp-workspace__interval">
            <span>Collection interval</span>
            <select
              aria-label="Collection interval"
              disabled={!settings.scheduleEnabled || savingSchedule}
              value={settings.intervalMinutes}
              onChange={(event) => void saveSettings({ ...settings, intervalMinutes: Number(event.target.value) })}
            >
              <option value={30}>30 minutes</option>
              <option value={60}>60 minutes</option>
              <option value={240}>240 minutes</option>
            </select>
          </label>
          <p className="stp-workspace__cadence" role="status">
            {settings.scheduleEnabled ? `Every ${settings.intervalMinutes} minutes` : "Schedule disabled"}
          </p>
        </div>
      </header>

      <div className="stp-workspace__body">
        <nav aria-label="STP snapshots" className="stp-workspace__snapshots">
          <section className="stp-workspace__nav-section">
            <h3>Snapshots</h3>
            <div className="stp-workspace__snapshot-list">
              {snapshots.map((snapshot) => (
                <button
                  aria-pressed={selectedId === snapshot.id}
                  className="stp-snapshot"
                  data-testid={`stp-snapshot-${snapshot.id}`}
                  key={snapshot.id}
                  onClick={() => {
                    setSelectedId(snapshot.id);
                    setInstance(snapshot.payload.instances?.[0]?.id ?? "all");
                    setInspectedDeviceId(null);
                  }}
                >
                  <span>{new Date(snapshot.startedAt * 1000).toLocaleString()}</span>
                  {statusBadge(snapshot.status)}
                </button>
              ))}
            </div>
          </section>
          {selected && !selectedFailure ? (
            <section className="stp-workspace__nav-section">
              <h3>Instance</h3>
              <label className="stp-workspace__instance-select">
                <span>VLAN/MST instance</span>
                <select value={instance} onChange={(event) => setInstance(event.target.value)}>
                  <option value="all">All instances</option>
                  {options.map((item) => (
                    <option key={item.id} value={item.id}>{item.label ?? item.vlan ?? item.id}</option>
                  ))}
                </select>
              </label>
            </section>
          ) : null}
          {displayedState ? (
            <p className="stp-workspace__state" data-testid={`stp-state-${displayedState}`} role="status">
              {workspaceMessage(displayedState)}
            </p>
          ) : null}
        </nav>

        <main className="stp-workspace__graph">
          {selected ? (
            selectedFailure ? (
              <p className="stp-workspace__state" data-testid={`stp-selected-state-${selectedFailure}`} role="status">
                {workspaceMessage(selectedFailure)}
              </p>
            ) : <>
              <div className="stp-workspace__graph-heading">
                <div>
                  <h3>{instance === "all" ? "All instances" : (options.find((item) => item.id === instance)?.label ?? instance)}</h3>
                  <p>Observed bridge and neighbor topology</p>
                </div>
                {scope.instances[0]?.mode ? <span className={`stp-mode stp-mode--${scope.instances[0].mode.toLowerCase()}`}>{scope.instances[0].mode.replace(/_/g, " ")}</span> : null}
              </div>
              {selected.status === "partial" ? (
                <p className="stp-workspace__partial" data-testid="stp-partial-notice" role="status">Partial snapshot: domain-wide summaries are suppressed.</p>
              ) : instance === "all" ? (
                <ul className="stp-workspace__domain" data-testid="stp-all-instance-summary">
                  {(selected.payload.instances ?? []).map((item, index) => (
                    <li key={`${item.id}-${index}`}>
                      {item.label ?? item.vlan ?? item.id} · Bridge {item.bridgeId ?? "not reported"} · Root {item.rootId ?? "not reported"}
                    </li>
                  ))}
                </ul>
              ) : (
                <section aria-label="Instance summary" className="stp-workspace__summary">
                  <div data-testid="stp-summary-root-bridge"><span>Root bridge</span><strong>{selectedSummary.rootBridge ?? "Not reported"}</strong></div>
                  <div data-testid="stp-summary-non-root-bridges"><span>Non-root bridges</span><strong>{selectedSummary.nonRootBridges}</strong></div>
                  <div data-testid="stp-summary-root-ports"><span>Root ports</span><strong>{selectedSummary.rootPorts}</strong></div>
                  <div data-testid="stp-summary-blocked-ports"><span>Blocked / alternate</span><strong>{selectedSummary.blockedPorts}</strong></div>
                  <div data-testid="stp-summary-topology-changes"><span>Topology changes</span><strong>{selectedSummary.topologyChanges ?? "Not reported"}</strong></div>
                </section>
              )}
              <div className="stp-workspace__canvas">
                <ReactFlow
                  aria-label="Spanning tree graph"
                  edgeTypes={STP_EDGE_TYPES}
                  edges={edges}
                  fitView
                  nodeTypes={STP_NODE_TYPES}
                  nodes={nodes}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  edgesFocusable={false}
                  edgesReconnectable={false}
                  deleteKeyCode={null}
                  onNodeClick={(_, node) => setInspectedDeviceId(node.id)}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
              <section className="stp-workspace__neighbors">
                <h3>Neighbors</h3>
                {scope.links.length > 0 ? (
                  <div className="stp-workspace__table-wrap">
                    <table>
                      <thead><tr><th scope="col">Local device</th><th scope="col">Local interface</th><th scope="col">Remote device</th><th scope="col">Remote interface</th><th scope="col">Confidence</th></tr></thead>
                      <tbody>{scope.links.map((link) => {
                        const id = link.id ?? `${link.localDeviceId}-${link.remoteDeviceId}-${link.localInterface}`;
                        const confidence = link.bidirectional ? "confirmed" : "provisional";
                        return (
                          <tr data-testid={`stp-neighbor-${id}`} key={id}>
                            <td>{link.localDeviceId}</td><td>{link.localInterface}</td><td>{link.remoteDeviceId ?? "Not reported"}</td><td>{scope.remoteInterface(link) ?? "Not reported"}</td>
                            <td><span className={`stp-confidence stp-confidence--${confidence}`}>{confidence === "confirmed" ? "Confirmed" : "Provisional"}</span></td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                  </div>
                ) : scope.devices.length === 1 ? (
                  <p className="stp-workspace__empty" data-testid="stp-no-neighbor-evidence">No neighbor evidence</p>
                ) : (
                  <p className="stp-workspace__empty">No links reported for this scope.</p>
                )}
              </section>
            </>
          ) : (
            <p className="muted" data-testid={`stp-state-${workspaceState}`} role="status">{workspaceState === "loading" ? "Loading spanning-tree snapshots…" : workspaceMessage(workspaceState)}</p>
          )}
        </main>

        <aside className="stp-workspace__evidence">
          <section className="stp-workspace__panel">
            <h3>Findings</h3>
            {(selected?.payload.findings ?? []).map((finding, index) => <p key={`${finding.kind}-${index}`}><strong>{finding.kind}</strong> [{finding.severity}] {finding.detail}</p>)}
            {selected?.status === "failed" ? <p role="alert">Collection failed; no baseline was promoted.</p> : null}
            {selected && selected.payload.findings.length === 0 ? <p className="stp-workspace__empty">No findings reported.</p> : null}
          </section>
          <section className="stp-workspace__panel">
            <h3>Evidence gaps</h3>
            {(selected?.payload.gaps ?? []).map((gap, index) => <p key={`${gap.source}-${index}`}>{gap.source}: {gap.code}</p>)}
            {selected && selected.payload.gaps.length === 0 ? <p className="stp-workspace__empty">No evidence gaps reported.</p> : null}
          </section>
          <section className="stp-workspace__panel stp-workspace__inspector">
            <h3>Device inspector</h3>
            {inspectedDevice ? (
              <div data-testid="stp-device-inspector">
                <div className="stp-inspector__heading"><strong>{inspectedDevice.deviceId}</strong><span>{inspectedDevice.platform}</span></div>
                <p className="stp-inspector__role">{scope.roleFor(inspectedDevice.deviceId)}</p>
                <div className="stp-inspector__facts">
                  <p><span>Root port</span> {inspectedInstance?.rootPort ?? "Not reported"}</p>
                  <p><span>Bridge priority</span> {inspectedInstance?.bridgePriority ?? "Not reported"}</p>
                  <p><span>Root priority</span> {inspectedInstance?.rootPriority ?? "Not reported"}</p>
                  <p><span>Root cost</span> {inspectedInstance?.rootCost ?? "Not reported"}</p>
                  <p><span>MST region</span> {inspectedInstance?.mstRegion ?? "Not reported"}</p>
                </div>
                <h4>Relevant ports</h4>
                {inspectedPorts.length > 0 ? (
                  <ul className="stp-inspector__ports">
                    {inspectedPorts.map((port) => (
                      <li key={`${port.deviceId}-${port.interface}`}>
                        <strong>{port.interface}</strong>
                        <span>{port.role ?? "Role not reported"} · {port.state ?? "State not reported"}</span>
                        <span>Cost {port.cost ?? "Not reported"}{port.bundleId ? ` · ${port.bundleId}` : ""}</span>
                        {port.explicitEvidence ? <span className="stp-inspector__explicit">{port.explicitEvidence}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="stp-workspace__empty">No port evidence for this device.</p>}
              </div>
            ) : <p className="stp-workspace__empty">Select a device to inspect its evidence.</p>}
          </section>
        </aside>
      </div>
    </section>
  );
}

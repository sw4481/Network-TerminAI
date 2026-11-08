/**
 * Plan 13 Phase 4 Task 4.2 — Topology inspector panel.
 *
 * Slides in from the right when a node is selected on the canvas.
 * Surfaces vendor/platform/mgmt_ip metadata, all edges that touch the
 * node grouped by protocol, and an "Open SSH"/"Open NETCONF" button
 * gated on recorded `device_kind`. Inventory is resolved again when opening;
 * discovery metadata is not proof of current reachability.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CaptureEvidence, TopologyEdge, TopologyNode } from "../../lib/topology";
import { TopologyMap } from "../../lib/topologyMap";
import "./TopologyInspector.css";

export interface TopologyInspectorProps {
  node: TopologyNode;
  edges: TopologyEdge[];
  captureEvidence?: CaptureEvidence[];
  onClose: () => void;
  onOpenSsh: () => void | Promise<void>;
  onOpenNetconf: () => void | Promise<void>;
  onOpenUnknown?: () => void | Promise<void>;
  onFocus?: () => void;
  opening?: boolean;
  openError?: string | null;
}

function portsFor(
  edge: TopologyEdge,
  anchor: string,
): { local: string; neighbor: string; otherRef: string } | null {
  if (edge.a_device_ref === anchor) {
    return {
      local: edge.a_port,
      neighbor: edge.b_port,
      otherRef: edge.b_device_ref,
    };
  }
  if (edge.b_device_ref === anchor) {
    return {
      local: edge.b_port,
      neighbor: edge.a_port,
      otherRef: edge.a_device_ref,
    };
  }
  return null;
}

export function TopologyInspector({
  node,
  edges,
  captureEvidence = [],
  onClose,
  onOpenSsh,
  onOpenNetconf,
  onOpenUnknown,
  onFocus,
  opening = false,
  openError,
}: TopologyInspectorProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const edgesByProtocol = useMemo(() => {
    const m = new Map<string, TopologyEdge[]>();
    for (const e of edges) {
      const arr = m.get(e.protocol) ?? [];
      arr.push(e);
      m.set(e.protocol, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [edges]);

  const vendorKey = (node.vendor ?? "unknown").toLowerCase();
  const logicalRouting = node.device_ref.startsWith("routing:");
  const sourceEvidence = captureEvidence.filter((capture) => capture.source_ref === node.device_ref);
  const captureTime = (seconds: number) => <time dateTime={TopologyMap.capturedLabel(seconds) === "Capture time unknown" ? undefined : new Date(seconds * 1000).toISOString()}>{TopologyMap.capturedLabel(seconds)}</time>;

  const handleCopyMgmt = async () => {
    if (!node.mgmt_ip) return;
    try {
      await navigator.clipboard.writeText(node.mgmt_ip);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1200);
    } catch (err) {
      console.warn("[topology] clipboard write failed:", err);
    }
  };

  return (
    <aside
      className="topology-inspector"
      data-testid="topology-inspector"
      aria-label={`Inspector for ${node.label}`}
    >
      <header className="topology-inspector__header">
        <span
          className="topology-inspector__vendor-badge"
          data-vendor={vendorKey}
          aria-label={`vendor: ${vendorKey}`}
        >
          {vendorKey}
        </span>
        <span className="topology-inspector__title">{node.label}</span>
        <button
          type="button"
          className="topology-inspector__close"
          onClick={onClose}
          ref={closeRef}
          aria-label="Close inspector"
          data-testid="topology-inspector-close"
        >
          ×
        </button>
      </header>

      <section className="topology-inspector__details">
        <dl>
          <dt>Reachability</dt><dd>Reachability unverified</dd>
          <dt>Connection</dt>
          <dd data-testid="topology-inspector-kind">{node.device_kind}</dd>
          <dt>Management IP</dt>
          <dd>
            {node.mgmt_ip ? (
              <button
                type="button"
                className="topology-inspector__copy"
                onClick={handleCopyMgmt}
                title="Copy mgmt IP to clipboard"
                data-testid="topology-inspector-mgmt-copy"
              >
                <span>{node.mgmt_ip}</span>
                <span className="topology-inspector__copy-state">
                  {copyState === "copied" ? "✓ copied" : "📋"}
                </span>
              </button>
            ) : (
              <span className="topology-inspector__placeholder">—</span>
            )}
          </dd>
          <dt>Platform</dt>
          <dd>
            {node.platform ?? (
              <span className="topology-inspector__placeholder">—</span>
            )}
          </dd>
        </dl>
      </section>

      <div className="topology-inspector__scroll">
      <section className="topology-inspector__neighbors" aria-label="Collected evidence">
        <h3 className="topology-inspector__section-title">Collected from {node.label}</h3>
        <p>Collection source: {node.device_ref}. Endpoint order does not establish collection direction. No address-to-interface proof or physical attachment is established.</p>
        {sourceEvidence.length === 0 && <p>No collection evidence recorded from this node.</p>}
        {sourceEvidence.map((capture, captureIndex) => <details className="topology-inspector__protocol-group" key={JSON.stringify([capture.protocol, capture.source_command, captureIndex])}>
          <summary>
            <span className="topology-inspector__protocol-title">{capture.protocol}</span>
            <span>Capture attempt: {capture.status} · {capture.observations.length} observations{capture.snmp_observations?.length ? ` · ${capture.snmp_observations.length} SNMP rows` : ""}</span>
            {capture.status !== "completed" ? <span>Any retained evidence historical/unconfirmed</span> : (capture.observations.some((row) => !row.in_latest_capture) || capture.snmp_observations?.some((row) => row.in_latest_attempt === false)) && <span>Includes historical/unconfirmed evidence</span>}
          </summary>
          <code>{capture.source_command}</code>
          <p>Attempted: {captureTime(capture.attempted_at)}</p>
          {capture.observations.length === 0 && !capture.snmp_observations?.length && <p>No retained observations.</p>}
          {!!capture.snmp_observations?.length && <details>
            <summary>SNMP table provenance ({capture.snmp_observations.length})</summary>
            <p>Table indexes and advertised identifiers are evidence, not management reachability or physical attachment proof. Unresolved rows do not create graph links.</p>
            <ul className="topology-inspector__edges">{capture.snmp_observations.map((row, index) => <li className="topology-inspector__edge" key={index}>
              <details>
              <summary>
                <strong>{row.neighbor_name || "Unknown neighbor"}</strong>
                <span>{row.in_latest_attempt === true ? "Returned in latest attempt — table evidence only" : row.in_latest_attempt === false ? "Retained from earlier attempt — historical/unconfirmed" : "Attempt ownership unknown"}</span>
              </summary>
              {row.captured_at ? <p>{captureTime(row.captured_at)}</p> : null}
              <p>Table index: {row.index.join(".")} · Local ifIndex: {row.local_ifindex ?? "Unresolved"}</p>
              <p>Local identifier: {row.local_port_id || "Unknown"} · {row.local_port_description || "No description"}</p>
              <p>Remote identifier: {row.remote_port_id || "Unknown"} · Subtype: {row.remote_port_subtype ?? "Unknown"} · {row.remote_port_description || "No description"}</p>
              <p>Local mapping: {row.mapping ?? "Unresolved"} · Resolution: {row.reason ?? "Resolved; reachability unverified"}</p>
              {row.management_addresses.map((address, i) => <p key={i}>Advertised management: {address} · Index: {row.management_indexes[i]?.join(".") ?? "Unknown"}</p>)}
              </details>
            </li>)}</ul>
          </details>}
          <ul className="topology-inspector__edges">{capture.observations.map((observation, index) => {
            const record = observation.record;
            const routingProtocol = ["bgp", "ospf", "isis", "eigrp"].includes(record.protocol);
            const routing = record.routing;
            return <li className="topology-inspector__edge" key={index}>
              <details>
              <summary>
                <strong>{record.neighbor_name}</strong> · {record.protocol}
                <span>{capture.status !== "completed" ? "Historical/unconfirmed — latest capture not completed" : observation.in_latest_capture ? "Observed in latest capture — reachability unverified" : "Not observed in latest capture — historical/unconfirmed"}</span>
              </summary>
              <p>Last seen: {captureTime(observation.captured_at)}</p>
              <p>Reported local interface (not physical attachment): {TopologyMap.portLabel(record.protocol, record.local_port)}</p>
              <p>Reported neighbor interface: {TopologyMap.portLabel(record.protocol, record.neighbor_port)}</p>
              {routingProtocol || routing ? <>
                <p>Logical routing observation — not physical attachment.</p>
                {routing ? <>
                  <p>Routing state: {routing.state || "Unknown"} · Established: {routing.established ? "yes" : "no"}</p>
                  <p>Peer address (not management): {routing.peer_address ?? "Unknown"}</p>
                  <p>VRF: {routing.vrf ?? "Unknown"} · Address family: {routing.address_family ?? "Unknown"}</p>
                  <p>Instance: {routing.instance ?? "Unknown"} · Level: {routing.level ?? "Unknown"}</p>
                  <p>Scope supported: {routing.scope_supported ? "yes" : "no — scope unconfirmed"}</p>
                  {routing.interface_association ? <>
                    <p>Subnet-supported interface: {routing.interface_association.interface} · Local address: {routing.interface_association.local_address}/{routing.interface_association.prefix_length}</p>
                    <p>Address evidence: {routing.interface_association.source_command}. Same subnet only — direct session and physical attachment unverified.</p>
                  </> : <p>Subnet-supported interface: Unknown — missing or ambiguous address evidence.</p>}
                </> : <p>Routing state/scope unknown.</p>}
              </> : <p>Reported management IP (reachability unverified): {record.neighbor_mgmt_ip ?? "Unknown"}</p>}
              {(record.neighbor_platform || record.neighbor_vendor) && <p>{record.neighbor_vendor} {record.neighbor_platform}</p>}
              </details>
            </li>;
          })}</ul>
        </details>)}
      </section>

      <section className="topology-inspector__neighbors">
        <h3 className="topology-inspector__section-title">Neighbors</h3>
        {edgesByProtocol.length === 0 ? (
          <p className="topology-inspector__placeholder">
            No edges touch this node.
          </p>
        ) : (
          edgesByProtocol.map(([protocol, group]) => (
            <details
              key={protocol}
              className="topology-inspector__protocol-group"
              data-protocol={protocol}
            >
              <summary><span className="topology-inspector__protocol-title">{protocol} ({group.length})</span></summary>
              <ul className="topology-inspector__edges">
                {group.map((edge, index) => {
                  const ports = portsFor(edge, node.device_ref);
                  if (!ports) return null;
                  return (
                    <li
                      key={JSON.stringify([edge.graph_id, edge.a_device_ref, edge.a_port, edge.b_device_ref, edge.b_port, edge.protocol, index])}
                      className="topology-inspector__edge"
                    >
                      <details>
                      <summary>
                        <code>{protocol}</code> · {TopologyMap.portLabel(protocol, ports.local)} ↔{" "}
                        <strong>{ports.otherRef}</strong>:{TopologyMap.portLabel(protocol, ports.neighbor)}
                      </summary>
                      <div>{TopologyMap.evidenceLabel(protocol)}</div>
                      <div>Source/freshness not recorded on this graph edge.</div>
                      {["bgp", "ospf", "isis", "eigrp"].includes(protocol) && <div>Routing state/scope unknown on this graph edge — logical observation, not physical attachment.</div>}
                      <time dateTime={TopologyMap.capturedLabel(edge.captured_at) === "Capture time unknown" ? undefined : new Date(edge.captured_at * 1000).toISOString()}>{TopologyMap.capturedLabel(edge.captured_at)}</time>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </details>
          ))
        )}
      </section>

      </div>

      <footer className="topology-inspector__actions">
        {openError && <p role="alert">{openError}</p>}
        {opening && <p role="status">Opening saved device…</p>}
        {onFocus && <button type="button" className="topology-inspector__action" onClick={onFocus}>Focus neighborhood</button>}
        {logicalRouting && <p className="topology-inspector__hint">Logical routing identifier — not a management target</p>}
        {!logicalRouting && node.device_kind === "ssh" && (
          <button
            type="button"
            className="topology-inspector__action"
            onClick={onOpenSsh}
            disabled={opening}
            data-testid="topology-inspector-open-ssh"
          >
            Open SSH
          </button>
        )}
        {!logicalRouting && node.device_kind === "netconf" && (
          <button
            type="button"
            className="topology-inspector__action"
            onClick={onOpenNetconf}
            disabled={opening}
            data-testid="topology-inspector-open-netconf"
          >
            Open NETCONF
          </button>
        )}
        {!logicalRouting && node.device_kind === "discovered" && (
          <>
            <p className="topology-inspector__hint">Discovered observation. Check saved inventory or save this neighbor before opening.</p>
            {onOpenUnknown && <button type="button" className="topology-inspector__action" disabled={opening} onClick={onOpenUnknown}>Open or save neighbor</button>}
          </>
        )}
      </footer>
    </aside>
  );
}

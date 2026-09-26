/**
 * Plan 13 Phase 4 Task 4.2 — Topology inspector panel.
 *
 * Slides in from the right when a node is selected on the canvas.
 * Surfaces vendor/platform/mgmt_ip metadata, all edges that touch the
 * node grouped by protocol, and an "Open SSH"/"Open NETCONF" button
 * gated on `device_kind`. Discovered (not-yet-saved) neighbors get a
 * helper note instead — saving them is handled by SaveNeighborModal
 * via the inline panel flow.
 */
import { useMemo, useState } from "react";
import type { TopologyEdge, TopologyNode } from "../../lib/topology";
import { vendorColor } from "./topologyTheme";
import "./TopologyInspector.css";

export interface TopologyInspectorProps {
  node: TopologyNode;
  edges: TopologyEdge[];
  onClose: () => void;
  onOpenSsh: () => void | Promise<void>;
  onOpenNetconf: () => void | Promise<void>;
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
  onClose,
  onOpenSsh,
  onOpenNetconf,
}: TopologyInspectorProps) {
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
  const color = vendorColor(vendorKey);

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
          style={{ backgroundColor: color }}
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
          aria-label="Close inspector"
          data-testid="topology-inspector-close"
        >
          ×
        </button>
      </header>

      <section className="topology-inspector__details">
        <dl>
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

      <section className="topology-inspector__neighbors">
        <h3 className="topology-inspector__section-title">Neighbors</h3>
        {edgesByProtocol.length === 0 ? (
          <p className="topology-inspector__placeholder">
            No edges touch this node.
          </p>
        ) : (
          edgesByProtocol.map(([protocol, group]) => (
            <div
              key={protocol}
              className="topology-inspector__protocol-group"
              data-protocol={protocol}
            >
              <h4 className="topology-inspector__protocol-title">{protocol}</h4>
              <ul className="topology-inspector__edges">
                {group.map((edge) => {
                  const ports = portsFor(edge, node.device_ref);
                  if (!ports) return null;
                  return (
                    <li
                      key={`${edge.a_device_ref}::${edge.a_port}--${edge.b_device_ref}::${edge.b_port}::${edge.protocol}`}
                      className="topology-inspector__edge"
                    >
                      <code>{protocol}</code> · {ports.local} ↔{" "}
                      <strong>{ports.otherRef}</strong>:{ports.neighbor}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </section>

      <footer className="topology-inspector__actions">
        {node.device_kind === "ssh" && (
          <button
            type="button"
            className="topology-inspector__action"
            onClick={onOpenSsh}
            data-testid="topology-inspector-open-ssh"
          >
            Open SSH
          </button>
        )}
        {node.device_kind === "netconf" && (
          <button
            type="button"
            className="topology-inspector__action"
            onClick={onOpenNetconf}
            data-testid="topology-inspector-open-netconf"
          >
            Open NETCONF
          </button>
        )}
        {node.device_kind === "discovered" && (
          <p className="topology-inspector__hint">
            This neighbor isn't a saved device yet. Save it (from the inline
            panel) to enable click-to-SSH.
          </p>
        )}
      </footer>
    </aside>
  );
}

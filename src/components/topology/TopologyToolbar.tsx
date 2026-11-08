import { useState, type ReactNode } from "react";
import { GLOBAL_GRAPH_ID } from "../../lib/topology";
import { useTopologyStore } from "../../state/topologyStore";
import "./TopologyToolbar.css";

export interface TopologyToolbarProps {
  onRefresh: () => void;
  onDiscoverDevices: () => void;
  onClearGraph: () => void;
  onArrange?: () => void;
  onArrangeConnected?: () => void;
  onResetLayout?: () => void;
  discovering?: boolean;
  children?: ReactNode;
}

const INTERVAL_OPTIONS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: "off" },
  { value: 30_000, label: "30s" },
  { value: 60_000, label: "1m" },
  { value: 300_000, label: "5m" },
  { value: 900_000, label: "15m" },
];

export function TopologyToolbar({
  onRefresh, onDiscoverDevices, onClearGraph, onArrange, onArrangeConnected,
  onResetLayout, discovering = false, children,
}: TopologyToolbarProps) {
  const graphs = useTopologyStore((s) => s.graphs);
  const currentGraphId = useTopologyStore((s) => s.currentGraphId);
  const selectGraph = useTopologyStore((s) => s.selectGraph);
  const createGraph = useTopologyStore((s) => s.createGraph);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const graphOptions = [{ id: GLOBAL_GRAPH_ID, name: "Global" }, ...graphs.filter((graph) => graph.id !== GLOBAL_GRAPH_ID)];
  if (!graphOptions.some((graph) => graph.id === currentGraphId)) graphOptions.push({ id: currentGraphId, name: currentGraphId });
  const autoRefreshIntervalMs = useTopologyStore((s) => s.autoRefreshIntervalMs);
  const setAutoRefreshInterval = useTopologyStore((s) => s.setAutoRefreshInterval);

  return (
    <div className="topology-toolbar" data-testid="topology-toolbar" role="toolbar" aria-label="Topology toolbar">
      <div className="topology-toolbar__group" role="group" aria-label="Graph selection">
        <label className="topology-toolbar__interval">
          <span className="topology-toolbar__label">Graph</span>
          <select className="topology-toolbar__select" value={currentGraphId} onChange={(event) => { void selectGraph(event.target.value); }}>
            {graphOptions.map((graph) => <option key={graph.id} value={graph.id}>{graph.name}</option>)}
          </select>
        </label>
      </div>
      <div className="topology-toolbar__group" role="group" aria-label="Discovery and refresh">
        <button type="button" className="topology-toolbar__button topology-toolbar__primary" onClick={onDiscoverDevices} disabled={discovering}
          title="Collect neighbors from saved Cisco IOS / IOS-XE connections" aria-label="Discover devices" data-testid="topology-toolbar-discover">
          <span aria-hidden="true">⌁</span> Discover devices
        </button>
        <button type="button" className="topology-toolbar__button" onClick={onRefresh} title="Refresh topology" aria-label="Refresh topology" data-testid="topology-toolbar-refresh">
          <span aria-hidden="true">↻</span> Refresh
        </button>
      </div>
      {children}
      <details className="topology-toolbar__tools" onKeyDown={(event) => {
        if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
      }} onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}>
        <summary className="topology-toolbar__button">Graph tools</summary>
        <div className="topology-toolbar__panel" role="group" aria-label="Graph output and cleanup">
          <form className="topology-toolbar__create" onSubmit={async (event) => {
            event.preventDefault();
            if (!name.trim() || creating) return;
            setCreating(true); setCreateError(null);
            try { await createGraph(name.trim()); setName(""); }
            catch (error) { setCreateError(`Graph not created: ${String(error)}`); }
            finally { setCreating(false); }
          }}>
            <label className="topology-toolbar__label">New graph
              <input className="topology-toolbar__select" aria-label="Graph name" placeholder="New graph name" maxLength={200} value={name} disabled={creating} onChange={(event) => setName(event.target.value)} />
            </label>
            <button className="topology-toolbar__button" type="submit" disabled={creating || !name.trim()}>Create graph</button>
          </form>
          <div className="topology-toolbar__group topology-toolbar__layout" role="group" aria-label="Layout">
            <button type="button" className="topology-toolbar__button" onClick={onArrange} title="Simple radial or vendor-grid arrangement">Arrange</button>
            <button type="button" className="topology-toolbar__button" onClick={onArrangeConnected} title="Arrange all devices by recorded connectivity, including disconnected components">Arrange connected</button>
            <button type="button" className="topology-toolbar__button" onClick={onResetLayout}>Reset layout</button>
          </div>
          <div className="topology-toolbar__group topology-toolbar__maintenance">
            <label className="topology-toolbar__interval"><span className="topology-toolbar__label">Auto-refresh</span>
              <select className="topology-toolbar__select" data-testid="topology-toolbar-auto-refresh" value={autoRefreshIntervalMs === null ? "off" : String(autoRefreshIntervalMs)} onChange={(e) => setAutoRefreshInterval(e.target.value === "off" ? null : Number(e.target.value))}>
                {INTERVAL_OPTIONS.map((opt) => <option key={opt.label} value={opt.value === null ? "off" : String(opt.value)}>{opt.label}</option>)}
              </select>
            </label>
            <button type="button" className="topology-toolbar__button topology-toolbar__danger" onClick={onClearGraph} title="Clear all nodes and edges in the current graph" aria-label="Clear graph" data-testid="topology-toolbar-clear">× Clear graph</button>
          </div>
        </div>
      </details>
      {createError && <span role="alert" className="topology-toolbar__error">{createError}</span>}
    </div>
  );
}

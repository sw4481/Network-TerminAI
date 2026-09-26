/**
 * Plan 13 Phase 4 Task 4.2 — Topology toolbar.
 *
 * Houses the actions that operate on the whole topology graph:
 *  - Refresh (re-pulls the snapshot from the store).
 *  - Auto-refresh interval dropdown (off / 30s / 1m / 5m / 15m). Phase 4
 *    only stores the preference; Phase 5.1 wires the actual setInterval.
 *  - Export PNG (best-effort; v12 doesn't expose a built-in helper, so
 *    Phase 4 just logs and surfaces the deferral).
 *  - Clear graph (destructive; the parent owns the confirm + dispatch).
 */
import { useTopologyStore } from "../../state/topologyStore";
import "./TopologyToolbar.css";

export interface TopologyToolbarProps {
  onRefresh: () => void;
  onDiscoverDevices: () => void;
  onExportPng: () => void;
  onClearGraph: () => void;
}

const INTERVAL_OPTIONS: ReadonlyArray<{
  value: number | null;
  label: string;
}> = [
  { value: null, label: "off" },
  { value: 30_000, label: "30s" },
  { value: 60_000, label: "1m" },
  { value: 300_000, label: "5m" },
  { value: 900_000, label: "15m" },
];

export function TopologyToolbar({
  onRefresh,
  onDiscoverDevices,
  onExportPng,
  onClearGraph,
}: TopologyToolbarProps) {
  const autoRefreshIntervalMs = useTopologyStore((s) => s.autoRefreshIntervalMs);
  const setAutoRefreshInterval = useTopologyStore(
    (s) => s.setAutoRefreshInterval,
  );

  return (
    <div
      className="topology-toolbar"
      data-testid="topology-toolbar"
      role="toolbar"
      aria-label="Topology toolbar"
    >
      <div
        className="topology-toolbar__group topology-toolbar__group--primary"
        role="group"
        aria-label="Discovery and refresh"
      >
        <button
          type="button"
          className="topology-toolbar__button topology-toolbar__primary"
          onClick={onDiscoverDevices}
          title="Automatically discover devices from saved connections"
          aria-label="Discover devices"
          data-testid="topology-toolbar-discover"
        >
          <span aria-hidden="true">⌁</span>
          Discover devices
        </button>
        <button
          type="button"
          className="topology-toolbar__button"
          onClick={onRefresh}
          title="Refresh topology"
          aria-label="Refresh topology"
          data-testid="topology-toolbar-refresh"
        >
          <span aria-hidden="true">↻</span>
          Refresh
        </button>
        <label className="topology-toolbar__interval">
          <span className="topology-toolbar__label">Auto-refresh</span>
          <select
            className="topology-toolbar__select"
            data-testid="topology-toolbar-auto-refresh"
            value={autoRefreshIntervalMs === null ? "off" : String(autoRefreshIntervalMs)}
            onChange={(e) => {
              const raw = e.target.value;
              setAutoRefreshInterval(raw === "off" ? null : Number(raw));
            }}
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option
                key={opt.label}
                value={opt.value === null ? "off" : String(opt.value)}
              >
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        className="topology-toolbar__group topology-toolbar__group--secondary"
        role="group"
        aria-label="Graph output and cleanup"
      >
        <button
          type="button"
          className="topology-toolbar__button"
          onClick={onExportPng}
          title="Export topology as PNG"
          aria-label="Export PNG"
          data-testid="topology-toolbar-export"
        >
          <span aria-hidden="true">⇩</span>
          Export PNG
        </button>
        <button
          type="button"
          className="topology-toolbar__button topology-toolbar__danger"
          onClick={onClearGraph}
          title="Clear all nodes and edges in the current graph"
          aria-label="Clear graph"
          data-testid="topology-toolbar-clear"
        >
          <span aria-hidden="true">×</span>
          Clear graph
        </button>
      </div>
    </div>
  );
}

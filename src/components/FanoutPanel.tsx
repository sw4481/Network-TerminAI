import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFanoutStore } from "../state/fanoutStore";
import { useFanoutRunsStore } from "../state/fanoutRunsStore";
import type { DeviceRunState } from "../state/fanoutRunsStore";
import { useFanoutEvents } from "../hooks/useFanoutEvents";
import {
  detectOutliers,
  type Outlier,
  type OutlierRow,
} from "../lib/fanoutOutliers";
import {
  fanoutRunGet,
  fanoutRunList,
  type FanoutRunSummary,
} from "../lib/fanout";
import "./FanoutPanel.css";

type DeviceMap = Record<string, DeviceRunState>;

function formatTime(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function progressForStatus(status: DeviceRunState["status"]): number | undefined {
  if (status === "pending") return 0;
  if (status === "running") return undefined;
  return 100;
}

export function FanoutPanel() {
  useFanoutEvents();
  const { groups, refreshGroups } = useFanoutStore();
  const { activeRunsById, selectedRunId, selectedTab, selectRun, selectTab } =
    useFanoutRunsStore();

  const [groupId, setGroupId] = useState<string>("");
  const [command, setCommand] = useState<string>("show version");
  const [timeoutMs, setTimeoutMs] = useState<number>(30000);
  const [history, setHistory] = useState<FanoutRunSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshGroups();
    fanoutRunList(50).then(setHistory).catch(() => {});
  }, [refreshGroups]);

  const run = selectedRunId ? activeRunsById[selectedRunId] : null;
  const devices: DeviceMap = run?.devices ?? {};
  const deviceList = useMemo(
    () =>
      Object.values(devices).sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      ),
    [devices],
  );

  // Build outlier rows from the per-device blocks. We don't yet have parsed
  // output streamed live — placeholder is empty; once the parser hook fires,
  // outliers will populate in subsequent renders.
  const outliers: Outlier[] = useMemo(() => {
    const rows: OutlierRow[] = deviceList
      .filter((d) => d.parsedOutputId)
      .map((d) => ({
        deviceKey: `${d.deviceKind}:${d.deviceId}`,
        columns: { device: d.displayName },
      }));
    if (rows.length < 3) return [];
    return detectOutliers(rows, { keyColumn: "device" });
  }, [deviceList]);

  const handleRun = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!groupId) throw new Error("Select a group");
      const runId = await invoke<string>("fanout_run_start", {
        command,
        groupId,
        memberOverrides: null,
        timeoutMs,
        concurrency: 50,
      });
      selectRun(runId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCancelAll = async () => {
    if (!selectedRunId) return;
    await invoke("fanout_run_cancel", { runId: selectedRunId }).catch(() => {});
  };

  const handleCancelDevice = async (d: DeviceRunState) => {
    if (!selectedRunId) return;
    await invoke("fanout_device_cancel", {
      runId: selectedRunId,
      deviceId: d.deviceId,
      deviceKind: d.deviceKind,
    }).catch(() => {});
  };

  const handleRetryDevice = async (d: DeviceRunState) => {
    if (!selectedRunId) return;
    await invoke("fanout_device_retry", {
      runId: selectedRunId,
      deviceId: d.deviceId,
      deviceKind: d.deviceKind,
    }).catch((e) => setError(String(e)));
  };

  const handleRetryAllFailed = async () => {
    if (!selectedRunId) return;
    for (const d of deviceList) {
      if (d.status === "failed" || d.status === "timeout") {
        await handleRetryDevice(d);
      }
    }
  };

  const handleHistoryOpen = async (runId: string) => {
    try {
      const detail = await fanoutRunGet(runId);
      // Materialize a synthetic ActiveRun so the panel renders the historical run.
      useFanoutRunsStore.setState((state) => ({
        activeRunsById: {
          ...state.activeRunsById,
          [runId]: {
            runId,
            command: detail.summary.command,
            groupId: detail.summary.group_id,
            startedAt: detail.summary.started_at * 1000,
            endedAt: detail.summary.ended_at
              ? detail.summary.ended_at * 1000
              : undefined,
            status:
              (detail.summary.status as any) === "running"
                ? "running"
                : (detail.summary.status as any),
            totalDevices: detail.devices.length,
            devices: Object.fromEntries(
              detail.devices.map((d) => [
                `${d.device_kind}:${d.device_id}`,
                {
                  deviceId: d.device_id,
                  deviceKind: d.device_kind,
                  displayName: d.display_name,
                  status: d.status,
                  attempt: d.attempt_number,
                  progressBytes: 0,
                  durationMs:
                    d.ended_at && d.started_at
                      ? (d.ended_at - d.started_at) * 1000
                      : undefined,
                  errorMessage: d.error ?? undefined,
                  blockId: d.block_id ?? undefined,
                  parsedOutputId: d.parsed_output_id ?? undefined,
                },
              ]),
            ),
          },
        },
        selectedRunId: runId,
        selectedTab: "merged",
      }));
    } catch (e) {
      setError(String(e));
    }
  };

  const handleExportZip = async () => {
    if (!selectedRunId) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: `fanout-${selectedRunId}.zip`,
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (!path) return;
    try {
      await invoke<void>("fanout_run_export_zip", {
        runId: selectedRunId,
        destPath: path,
      });
    } catch (e) {
      setError(String(e));
    }
  };

  const focusDevice = (deviceKey: string) => selectTab(deviceKey);

  return (
    <div className="fanout-panel" data-testid="fanout-panel">
      <div className="fanout-command-bar">
        <select
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          data-testid="fanout-group-select"
        >
          <option value="">— Select Group —</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.member_count})
            </option>
          ))}
        </select>
        <input
          className="command-input"
          placeholder="show ip int br"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          data-testid="fanout-command"
        />
        <input
          className="timeout-input"
          type="number"
          value={timeoutMs}
          onChange={(e) => setTimeoutMs(parseInt(e.target.value, 10))}
          title="Per-device timeout (ms)"
          data-testid="fanout-timeout"
        />
        <button
          onClick={handleRun}
          disabled={busy || !groupId || !command.trim()}
          data-testid="fanout-run"
        >
          Run
        </button>
        {selectedRunId && run?.status === "running" && (
          <button className="danger" onClick={handleCancelAll}>
            Cancel All
          </button>
        )}
        {selectedRunId && run?.status !== "running" && (
          <>
            <button onClick={handleRetryAllFailed}>Retry Failed</button>
            <button onClick={handleExportZip}>Export Zip</button>
          </>
        )}
      </div>

      {error && (
        <div
          style={{
            background: "var(--surface-2)",
            color: "var(--text-primary)",
            padding: "6px 12px",
            fontSize: 11,
          }}
        >
          {error}
        </div>
      )}

      {outliers.length > 0 && (
        <div className="fanout-outlier-banner">
          {outliers.length} outlier{outliers.length === 1 ? "" : "s"} detected:{" "}
          {outliers.slice(0, 3).map((o) => (
            <button
              key={`${o.deviceKey}:${o.column}`}
              onClick={() => focusDevice(o.deviceKey)}
            >
              {o.deviceKey} {o.column}={o.value} (vs {o.majorityValue})
            </button>
          ))}
        </div>
      )}

      {selectedRunId && (
        <>
          <div className="fanout-progress-lane">
            {deviceList.map((d) => (
              <div
                key={`${d.deviceKind}:${d.deviceId}`}
                className="fanout-progress-row"
                data-testid={`fanout-row-${d.deviceKind}-${d.deviceId}`}
              >
                <span className={`fanout-status-chip ${d.status}`}>
                  {d.status}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {d.displayName}
                </span>
                <div
                  className={`fanout-progress-bar ${d.status}`}
                  role="progressbar"
                  aria-label={`${d.displayName} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressForStatus(d.status)}
                  aria-valuetext={d.status}
                >
                  <div />
                </div>
                <span style={{ color: "var(--text-secondary)" }}>
                  {formatTime(d.durationMs)}
                </span>
                <div className="fanout-row-actions">
                  {d.status === "running" || d.status === "pending" ? (
                    <button
                      title="Cancel"
                      onClick={() => handleCancelDevice(d)}
                    >
                      ×
                    </button>
                  ) : null}
                  {(d.status === "failed" ||
                    d.status === "timeout" ||
                    d.status === "cancelled") && (
                    <button title="Retry" onClick={() => handleRetryDevice(d)}>
                      ↻
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="fanout-tabs">
            <div
              className={`fanout-tab ${selectedTab === "merged" ? "active" : ""}`}
              onClick={() => selectTab("merged")}
              data-testid="fanout-tab-merged"
            >
              Merged
            </div>
            {deviceList.map((d) => {
              const k = `${d.deviceKind}:${d.deviceId}`;
              return (
                <div
                  key={k}
                  className={`fanout-tab ${selectedTab === k ? "active" : ""}`}
                  onClick={() => selectTab(k)}
                  data-testid={`fanout-tab-${d.deviceKind}-${d.deviceId}`}
                >
                  {d.displayName}
                  {d.status !== "success" && (
                    <span
                      className={`fanout-status-chip ${d.status}`}
                      style={{ marginLeft: 6 }}
                    >
                      {d.status}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="fanout-main">
            {selectedTab === "merged" ? (
              <MergedView devices={deviceList} />
            ) : (
              <DeviceRawView
                blockId={devices[selectedTab]?.blockId ?? null}
                onError={setError}
              />
            )}
          </div>
        </>
      )}

      <div className="fanout-history">
        <div className="fanout-history-header">Recent runs</div>
        {history.map((h) => (
          <div
            key={h.id}
            className="fanout-history-row"
            onClick={() => handleHistoryOpen(h.id)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {h.command}
            </span>
            <span className={`fanout-status-chip ${h.status}`}>{h.status}</span>
            <span style={{ color: "var(--text-secondary)" }}>
              {h.succeeded}/{h.total}
            </span>
            <span style={{ color: "var(--text-secondary)" }}>
              {new Date(h.started_at * 1000).toLocaleTimeString()}
            </span>
          </div>
        ))}
        {history.length === 0 && (
          <div className="fanout-history-row" style={{ color: "var(--text-secondary)" }}>
            No previous runs
          </div>
        )}
      </div>
    </div>
  );
}

function MergedView({ devices }: { devices: DeviceRunState[] }) {
  const succeeded = devices.filter((d) => d.status === "success");
  if (succeeded.length === 0) {
    return (
      <div style={{ color: "var(--text-secondary)" }}>
        Waiting for device output. Each device's parsed result will appear here
        as a column once the run completes.
      </div>
    );
  }
  // Show a count summary + per-device status overview. Real per-column merged
  // diff lights up when parsed_outputs are populated by the parser hook.
  return (
    <table className="fanout-merged-table">
      <thead>
        <tr>
          <th>device</th>
          <th>status</th>
          <th>duration</th>
          <th>block</th>
          <th>parsed</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => (
          <tr key={`${d.deviceKind}:${d.deviceId}`}>
            <td>{d.displayName}</td>
            <td>
              <span className={`fanout-status-chip ${d.status}`}>
                {d.status}
              </span>
            </td>
            <td>{formatTime(d.durationMs)}</td>
            <td style={{ color: "var(--text-secondary)" }}>
              {d.blockId ? d.blockId.slice(0, 8) : "—"}
            </td>
            <td style={{ color: "var(--text-secondary)" }}>
              {d.parsedOutputId ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DeviceRawView({
  blockId,
  onError,
}: {
  blockId: string | null;
  onError: (s: string) => void;
}) {
  const [raw, setRaw] = useState<string>("(loading…)");
  useEffect(() => {
    if (!blockId) {
      setRaw("(no output yet)");
      return;
    }
    invoke<string>("fanout_block_output_text", { blockId })
      .then(setRaw)
      .catch((e) => {
        onError(String(e));
        setRaw(`(failed: ${String(e)})`);
      });
  }, [blockId, onError]);
  return <pre className="fanout-raw">{raw}</pre>;
}

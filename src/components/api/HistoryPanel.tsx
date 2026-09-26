import { useCallback, useEffect, useState } from "react";
import {
  apiGetHistoryDetail,
  apiListHistory,
  type ApiHistoryRow,
} from "../../lib/tauri";
import {
  applyHistoryDetailToState,
  useApiRunner,
} from "../../state/apiRunnerStore";

type Props = {
  /** Source API tab id — we filter history to this tab only. */
  tabId: string;
  /** Callback fired when the user picks a row; parent usually collapses the panel. */
  onLoad?: (row: ApiHistoryRow) => void;
};

function statusColor(code: number | null): string {
  if (code === null || code === 0) return "var(--status-danger)";
  if (code >= 200 && code < 300) return "var(--status-success)";
  if (code >= 300 && code < 400) return "var(--status-warning)";
  return "var(--status-danger)";
}

function relTime(sec: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/**
 * Recent-requests drawer for a single API tab. Clicking a row rehydrates
 * the builder + response viewer with that attempt so the user can re-fire
 * or tweak it.
 */
export function HistoryPanel({ tabId, onLoad }: Props) {
  const [rows, setRows] = useState<ApiHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = useApiRunner((s) => s.patch);

  const reload = useCallback(() => {
    apiListHistory({ tabId, limit: 100 })
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [tabId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const load = useCallback(
    async (row: ApiHistoryRow) => {
      try {
        const detail = await apiGetHistoryDetail(row.id);
        const cur = useApiRunner.getState().tabs[tabId] ?? useApiRunner
          .getState()
          .ensure(tabId);
        const next = applyHistoryDetailToState(cur, detail);
        patch(tabId, next);
        onLoad?.(row);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [tabId, patch, onLoad],
  );

  return (
    <div
      data-testid="api-history-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderTop: "1px solid var(--border-default)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          color: "var(--text-secondary)",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          background: "var(--surface-2)",
        }}
      >
        <span>History</span>
        <button
          data-testid="api-history-refresh"
          onClick={reload}
          style={{
            background: "transparent",
            color: "var(--accent)",
            border: "none",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          refresh
        </button>
      </div>
      {error && (
        <div
          data-testid="api-history-error"
          style={{ color: "var(--status-danger)", fontSize: 11, padding: 6 }}
        >
          {error}
        </div>
      )}
      <div
        data-testid="api-history-list"
        style={{ overflowY: "auto", maxHeight: 200, fontFamily: "Menlo, monospace" }}
      >
        {rows && rows.length === 0 && (
          <div
            data-testid="api-history-empty"
            style={{ color: "var(--text-muted)", fontSize: 11, padding: 10 }}
          >
            No requests sent yet.
          </div>
        )}
        {(rows ?? []).map((r) => (
          <button
            key={r.id}
            data-testid={`api-history-row-${r.id}`}
            onClick={() => load(r)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "4px 10px",
              background: "transparent",
              border: "none",
              borderBottom: "1px solid var(--surface-2)",
              color: "var(--text-primary)",
              fontFamily: "Menlo, monospace",
              fontSize: 11,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              style={{
                width: 46,
                flexShrink: 0,
                color: "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              {r.method}
            </span>
            <span
              style={{
                width: 36,
                flexShrink: 0,
                color: statusColor(r.status_code),
                fontWeight: 600,
              }}
            >
              {r.status_code === null || r.status_code === 0
                ? "ERR"
                : r.status_code}
            </span>
            <span
              style={{
                flex: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={r.url}
            >
              {r.url}
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
              {relTime(r.sent_at)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

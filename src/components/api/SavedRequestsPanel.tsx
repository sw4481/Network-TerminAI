import { useCallback, useEffect, useState } from "react";
import {
  apiDeleteSavedRequest,
  apiListSavedRequests,
  type ApiSavedRequest,
} from "../../lib/tauri";
import {
  applySavedRequestToState,
  useApiRunner,
} from "../../state/apiRunnerStore";

type Props = {
  tabId: string;
  /** Refresh signal: increment from the parent after save/delete. */
  refreshKey?: number;
  onLoad?: (row: ApiSavedRequest) => void;
};

export function SavedRequestsPanel({ tabId, refreshKey, onLoad }: Props) {
  const [rows, setRows] = useState<ApiSavedRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = useApiRunner((s) => s.patch);

  const reload = useCallback(() => {
    apiListSavedRequests()
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  const load = useCallback(
    (row: ApiSavedRequest) => {
      const cur = useApiRunner.getState().tabs[tabId] ?? useApiRunner
        .getState()
        .ensure(tabId);
      const next = applySavedRequestToState(cur, row);
      patch(tabId, next);
      onLoad?.(row);
    },
    [tabId, patch, onLoad],
  );

  const remove = useCallback(
    async (row: ApiSavedRequest, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await apiDeleteSavedRequest(row.id);
        reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [reload],
  );

  return (
    <div
      data-testid="api-saved-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderTop: "1px solid var(--border-default)",
      }}
    >
      <div
        style={{
          padding: "6px 10px",
          color: "var(--text-secondary)",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          background: "var(--surface-2)",
        }}
      >
        Saved Requests
      </div>
      {error && (
        <div
          data-testid="api-saved-error"
          style={{ color: "var(--status-danger)", fontSize: 11, padding: 6 }}
        >
          {error}
        </div>
      )}
      <div
        data-testid="api-saved-list"
        style={{ overflowY: "auto", maxHeight: 200, fontFamily: "Menlo, monospace" }}
      >
        {rows && rows.length === 0 && (
          <div
            data-testid="api-saved-empty"
            style={{ color: "var(--text-muted)", fontSize: 11, padding: 10 }}
          >
            No saved requests. Click the ★ next to Send to save one.
          </div>
        )}
        {(rows ?? []).map((r) => (
          <div
            key={r.id}
            data-testid={`api-saved-row-${r.id}`}
            onClick={() => load(r)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 10px",
              borderBottom: "1px solid var(--surface-2)",
              cursor: "pointer",
              color: "var(--text-primary)",
              fontSize: 11,
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
            <span style={{ flex: 1, fontWeight: 600 }}>{r.name}</span>
            <span
              style={{
                flex: 2,
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={r.url}
            >
              {r.url}
            </span>
            <button
              data-testid={`api-saved-delete-${r.id}`}
              onClick={(e) => remove(r, e)}
              aria-label={`Delete ${r.name}`}
              style={{
                background: "transparent",
                color: "var(--status-danger)",
                border: "none",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

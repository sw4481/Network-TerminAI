import { useCallback, useEffect, useState } from "react";
import {
  apiCommitPostmanImport,
  apiDeleteSavedRequest,
  apiListSavedRequests,
  apiPreviewPostmanImport,
  type ApiSavedRequest,
  type PostmanImportPreview,
  type PostmanImportResult,
} from "../../lib/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import {
  applySavedRequestToState,
  useApiRunner,
} from "../../state/apiRunnerStore";

type Props = {
  tabId: string;
  /** Refresh signal: increment from the parent after save/delete. */
  refreshKey?: number;
  onLoad?: (row: ApiSavedRequest) => void;
  onImportStart?: () => void;
  onImportComplete?: (result: PostmanImportResult) => void;
};

export function SavedRequestsPanel({
  tabId,
  refreshKey,
  onLoad,
  onImportStart,
  onImportComplete,
}: Props) {
  const [rows, setRows] = useState<ApiSavedRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PostmanImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<PostmanImportResult | null>(null);
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

  const choosePostmanCollection = useCallback(async () => {
    onImportStart?.();
    setError(null);
    setImportResult(null);
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Postman Collection", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    setImportPath(null);
    setPreview(null);
    setImporting(true);
    try {
      const safePreview = await apiPreviewPostmanImport(selected);
      setImportPath(selected);
      setPreview(safePreview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  }, [onImportStart]);

  const commitPostmanCollection = useCallback(async () => {
    if (!importPath || !preview) return;
    setImporting(true);
    setError(null);
    try {
      const result = await apiCommitPostmanImport(importPath, preview.fingerprint);
      setImportResult(result);
      setImportPath(null);
      setPreview(null);
      reload();
      onImportComplete?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  }, [importPath, preview, reload, onImportComplete]);

  const groupedRows = (rows ?? []).reduce<Array<{
    key: string;
    label: string;
    folders: Array<{ path: string; rows: ApiSavedRequest[] }>;
  }>>((groups, row) => {
    const key = row.collection_id ?? "native";
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = {
        key,
        label: row.collection_id ? (row.collection_name ?? "Imported collection") : "TerminAI saved requests",
        folders: [],
      };
      groups.push(group);
    }
    const path = row.folder_path || "";
    let folder = group.folders.find((candidate) => candidate.path === path);
    if (!folder) {
      folder = { path, rows: [] };
      group.folders.push(folder);
    }
    folder.rows.push(row);
    return groups;
  }, []);
  const secretVariableCount = preview?.variable_keys.reduce(
    (count, variable) => count + (variable.is_secret ? 1 : 0),
    0,
  ) ?? 0;

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
        <span>Saved Requests</span>
        <button
          type="button"
          onClick={() => void choosePostmanCollection()}
          disabled={importing}
          style={{ marginLeft: 10, fontSize: 11 }}
        >
          {importing && !preview ? "Reading…" : "Import Postman…"}
        </button>
      </div>
      {error && (
        <div
          data-testid="api-saved-error"
          style={{ color: "var(--status-danger)", fontSize: 11, padding: 6 }}
        >
          {error}
        </div>
      )}
      {importResult && (
        <div data-testid="postman-import-success" style={{ color: "var(--status-success)", fontSize: 11, padding: 6 }}>
          Imported {importResult.imported_count} request{importResult.imported_count === 1 ? "" : "s"} into {importResult.collection_name} ({importResult.environment}).
        </div>
      )}
      {preview && (
        <div
          data-testid="postman-import-preview"
          style={{
            padding: 10,
            borderBottom: "1px solid var(--border-default)",
            fontSize: 11,
            maxHeight: "min(320px, 42vh)",
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          <strong>{preview.collection_name}</strong>
          <div>{preview.request_count} supported requests · {preview.folder_count} folders · {preview.variable_keys.length} environment keys</div>
          <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
            Preview only — nothing has been imported yet.
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button type="button" disabled={importing || preview.request_count === 0} onClick={() => void commitPostmanCollection()}>{importing ? "Importing…" : "Import"}</button>
            <button type="button" disabled={importing} onClick={() => { setPreview(null); setImportPath(null); }}>Cancel</button>
          </div>
          {preview.variable_keys.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary>{preview.variable_keys.length} environment keys · {secretVariableCount} marked secret</summary>
              <div style={{ maxHeight: 120, overflowY: "auto", padding: "4px 0 0 14px", overflowWrap: "anywhere" }}>
                {preview.variable_keys.map((variable) => (
                  <div key={variable.key}>{variable.key}{variable.is_secret ? " (secret)" : ""}</div>
                ))}
              </div>
            </details>
          )}
          {preview.skipped_items.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary>{preview.skipped_items.length} skipped item{preview.skipped_items.length === 1 ? "" : "s"}</summary>
              <ul>{preview.skipped_items.map((item, index) => <li key={`${item.path}-${index}`}>{item.path}: {item.reason}</li>)}</ul>
            </details>
          )}
          {preview.warnings.length > 0 && (
            <ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          )}
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
        {groupedRows.flatMap((group) => [
          <div key={`group-${group.key}`} data-testid={`api-saved-group-${group.key}`} style={{ padding: "5px 10px", color: "var(--text-secondary)", fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>
            {group.label}
          </div>,
          ...group.folders.flatMap((folder) => [
            folder.path ? <div key={`folder-${group.key}-${folder.path}`} style={{ padding: "3px 18px", color: "var(--text-muted)", fontSize: 10 }}>▾ {folder.path}</div> : null,
            ...folder.rows.map((r) => (
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
            <span style={{ flex: 1, fontWeight: 600 }}>{r.display_name || r.name}</span>
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
              aria-label={`Delete ${r.display_name || r.name}`}
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
            )),
          ]),
        ])}
      </div>
    </div>
  );
}

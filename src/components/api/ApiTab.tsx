import { useCallback, useEffect, useState } from "react";
import type { Tab } from "../../lib/types";
import {
  apiGetTarget,
  apiImportOpenApi,
  apiSaveRequest,
  apiSendRequest,
  type ApiEndpoint,
  type ApiTargetDetail,
} from "../../lib/tauri";
import {
  applyEndpointToState,
  isSendable,
  stateRequiredKeys,
  stateToRequest,
  stateToSavedJson,
  useApiRunner,
} from "../../state/apiRunnerStore";
import { CUSTOM_TARGET_ID, TargetPicker } from "./TargetPicker";
import { EndpointPicker } from "./EndpointPicker";
import { EnvironmentPicker, NO_ENVIRONMENT } from "./EnvironmentPicker";
import { CredentialsPanel } from "./CredentialsPanel";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { HistoryPanel } from "./HistoryPanel";
import { SavedRequestsPanel } from "./SavedRequestsPanel";
import { CommandPalette } from "./CommandPalette";

type Drawer = "closed" | "history" | "saved";

export function ApiTab({ tab }: { tab: Tab }) {
  const ensure = useApiRunner((s) => s.ensure);
  const state = useApiRunner((s) => s.tabs[tab.id]) ?? ensure(tab.id);
  const patch = useApiRunner((s) => s.patch);
  const setSending = useApiRunner((s) => s.setSending);
  const setResponse = useApiRunner((s) => s.setResponse);
  const setError = useApiRunner((s) => s.setError);

  const [targetId, setTargetId] = useState<string>(CUSTOM_TARGET_ID);
  const [targetDetail, setTargetDetail] = useState<ApiTargetDetail | null>(null);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [targetErr, setTargetErr] = useState<string | null>(null);

  const [environment, setEnvironment] = useState<string>(NO_ENVIRONMENT);
  const [credentialsOpen, setCredentialsOpen] = useState(false);

  const [drawer, setDrawer] = useState<Drawer>("closed");
  const [savedRefreshKey, setSavedRefreshKey] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Cmd/Ctrl-K opens the palette. We listen at the window level so pressing
  // the shortcut anywhere inside the tab opens it — even from a focused
  // input, which fires keydown before the input intercepts it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (targetId === CUSTOM_TARGET_ID) {
      setTargetDetail(null);
      setEndpointId(null);
      setTargetErr(null);
      return;
    }
    let cancelled = false;
    apiGetTarget(targetId)
      .then((detail) => {
        if (cancelled) return;
        setTargetDetail(detail);
        setTargetErr(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setTargetDetail(null);
        setTargetErr(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [targetId]);

  const onImportOpenApi = useCallback(async () => {
    if (!targetDetail?.manifest.openapi_url) return;
    setImporting(true);
    setImportStatus(null);
    try {
      const endpoints = await apiImportOpenApi(
        targetDetail.manifest.openapi_url,
      );
      // Merge imported endpoints into the current detail; de-dupe by id.
      const byId = new Map<string, ApiEndpoint>();
      for (const e of targetDetail.endpoints) byId.set(e.id, e);
      for (const e of endpoints) byId.set(e.id, e);
      setTargetDetail({
        ...targetDetail,
        endpoints: Array.from(byId.values()),
      });
      setImportStatus(`Imported ${endpoints.length} endpoints`);
    } catch (err) {
      setImportStatus(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImporting(false);
    }
  }, [targetDetail]);

  const onSelectEndpoint = useCallback(
    (endpoint: ApiEndpoint | null) => {
      if (!endpoint || !targetDetail) return;
      setEndpointId(endpoint.id);
      const cur = useApiRunner.getState().tabs[tab.id] ?? ensure(tab.id);
      const next = applyEndpointToState(cur, targetDetail.manifest, endpoint);
      patch(tab.id, next);
    },
    [targetDetail, patch, tab.id, ensure],
  );

  const onSend = useCallback(async () => {
    if (!isSendable(state)) return;
    const req = stateToRequest(state);
    setSending(tab.id, true);
    setError(tab.id, null);
    try {
      const resp = await apiSendRequest({
        tabId: tab.id,
        targetId: targetId === CUSTOM_TARGET_ID ? null : targetId,
        environment: environment || null,
        request: req,
      });
      setResponse(tab.id, resp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(tab.id, msg);
      setResponse(tab.id, null);
    } finally {
      setSending(tab.id, false);
    }
  }, [state, tab.id, targetId, environment, setSending, setResponse, setError]);

  const commitSave = useCallback(async () => {
    const name = saveName.trim();
    if (!name) return;
    try {
      const { headersJson, queryJson } = stateToSavedJson(state);
      await apiSaveRequest({
        name,
        targetId: targetId === CUSTOM_TARGET_ID ? null : targetId,
        environment: environment || null,
        method: state.method,
        url: state.url.trim(),
        headersJson,
        queryJson,
        bodyKind: state.body_kind,
        bodyText:
          state.body_kind === "none" || state.body_kind === "binary"
            ? null
            : state.body_text,
      });
      setSavePromptOpen(false);
      setSaveName("");
      setSaveErr(null);
      setSavedRefreshKey((k) => k + 1);
      setDrawer("saved");
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    }
  }, [saveName, state, targetId, environment]);

  return (
    <div
      className="api-tab"
      data-testid="api-tab"
      data-tab-id={tab.id}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #262a33",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <TargetPicker value={targetId} onChange={setTargetId} />
          {targetDetail?.manifest.openapi_url && (
            <button
              data-testid="api-import-openapi"
              onClick={onImportOpenApi}
              disabled={importing}
              title={`Fetch ${targetDetail.manifest.openapi_url}`}
              style={{
                background: "transparent",
                color: importing ? "#6c7380" : "#5ccfe6",
                border: "1px dashed #262a33",
                borderRadius: 4,
                padding: "2px 10px",
                cursor: importing ? "wait" : "pointer",
                fontSize: 12,
              }}
            >
              {importing ? "importing…" : "import OpenAPI"}
            </button>
          )}
          <EnvironmentPicker
            value={environment}
            onChange={setEnvironment}
            onOpenCredentials={() => setCredentialsOpen(true)}
          />
          <div style={{ flex: 1 }} />
          <DrawerToggle drawer={drawer} setDrawer={setDrawer} />
        </div>
        {importStatus && (
          <div
            data-testid="api-import-status"
            style={{
              color: importStatus.startsWith("Import failed")
                ? "#f28779"
                : "#6bd968",
              fontSize: 11,
            }}
          >
            {importStatus}
          </div>
        )}
        {targetErr && (
          <div
            data-testid="api-target-detail-error"
            style={{ color: "#f28779", fontSize: 11 }}
          >
            {targetErr}
          </div>
        )}
        {targetDetail && targetDetail.endpoints.length > 0 && (
          <EndpointPicker
            endpoints={targetDetail.endpoints}
            value={endpointId}
            onChange={onSelectEndpoint}
          />
        )}
      </div>
      <RequestBuilder
        tabId={tab.id}
        onSend={onSend}
        onSaveRequest={() => {
          setSaveName("");
          setSaveErr(null);
          setSavePromptOpen(true);
        }}
      />
      <div
        style={{
          borderTop: "1px solid #262a33",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ResponseViewer
          response={state.response}
          tabId={tab.id}
          requestMethod={state.method}
          requestUrl={state.url}
        />
      </div>
      {drawer === "history" && (
        <HistoryPanel tabId={tab.id} onLoad={() => setDrawer("closed")} />
      )}
      {drawer === "saved" && (
        <SavedRequestsPanel
          tabId={tab.id}
          refreshKey={savedRefreshKey}
          onLoad={() => setDrawer("closed")}
        />
      )}
      {credentialsOpen && environment && (
        <CredentialsPanel
          environment={environment}
          onClose={() => setCredentialsOpen(false)}
          // Scan the tab's current state (URL, headers, query, body, auth)
          // for BOTH ${env:X} AND ${var:X} placeholders — path params
          // rewritten via rewritePathParams() land as ${var:...}.
          requiredKeys={stateRequiredKeys(state)}
          // Auto-select the matching Quick Setup preset for the active
          // target so the user's first action is "fill in labeled fields".
          targetId={targetId === CUSTOM_TARGET_ID ? null : targetId}
        />
      )}
      {savePromptOpen && (
        <SavePrompt
          name={saveName}
          error={saveErr}
          onChange={setSaveName}
          onCommit={commitSave}
          onClose={() => setSavePromptOpen(false)}
        />
      )}
      <CommandPalette
        tabId={tab.id}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}

function DrawerToggle({
  drawer,
  setDrawer,
}: {
  drawer: Drawer;
  setDrawer: (d: Drawer) => void;
}) {
  const btn = (key: Drawer, label: string) => (
    <button
      data-testid={`api-drawer-${key}`}
      onClick={() => setDrawer(drawer === key ? "closed" : key)}
      style={{
        background: drawer === key ? "#262a33" : "transparent",
        color: drawer === key ? "#e6e1cf" : "#8a8d94",
        border: "1px solid #262a33",
        borderRadius: 4,
        padding: "2px 10px",
        cursor: "pointer",
        fontSize: 12,
        marginLeft: 4,
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 0 }}>
      {btn("history", "History")}
      {btn("saved", "Saved")}
    </div>
  );
}

function SavePrompt({
  name,
  error,
  onChange,
  onCommit,
  onClose,
}: {
  name: string;
  error: string | null;
  onChange: (s: string) => void;
  onCommit: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="api-save-prompt"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 25,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#14161a",
          border: "1px solid #262a33",
          borderRadius: 6,
          padding: 14,
          width: 420,
          maxWidth: "90vw",
          color: "#e6e1cf",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 600 }}>Save request as…</div>
        <input
          data-testid="api-save-name"
          autoFocus
          value={name}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit();
            if (e.key === "Escape") onClose();
          }}
          placeholder="list-prod-orgs"
          style={{
            background: "#0f1114",
            color: "#e6e1cf",
            border: "1px solid #262a33",
            borderRadius: 4,
            padding: "6px 10px",
            fontFamily: "Menlo, monospace",
            fontSize: 13,
          }}
        />
        {error && (
          <div
            data-testid="api-save-error"
            style={{ color: "#f28779", fontSize: 11 }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button
            data-testid="api-save-cancel"
            onClick={onClose}
            style={{
              background: "transparent",
              color: "#8a8d94",
              border: "1px solid #262a33",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            data-testid="api-save-commit"
            onClick={onCommit}
            disabled={!name.trim()}
            style={{
              background: name.trim() ? "#2d5a8c" : "#262a33",
              color: "#e6e1cf",
              border: "none",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: name.trim() ? "pointer" : "not-allowed",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { apiExplainResponse, type ApiResponse, type HttpMethod } from "../../lib/tauri";
import { ArrayTableView, type TableRow } from "./ArrayTableView";
import { JqFilterBar } from "./JqFilterBar";
import { applyFilter } from "./jsonFilter";
import { PipeMenu, type PipeTarget } from "./PipeMenu";
import { prettyFormat } from "./prettyFormat";

/** Decode base64 → UTF-8 for display. Non-UTF-8 bytes are replaced with �. */
function decodeBody(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "<invalid base64>";
  }
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function statusColor(code: number): string {
  if (code === 0) return "var(--status-danger)";
  if (code >= 200 && code < 300) return "var(--status-success)";
  if (code >= 300 && code < 400) return "var(--status-warning)";
  return "var(--status-danger)";
}

export function ResponseViewer({
  response,
  tabId,
  /**
   * Request method + URL — used by the "Explain" button's LLM prompt so
   * the model knows what was asked, not just the response body.
   */
  requestMethod,
  requestUrl,
}: {
  response: ApiResponse | null;
  /**
   * Source tab id — needed so the pipe-to-AI action targets THIS tab's
   * chat. `undefined` disables the pipe menu (useful in standalone stories).
   */
  tabId?: string;
  requestMethod?: HttpMethod;
  requestUrl?: string;
}) {
  const [tab, setTab] = useState<
    "body" | "pretty" | "table" | "headers" | "explain"
  >("body");
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<PipeTarget | null>(null);
  // Plain-English summary of the current response. Per-response state —
  // swapping responses blanks it out.
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  // When response changes, reset the explain state so we don't show a
  // stale summary next to a fresh response.
  useEffect(() => {
    setExplanation(null);
    setExplainError(null);
    setExplaining(false);
  }, [response]);

  // Decode + parse once per response change.
  const bodyText = useMemo(
    () => (response ? decodeBody(response.body) : ""),
    [response],
  );
  const parsed = useMemo(() => {
    if (!response) return { ok: false as const, value: null };
    if (!bodyText.trim()) return { ok: false as const, value: null };
    try {
      return { ok: true as const, value: JSON.parse(bodyText) };
    } catch {
      return { ok: false as const, value: null };
    }
  }, [response, bodyText]);

  // Apply the JSONPath filter (or passthrough) to the parsed JSON.
  const filtered = useMemo(() => {
    if (!parsed.ok) return null;
    return applyFilter(filter, parsed.value);
  }, [parsed, filter]);

  const displayValue: unknown = filtered?.kind === "ok" ? filtered.value : parsed.value;
  const filterError = filtered?.kind === "error" ? filtered.message : null;

  const prettyBody = useMemo(() => {
    if (!parsed.ok) return bodyText;
    return pretty(displayValue);
  }, [parsed, displayValue, bodyText]);

  // YAML-ish "human-readable" rendering. Only meaningful when the body
  // parsed as JSON; for plain text we fall back to the raw body.
  const prettyText = useMemo(() => {
    if (!parsed.ok) return bodyText;
    return prettyFormat(displayValue);
  }, [parsed, displayValue, bodyText]);

  const arrayRows: unknown[] = useMemo(() => {
    if (Array.isArray(displayValue)) return displayValue as unknown[];
    return [];
  }, [displayValue]);

  const showTableTab = arrayRows.length > 0;
  const showPrettyTab = parsed.ok;

  if (!response) {
    return (
      <div
        data-testid="api-response-empty"
        style={{
          padding: 20,
          color: "var(--text-muted)",
          fontSize: 12,
          textAlign: "center",
        }}
      >
        Send a request to see the response.
      </div>
    );
  }

  const isNetErr = response.status_code === 0;

  const openMenu = (
    value: unknown,
    label: string | undefined,
    e: { clientX: number; clientY: number },
  ) => {
    if (!tabId) return;
    setMenu({
      sourceTabId: tabId,
      value,
      label,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const runExplain = async () => {
    if (!response || explaining) return;
    setExplaining(true);
    setExplainError(null);
    setTab("explain");
    try {
      const summary = await apiExplainResponse({
        method: requestMethod ?? "GET",
        url: requestUrl ?? response.final_url,
        statusCode: response.status_code,
        // Use the already-decoded + optionally-filtered body so the LLM
        // sees exactly what the user is looking at.
        body: prettyBody,
      });
      setExplanation(summary);
    } catch (err) {
      setExplainError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setExplaining(false);
    }
  };

  return (
    <div
      data-testid="api-response"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 12,
        minHeight: 0,
        flex: 1,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          fontFamily: "Menlo, monospace",
          fontSize: 12,
        }}
      >
        <span
          data-testid="api-response-status"
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            background: "var(--surface-2)",
            color: statusColor(response.status_code),
            fontWeight: 600,
          }}
        >
          {isNetErr ? "ERR" : `${response.status_code} ${response.status_text}`}
        </span>
        <span style={{ color: "var(--text-secondary)" }}>{response.duration_ms} ms</span>
        <span style={{ color: "var(--text-secondary)" }}>
          {humanSize(Math.ceil((response.body.length * 3) / 4))}
        </span>
        {response.body_truncated && (
          <span style={{ color: "var(--status-warning)" }} data-testid="api-body-truncated">
            truncated
          </span>
        )}
        <div style={{ flex: 1 }} />
        {/* Plain-English summary. Primary action when you open a response
            and the body is a wall of JSON you don't feel like parsing. */}
        <button
          data-testid="api-response-explain"
          onClick={runExplain}
          disabled={explaining || !parsed.ok}
          title={
            parsed.ok
              ? "Ask the AI to summarize this response in plain English"
              : "Only JSON responses can be summarized"
          }
          style={{
            background:
              explaining || !parsed.ok ? "var(--surface-selected)" : "var(--accent-subtle)",
            color: "var(--text-primary)",
            border: "none",
            borderRadius: 4,
            padding: "3px 10px",
            cursor: explaining || !parsed.ok ? "not-allowed" : "pointer",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {explaining ? "Explaining…" : "✨ Explain"}
        </button>
      </div>

      {response.error && (
        <div
          data-testid="api-response-error"
          style={{
            color: "var(--status-danger)",
            background: "var(--surface-2)",
            border: "1px solid var(--status-danger)",
            borderRadius: 4,
            padding: 8,
            fontFamily: "Menlo, monospace",
            fontSize: 12,
          }}
        >
          {response.error}
        </div>
      )}

      {parsed.ok && (
        <JqFilterBar value={filter} onChange={setFilter} error={filterError} />
      )}

      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border-default)" }}>
        {(
          [
            "body",
            // Pretty view: zero-cost YAML-ish render of the parsed JSON.
            // Sits right after Body so a non-devops user's eye lands
            // on it immediately.
            ...(showPrettyTab ? (["pretty"] as const) : []),
            ...(showTableTab ? (["table"] as const) : []),
            "headers",
            // Only surface the Explain tab once we have something to show —
            // either a fresh result, an error, or an in-flight request.
            ...(explanation !== null || explaining || explainError
              ? (["explain"] as const)
              : []),
          ] as const
        ).map((k) => (
          <button
            key={k}
            data-testid={`api-response-tab-${k}`}
            onClick={() => setTab(k)}
            style={{
              background: tab === k ? "var(--surface-3)" : "transparent",
              color: tab === k ? "var(--text-primary)" : "var(--text-secondary)",
              border: "none",
              borderBottom:
                tab === k ? "2px solid var(--accent)" : "2px solid transparent",
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 12,
              textTransform: "capitalize",
            }}
          >
            {k === "explain" ? "✨ Explain" : k}
          </button>
        ))}
      </div>

      {tab === "body" && (
        <pre
          data-testid="api-response-body"
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(displayValue ?? bodyText, "body", e);
          }}
          style={{
            margin: 0,
            padding: 10,
            background: "var(--app-canvas)",
            color: "var(--text-primary)",
            borderRadius: 4,
            flex: 1,
            overflow: "auto",
            fontFamily: "Menlo, monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {prettyBody || (
            <span style={{ color: "var(--text-muted)" }}>(empty body)</span>
          )}
        </pre>
      )}
      {tab === "pretty" && (
        <pre
          data-testid="api-response-pretty"
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(displayValue ?? bodyText, "body", e);
          }}
          style={{
            margin: 0,
            padding: 10,
            background: "var(--app-canvas)",
            // Use the system font here, not Menlo — the pretty view is
            // meant to read like a document, not code.
            color: "var(--text-primary)",
            borderRadius: 4,
            flex: 1,
            overflow: "auto",
            fontFamily: "-apple-system, system-ui, sans-serif",
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: "pre",
            wordBreak: "normal",
          }}
        >
          {prettyText || (
            <span style={{ color: "var(--text-muted)" }}>(empty body)</span>
          )}
        </pre>
      )}
      {tab === "table" && (
        <ArrayTableView
          rows={arrayRows}
          onCellContext={(value, column, row: TableRow) => {
            const label = column;
            // Use center of screen as a fallback position when we don't
            // have a MouseEvent handy — the cell handler uses
            // onContextMenu directly, so this fallback path is only
            // reached in tests.
            const x =
              typeof window !== "undefined" ? window.innerWidth / 2 : 100;
            const y =
              typeof window !== "undefined" ? window.innerHeight / 2 : 100;
            // Prefer the full row when the value is scalar + we have a
            // row — lets "Copy as CSV" produce one meaningful line.
            const payload =
              value !== null && typeof value === "object" ? value : { [label]: value };
            void row; // row retained for future "copy whole row" action
            openMenu(payload, label, { clientX: x, clientY: y });
          }}
        />
      )}
      {tab === "headers" && (
        <div
          data-testid="api-response-headers"
          style={{
            padding: 10,
            background: "var(--app-canvas)",
            borderRadius: 4,
            flex: 1,
            overflow: "auto",
            fontFamily: "Menlo, monospace",
            fontSize: 12,
          }}
        >
          {Object.entries(response.headers).length === 0 && (
            <span style={{ color: "var(--text-muted)" }}>(no headers)</span>
          )}
          {Object.entries(response.headers).map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 8 }}>
              <span style={{ color: "var(--accent)" }}>{k}:</span>
              <span style={{ color: "var(--text-primary)", wordBreak: "break-all" }}>
                {v}
              </span>
            </div>
          ))}
        </div>
      )}
      {tab === "explain" && (
        <div
          data-testid="api-response-explain-pane"
          style={{
            padding: 12,
            background: "var(--app-canvas)",
            borderRadius: 4,
            flex: 1,
            overflow: "auto",
            fontFamily: "-apple-system, system-ui, sans-serif",
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {explaining && (
            <div style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>
              Asking the AI to summarize…
            </div>
          )}
          {explainError && !explaining && (
            <div
              data-testid="api-response-explain-error"
              style={{
                color: "var(--status-danger)",
                border: "1px solid var(--status-danger)",
                background: "var(--surface-2)",
                borderRadius: 4,
                padding: 8,
                fontFamily: "Menlo, monospace",
                fontSize: 12,
              }}
            >
              {explainError}
            </div>
          )}
          {!explaining && !explainError && explanation && (
            <div data-testid="api-response-explain-text">{explanation}</div>
          )}
          {!explaining && !explainError && !explanation && (
            <div style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>
              Click ✨ Explain in the header row to generate a plain-English
              summary of this response.
            </div>
          )}
        </div>
      )}

      <PipeMenu target={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

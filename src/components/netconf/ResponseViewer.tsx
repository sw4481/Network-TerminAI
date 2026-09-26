import { useState } from "react";
import type { NetconfTabState } from "../../state/netconfRunnerStore";
import { formatXml } from "../../state/netconfRunnerStore";
import { netconfExplainResponse } from "../../lib/tauri";
import { PipeMenu, type PipeTarget } from "../api/PipeMenu";

type Props = {
  tabId: string;
  state: NetconfTabState;
};

type ViewMode = "formatted" | "raw";

export function ResponseViewer({ tabId, state }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("formatted");
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [menu, setMenu] = useState<PipeTarget | null>(null);

  const hasResponse = state.response !== null;
  const displayContent = hasResponse && state.response
    ? viewMode === "formatted"
      ? formatXml(state.response)
      : state.response
    : "";

  const copyToClipboard = () => {
    if (state.response) {
      navigator.clipboard.writeText(state.response);
    }
  };

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

  const handleExplain = async () => {
    if (!state.response) return;
    setExplaining(true);
    setExplanation(null);
    try {
      // Extract operation from rpc_xml (simple heuristic)
      const operationMatch = state.rpc_xml.match(/<([a-z-]+)[>\s]/);
      const operation = operationMatch ? operationMatch[1] : "unknown";
      const result = await netconfExplainResponse(operation, state.response);
      setExplanation(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExplanation(`Error: ${msg}`);
    } finally {
      setExplaining(false);
    }
  };

  return (
    <div
      data-testid="netconf-response-viewer"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
          Response
        </div>
        <div style={{ flex: 1 }} />
        {hasResponse && (
          <>
            <button
              data-testid="netconf-view-formatted"
              onClick={() => setViewMode("formatted")}
              style={{
                background: viewMode === "formatted" ? "var(--surface-3)" : "transparent",
                color: viewMode === "formatted" ? "var(--text-primary)" : "var(--text-secondary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Formatted
            </button>
            <button
              data-testid="netconf-view-raw"
              onClick={() => setViewMode("raw")}
              style={{
                background: viewMode === "raw" ? "var(--surface-3)" : "transparent",
                color: viewMode === "raw" ? "var(--text-primary)" : "var(--text-secondary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Raw
            </button>
            <button
              data-testid="netconf-copy-response"
              onClick={copyToClipboard}
              style={{
                background: "transparent",
                color: "var(--accent)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Copy
            </button>
            <button
              data-testid="netconf-explain-response"
              onClick={handleExplain}
              disabled={explaining}
              style={{
                background: "var(--accent-subtle)",
                color: "var(--text-primary)",
                border: "none",
                borderRadius: 4,
                padding: "3px 10px",
                cursor: explaining ? "wait" : "pointer",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {explaining ? "Explaining..." : "Explain"}
            </button>
          </>
        )}
      </div>

      {/* Response content */}
      <div
        data-testid="netconf-response-content"
        onContextMenu={(e) => {
          e.preventDefault();
          if (state.response) {
            openMenu(state.response, "NETCONF Response", e);
          }
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          background: "var(--app-canvas)",
          padding: hasResponse ? 12 : 0,
          fontFamily: "Menlo, monospace",
          fontSize: 12,
          color: "var(--text-primary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {hasResponse ? (
          displayContent
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            No response yet
          </div>
        )}
      </div>

      {/* AI Explanation */}
      {explanation && (
        <div
          data-testid="netconf-explanation"
          style={{
            borderTop: "1px solid var(--border-default)",
            background: "var(--surface-2)",
            padding: 12,
            maxHeight: "30%",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--accent)",
              marginBottom: 8,
            }}
          >
            AI Explanation
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-primary)",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {explanation}
          </div>
        </div>
      )}

      {/* Pipe Menu */}
      <PipeMenu target={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

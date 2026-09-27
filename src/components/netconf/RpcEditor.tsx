import { useState, useEffect } from "react";
import type { NetconfTabState } from "../../state/netconfRunnerStore";
import { isSendable, useNetconfRunner } from "../../state/netconfRunnerStore";
import { netconfWrapCli } from "../../lib/tauri";

type Props = {
  tabId: string;
  state: NetconfTabState;
  onSend: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  savedRpcsOpen: boolean;
  onToggleSavedRpcs: () => void;
};

export function RpcEditor({
  tabId,
  state,
  onSend,
  historyOpen,
  onToggleHistory,
  savedRpcsOpen,
  onToggleSavedRpcs,
}: Props) {
  const patch = useNetconfRunner((s) => s.patch);
  const canSend = isSendable(state);
  const [previewXml, setPreviewXml] = useState<string | null>(null);

  const insertExample = (xml: string) => {
    patch(tabId, { rpc_xml: xml });
  };

  const handlePreview = async () => {
    if (state.editor_mode === "cli" && state.rpc_xml.trim()) {
      try {
        const wrapped = await netconfWrapCli(state.cli_platform, state.rpc_xml.trim());
        setPreviewXml(wrapped);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        alert(`Preview error: ${msg}`);
      }
    }
  };

  // Clear preview when switching modes or editing
  useEffect(() => {
    setPreviewXml(null);
  }, [state.editor_mode, state.rpc_xml]);

  return (
    <div
      data-testid="netconf-rpc-editor"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 200,
        maxHeight: "50%",
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
          RPC Editor
        </div>

        {/* Mode toggle */}
        <div style={{ display: "flex", gap: 4 }}>
          <button
            data-testid="netconf-mode-xml"
            onClick={() => patch(tabId, { editor_mode: "xml" })}
            style={{
              background: state.editor_mode === "xml" ? "var(--surface-3)" : "transparent",
              color: state.editor_mode === "xml" ? "var(--text-primary)" : "var(--text-secondary)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            XML
          </button>
          <button
            data-testid="netconf-mode-cli"
            onClick={() => patch(tabId, { editor_mode: "cli" })}
            style={{
              background: state.editor_mode === "cli" ? "var(--surface-3)" : "transparent",
              color: state.editor_mode === "cli" ? "var(--text-primary)" : "var(--text-secondary)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            CLI
          </button>
        </div>

        {/* Platform selector (only shown in CLI mode) */}
        {state.editor_mode === "cli" && (
          <select
            data-testid="netconf-cli-platform"
            value={state.cli_platform}
            onChange={(e) =>
              patch(tabId, { cli_platform: e.target.value as "iosxe" | "nxos" })
            }
            style={{
              background: "var(--app-canvas)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "2px 6px",
              fontSize: 11,
              fontFamily: "Menlo, monospace",
            }}
          >
            <option value="iosxe">IOS-XE</option>
            <option value="nxos">NX-OS</option>
          </select>
        )}

        <div style={{ flex: 1 }} />

        {/* Example buttons */}
        {state.editor_mode === "xml" && (
          <button
            data-testid="netconf-example-get-config"
            onClick={() =>
              insertExample(`<get-config>
  <source>
    <running/>
  </source>
</get-config>`)
            }
            style={{
              background: "transparent",
              color: "var(--accent)",
              border: "1px dashed var(--border-default)",
              borderRadius: 4,
              padding: "3px 8px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            Example: get-config
          </button>
        )}

        {state.editor_mode === "cli" && (
          <>
            <button
              data-testid="netconf-example-cli"
              onClick={() => insertExample("show version")}
              style={{
                background: "transparent",
                color: "var(--accent)",
                border: "1px dashed var(--border-default)",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Example: show version
            </button>
            <button
              data-testid="netconf-preview-xml"
              onClick={handlePreview}
              disabled={!state.rpc_xml.trim()}
              style={{
                background: "transparent",
                color: state.rpc_xml.trim() ? "var(--accent)" : "var(--text-muted)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: state.rpc_xml.trim() ? "pointer" : "not-allowed",
                fontSize: 11,
              }}
            >
              Preview XML
            </button>
          </>
        )}

        <button
          data-testid="netconf-saved-rpcs-toggle"
          onClick={onToggleSavedRpcs}
          style={{
            background: savedRpcsOpen ? "var(--surface-3)" : "transparent",
            color: savedRpcsOpen ? "var(--text-primary)" : "var(--text-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          Saved
        </button>

        <button
          data-testid="netconf-history-toggle"
          onClick={onToggleHistory}
          style={{
            background: historyOpen ? "var(--surface-3)" : "transparent",
            color: historyOpen ? "var(--text-primary)" : "var(--text-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          History
        </button>

        <button
          data-testid="netconf-send-rpc"
          onClick={onSend}
          disabled={!canSend}
          style={{
            background: canSend ? "var(--accent-subtle)" : "var(--surface-3)",
            color: canSend ? "var(--text-primary)" : "var(--text-muted)",
            border: "none",
            borderRadius: 4,
            padding: "6px 14px",
            cursor: canSend ? "pointer" : "not-allowed",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {state.sending ? "Sending..." : "Send"}
        </button>
      </div>

      {/* CLI mode help banner */}
      {state.editor_mode === "cli" && (
        <div
          style={{
            padding: "6px 12px",
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            fontSize: 11,
            fontFamily: "Menlo, monospace",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ color: "var(--text-primary)" }}>ℹ️</span>
          <span>
            Enter <strong>configuration</strong> CLI — auto-wrapped via Cisco-IOS-XE-cli-rpc on Send.
            Show/exec commands aren't supported over NETCONF; use SSH for those.
          </span>
        </div>
      )}

      {/* Editor */}
      <textarea
        data-testid="netconf-rpc-textarea"
        value={state.rpc_xml}
        onChange={(e) => patch(tabId, { rpc_xml: e.target.value })}
        placeholder={
          state.editor_mode === "xml"
            ? "<get-config>...</get-config>"
            : "interface Loopback99\ndescription test"
        }
        disabled={state.status !== "connected"}
        style={{
          flex: 1,
          background: "var(--app-canvas)",
          color: "var(--text-primary)",
          border: "none",
          padding: 12,
          fontFamily: "Menlo, monospace",
          fontSize: 12,
          resize: "none",
          outline: "none",
        }}
      />

      {/* RPC error banner */}
      {state.rpc_error && (
        <div
          data-testid="netconf-rpc-error"
          style={{
            padding: "8px 12px",
            background: "var(--surface-2)",
            borderTop: "1px solid var(--border-default)",
            color: "var(--status-danger)",
            fontSize: 11,
            fontFamily: "Menlo, monospace",
          }}
        >
          {state.rpc_error}
        </div>
      )}

      {/* XML Preview Modal */}
      {previewXml && (
        <div
          data-testid="netconf-preview-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgb(var(--backdrop-rgb) / 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setPreviewXml(null)}
        >
          <div
            style={{
              background: "var(--app-canvas)",
              border: "1px solid var(--border-default)",
              borderRadius: 8,
              width: "80%",
              maxWidth: 800,
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-default)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                NETCONF XML Preview
              </div>
              <button
                onClick={() => setPreviewXml(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 16,
                  padding: "0 4px",
                }}
              >
                ✕
              </button>
            </div>
            <div
              style={{
                flex: 1,
                overflow: "auto",
                padding: 16,
              }}
            >
              <pre
                style={{
                  margin: 0,
                  color: "var(--text-primary)",
                  fontSize: 12,
                  fontFamily: "Menlo, monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {previewXml}
              </pre>
            </div>
            <div
              style={{
                padding: "12px 16px",
                borderTop: "1px solid var(--border-default)",
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <button
                onClick={() => {
                  navigator.clipboard.writeText(previewXml);
                }}
                style={{
                  background: "transparent",
                  color: "var(--accent)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Copy to Clipboard
              </button>
              <button
                onClick={() => setPreviewXml(null)}
                style={{
                  background: "var(--accent-subtle)",
                  color: "var(--text-primary)",
                  border: "none",
                  borderRadius: 4,
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

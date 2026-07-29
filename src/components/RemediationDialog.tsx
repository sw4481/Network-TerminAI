import { Suspense, lazy, useMemo, useState } from "react";
import type { DriftReport } from "../lib/drift";

const MonacoEditor = lazy(() =>
  import("./editor/MonacoEditor").then((m) => ({ default: m.MonacoEditor })),
);

interface Props {
  report: DriftReport;
  onClose: () => void;
}

/**
 * Generate a config patch that — when applied to the device — would bring it
 * back into alignment with the intent. Insert lines (intent has, device
 * doesn't) become straight config commands; Delete lines (device has,
 * intent doesn't) become `no <command>` directives.
 */
function buildPatch(report: DriftReport): string {
  if (!report.diff_patch) return "";
  const lines: string[] = [];
  for (const block of report.diff_patch.blocks) {
    if (block.block_path !== "<root>") {
      lines.push(`! Block: ${block.block_path}`);
    }
    for (const change of block.changes) {
      switch (change.tag) {
        case "insert":
          lines.push(change.line);
          break;
        case "delete": {
          const trimmed = change.line.trimStart();
          if (trimmed.startsWith("!") || trimmed === "") continue;
          // Indent-preserving "no" prefix
          const indent = change.line.match(/^\s*/)?.[0] ?? "";
          lines.push(`${indent}no ${trimmed}`);
          break;
        }
        case "equal":
          // skip — context only
          break;
      }
    }
  }
  return lines.join("\n");
}

export function RemediationDialog({ report, onClose }: Props) {
  const initialPatch = useMemo(() => buildPatch(report), [report]);
  const [patch, setPatch] = useState(initialPatch);
  const [approved, setApproved] = useState(false);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(900px, 92vw)",
          height: "min(640px, 80vh)",
          background: "#14171c",
          border: "1px solid #262a33",
          borderRadius: 6,
          color: "#e6e1cf",
          fontFamily: "Menlo, monospace",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid="remediation-dialog"
      >
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid #262a33",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            Remediation Patch · {report.device_id}
          </span>
          <span style={{ fontSize: 11, color: "#8a8d94" }}>
            Review before pushing
          </span>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              background: "transparent",
              color: "#8a8d94",
              border: "none",
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, position: "relative" }}>
          <Suspense
            fallback={
              <div style={{ padding: 16, color: "#8a8d94" }}>
                Loading editor…
              </div>
            }
          >
            <MonacoEditor
              value={patch}
              language="plaintext"
              onChange={setPatch}
              readOnly={!approved}
            />
          </Suspense>
        </div>

        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid #262a33",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <label
            style={{
              fontSize: 11,
              color: "#e6e1cf",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              data-testid="remediation-approve"
            />
            I have reviewed this patch and understand it will be applied as-is.
          </label>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => navigator.clipboard.writeText(patch)}
            style={{
              background: "#1a1d22",
              color: "#e6e1cf",
              border: "1px solid #262a33",
              borderRadius: 4,
              padding: "6px 12px",
              fontFamily: "inherit",
              fontSize: 11,
              cursor: "pointer",
            }}
            data-testid="remediation-copy"
          >
            Copy patch
          </button>
          <button
            disabled={!approved}
            style={{
              background: approved ? "#5a2d2d" : "#262a33",
              color: approved ? "#fff" : "#8a8d94",
              border: "none",
              borderRadius: 4,
              padding: "6px 14px",
              fontFamily: "inherit",
              fontSize: 12,
              cursor: approved ? "pointer" : "not-allowed",
            }}
            data-testid="remediation-push"
            onClick={() =>
              alert(
                "Push gating happens in Plan 09 (AI Guardrails). For now this dialog is review-only — copy the patch and apply it manually.",
              )
            }
          >
            Push patch (gated by Plan 09)
          </button>
        </div>
      </div>
    </div>
  );
}

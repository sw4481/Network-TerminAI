import { DiffEditor } from "@monaco-editor/react";
import type { GitDiffPayload } from "../../lib/tauri";
import type { GitDiffStyle } from "./gitPanelState";

export function GitDiffReview({
  path,
  payload,
  style,
  onStyleChange,
  onClose,
}: {
  path: string;
  payload: GitDiffPayload;
  style: GitDiffStyle;
  onStyleChange: (style: GitDiffStyle) => void;
  onClose: () => void;
}) {
  const unavailable = payload.binary || payload.oversized;
  return (
    <section className="git-diff-review" data-testid="git-diff-review">
      <header className="git-diff-review-header">
        <div>
          <strong>{path}</strong>
          <span title={payload.originalLabel}>{payload.originalLabel}</span>
          <span aria-hidden="true">→</span>
          <span title={payload.modifiedLabel}>{payload.modifiedLabel}</span>
        </div>
        <div className="git-diff-review-actions">
          <button
            type="button"
            className={style === "split" ? "active" : ""}
            onClick={() => onStyleChange("split")}
          >
            Split
          </button>
          <button
            type="button"
            className={style === "unified" ? "active" : ""}
            onClick={() => onStyleChange("unified")}
          >
            Unified
          </button>
          <button type="button" onClick={onClose} aria-label="Close Git diff">
            ✕
          </button>
        </div>
      </header>

      {unavailable ? (
        <div className="git-diff-review-unavailable" role="status">
          <strong>
            {payload.binary ? "Binary file" : "File is too large for text diff"}
          </strong>
          <span>
            Original {formatBytes(payload.originalSize)} · Modified{" "}
            {formatBytes(payload.modifiedSize)}
          </span>
          <p>
            TerminAI keeps this review non-text so Monaco does not decode or render
            misleading binary/oversized content.
          </p>
        </div>
      ) : (
        <div className="git-diff-review-editor">
          <DiffEditor
            original={payload.original ?? ""}
            modified={payload.modified ?? ""}
            language={payload.language}
            originalModelPath={`inmemory://terminai-git/original/${encodeURIComponent(path)}`}
            modifiedModelPath={`inmemory://terminai-git/modified/${encodeURIComponent(path)}`}
            theme="ccie-zed-one-dark"
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: style === "split",
              minimap: { enabled: false },
              overviewRulerLanes: 0,
              renderOverviewRuler: false,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        </div>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

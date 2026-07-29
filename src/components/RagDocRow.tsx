/**
 * Plan 12 Phase 3 — Single doc row.
 *
 * Three variants:
 * 1. Idle (most common) — kind tile, title, tag chips, byte/chunks meta,
 *    timestamp, delete X.
 * 2. Uploading — pipeline glyph (extract → chunk → embed → persist) +
 *    "N/M chunks" sub-line.
 * 3. Error — single warning sub-line + Retry / dismiss.
 *
 * Delete is a two-step: first click swaps × for "Confirm delete" with
 * a 4 s auto-revert. No `window.confirm`. See design spec section 5.
 */
import { useEffect, useRef, useState } from "react";
import type { DocRow, RagKind, UploadProgress } from "../lib/rag";
import { formatTimeAgo } from "../lib/formatTimeAgo";

const KIND_LABEL: Record<RagKind, string> = {
  pdf: "[ PDF ]",
  md: "[ MD  ]",
  html: "[HTML ]",
  txt: "[ TXT ]",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const PIPELINE_STEPS: Array<{
  key: "extracting" | "chunking" | "embedding" | "persisting";
  label: string;
}> = [
  { key: "extracting", label: "extract" },
  { key: "chunking", label: "chunk" },
  { key: "embedding", label: "embed" },
  { key: "persisting", label: "persist" },
];

function stepStatus(
  step: (typeof PIPELINE_STEPS)[number]["key"],
  current: UploadProgress["phase"],
): "done" | "active" | "pending" {
  const order: UploadProgress["phase"][] = [
    "extracting",
    "chunking",
    "embedding",
    "persisting",
    "done",
  ];
  const stepIdx = order.indexOf(step);
  const curIdx = order.indexOf(current);
  if (current === "done") return "done";
  if (curIdx > stepIdx) return "done";
  if (curIdx === stepIdx) return "active";
  return "pending";
}

export type RagDocRowProps = {
  doc: DocRow;
  progress?: UploadProgress;
  onDelete: (docId: number) => void;
};

export function RagDocRow({ doc, progress, onDelete }: RagDocRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
    };
  }, []);

  const armDelete = () => {
    setConfirmingDelete(true);
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => {
      setConfirmingDelete(false);
    }, 4000);
  };

  const confirmDelete = () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
    setConfirmingDelete(false);
    onDelete(doc.id);
  };

  const isUploading =
    progress &&
    progress.phase !== "done" &&
    progress.phase !== "error";
  const isError = progress?.phase === "error";

  return (
    <div
      className={
        "rag-doc-row" +
        (isUploading ? " rag-doc-row--uploading" : "") +
        (isError ? " rag-doc-row--error" : "")
      }
      data-testid={`rag-doc-row-${doc.id}`}
    >
      <span
        className={`rag-kind rag-kind--${doc.kind}`}
        aria-label={doc.kind.toUpperCase()}
      >
        {KIND_LABEL[doc.kind]}
      </span>

      <div className="rag-doc-row-main">
        <div className="rag-doc-row-title-line">
          <span className="rag-doc-title" title={doc.title}>
            {doc.title}
          </span>
          {!isUploading && !isError && (
            <span className="rag-doc-meta">
              {formatBytes(doc.bytes)} · {doc.chunk_count.toLocaleString()}{" "}
              chunks
            </span>
          )}
        </div>

        {isUploading ? (
          <div className="rag-doc-row-pipeline-line">
            <div className="rag-pipeline" aria-hidden="true">
              {PIPELINE_STEPS.map((step) => {
                const s = stepStatus(step.key, progress!.phase);
                return (
                  <div
                    key={step.key}
                    className={`rag-pipeline-step rag-pipeline-step--${s}`}
                  >
                    <span className="rag-pipeline-glyph">
                      {s === "pending" ? "○" : "●"}
                    </span>
                    <span className="rag-pipeline-label">{step.label}</span>
                  </div>
                );
              })}
            </div>
            {progress?.chunksTotal != null && (
              <span className="rag-doc-meta">
                {progress.chunksDone ?? 0}/{progress.chunksTotal} chunks
              </span>
            )}
          </div>
        ) : isError ? (
          <div className="rag-row-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            {progress?.errorMessage ?? "Upload failed"}
          </div>
        ) : (
          <div className="rag-doc-row-meta-line">
            <div className="rag-tag-row">
              {doc.tags.map((t) => (
                <span key={t} className="rag-tag rag-tag--row">
                  {t}
                </span>
              ))}
            </div>
            <span
              className="rag-doc-timestamp"
              title={new Date(doc.uploaded_at * 1000).toISOString()}
            >
              {formatTimeAgo(doc.uploaded_at)}
            </span>
          </div>
        )}
      </div>

      {!isUploading && (
        <div className="rag-doc-row-actions">
          {confirmingDelete ? (
            <button
              type="button"
              className="rag-row-action rag-row-action--danger"
              onClick={confirmDelete}
              data-testid={`rag-doc-row-${doc.id}-confirm-delete`}
            >
              Confirm delete
            </button>
          ) : (
            <button
              type="button"
              className="rag-row-action"
              onClick={armDelete}
              aria-label="Delete document"
              data-testid={`rag-doc-row-${doc.id}-delete`}
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Plan 12 Phase 3 — Settings → RAG tab root.
 *
 * Renders the empty/populated states from `docs/design/rag-settings-tab.md`,
 * orchestrates the drop zone, the upload modal, and per-row delete.
 *
 * Day grouping uses the same time taxonomy as `formatTimeAgo` — "Today",
 * "Yesterday", or `MMM D` for older docs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ragUpload,
  ragDelete,
  ragRunSeedScript,
  ragListSeedFiles,
  onSeedProgress,
  type RagKind,
  type RagTag,
  type DocRow,
  type SeedProgressEvent,
} from "../lib/rag";
import { useRagStore } from "../state/ragStore";
import { RagDocRow } from "./RagDocRow";
import { RagUploadModal, type PendingFile } from "./RagUploadModal";
import "./RagSettingsTab.css";

const ACCEPTED_EXTENSIONS = [
  "pdf",
  "html",
  "htm",
  "md",
  "markdown",
  "txt",
] as const;

function classifyKind(filename: string): RagKind | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "txt") return "txt";
  return null;
}

function deriveTitle(filename: string): string {
  const stem = filename.split("/").pop() ?? filename;
  return stem.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

function dayLabel(uploadedAt: number, nowSec: number): string {
  const date = new Date(uploadedAt * 1000);
  const now = new Date(nowSec * 1000);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  const todayStart = startOfDay(now);
  const docStart = startOfDay(date);
  const diff = todayStart - docStart;
  if (diff <= 0) return "Today";
  if (diff <= 86400) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function groupByDay(docs: DocRow[]): Array<{ label: string; docs: DocRow[] }> {
  const now = Math.floor(Date.now() / 1000);
  const groups = new Map<string, DocRow[]>();
  const order: string[] = [];
  for (const d of docs) {
    const label = dayLabel(d.uploaded_at, now);
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(d);
  }
  return order.map((label) => ({ label, docs: groups.get(label)! }));
}

export function RagSettingsTab() {
  const documents = useRagStore((s) => s.documents);
  const inFlight = useRagStore((s) => s.inFlight);
  const taxonomy = useRagStore((s) => s.taxonomy);
  const loadDocuments = useRagStore((s) => s.loadDocuments);
  const loadTaxonomy = useRagStore((s) => s.loadTaxonomy);
  const optimisticDelete = useRagStore((s) => s.optimisticDelete);
  const clearInFlight = useRagStore((s) => s.clearInFlight);
  const subscribeUploadProgress = useRagStore(
    (s) => s.subscribeUploadProgress,
  );
  const unsubscribeUploadProgress = useRagStore(
    (s) => s.unsubscribeUploadProgress,
  );

  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [dragCount, setDragCount] = useState<number | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const dropErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);

  // Plan 12 Phase 6 — optional starter-pack downloader. The button
  // state machine has four phases:
  //   idle        → button enabled, label "Download starter pack"
  //   downloading → script running, label "Downloading… i/N"
  //   uploading   → script done, ingesting files, label "Uploading… i/N"
  //   error       → label "Retry starter pack" + error message below
  type SeedPhase = "idle" | "downloading" | "uploading" | "error";
  const [seedPhase, setSeedPhase] = useState<SeedPhase>("idle");
  const [seedIndex, setSeedIndex] = useState(0);
  const [seedTotal, setSeedTotal] = useState(0);
  const [seedError, setSeedError] = useState<string | null>(null);

  useEffect(() => {
    loadDocuments();
    loadTaxonomy();
    void subscribeUploadProgress();
    return () => {
      unsubscribeUploadProgress();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-clear an upload's inFlight entry once we observe the doc in
  // the documents list (server side reconciles after the persist
  // step). Without this, the row would render twice.
  useEffect(() => {
    for (const path of Object.keys(inFlight)) {
      const p = inFlight[path];
      if (p.phase === "done" || p.phase === "error") {
        // Reload documents to pick up the persisted row, then clear.
        const t = setTimeout(() => {
          loadDocuments();
          clearInFlight(path);
        }, 200);
        return () => clearTimeout(t);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight]);

  const showDropError = (msg: string) => {
    setDropError(msg);
    if (dropErrorTimer.current) clearTimeout(dropErrorTimer.current);
    dropErrorTimer.current = setTimeout(() => setDropError(null), 4000);
  };

  // Drag handling. We rely on the file system path being available on
  // `dataTransfer.files[i].path` (Tauri exposes this on macOS / Linux);
  // when running in a pure browser the path field is empty and we fall
  // back to the file name. Production Tauri builds will always have it.
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
    setDragCount(e.dataTransfer.items?.length ?? null);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setDragOver(false);
      setDragCount(null);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setDragCount(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    const accepted: PendingFile[] = [];
    let rejectedAny = false;
    for (const f of files) {
      const kind = classifyKind(f.name);
      if (!kind) {
        rejectedAny = true;
        continue;
      }
      const fpath =
        // Tauri exposes the absolute path; browsers do not.
        (f as unknown as { path?: string }).path ?? f.name;
      accepted.push({
        path: fpath,
        title: deriveTitle(f.name),
        kind,
        bytes: f.size,
      });
    }
    if (rejectedAny) {
      showDropError("Only PDF, HTML, MD, or TXT files are accepted.");
    }
    if (accepted.length > 0) setPending(accepted);
  };

  const onAddDocClick = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: "Documents",
            extensions: ACCEPTED_EXTENSIONS as unknown as string[],
          },
        ],
      });
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      const acc: PendingFile[] = [];
      for (const p of paths) {
        const name = p.split("/").pop() ?? p;
        const kind = classifyKind(name);
        if (!kind) continue;
        acc.push({ path: p, title: deriveTitle(name), kind, bytes: 0 });
      }
      if (acc.length > 0) setPending(acc);
    } catch (e) {
      // Tauri dialog isn't available outside the app — silently noop.
      console.warn("Open dialog failed", e);
    }
  };

  const dispatchUploads = async (
    files: { path: string; title: string; kind: RagKind }[],
    tags: RagTag[],
  ) => {
    setPending([]);
    for (const f of files) {
      try {
        const docId = await ragUpload({
          path: f.path,
          kind: f.kind,
          title: f.title,
          tags,
        });
        // We optimistically reload after each upload so list-time
        // ordering matches the server.
        await loadDocuments();
        // appendDocument would create a duplicate of the just-loaded
        // row; only used by tests / fast paths.
        void docId;
      } catch (e) {
        console.error("ragUpload failed", e);
      }
    }
  };

  const handleDelete = async (docId: number) => {
    optimisticDelete(docId);
    try {
      await ragDelete(docId);
    } catch (e) {
      console.error("ragDelete failed; reloading", e);
      // Reconcile by reloading; the row will reappear if the backend
      // still has it.
      void loadDocuments();
    }
  };

  // Subscribe to `rag://seed-progress` while the seed script is
  // running. We tear the listener down on unmount and on phase return
  // to `idle`/`error` to avoid leaks across mount cycles.
  useEffect(() => {
    if (seedPhase !== "downloading") return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onSeedProgress((evt: SeedProgressEvent) => {
      if (cancelled) return;
      if (evt.verb === "start" && typeof evt.total === "number") {
        setSeedTotal(evt.total);
        setSeedIndex(0);
        return;
      }
      if (
        (evt.verb === "download" || evt.verb === "skip" || evt.verb === "error") &&
        typeof evt.index === "number"
      ) {
        setSeedIndex(evt.index);
        if (typeof evt.total === "number") setSeedTotal(evt.total);
      }
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [seedPhase]);

  const handleSeedDownload = async () => {
    setSeedPhase("downloading");
    setSeedError(null);
    setSeedIndex(0);
    setSeedTotal(0);
    try {
      const result = await ragRunSeedScript();
      if (result.exit_code !== 0) {
        setSeedPhase("error");
        setSeedError(
          `Seed script exited with code ${result.exit_code}. ` +
            "Check the Tauri log for details.",
        );
        return;
      }

      // Phase: uploading — iterate the seed dir, skip docs already
      // ingested (matched on title). The Rust side normalizes empty
      // tags to ["generic"] so we never get an empty-tag rejection.
      setSeedPhase("uploading");
      setSeedIndex(0);
      const files = await ragListSeedFiles();
      setSeedTotal(files.length);

      // Build a quick lookup of existing doc titles so re-uploads
      // are no-ops. We could also compare source_path but title is a
      // user-facing match that survives slug renames.
      const existingTitles = new Set(documents.map((d) => d.title));

      let i = 0;
      for (const f of files) {
        i += 1;
        setSeedIndex(i);
        if (existingTitles.has(f.title)) continue;
        try {
          await ragUpload({
            path: f.path,
            kind: f.kind,
            title: f.title,
            tags: f.tags,
          });
        } catch (e) {
          console.error("ragUpload(seed) failed for", f.filename, e);
          // Keep going — partial success is better than aborting.
        }
      }

      await loadDocuments();
      setSeedPhase("idle");
    } catch (e) {
      console.error("seed-pack failed", e);
      setSeedPhase("error");
      setSeedError(typeof e === "string" ? e : (e as Error).message);
    }
  };

  const seedBusy = seedPhase === "downloading" || seedPhase === "uploading";
  const seedLabel = (() => {
    if (seedPhase === "downloading")
      return `Downloading… ${seedIndex}/${seedTotal || "?"}`;
    if (seedPhase === "uploading")
      return `Uploading… ${seedIndex}/${seedTotal || "?"}`;
    if (seedPhase === "error") return "Retry starter pack";
    return "Download starter pack";
  })();

  const groups = useMemo(() => groupByDay(documents), [documents]);
  const inFlightArr = Object.values(inFlight).filter(
    (p) => p.phase !== "done" && p.phase !== "error",
  );

  return (
    <div className="rag-tab tab-content" data-testid="rag-settings-tab">
      <div className="tab-header">
        <div>
          <h2>RAG Library</h2>
          <p className="rag-subtitle">Vendor docs the AI can cite</p>
        </div>
        <button
          type="button"
          className="rag-btn rag-btn--primary"
          onClick={onAddDocClick}
        >
          + Add document
        </button>
      </div>

      <div
        ref={dropZoneRef}
        tabIndex={0}
        className={
          "rag-dropzone" + (dragOver ? " rag-dropzone--active" : "")
        }
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onAddDocClick();
          }
        }}
        role="button"
        aria-label="Drop PDF, HTML, MD, or TXT files here"
        data-testid="rag-dropzone"
      >
        <div className="rag-dropzone-copy">
          {dragOver ? (
            <>
              <p className="rag-dropzone-title">
                ↓ Release to upload {dragCount ?? ""} file
                {dragCount === 1 ? "" : "s"}
              </p>
              <p className="rag-dropzone-sub">PDF · HTML · MD · TXT</p>
            </>
          ) : (
            <>
              <p className="rag-dropzone-title">
                Drop PDFs, HTML, MD, or TXT here
              </p>
              <p className="rag-dropzone-sub">
                The AI cites these on every chat turn
              </p>
            </>
          )}
        </div>
      </div>

      {dropError && (
        <p className="rag-drop-error" role="alert">
          {dropError}
        </p>
      )}

      {/* Aria-live for screen readers — single string per active step. */}
      <div role="status" aria-live="polite" className="sr-only">
        {inFlightArr.length > 0
          ? `${inFlightArr[0].phase}, ${inFlightArr.length} document${
              inFlightArr.length === 1 ? "" : "s"
            } in progress`
          : ""}
      </div>

      {documents.length === 0 && inFlightArr.length === 0 ? (
        <div className="rag-empty" data-testid="rag-empty-state">
          <p className="rag-empty-title">No documents yet.</p>
          <p className="rag-empty-body">
            When you upload vendor docs (Cisco IOS-XE references, Meraki API
            notes, internal runbooks…), the assistant retrieves the most
            relevant chunks at chat time and cites them inline. Tag each doc
            by platform — chats only see docs tagged for the active session's
            vendor (plus <code>generic</code>).
          </p>
        </div>
      ) : (
        <div className="rag-doc-list" data-testid="rag-doc-list">
          {/* Render in-flight first as ghost rows. */}
          {inFlightArr.map((p) => (
            <div
              key={`flight-${p.docPath}`}
              className="rag-doc-row rag-doc-row--uploading rag-doc-row--ghost"
              data-testid={`rag-flight-${p.docPath}`}
            >
              <span className="rag-kind rag-kind--md">[ ··· ]</span>
              <div className="rag-doc-row-main">
                <div className="rag-doc-row-title-line">
                  <span className="rag-doc-title">
                    {p.docPath.split("/").pop()}
                  </span>
                </div>
                <div className="rag-doc-row-pipeline-line">
                  <span>{p.phase}</span>
                  {p.chunksTotal != null && (
                    <span className="rag-doc-meta">
                      {p.chunksDone ?? 0}/{p.chunksTotal} chunks
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
          {groups.map((g) => (
            <div className="rag-day-group" key={g.label}>
              <div className="rag-day-label">{g.label}</div>
              {g.docs.map((d) => (
                <RagDocRow
                  key={d.id}
                  doc={d}
                  progress={inFlight[d.title]}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Plan 12 Phase 6 — optional starter pack. Always visible at
          the bottom; this is a secondary action (teal accent), never
          the default. The drop zone above remains the primary path. */}
      <div className="rag-seed-row" data-testid="rag-seed-row">
        <button
          type="button"
          className="rag-btn rag-btn--secondary"
          onClick={handleSeedDownload}
          disabled={seedBusy}
          aria-busy={seedBusy ? "true" : undefined}
          data-testid="rag-seed-button"
        >
          {seedLabel}
        </button>
        <p className="rag-seed-help">
          Download a small public starter pack to{" "}
          <code>~/.ccie-terminal/rag-seed/</code>. Idempotent — already
          ingested docs are skipped.
        </p>
        {seedError && (
          <p
            className="rag-seed-error"
            role="alert"
            data-testid="rag-seed-error"
          >
            {seedError}
          </p>
        )}
      </div>

      {pending.length > 0 && taxonomy.builtin.length > 0 && (
        <RagUploadModal
          files={pending}
          taxonomy={taxonomy}
          onCancel={() => setPending([])}
          onSubmit={dispatchUploads}
        />
      )}
    </div>
  );
}

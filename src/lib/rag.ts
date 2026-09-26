/**
 * Plan 12 Phase 3 — RAG Tauri wrappers + types.
 *
 * The Tauri command surface (defined in `src-tauri/src/commands/rag.rs`):
 * - `rag_upload(args)`           → number doc_id
 * - `rag_list_documents()`       → DocRow[]
 * - `rag_delete_document(docId)` → void
 * - `rag_tag_taxonomy()`         → RagTag[]
 *
 * Streaming progress is delivered via the `rag://upload-progress`
 * Tauri event so the upload modal can render the extract → chunk →
 * embed → persist → done pipeline.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Builtin (vendor) tags. Mirrors `TAG_TAXONOMY` in
 *  `src-tauri/src/rag/tags.rs`; keep these two lists in sync. */
export const BUILTIN_RAG_TAGS = [
  "cisco-iosxe-switch",
  "cisco-iosxe-router",
  "cisco-nxos",
  "cisco-meraki",
  "juniper-junos",
  "arista-eos",
  "generic",
] as const;
export type BuiltinRagTag = (typeof BUILTIN_RAG_TAGS)[number];

/** A RAG tag — any builtin or any user-defined slug. The Rust validator
 *  enforces shape; this type is intentionally `string` so user tags
 *  type-check in callers. */
export type RagTag = string;

/** Mirrors `validate_tag_shape` in Rust: 1..=32 chars, lowercase alnum
 *  + hyphen, must start with letter/digit. Reserved-prefix check is a
 *  separate function. */
export const TAG_SHAPE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** True iff `t` would be rejected by Rust as a reserved-prefix user
 *  tag. Builtin tags themselves return false (they're allowed). */
export function isReservedPrefix(t: string): boolean {
  if ((BUILTIN_RAG_TAGS as readonly string[]).includes(t)) return false;
  return (
    t.startsWith("cisco-") ||
    t.startsWith("juniper-") ||
    t.startsWith("arista-")
  );
}

/** One row in `RagTaxonomy.user`. */
export type UserTagSummary = { tag: string; usage_count: number };

/** Result shape of `rag_tag_taxonomy`. */
export type RagTaxonomy = {
  builtin: readonly BuiltinRagTag[];
  user: UserTagSummary[];
};

export type RagKind = "pdf" | "html" | "md" | "txt";

export type DocRow = {
  id: number;
  title: string;
  kind: RagKind;
  bytes: number;
  uploaded_at: number;
  tags: RagTag[];
  chunk_count: number;
};

export type UploadPhase =
  | "extracting"
  | "chunking"
  | "embedding"
  | "persisting"
  | "done"
  | "error";

export type UploadProgress = {
  docPath: string;
  phase: UploadPhase;
  chunksDone?: number;
  chunksTotal?: number;
  errorMessage?: string;
};

export type UploadArgs = {
  path: string;
  kind: RagKind;
  title: string;
  tags: RagTag[];
};

export const ragUpload = (args: UploadArgs): Promise<number> =>
  invoke<number>("rag_upload", { args });

export const ragList = (): Promise<DocRow[]> =>
  invoke<DocRow[]>("rag_list_documents");

export const ragDelete = (docId: number): Promise<void> =>
  invoke<void>("rag_delete_document", { docId });

export const ragTaxonomy = (): Promise<RagTaxonomy> =>
  invoke<RagTaxonomy>("rag_tag_taxonomy");

/** Plan 12 Phase 4 — one row per chunk returned by `rag_retrieve`.
 *  `distance` is cosine distance from the query embedding (lower = more
 *  similar); `tags` mirrors the document-level tag set. */
export type RetrievedChunk = {
  chunk_id: number;
  document_id: number;
  document_title: string;
  chunk_idx: number;
  text: string;
  distance: number;
  tags: RagTag[];
};

export type RetrieveArgs = {
  query: string;
  tags: RagTag[];
  k: number;
};

/** Run a RAG retrieval against the local SQLite + sqlite-vec index.
 *  The backend auto-includes `generic` in the effective tag set so a
 *  bare-vendor query still surfaces vendor-neutral docs. */
export const ragRetrieve = (args: RetrieveArgs): Promise<RetrievedChunk[]> =>
  invoke<RetrievedChunk[]>("rag_retrieve", { args });

/** Subscribe to the streaming progress event. Returns an unlisten
 *  function the caller MUST call on unmount to avoid leaks. */
export const onUploadProgress = (
  cb: (p: UploadProgress) => void,
): Promise<UnlistenFn> =>
  listen<UploadProgress>("rag://upload-progress", (e) => cb(e.payload));

/* -------------------------------------------------------------------------
 * Plan 12 Phase 6 — optional seed-pack downloader.
 *
 * The "Download starter pack" button in Settings → RAG calls
 * `rag_run_seed_script` to spawn `scripts/seed-rag/seed.py`, which
 * hydrates `~/.ccie-terminal/rag-seed/` with the URLs catalogued in
 * `scripts/seed-rag/sources.json`. After the script exits the UI calls
 * `rag_list_seed_files` to enumerate what landed on disk and uploads
 * each via the existing `rag_upload`. Idempotency is enforced by
 * `rag_list_documents` source-path matching (skip already-uploaded).
 */

/** Verbs the seed script emits in its `seed: ...` stdout protocol. */
export type SeedVerb = "start" | "download" | "skip" | "error" | "done";

export type SeedProgressEvent = {
  /** Raw stdout line from `seed.py`. */
  line: string;
  /** Best-effort parsed verb (start/download/skip/error/done). */
  verb?: SeedVerb;
  /** 1-based index of the source being processed (download/skip/error). */
  index?: number;
  /** Total source count (start/download/skip/error). */
  total?: number;
};

export type SeedRunResult = {
  exit_code: number;
  seed_dir: string;
  script_path: string;
};

export type SeedFile = {
  path: string;
  filename: string;
  bytes: number;
  kind: RagKind;
  /** Title from `sources.json` manifest; falls back to the file stem
   *  for manually-dropped files. */
  title: string;
  /** Tags from `sources.json`; defaults to `["generic"]` for manually
   *  dropped files so `rag_upload` (which rejects empty tags) still
   *  succeeds. */
  tags: RagTag[];
};

/** Spawn `seed.py`. Throws if `python3` isn't installed. */
export const ragRunSeedScript = (): Promise<SeedRunResult> =>
  invoke<SeedRunResult>("rag_run_seed_script");

/** List files in `~/.ccie-terminal/rag-seed/` that map to a known
 *  RAG `kind`. The UI iterates these and calls `rag_upload` per file. */
export const ragListSeedFiles = (): Promise<SeedFile[]> =>
  invoke<SeedFile[]>("rag_list_seed_files");

export const onSeedProgress = (
  cb: (p: SeedProgressEvent) => void,
): Promise<UnlistenFn> =>
  listen<SeedProgressEvent>("rag://seed-progress", (e) => cb(e.payload));

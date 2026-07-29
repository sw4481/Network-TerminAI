//! Plan 12 Phase 3 — Tauri commands for the RAG settings tab.
//!
//! Surfaces the four entry points the frontend needs:
//! - `rag_upload`        : extract → chunk → embed (sidecar) → persist (store)
//! - `rag_list_documents`: single SQL pass returning rows the UI renders
//! - `rag_delete_document`: cascade delete (vec0 + tables)
//! - `rag_tag_taxonomy`  : exposes the fixed taxonomy to the picker UI
//!
//! Streaming progress is published via the `rag://upload-progress`
//! Tauri event so the React Zustand store can update without
//! polling. Empty / unknown tags are rejected BEFORE the bridge call
//! to avoid burning sidecar work on a doomed upload.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::rag::bridge::{IngestProgress, IngestedDoc, RagBridgeApi};
use crate::rag::retrieve::{retrieve as rag_retrieve_inner, RetrieveArgs, RetrievedChunk};
use crate::rag::store::{DocSummary, RagStore, UserTagSummary};
use crate::rag::tags::{validate_tag_shape, TAG_TAXONOMY};

/// Frontend-side phase markers — match `UploadProgress.phase` in
/// `src/lib/rag.ts`. The sidecar's `rag.ingest` only reports
/// `extract → chunk → embed`; the Rust persistence step adds
/// `persisting` and `done` here.
const PHASE_EMBEDDING: &str = "embedding";
const PHASE_PERSISTING: &str = "persisting";
const PHASE_DONE: &str = "done";
const PHASE_ERROR: &str = "error";

const PROGRESS_EVENT: &str = "rag://upload-progress";

#[derive(Debug, Deserialize)]
pub struct UploadArgs {
    pub path: String,
    pub kind: String,
    pub title: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DocRow {
    pub id: i64,
    pub title: String,
    pub kind: String,
    pub bytes: i64,
    pub uploaded_at: i64,
    pub tags: Vec<String>,
    pub chunk_count: i64,
}

impl From<DocSummary> for DocRow {
    fn from(s: DocSummary) -> Self {
        DocRow {
            id: s.id,
            title: s.title,
            kind: s.kind,
            bytes: s.bytes,
            uploaded_at: s.uploaded_at,
            tags: s.tags,
            chunk_count: s.chunk_count,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct UploadProgressEvent<'a> {
    #[serde(rename = "docPath")]
    doc_path: &'a str,
    phase: &'a str,
    #[serde(rename = "chunksDone", skip_serializing_if = "Option::is_none")]
    chunks_done: Option<i64>,
    #[serde(rename = "chunksTotal", skip_serializing_if = "Option::is_none")]
    chunks_total: Option<i64>,
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

/// Validate the upload args before any sidecar work happens. Returns
/// the kind (lowercased) on success.
fn validate_upload_args(args: &UploadArgs) -> Result<String, String> {
    let path = args.path.trim();
    if path.is_empty() {
        return Err("upload path must be non-empty".to_string());
    }
    let title = args.title.trim();
    if title.is_empty() {
        return Err("upload title must be non-empty".to_string());
    }
    let kind = args.kind.trim().to_ascii_lowercase();
    match kind.as_str() {
        "pdf" | "html" | "md" | "txt" => {}
        other => return Err(format!("unsupported kind '{other}'")),
    }
    if args.tags.is_empty() {
        return Err("at least one tag is required".to_string());
    }
    for t in &args.tags {
        validate_tag_shape(t).map_err(|e| e.to_string())?;
    }
    Ok(kind)
}

/// Test-friendly inner for `rag_upload`: takes the bridge + store as
/// trait objects so tests can swap in a mock. Emits progress events
/// when an `app` handle is provided; tests pass `None` to short-circuit
/// the Tauri event bus.
pub async fn rag_upload_inner(
    store: &RagStore,
    bridge: &dyn RagBridgeApi,
    args: UploadArgs,
    app: Option<&AppHandle>,
) -> Result<i64, String> {
    let kind = validate_upload_args(&args)?;

    let bytes = std::fs::metadata(&args.path).map(|m| m.len() as i64).unwrap_or(0);

    // Capture the path for the progress callback so we don't need to
    // clone it into the bridge closure repeatedly.
    let progress_path = args.path.clone();
    let app_for_progress = app.cloned();
    let on_progress: Box<dyn Fn(IngestProgress) + Send + Sync> =
        Box::new(move |p: IngestProgress| {
            if let Some(handle) = &app_for_progress {
                let _ = handle.emit(
                    PROGRESS_EVENT,
                    UploadProgressEvent {
                        doc_path: &progress_path,
                        phase: PHASE_EMBEDDING,
                        chunks_done: Some(p.chunks_done),
                        chunks_total: Some(p.chunks_total),
                        error_message: None,
                    },
                );
            }
        });

    let ingested: IngestedDoc = match bridge
        .ingest(&args.path, &kind, &args.title, on_progress)
        .await
    {
        Ok(d) => d,
        Err(e) => {
            let msg = e.to_string();
            if let Some(app) = app {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    UploadProgressEvent {
                        doc_path: &args.path,
                        phase: PHASE_ERROR,
                        chunks_done: None,
                        chunks_total: None,
                        error_message: Some(msg.clone()),
                    },
                );
            }
            return Err(msg);
        }
    };

    if let Some(app) = app {
        let _ = app.emit(
            PROGRESS_EVENT,
            UploadProgressEvent {
                doc_path: &args.path,
                phase: PHASE_PERSISTING,
                chunks_done: None,
                chunks_total: None,
                error_message: None,
            },
        );
    }

    // Persist: insert document, set tags, then write each chunk. The
    // store applies the same up-front tag validation, but we already
    // validated so the second pass is cheap.
    let doc_id = store
        .insert_document(&args.title, &args.path, &kind, bytes)
        .map_err(|e| e.to_string())?;

    let tag_refs: Vec<&str> = args.tags.iter().map(|s| s.as_str()).collect();
    if let Err(e) = store.set_tags(doc_id, &tag_refs) {
        // Clean up the half-inserted doc so listing doesn't show a
        // tag-less ghost row.
        let _ = store.delete_document(doc_id);
        return Err(e.to_string());
    }

    for chunk in &ingested.chunks {
        if let Err(e) =
            store.insert_chunk(doc_id, chunk.chunk_idx, &chunk.text, &chunk.embedding)
        {
            let _ = store.delete_document(doc_id);
            return Err(e.to_string());
        }
    }

    if let Some(app) = app {
        let _ = app.emit(
            PROGRESS_EVENT,
            UploadProgressEvent {
                doc_path: &args.path,
                phase: PHASE_DONE,
                chunks_done: Some(ingested.chunks.len() as i64),
                chunks_total: Some(ingested.chunks.len() as i64),
                error_message: None,
            },
        );
    }

    Ok(doc_id)
}

#[tauri::command]
pub async fn rag_upload(
    args: UploadArgs,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<i64, String> {
    let store = state.rag_store.clone();
    let bridge = state.rag_bridge.clone();
    rag_upload_inner(&store, bridge.as_ref(), args, Some(&app)).await
}

#[tauri::command]
pub async fn rag_list_documents(
    state: State<'_, AppState>,
) -> Result<Vec<DocRow>, String> {
    let store = state.rag_store.clone();
    tokio::task::spawn_blocking(move || {
        store
            .list_documents()
            .map(|rows| rows.into_iter().map(DocRow::from).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("list_documents join: {e}"))?
}

#[tauri::command]
pub async fn rag_delete_document(
    doc_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let store = state.rag_store.clone();
    tokio::task::spawn_blocking(move || {
        store.delete_document(doc_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("delete_document join: {e}"))?
}

/// Frontend payload for the tag picker. `builtin` is the seven fixed
/// vendor tags; `user` is whatever non-builtin tags currently appear
/// in `rag_document_tags` (with usage counts).
#[derive(Debug, Serialize)]
pub struct RagTaxonomyPayload {
    pub builtin: Vec<&'static str>,
    pub user: Vec<UserTagSummary>,
}

#[tauri::command]
pub async fn rag_tag_taxonomy(
    state: State<'_, AppState>,
) -> Result<RagTaxonomyPayload, String> {
    let store = state.rag_store.clone();
    let user = tokio::task::spawn_blocking(move || store.list_user_tags())
        .await
        .map_err(|e| format!("list_user_tags join: {e}"))?
        .map_err(|e| e.to_string())?;
    Ok(RagTaxonomyPayload {
        builtin: TAG_TAXONOMY.to_vec(),
        user,
    })
}

#[tauri::command]
pub async fn rag_retrieve(
    args: RetrieveArgs,
    state: State<'_, AppState>,
) -> Result<Vec<RetrievedChunk>, String> {
    let store = state.rag_store.clone();
    let bridge = state.rag_bridge.clone();
    rag_retrieve_inner(&store, bridge.as_ref(), args)
        .await
        .map_err(|e| e.to_string())
}

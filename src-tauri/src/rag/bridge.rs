//! Plan 12 Phase 3 — RAG bridge between the Rust app layer and the
//! Python sidecar's `rag.ingest` NDJSON streaming method.
//!
//! Reuses the existing [`SidecarSupervisor`] handle owned by
//! `AgentBridge` (cloned in via `AppState::new`). One supervisor per
//! sidecar process — we never spawn a fresh child here.
//!
//! The sidecar speaks this transcript:
//!
//! ```text
//! → {"id":"42","method":"rag.ingest","params":{"path":"/x.md","kind":"md","title":"X"}}
//! ← {"id":"42","type":"rag.ingest.progress","payload":{"chunks_done":16,"chunks_total":48}}
//! ← {"id":"42","type":"rag.ingest.progress","payload":{"chunks_done":32,"chunks_total":48}}
//! ← {"id":"42","type":"rag.ingest.result","payload":{"title":"X","chunks":[…]}}
//! ← {"id":"42","type":"done"}
//! ```
//!
//! `rag.ingest.result` carries `chunks: [{chunk_idx, text, embedding[384]}]`.
//! Errors come back as `{"type":"error","message":"..."}` and surface as
//! `Err(_)` from [`RagBridge::ingest`].
//!
//! Memory note: the sidecar emits one `rag.ingest.result` line containing
//! the full `chunks` array. The bridge deserializes this in one allocation
//! before returning. For typical vendor docs (≤ 2000 chunks ≈ 60 MB)
//! this is fine; multi-thousand-page PDFs would benefit from a future
//! per-chunk streaming protocol.

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use crate::agent_bridge::AgentBridge;
use crate::bridge::SidecarSupervisor;
use crate::rag::store::EMBEDDING_DIM;

/// Single chunk persisted by the ingest pipeline. `embedding` is fixed
/// at 384 floats to match the bundled `all-MiniLM-L6-v2` model.
#[derive(Debug, Clone)]
pub struct IngestedChunk {
    pub chunk_idx: i64,
    pub text: String,
    pub embedding: Vec<f32>,
}

/// Streaming progress tick from the sidecar (one per BATCH=16 chunks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngestProgress {
    pub chunks_done: i64,
    pub chunks_total: i64,
}

/// Final payload returned by `rag.ingest`. The bridge collects chunks
/// in order and returns them once the sidecar emits its `done` line.
#[derive(Debug, Clone)]
pub struct IngestedDoc {
    pub title: String,
    pub chunks: Vec<IngestedChunk>,
}

/// Async-trait abstraction so the upload command can be unit-tested
/// against a deterministic mock without spawning the real sidecar.
#[async_trait]
pub trait RagBridgeApi: Send + Sync {
    async fn ingest(
        &self,
        path: &str,
        kind: &str,
        title: &str,
        on_progress: Box<dyn Fn(IngestProgress) + Send + Sync>,
    ) -> Result<IngestedDoc>;

    /// Plan 12 Phase 4 — embed a single string for query-time retrieval.
    /// Returns a 384-dim L2-normalized vector matching the model used by
    /// `rag.ingest`. Non-streaming; one round-trip to the sidecar.
    async fn embed(&self, text: &str) -> Result<Vec<f32>>;
}

/// Production bridge — wraps the live sidecar supervisor.
#[derive(Clone)]
pub struct RagBridge {
    supervisor: Arc<SidecarSupervisor>,
}

impl RagBridge {
    pub fn new(supervisor: Arc<SidecarSupervisor>) -> Self {
        Self { supervisor }
    }

    /// Convenience constructor: pull the supervisor out of an existing
    /// [`AgentBridge`] so the RAG bridge shares the same long-lived
    /// child process.
    pub fn from_agent_bridge(agent: &AgentBridge) -> Self {
        Self::new(agent.supervisor())
    }
}

#[async_trait]
impl RagBridgeApi for RagBridge {
    async fn ingest(
        &self,
        path: &str,
        kind: &str,
        title: &str,
        on_progress: Box<dyn Fn(IngestProgress) + Send + Sync>,
    ) -> Result<IngestedDoc> {
        let supervisor = self.supervisor.clone();
        let params = serde_json::json!({
            "path": path,
            "kind": kind,
            "title": title,
        });
        // Own the path string so the spawn_blocking task doesn't borrow
        // the caller's slice past the method body.
        let path_owned = path.to_string();

        // Run the (blocking) supervisor call on a worker thread so we
        // don't park the tokio reactor while NDJSON streams in. The
        // supervisor's reader thread fans events back through a sync
        // channel, so we collect them into the result on the worker.
        tokio::task::spawn_blocking(move || -> Result<IngestedDoc> {
            let mut result_payload: Option<Value> = None;
            // Capture the result event when it arrives. The terminal
            // `done` event itself carries no payload, so we rely on
            // `rag.ingest.result` (intermediate) to seed `result_payload`.
            supervisor
                .call_stream_ex("rag.ingest", params, |ev| {
                    let ev_type =
                        ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match ev_type {
                        "rag.ingest.progress" => {
                            if let Some(payload) = ev.get("payload") {
                                if let Ok(p) = serde_json::from_value::<
                                    IngestProgressWire,
                                >(payload.clone())
                                {
                                    on_progress(IngestProgress {
                                        chunks_done: p.chunks_done,
                                        chunks_total: p.chunks_total,
                                    });
                                }
                            }
                        }
                        "rag.ingest.result" => {
                            result_payload = ev.get("payload").cloned();
                        }
                        _ => {
                            // Ignore unexpected intermediate events.
                        }
                    }
                    Ok(())
                })
                .with_context(|| format!("rag.ingest call for {path_owned}"))?;

            let payload = result_payload
                .ok_or_else(|| anyhow!("rag.ingest finished without a result payload"))?;
            let parsed: IngestResultWire = serde_json::from_value(payload)
                .context("decode rag.ingest.result payload")?;
            let mut chunks = Vec::with_capacity(parsed.chunks.len());
            for c in parsed.chunks {
                if c.embedding.len() != EMBEDDING_DIM {
                    bail!(
                        "rag.ingest returned chunk with {} dims, expected {}",
                        c.embedding.len(),
                        EMBEDDING_DIM
                    );
                }
                chunks.push(IngestedChunk {
                    chunk_idx: c.chunk_idx,
                    text: c.text,
                    embedding: c.embedding,
                });
            }
            Ok(IngestedDoc {
                title: parsed.title,
                chunks,
            })
        })
        .await
        .map_err(|e| anyhow!("rag.ingest worker join: {e}"))?
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>> {
        let supervisor = self.supervisor.clone();
        let params = serde_json::json!({ "text": text });

        // Like `ingest`, run on a worker thread so we don't block the
        // tokio reactor on the supervisor's blocking channel API. The
        // sidecar replies with a single `done` event whose `result`
        // payload is `{"embedding": [...384 floats...]}`.
        tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
            let result = supervisor
                .call("rag.embed", params)
                .context("rag.embed call")?;
            let parsed: EmbedResultWire = serde_json::from_value(result)
                .context("decode rag.embed result payload")?;
            if parsed.embedding.len() != EMBEDDING_DIM {
                bail!(
                    "rag.embed returned {}-dim vector, expected {}",
                    parsed.embedding.len(),
                    EMBEDDING_DIM
                );
            }
            Ok(parsed.embedding)
        })
        .await
        .map_err(|e| anyhow!("rag.embed worker join: {e}"))?
    }
}

#[derive(Deserialize)]
struct EmbedResultWire {
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct IngestProgressWire {
    chunks_done: i64,
    chunks_total: i64,
}

#[derive(Deserialize)]
struct IngestResultWire {
    title: String,
    chunks: Vec<IngestChunkWire>,
}

#[derive(Deserialize)]
struct IngestChunkWire {
    chunk_idx: i64,
    text: String,
    embedding: Vec<f32>,
}

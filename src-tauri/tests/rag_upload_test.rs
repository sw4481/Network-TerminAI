//! Plan 12 Phase 3 Task 3.2 — `rag_upload_inner` integration test.
//!
//! Exercises the upload command's *core* flow without spinning up the
//! real Python sidecar. We mock the bridge with a deterministic stub
//! that returns three pre-baked chunks so the assertions below can
//! cover persistence, tag canonicalization, and the up-front
//! validation rules (empty tags / unknown tags must reject BEFORE the
//! bridge is invoked).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ccie_terminal_lib::commands::rag::{rag_upload_inner, UploadArgs, UploadProgressCallback};
use ccie_terminal_lib::rag::bridge::{IngestProgress, IngestedChunk, IngestedDoc, RagBridgeApi};
use ccie_terminal_lib::rag::store::RagStore;

fn make_vec(seed: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; 384];
    v[seed % 384] = 1.0;
    v
}

/// Returns a closed-over set of chunks; tracks how many times `ingest`
/// was called so tests can assert "no bridge call on validation reject".
struct MockBridge {
    chunks: Vec<IngestedChunk>,
    calls: Arc<AtomicUsize>,
}

impl MockBridge {
    fn new(chunks: Vec<IngestedChunk>) -> (Self, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                chunks,
                calls: calls.clone(),
            },
            calls,
        )
    }
}

#[async_trait]
impl RagBridgeApi for MockBridge {
    async fn ingest(
        &self,
        _path: &str,
        _kind: &str,
        title: &str,
        on_progress: Box<dyn Fn(IngestProgress) + Send + Sync>,
    ) -> anyhow::Result<IngestedDoc> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        // Emit a single progress tick so the test surface mirrors the
        // production sidecar transcript.
        on_progress(IngestProgress {
            chunks_done: self.chunks.len() as i64,
            chunks_total: self.chunks.len() as i64,
        });
        Ok(IngestedDoc {
            title: title.to_string(),
            chunks: self.chunks.clone(),
        })
    }

    async fn embed(&self, _text: &str) -> anyhow::Result<Vec<f32>> {
        // Phase 4 widens RagBridgeApi with `embed`. Phase 3 upload tests
        // never exercise it; return a benign 384-dim zero vector so the
        // trait is satisfied without affecting these tests' behaviour.
        Ok(vec![0.0f32; 384])
    }
}

fn three_chunk_bridge() -> (MockBridge, Arc<AtomicUsize>) {
    let chunks = vec![
        IngestedChunk {
            chunk_idx: 0,
            text: "chunk a".into(),
            embedding: make_vec(1),
        },
        IngestedChunk {
            chunk_idx: 1,
            text: "chunk b".into(),
            embedding: make_vec(2),
        },
        IngestedChunk {
            chunk_idx: 2,
            text: "chunk c".into(),
            embedding: make_vec(3),
        },
    ];
    MockBridge::new(chunks)
}

#[tokio::test]
async fn rag_upload_persists_and_returns_doc_id() {
    let store = RagStore::open_in_memory().expect("open store");
    let (bridge, calls) = three_chunk_bridge();

    let doc_id = rag_upload_inner(
        &store,
        &bridge,
        UploadArgs {
            path: "/tmp/doesnt-matter.md".into(),
            kind: "md".into(),
            title: "Test Doc".into(),
            tags: vec!["cisco-iosxe-router".into(), "generic".into()],
        },
        None,
    )
    .await
    .expect("upload should succeed");

    assert!(doc_id > 0, "doc_id must be a real rowid");
    assert_eq!(
        store.count_chunks(doc_id).expect("count chunks"),
        3,
        "all 3 mocked chunks must have been persisted"
    );
    assert_eq!(
        store.list_tags(doc_id).expect("list tags"),
        vec!["cisco-iosxe-router".to_string(), "generic".to_string()],
        "tags must be persisted in canonical (alphabetical) order"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "bridge.ingest must have been called exactly once"
    );
}

#[tokio::test]
async fn rag_upload_reports_progress_without_a_tauri_handle() {
    let store = RagStore::open_in_memory().expect("open store");
    let (bridge, _calls) = three_chunk_bridge();
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured_events = events.clone();
    let progress: UploadProgressCallback = Arc::new(move |event| {
        captured_events
            .lock()
            .expect("progress lock")
            .push(serde_json::to_value(event).expect("serialize progress"));
    });

    rag_upload_inner(
        &store,
        &bridge,
        UploadArgs {
            path: "/tmp/progress.md".into(),
            kind: "md".into(),
            title: "Progress Doc".into(),
            tags: vec!["generic".into()],
        },
        Some(progress),
    )
    .await
    .expect("upload should succeed");

    let events = events.lock().expect("progress lock");
    let phases: Vec<&str> = events
        .iter()
        .map(|event| event["phase"].as_str().expect("phase"))
        .collect();
    assert_eq!(phases, ["embedding", "persisting", "done"]);
    assert!(events
        .iter()
        .all(|event| event["docPath"] == "/tmp/progress.md"));
    assert_eq!(events[0]["chunksDone"], 3);
    assert_eq!(events[0]["chunksTotal"], 3);
    assert_eq!(events[2]["chunksDone"], 3);
    assert_eq!(events[2]["chunksTotal"], 3);
}

#[tokio::test]
async fn rag_upload_rejects_empty_tags_before_bridge() {
    let store = RagStore::open_in_memory().expect("open store");
    let (bridge, calls) = three_chunk_bridge();

    let err = rag_upload_inner(
        &store,
        &bridge,
        UploadArgs {
            path: "/tmp/x.md".into(),
            kind: "md".into(),
            title: "Test".into(),
            tags: vec![],
        },
        None,
    )
    .await
    .expect_err("empty tags must be rejected");

    assert!(err.contains("tag"), "error must mention tags, got {err:?}");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "bridge.ingest must not be invoked when tags are empty"
    );
}

#[tokio::test]
async fn rag_upload_accepts_user_tag() {
    // Post validate_tag_shape migration: any slug-shape tag is accepted.
    let store = RagStore::open_in_memory().expect("open store");
    let (bridge, calls) = three_chunk_bridge();

    let doc_id = rag_upload_inner(
        &store,
        &bridge,
        UploadArgs {
            path: "/tmp/x.md".into(),
            kind: "md".into(),
            title: "Acme runbook".into(),
            tags: vec!["cisco-iosxe-router".into(), "customer-acme".into()],
        },
        None,
    )
    .await
    .expect("user tag must be accepted");

    assert!(doc_id > 0, "doc_id must be a real rowid");
    let tags = store.list_tags(doc_id).expect("list tags");
    assert!(
        tags.iter().any(|t| t == "customer-acme"),
        "user tag must be persisted"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "bridge.ingest must have been called exactly once"
    );
}

#[tokio::test]
async fn rag_upload_rejects_reserved_prefix_tag() {
    let store = RagStore::open_in_memory().expect("open store");
    let (bridge, calls) = three_chunk_bridge();

    let err = rag_upload_inner(
        &store,
        &bridge,
        UploadArgs {
            path: "/tmp/x.md".into(),
            kind: "md".into(),
            title: "Bogus".into(),
            tags: vec!["cisco-foo".into()],
        },
        None,
    )
    .await
    .expect_err("reserved prefix must be rejected");

    assert!(
        err.contains("cisco-foo") || err.contains("reserved"),
        "error must mention the bad tag or reserved prefix, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "bridge.ingest must not be invoked when tag has reserved prefix"
    );
}

#[tokio::test]
async fn rag_upload_rejects_unsupported_kind() {
    let store = RagStore::open_in_memory().expect("open store");
    let (bridge, calls) = three_chunk_bridge();

    let err = rag_upload_inner(
        &store,
        &bridge,
        UploadArgs {
            path: "/tmp/x.docx".into(),
            kind: "docx".into(),
            title: "Test".into(),
            tags: vec!["generic".into()],
        },
        None,
    )
    .await
    .expect_err("unsupported kind must be rejected");

    assert!(
        err.contains("docx") || err.contains("kind"),
        "error must mention the bad kind, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "bridge.ingest must not be invoked for unsupported kind"
    );
}

#[tokio::test]
async fn rag_upload_accepts_zero_chunks() {
    // Coverage gap: an empty input file produces 0 chunks from the
    // sidecar chunker. The pipeline must still persist the document
    // row + tags so the user sees their upload in the list.
    let store = RagStore::open_in_memory().expect("open store");
    let (bridge, _calls) = MockBridge::new(Vec::new());

    let doc_id = rag_upload_inner(
        &store,
        &bridge,
        UploadArgs {
            path: "/tmp/empty.md".into(),
            kind: "md".into(),
            title: "Empty".into(),
            tags: vec!["generic".into()],
        },
        None,
    )
    .await
    .expect("zero-chunk upload should succeed");

    assert!(doc_id > 0, "doc_id must be a real rowid");
    assert_eq!(
        store.count_chunks(doc_id).expect("count chunks"),
        0,
        "no chunks should have been persisted"
    );
    let docs = store.list_documents().expect("list documents");
    let row = docs
        .iter()
        .find(|d| d.id == doc_id)
        .expect("doc row should be listed");
    assert_eq!(
        row.chunk_count, 0,
        "list_documents must surface chunk_count=0"
    );
    assert_eq!(
        store.list_tags(doc_id).expect("list tags"),
        vec!["generic".to_string()],
        "tags must persist even when there are no chunks"
    );
}

#[tokio::test]
async fn rag_upload_listed_after_persist() {
    let store = RagStore::open_in_memory().expect("open store");
    let (bridge, _calls) = three_chunk_bridge();

    let doc_id = rag_upload_inner(
        &store,
        &bridge,
        UploadArgs {
            path: "/tmp/x.md".into(),
            kind: "md".into(),
            title: "Hello Doc".into(),
            tags: vec!["generic".into()],
        },
        None,
    )
    .await
    .expect("upload should succeed");

    let docs = store.list_documents().expect("list documents");
    assert_eq!(docs.len(), 1, "exactly one doc should be listed");
    let row = &docs[0];
    assert_eq!(row.id, doc_id);
    assert_eq!(row.title, "Hello Doc");
    assert_eq!(row.kind, "md");
    assert_eq!(row.chunk_count, 3);
    assert_eq!(row.tags, vec!["generic".to_string()]);
}

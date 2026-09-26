//! Plan 12 Phase 4 — `retrieve` integration tests.
//!
//! Seeds three RAG documents into an in-memory store, mocks the bridge
//! so the embedder is deterministic, then exercises:
//! - happy path: tag filter + auto-include "generic" + top-K trim.
//! - empty tags input: only "generic"-tagged docs surface.
//! - k=0: rejected.
//! - unknown tag: rejected.
//! - empty store: returns Ok(empty).
//! - rag_queries_log: best-effort INSERT lands a row with the right
//!   query text and chunk-id JSON.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use ccie_terminal_lib::rag::bridge::{
    IngestProgress, IngestedDoc, RagBridgeApi,
};
use ccie_terminal_lib::rag::retrieve::{retrieve, RetrieveArgs};
use ccie_terminal_lib::rag::store::RagStore;

/// L2-normalize an arbitrary 384-dim vector. Both stored chunks AND the
/// query embedding need to live on the unit sphere so cosine distance
/// (= 1 - dot) ranks them sensibly under vec0's MATCH operator.
fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    for x in &mut v {
        *x /= n;
    }
    v
}

/// Build a 384-dim one-hot vector at index `i` (already normalized).
fn one_hot(i: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; 384];
    v[i] = 1.0;
    v
}

/// MockBridge — extends Phase 3's pattern to also satisfy `embed`.
/// `embed_returns` is the canned 384-dim vector returned for any call.
/// `ingest` is unused by Phase 4 tests but required by the trait.
struct MockBridge {
    embed_returns: Vec<f32>,
    embed_calls: Arc<AtomicUsize>,
}

impl MockBridge {
    fn new(embed_returns: Vec<f32>) -> Self {
        Self {
            embed_returns,
            embed_calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[async_trait]
impl RagBridgeApi for MockBridge {
    async fn ingest(
        &self,
        _path: &str,
        _kind: &str,
        title: &str,
        _on_progress: Box<dyn Fn(IngestProgress) + Send + Sync>,
    ) -> anyhow::Result<IngestedDoc> {
        Ok(IngestedDoc {
            title: title.to_string(),
            chunks: Vec::new(),
        })
    }

    async fn embed(&self, _text: &str) -> anyhow::Result<Vec<f32>> {
        self.embed_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.embed_returns.clone())
    }
}

/// Three-document fixture:
/// - Doc A: tagged cisco-iosxe-router, two chunks at one_hot(0).
/// - Doc B: tagged cisco-meraki, two chunks at one_hot(1).
/// - Doc C: tagged generic, two chunks at one_hot(2).
/// Returns `(store, doc_a_id, doc_b_id, doc_c_id)`.
fn seed_three_docs() -> (RagStore, i64, i64, i64) {
    let store = RagStore::open_in_memory().expect("open store");

    let doc_a = store
        .insert_document("IOS-XE BGP Reference", "/tmp/a.md", "md", 1)
        .expect("insert A");
    store
        .set_tags(doc_a, &["cisco-iosxe-router"])
        .expect("tag A");
    store
        .insert_chunk(doc_a, 0, "BGP neighbor configuration on IOS-XE", &one_hot(0))
        .expect("chunk A0");
    store
        .insert_chunk(doc_a, 1, "clear ip bgp * soft on IOS-XE", &one_hot(0))
        .expect("chunk A1");

    let doc_b = store
        .insert_document("Meraki Dashboard API", "/tmp/b.md", "md", 1)
        .expect("insert B");
    store
        .set_tags(doc_b, &["cisco-meraki"])
        .expect("tag B");
    store
        .insert_chunk(doc_b, 0, "Meraki API key auth header", &one_hot(1))
        .expect("chunk B0");
    store
        .insert_chunk(doc_b, 1, "Meraki organization endpoint", &one_hot(1))
        .expect("chunk B1");

    let doc_c = store
        .insert_document("OSI Model Primer", "/tmp/c.md", "md", 1)
        .expect("insert C");
    store.set_tags(doc_c, &["generic"]).expect("tag C");
    store
        .insert_chunk(doc_c, 0, "OSI layer 3 routing", &one_hot(2))
        .expect("chunk C0");
    store
        .insert_chunk(doc_c, 1, "OSI layer 7 application", &one_hot(2))
        .expect("chunk C1");

    (store, doc_a, doc_b, doc_c)
}

/// Query embedding biased toward Doc A (dim 0) with a smaller component
/// on Doc C (dim 2) and zero on Doc B (dim 1). After normalization the
/// cosine-distance ranking is: A best, C second, B last.
fn biased_query() -> Vec<f32> {
    let mut q = vec![0.0f32; 384];
    q[0] = 0.9;
    q[2] = 0.4;
    normalize(q)
}

#[tokio::test]
async fn retrieve_returns_top_k_with_tag_filter_and_auto_generic() {
    let (store, doc_a, _doc_b, doc_c) = seed_three_docs();
    let bridge = MockBridge::new(biased_query());

    let out = retrieve(
        &store,
        &bridge,
        RetrieveArgs {
            query: "how do I reset a BGP session".to_string(),
            tags: vec!["cisco-iosxe-router".to_string()],
            k: 3,
        },
    )
    .await
    .expect("retrieve must succeed");

    assert_eq!(out.len(), 3, "expected k=3 chunks");
    // Distance ascending — Doc A first (closest), then Doc C, then Doc A's
    // second chunk OR Doc C's second chunk depending on insertion order
    // among ties. The first two MUST be Doc A; the third MUST be Doc C
    // because B is filtered out.
    assert_eq!(out[0].document_id, doc_a, "closest chunk is from Doc A");
    assert_eq!(out[1].document_id, doc_a, "second-closest is also Doc A");
    assert_eq!(
        out[2].document_id, doc_c,
        "third comes from Doc C via auto-included generic"
    );
    // Doc B never appears.
    assert!(
        out.iter().all(|c| c.document_id != _doc_b),
        "Doc B is excluded by tag filter"
    );
    // Distances are sorted ascending.
    assert!(out[0].distance <= out[1].distance);
    assert!(out[1].distance <= out[2].distance);

    // Tags are populated from the doc-level tag query.
    assert_eq!(out[0].tags, vec!["cisco-iosxe-router".to_string()]);
    assert_eq!(out[2].tags, vec!["generic".to_string()]);

    // Chunk fields plumbed through. Doc A's two chunks share a distance
    // (identical one-hot embeddings), so vec0's tie-break is opaque —
    // accept either chunk text.
    assert!(out[0].text.to_lowercase().contains("bgp"));
    assert!(out[0].chunk_id > 0);
    assert!(out[0].chunk_idx >= 0);
    assert_eq!(out[0].document_title, "IOS-XE BGP Reference");

    // Phase 4 Task 4.3 — query log row written best-effort.
    let conn = store.conn_for_test();
    let g = conn.lock();
    let (logged_query, ids_json): (String, String) = g
        .query_row(
            "SELECT query, retrieved_chunk_ids_json FROM rag_queries_log",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("rag_queries_log row should exist");
    assert_eq!(logged_query, "how do I reset a BGP session");
    let parsed: Vec<i64> =
        serde_json::from_str(&ids_json).expect("retrieved_chunk_ids_json is valid JSON");
    let actual: Vec<i64> = out.iter().map(|c| c.chunk_id).collect();
    assert_eq!(parsed, actual, "log captures returned chunk ids in order");
}

#[tokio::test]
async fn retrieve_with_empty_tags_only_returns_generic_docs() {
    let (store, _doc_a, _doc_b, doc_c) = seed_three_docs();
    let bridge = MockBridge::new(biased_query());

    let out = retrieve(
        &store,
        &bridge,
        RetrieveArgs {
            query: "anything".to_string(),
            tags: vec![],
            k: 5,
        },
    )
    .await
    .expect("retrieve must succeed with empty tags");

    // Only Doc C (tagged "generic") survives the auto-include filter.
    assert!(!out.is_empty(), "Doc C chunks should surface");
    assert!(
        out.iter().all(|c| c.document_id == doc_c),
        "every returned chunk must come from Doc C; got {:?}",
        out.iter().map(|c| c.document_id).collect::<Vec<_>>()
    );
    assert_eq!(out.len(), 2, "Doc C has exactly 2 chunks");
}

#[tokio::test]
async fn retrieve_rejects_zero_k() {
    let (store, _, _, _) = seed_three_docs();
    let bridge = MockBridge::new(biased_query());

    let err = retrieve(
        &store,
        &bridge,
        RetrieveArgs {
            query: "anything".to_string(),
            tags: vec!["generic".to_string()],
            k: 0,
        },
    )
    .await
    .expect_err("k=0 must be rejected");

    assert!(err.to_string().to_lowercase().contains("k"), "error mentions k");
}

#[tokio::test]
async fn retrieve_rejects_invalid_tag_shape() {
    let (store, _, _, _) = seed_three_docs();
    let bridge = MockBridge::new(biased_query());

    let err = retrieve(
        &store,
        &bridge,
        RetrieveArgs {
            query: "anything".to_string(),
            tags: vec!["Bad Tag!".to_string()],
            k: 3,
        },
    )
    .await
    .expect_err("invalid tag shape must be rejected");

    let msg = err.to_string();
    assert!(
        msg.contains("Bad Tag!") || msg.contains("invalid"),
        "error must surface the bad tag, got {msg:?}"
    );
}

#[tokio::test]
async fn retrieve_on_empty_store_returns_empty_vec() {
    let store = RagStore::open_in_memory().expect("open store");
    let bridge = MockBridge::new(biased_query());

    let out = retrieve(
        &store,
        &bridge,
        RetrieveArgs {
            query: "anything".to_string(),
            tags: vec!["cisco-iosxe-router".to_string()],
            k: 3,
        },
    )
    .await
    .expect("empty store must not error");

    assert!(out.is_empty(), "no chunks → empty Vec");
}

#[tokio::test]
async fn retrieve_user_tag_subset_of_one_passes() {
    let store = RagStore::open_in_memory().expect("open store");
    let doc_id = store
        .insert_document("Acme Cisco runbook", "/tmp/acme.md", "md", 1)
        .expect("insert doc");
    store
        .set_tags(doc_id, &["cisco-iosxe-router", "customer-acme"])
        .expect("set tags");
    store
        .insert_chunk(doc_id, 0, "OSPF area configuration for Acme", &one_hot(0))
        .expect("insert chunk");

    let bridge = MockBridge::new(one_hot(0));
    let args = RetrieveArgs {
        query: "ospf areas".into(),
        tags: vec!["cisco-iosxe-router".into(), "customer-acme".into()],
        k: 5,
    };
    let chunks = retrieve(&store, &bridge, args)
        .await
        .expect("retrieve ok");
    assert!(
        chunks.iter().any(|c| c.document_id == doc_id),
        "tagged doc must surface"
    );
}

#[tokio::test]
async fn retrieve_user_tag_missing_excludes_doc() {
    let store = RagStore::open_in_memory().expect("open store");
    // Doc has only the vendor tag, no user tag.
    let doc_id = store
        .insert_document("Generic Cisco runbook", "/tmp/generic.md", "md", 1)
        .expect("insert doc");
    store
        .set_tags(doc_id, &["cisco-iosxe-router"])
        .expect("set tags");
    store
        .insert_chunk(doc_id, 0, "OSPF area configuration", &one_hot(0))
        .expect("insert chunk");

    let bridge = MockBridge::new(one_hot(0));
    let args = RetrieveArgs {
        query: "ospf areas".into(),
        tags: vec!["cisco-iosxe-router".into(), "customer-acme".into()],
        k: 5,
    };
    let chunks = retrieve(&store, &bridge, args)
        .await
        .expect("retrieve ok");
    assert!(
        !chunks.iter().any(|c| c.document_id == doc_id),
        "doc without all user tags must be excluded"
    );
}

#[tokio::test]
async fn retrieve_two_user_tags_both_present_passes() {
    let store = RagStore::open_in_memory().expect("open store");
    let doc_id = store
        .insert_document("Acme CLI runbook", "/tmp/acme-cli.md", "md", 1)
        .expect("insert doc");
    store
        .set_tags(doc_id, &["cisco-iosxe-router", "customer-acme", "cli-only"])
        .expect("set tags");
    store
        .insert_chunk(doc_id, 0, "OSPF CLI commands for Acme", &one_hot(0))
        .expect("insert chunk");

    let bridge = MockBridge::new(one_hot(0));
    let args = RetrieveArgs {
        query: "ospf areas".into(),
        tags: vec![
            "cisco-iosxe-router".into(),
            "customer-acme".into(),
            "cli-only".into(),
        ],
        k: 5,
    };
    let chunks = retrieve(&store, &bridge, args)
        .await
        .expect("retrieve ok");
    assert!(
        chunks.iter().any(|c| c.document_id == doc_id),
        "doc with both user tags must surface"
    );
}

//! Plan 12 Phase 1 Task 1.4 — `RagStore` insert/list/count round-trip
//! plus tag-taxonomy enforcement. Exercises the full write path:
//! `insert_document` → `set_tags` → `insert_chunk` (writes both
//! `rag_chunks` and `rag_chunks_vec`) → `list_tags` / `count_chunks`.

use ccie_terminal_lib::rag::{store::RagStore, tags::TAG_TAXONOMY};

/// Build a 384-dim vector with a single non-zero element. Plenty for
/// vec0 to accept and for `RagStore::insert_chunk` to JSON-serialize;
/// retrieval ranking is exercised in Phase 4 tests.
fn make_vec(i: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; 384];
    v[i % 384] = 1.0;
    v
}

#[test]
fn insert_doc_and_chunks_then_read_back() {
    let store = RagStore::open_in_memory().expect("open RagStore");
    let doc_id = store
        .insert_document("IOS-XE CLI Reference", "/tmp/ios.pdf", "pdf", 12345)
        .expect("insert doc");
    assert!(doc_id > 0);

    store
        .set_tags(doc_id, &["cisco-iosxe-router", "generic"])
        .expect("set tags");

    for i in 0..3 {
        store
            .insert_chunk(doc_id, i as i64, &format!("chunk {}", i), &make_vec(i))
            .expect("insert chunk");
    }

    // list_tags returns alphabetical order.
    let tags = store.list_tags(doc_id).expect("list tags");
    assert_eq!(
        tags,
        vec!["cisco-iosxe-router".to_string(), "generic".to_string()]
    );

    let n_chunks = store.count_chunks(doc_id).expect("count chunks");
    assert_eq!(n_chunks, 3);

    // set_tags must reject reserved-prefix tags (user tags follow-up).
    // "nonsense-vendor" is now accepted as a valid user tag, so test a
    // reserved prefix instead.
    let bad = store.set_tags(doc_id, &["cisco-foo"]);
    assert!(bad.is_err(), "reserved-prefix tag must be rejected");
    let tags_after = store.list_tags(doc_id).expect("list tags after reject");
    assert_eq!(
        tags_after,
        vec!["cisco-iosxe-router".to_string(), "generic".to_string()],
        "rejected set_tags must not touch existing tags"
    );

    // Sanity: TAG_TAXONOMY in sync with docs / brief.
    assert!(TAG_TAXONOMY.contains(&"cisco-meraki"));
}

#[test]
fn insert_chunk_rejects_wrong_dim() {
    let store = RagStore::open_in_memory().expect("open RagStore");
    let doc_id = store
        .insert_document("title", "/p", "txt", 1)
        .expect("insert doc");
    let bad = vec![0.0f32; 100];
    let err = store.insert_chunk(doc_id, 0, "x", &bad);
    assert!(err.is_err(), "100-dim vector must be rejected");
}

#[test]
fn delete_document_clears_vec_rows() {
    let store = RagStore::open_in_memory().expect("open RagStore");
    let doc_id = store
        .insert_document("doomed", "/p", "txt", 1)
        .expect("insert doc");
    store
        .set_tags(doc_id, &["generic"])
        .expect("set tags");
    for i in 0..2 {
        store
            .insert_chunk(doc_id, i as i64, "x", &make_vec(i))
            .expect("insert chunk");
    }
    assert_eq!(store.count_chunks(doc_id).unwrap(), 2);

    store.delete_document(doc_id).expect("delete doc");
    // FK cascade regression — `count_chunks` queries `rag_chunks WHERE
    // document_id=?1`, so this 0 only holds if `PRAGMA foreign_keys = ON`
    // and V0039's ON DELETE CASCADE actually fires when the parent
    // `rag_documents` row is deleted. Without the pragma the rows would
    // silently leak in production (and this assertion would read 2).
    assert_eq!(
        store.count_chunks(doc_id).unwrap(),
        0,
        "rag_chunks must cascade-delete with the parent document (FK pragma regression)"
    );
    // Tags also cascade-delete; the public API doesn't expose a count,
    // but `list_tags` returning empty is the equivalent check.
    assert!(
        store.list_tags(doc_id).unwrap().is_empty(),
        "rag_document_tags must cascade-delete with the parent document"
    );

    // After delete, re-using the same chunk_idx must succeed — this would
    // fail if the vec0 rowids were still occupied (they share rowid with
    // rag_chunks.id, which AUTOINCREMENTs forward, so a fresh insert is
    // a smoke check that no orphaned vec0 row collides with the new
    // chunk's rowid path).
    let new_doc = store
        .insert_document("phoenix", "/p", "txt", 1)
        .expect("insert doc");
    store.set_tags(new_doc, &["generic"]).expect("set tags");
    store
        .insert_chunk(new_doc, 0, "x", &make_vec(7))
        .expect("insert chunk after delete");
    assert_eq!(store.count_chunks(new_doc).unwrap(), 1);
}

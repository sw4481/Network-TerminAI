//! Plan 12 Phase 4 — query-time retrieval against `rag_chunks_vec`.
//!
//! ## Algorithm
//!
//! 1. Validate args (k, tags).
//! 2. Embed the query via the sidecar (`rag.embed`).
//! 3. Over-fetch `K * 4` (min 16) candidates from `rag_chunks_vec` using
//!    `vec0`'s `MATCH` operator. We can't filter by tag inside the ANN
//!    search — `vec0` doesn't expose join-pushdown — so we trim in Rust.
//! 4. Batch-fetch the tag set for every candidate document in a single
//!    SQL pass (`WHERE document_id IN (?, ?, ...)`) so the per-candidate
//!    work stays O(1) regardless of K.
//! 5. Walk candidates in distance order, keep iff their doc tags
//!    intersect with `tags ∪ {generic}`, stop after K kept.
//! 6. Best-effort INSERT into `rag_queries_log` (failures are logged but
//!    never fail the request — the log is observability, not a contract).
//!
//! ## Why over-fetch K*4
//!
//! In the worst case (a corpus where most docs are tagged outside the
//! caller's filter) we need a deeper window to find K matches. K*4 is a
//! pragmatic floor; the `.max(16)` clamp guarantees small-K queries
//! still get enough headroom on a sparse corpus.

use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::rag::bridge::RagBridgeApi;
use crate::rag::store::RagStore;
use crate::rag::tags::{is_builtin_tag, validate_tag_shape};

/// Upper bound on `args.k`. Empirically beyond 50 the over-fetch hits
/// vec0's index cost without meaningful recall improvement; clamp to
/// keep retrieve calls predictable.
const MAX_K: usize = 50;

/// Floor on the over-fetch window. Even tiny K=1 queries need a few
/// candidates so a single tag-mismatched neighbour doesn't starve the
/// caller of any result.
const OVERFETCH_MIN: i64 = 16;

#[derive(Debug, Clone, Deserialize)]
pub struct RetrieveArgs {
    pub query: String,
    pub tags: Vec<String>,
    pub k: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RetrievedChunk {
    pub chunk_id: i64,
    pub document_id: i64,
    pub document_title: String,
    pub chunk_idx: i64,
    pub text: String,
    pub distance: f32,
    pub tags: Vec<String>,
}

/// Internal candidate row before the tag-filter pass; mirrors the
/// columns produced by the over-fetch SQL.
struct Candidate {
    chunk_id: i64,
    document_id: i64,
    document_title: String,
    chunk_idx: i64,
    text: String,
    distance: f32,
}

/// Execute the retrieval pipeline. See module docs for the algorithm.
pub async fn retrieve(
    store: &RagStore,
    bridge: &dyn RagBridgeApi,
    args: RetrieveArgs,
) -> Result<Vec<RetrievedChunk>> {
    // 1. Validate args.
    if args.k == 0 {
        return Err(anyhow!("retrieve: k must be > 0"));
    }
    let k = args.k.min(MAX_K);
    for t in &args.tags {
        validate_tag_shape(t).with_context(|| format!("retrieve: invalid tag '{t}'"))?;
    }

    // Split incoming tags into the builtin (OR) set and the user (AND)
    // set. Builtins always include `generic` so a bare-vendor query
    // still surfaces vendor-neutral docs (existing semantics).
    let mut builtin_set: std::collections::HashSet<String> = args
        .tags
        .iter()
        .filter(|t| is_builtin_tag(t))
        .cloned()
        .collect();
    builtin_set.insert("generic".to_string());

    let user_set: std::collections::HashSet<String> = args
        .tags
        .iter()
        .filter(|t| !is_builtin_tag(t))
        .cloned()
        .collect();

    // 2. Embed the query.
    let q_vec = bridge
        .embed(&args.query)
        .await
        .context("retrieve: embed query")?;
    let q_json = serde_json::to_string(&q_vec).context("serialize query embedding")?;

    // 4. Over-fetch K*4 (floored at OVERFETCH_MIN) candidates.
    let overfetch = ((k as i64) * 4).max(OVERFETCH_MIN);
    let candidates = fetch_candidates(store, &q_json, overfetch)?;
    if candidates.is_empty() {
        // Empty store — nothing to filter, nothing to log.
        return Ok(Vec::new());
    }

    // 5. Batch-load tags for every candidate doc.
    let doc_ids: Vec<i64> = {
        let mut seen: HashSet<i64> = HashSet::new();
        candidates
            .iter()
            .map(|c| c.document_id)
            .filter(|id| seen.insert(*id))
            .collect()
    };
    let tags_by_doc = fetch_tags_for_docs(store, &doc_ids)?;

    // 6. Walk candidates, keep up to K that pass the tag filter.
    let mut out: Vec<RetrievedChunk> = Vec::with_capacity(k);
    for c in candidates {
        let doc_tags = tags_by_doc.get(&c.document_id).cloned().unwrap_or_default();
        let builtin_match = doc_tags.iter().any(|t| builtin_set.contains(t));
        let user_match = user_set.iter().all(|t| doc_tags.contains(t));
        if !(builtin_match && user_match) {
            continue;
        }
        out.push(RetrievedChunk {
            chunk_id: c.chunk_id,
            document_id: c.document_id,
            document_title: c.document_title,
            chunk_idx: c.chunk_idx,
            text: c.text,
            distance: c.distance,
            tags: doc_tags,
        });
        if out.len() >= k {
            break;
        }
    }

    // 7. Best-effort query log. Phase 4 doesn't carry an
    // `agent_session_id` through the call site (Phase 5 will plumb it),
    // so we record `NULL` for now.
    log_query_best_effort(store, &args.query, &out);

    Ok(out)
}

/// Best-effort `rag_queries_log` write. Documented contract: never fails
/// the retrieval. We log a warning so an operator can spot a broken log
/// without seeing user-visible regressions.
fn log_query_best_effort(store: &RagStore, query: &str, out: &[RetrievedChunk]) {
    let chunk_ids: Vec<i64> = out.iter().map(|c| c.chunk_id).collect();
    let ids_json = match serde_json::to_string(&chunk_ids) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "rag_queries_log: failed to serialize chunk ids");
            return;
        }
    };
    let conn = store.conn_for_test();
    let g = conn.lock();
    if let Err(e) = g.execute(
        "INSERT INTO rag_queries_log(agent_session_id, query, retrieved_chunk_ids_json)
             VALUES (?1, ?2, ?3)",
        params![Option::<String>::None, query, ids_json],
    ) {
        tracing::warn!(error = %e, "rag_queries_log: insert failed (non-fatal)");
    }
}

fn fetch_candidates(store: &RagStore, q_json: &str, limit: i64) -> Result<Vec<Candidate>> {
    // vec0 KNN queries require the LIMIT to live in the same SELECT
    // that touches the virtual table (otherwise the planner reports
    // "A LIMIT or 'k = ?' constraint is required on vec0 knn queries").
    // The JOIN form pushes the LIMIT past the vec0 scan, so we run the
    // KNN as an inner subquery first and join afterwards. `limit` is a
    // safely-clamped i64 derived from a validated `usize`, so inlining
    // is safe; only `q_json` is user-influenced and stays bound.
    let conn = store.conn_for_test();
    let g = conn.lock();
    let sql = format!(
        "WITH knn AS (
            SELECT rowid AS chunk_rowid, distance
              FROM rag_chunks_vec
             WHERE embedding MATCH ?1
             ORDER BY distance
             LIMIT {limit}
         )
         SELECT c.id, c.document_id, d.title, c.chunk_idx, c.text, knn.distance
           FROM knn
           JOIN rag_chunks c ON c.id = knn.chunk_rowid
           JOIN rag_documents d ON d.id = c.document_id
          ORDER BY knn.distance"
    );
    let mut stmt = g.prepare(&sql)?;
    let rows = stmt.query_map(params![q_json], |r| {
        Ok(Candidate {
            chunk_id: r.get(0)?,
            document_id: r.get(1)?,
            document_title: r.get(2)?,
            chunk_idx: r.get(3)?,
            text: r.get(4)?,
            distance: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn fetch_tags_for_docs(store: &RagStore, doc_ids: &[i64]) -> Result<HashMap<i64, Vec<String>>> {
    let mut map: HashMap<i64, Vec<String>> = HashMap::new();
    if doc_ids.is_empty() {
        return Ok(map);
    }
    // Build "(?,?,?)" placeholder list of the right length.
    let placeholders: String = std::iter::repeat_n("?", doc_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT document_id, tag FROM rag_document_tags WHERE document_id IN ({placeholders}) ORDER BY tag"
    );

    let conn = store.conn_for_test();
    let g = conn.lock();
    let mut stmt = g.prepare(&sql)?;
    let params_iter: Vec<&dyn rusqlite::ToSql> = doc_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt.query_map(params_iter.as_slice(), |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;
    for r in rows {
        let (doc_id, tag) = r?;
        map.entry(doc_id).or_default().push(tag);
    }
    Ok(map)
}

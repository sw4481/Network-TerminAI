//! Plan 12 Phase 1 Task 1.4 — `RagStore` write path.
//!
//! Plan 12 Phase 3 refactor: the connection is wrapped in
//! `Arc<Mutex<Connection>>` so the production app can share the SAME
//! handle that `AppState.db` already holds. Opening a second on-disk
//! connection would race with refinery and break vec0 row ordering.
//! Phase 1's tests exercise the `open_in_memory` constructor, which
//! still works against a fresh in-memory connection.

use anyhow::{ensure, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::sync::Arc;

use super::tags::validate_tag_shape;
use super::vec::enable_vec_extension;

/// Embedding dimension expected by `rag_chunks_vec` (matches the ONNX
/// `all-MiniLM-L6-v2` model bundled in Plan 12 Phase 2). Centralising the
/// constant lets future model swaps land in one place + a migration.
pub const EMBEDDING_DIM: usize = 384;

/// One row per distinct non-builtin tag currently referenced by at
/// least one document. Returned by [`RagStore::list_user_tags`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UserTagSummary {
    pub tag: String,
    pub usage_count: i64,
}

#[derive(Clone)]
pub struct RagStore {
    pub(crate) conn: Arc<Mutex<Connection>>,
}

impl RagStore {
    /// Wrap an already-open connection. The production caller passes the
    /// same `Arc<Mutex<Connection>>` it stores in `AppState.db` so writes
    /// stay coherent with the rest of the schema.
    ///
    /// The caller is responsible for having registered sqlite-vec and
    /// run migrations on this connection — `open_and_migrate*` in
    /// `src-tauri/src/db.rs` handles both for the production flow.
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    /// Test-only accessor for the inner `Arc<Mutex<Connection>>` so
    /// integration tests can run ad-hoc SQL (e.g. assert that the
    /// `rag_queries_log` row Phase 4 writes actually landed). Not part
    /// of the production API surface — production code goes through the
    /// typed methods on `RagStore`.
    pub fn conn_for_test(&self) -> Arc<Mutex<Connection>> {
        self.conn.clone()
    }

    /// In-memory store with sqlite-vec registered + V0039 applied.
    /// Used by Phase 1 tests today; production wiring in Phase 3 calls
    /// [`RagStore::new`] with the app's shared `AppState.db` connection.
    pub fn open_in_memory() -> Result<Self> {
        // Register the sqlite-vec auto-extension BEFORE opening the
        // connection so vec0 is visible on it. `enable_vec_extension`
        // afterwards is the sanity-check pass.
        super::vec::register_vec_auto_extension();
        let mut conn = Connection::open_in_memory().context("open in-memory sqlite")?;
        // SQLite defaults to foreign_keys=OFF. V0039 relies on ON DELETE
        // CASCADE for rag_document_tags + rag_chunks; enable FKs BEFORE
        // running migrations so the pragma sticks for the connection's
        // lifetime and matches production behavior.
        conn.execute_batch("PRAGMA foreign_keys = ON")
            .context("enable foreign_keys pragma on RagStore connection")?;
        enable_vec_extension(&conn).context("register sqlite-vec on RagStore connection")?;
        crate::db::apply_migrations(&mut conn).context("apply migrations on RagStore")?;
        Ok(Self::new(Arc::new(Mutex::new(conn))))
    }

    /// Insert a `rag_documents` row and return the new id. Tag assignment
    /// is a separate call — `set_tags` validates each tag against the
    /// taxonomy.
    pub fn insert_document(
        &self,
        title: &str,
        source_path: &str,
        kind: &str,
        bytes: i64,
    ) -> Result<i64> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO rag_documents(title, source_path, kind, bytes)
                 VALUES (?1, ?2, ?3, ?4)",
            params![title, source_path, kind, bytes],
        )
        .context("insert rag_documents row")?;
        Ok(conn.last_insert_rowid())
    }

    /// Replace the tag set for `doc_id`. Each tag must pass
    /// `tags::validate_tag`; an unknown tag aborts the transaction so
    /// the caller's previous tag set is preserved on error.
    pub fn set_tags(&self, doc_id: i64, tags: &[&str]) -> Result<()> {
        // Validate up-front so we don't half-apply on the first bad tag.
        for t in tags {
            validate_tag_shape(t).with_context(|| format!("validate tag '{t}' for doc {doc_id}"))?;
        }
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM rag_document_tags WHERE document_id=?1",
            params![doc_id],
        )?;
        for t in tags {
            tx.execute(
                "INSERT OR IGNORE INTO rag_document_tags(document_id, tag) VALUES (?1, ?2)",
                params![doc_id, t],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Return the tags assigned to `doc_id`, sorted alphabetically so
    /// callers can use the result directly for stable display.
    pub fn list_tags(&self, doc_id: i64) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT tag FROM rag_document_tags WHERE document_id=?1 ORDER BY tag",
        )?;
        let rows = stmt.query_map(params![doc_id], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Enumerate every distinct tag in `rag_document_tags` that is NOT
    /// a member of [`super::tags::TAG_TAXONOMY`], with its usage count.
    /// Ordered by `usage_count desc, tag asc` so the picker UI can
    /// present popular tags first. The taxonomy filter happens in Rust
    /// rather than SQL because the builtin list is short and lives in
    /// code, not the database.
    pub fn list_user_tags(&self) -> Result<Vec<UserTagSummary>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT tag, COUNT(*) AS usage_count
                 FROM rag_document_tags
             GROUP BY tag",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut out: Vec<UserTagSummary> = Vec::new();
        for row in rows {
            let (tag, usage_count) = row?;
            if super::tags::is_builtin_tag(&tag) {
                continue;
            }
            out.push(UserTagSummary { tag, usage_count });
        }
        out.sort_by(|a, b| {
            b.usage_count
                .cmp(&a.usage_count)
                .then_with(|| a.tag.cmp(&b.tag))
        });
        Ok(out)
    }

    /// Persist a chunk's text + embedding. Writes go into both
    /// `rag_chunks` (with a little-endian f32 blob copy) and
    /// `rag_chunks_vec` (JSON literal — vec0's MATCH syntax).
    pub fn insert_chunk(
        &self,
        doc_id: i64,
        chunk_idx: i64,
        text: &str,
        embedding: &[f32],
    ) -> Result<i64> {
        ensure!(
            embedding.len() == EMBEDDING_DIM,
            "expected {EMBEDDING_DIM}-dim embedding, got {}",
            embedding.len()
        );
        let blob: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO rag_chunks(document_id, chunk_idx, text, embedding_blob)
             VALUES (?1, ?2, ?3, ?4)",
            params![doc_id, chunk_idx, text, blob],
        )?;
        let chunk_id = tx.last_insert_rowid();
        // vec0's MATCH-friendly insert format is the JSON array literal
        // (the same shape `serde_json::to_string(&[f32; 384])` produces).
        let vec_str = serde_json::to_string(embedding).context("serialize embedding to JSON")?;
        tx.execute(
            "INSERT INTO rag_chunks_vec(rowid, embedding) VALUES (?1, ?2)",
            params![chunk_id, vec_str],
        )?;
        tx.commit()?;
        Ok(chunk_id)
    }

    /// Number of chunks owned by `doc_id`.
    pub fn count_chunks(&self, doc_id: i64) -> Result<i64> {
        let conn = self.conn.lock();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM rag_chunks WHERE document_id=?1",
            params![doc_id],
            |r| r.get(0),
        )?)
    }

    /// Cascade-delete a document. Foreign keys do NOT propagate into
    /// vec0 virtual tables, so we manually clear the corresponding
    /// `rag_chunks_vec` rowids first; the FK ON DELETE CASCADE on
    /// `rag_chunks` then sweeps up the regular-table rows.
    pub fn delete_document(&self, doc_id: i64) -> Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM rag_chunks_vec
              WHERE rowid IN (SELECT id FROM rag_chunks WHERE document_id=?1)",
            params![doc_id],
        )?;
        tx.execute("DELETE FROM rag_documents WHERE id=?1", params![doc_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Plan 12 Phase 3 — list all RAG documents with a single SQL pass:
    /// LEFT JOIN tags + chunk count. Returns rows in reverse-chronological
    /// upload order (matches the day-grouping the UI expects).
    pub fn list_documents(&self) -> Result<Vec<DocSummary>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT d.id, d.title, d.kind, d.bytes, d.uploaded_at,
                    COALESCE(GROUP_CONCAT(t.tag, ','), '') AS tags_csv,
                    (SELECT COUNT(*) FROM rag_chunks c WHERE c.document_id = d.id) AS chunk_count
               FROM rag_documents d
               LEFT JOIN rag_document_tags t ON t.document_id = d.id
               GROUP BY d.id
               ORDER BY d.uploaded_at DESC, d.id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let tags_csv: String = r.get(5)?;
            let mut tags: Vec<String> = if tags_csv.is_empty() {
                Vec::new()
            } else {
                tags_csv.split(',').map(|s| s.to_string()).collect()
            };
            tags.sort();
            tags.dedup();
            Ok(DocSummary {
                id: r.get(0)?,
                title: r.get(1)?,
                kind: r.get(2)?,
                bytes: r.get(3)?,
                uploaded_at: r.get(4)?,
                tags,
                chunk_count: r.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

/// Row shape returned by [`RagStore::list_documents`]. Used by the
/// `rag_list_documents` Tauri command — kept in the store so callers
/// don't need to know the join shape.
#[derive(Debug, Clone)]
pub struct DocSummary {
    pub id: i64,
    pub title: String,
    pub kind: String,
    pub bytes: i64,
    pub uploaded_at: i64,
    pub tags: Vec<String>,
    pub chunk_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_tags_accepts_user_tag_shapes() {
        let store = RagStore::open_in_memory().expect("open store");
        let id = store
            .insert_document("Doc", "/tmp/d.md", "md", 10)
            .expect("insert");
        store
            .set_tags(id, &["cisco-iosxe-router", "customer-acme"])
            .expect("set_tags ok with mixed builtin + user");
        let tags = store.list_tags(id).expect("list_tags");
        assert!(tags.iter().any(|t| t == "cisco-iosxe-router"));
        assert!(tags.iter().any(|t| t == "customer-acme"));
    }

    #[test]
    fn set_tags_rejects_reserved_prefix() {
        let store = RagStore::open_in_memory().expect("open store");
        let id = store
            .insert_document("Doc", "/tmp/d.md", "md", 10)
            .expect("insert");
        let err = store
            .set_tags(id, &["cisco-foo"])
            .expect_err("reserved prefix must be rejected");
        let msg = format!("{err:#}");
        assert!(msg.contains("cisco-foo"), "msg = {msg}");
    }

    #[test]
    fn list_user_tags_excludes_builtins_and_orders_by_usage() {
        let store = RagStore::open_in_memory().expect("open store");
        let a = store
            .insert_document("A", "/tmp/a.md", "md", 1)
            .expect("insert a");
        let b = store
            .insert_document("B", "/tmp/b.md", "md", 1)
            .expect("insert b");
        store
            .set_tags(a, &["customer-acme", "generic"])
            .expect("tags a");
        store
            .set_tags(b, &["customer-acme", "project1"])
            .expect("tags b");
        let user = store.list_user_tags().expect("list_user_tags");
        // generic is builtin → filtered out.
        assert_eq!(user.len(), 2);
        assert_eq!(user[0].tag, "customer-acme");
        assert_eq!(user[0].usage_count, 2);
        assert_eq!(user[1].tag, "project1");
        assert_eq!(user[1].usage_count, 1);
    }
}

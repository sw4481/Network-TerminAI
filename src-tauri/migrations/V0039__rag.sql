-- V0039: vendor-aware RAG for AI agent completion (Plan 12 Phase 1).
-- Depends on: V0010 agent_sessions (for rag_queries_log.agent_session_id FK
-- semantics, though the column is intentionally NOT a hard FK so the log
-- survives a tab-row purge).
--
-- Ordering note: the `rag_chunks_vec` virtual table can only be created
-- after the `vec0` module is registered on the connection. The migration
-- runner in `src-tauri/src/db.rs` calls `rag::vec::enable_vec_extension`
-- BEFORE refinery runs, so by the time this file executes vec0 is
-- already loaded.

CREATE TABLE IF NOT EXISTS rag_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  source_path  TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('pdf','html','md','txt')),
  bytes        INTEGER NOT NULL,
  uploaded_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_uploaded
  ON rag_documents(uploaded_at DESC);

-- Fixed taxonomy enforced at app layer (see src-tauri/src/rag/tags.rs).
-- We do NOT put CHECK constraints here because the taxonomy may grow over
-- time; app-layer validation lets us introduce new tags without another
-- migration.
CREATE TABLE IF NOT EXISTS rag_document_tags (
  document_id INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  PRIMARY KEY (document_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_rag_document_tags_tag
  ON rag_document_tags(tag);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_idx       INTEGER NOT NULL,
  text            TEXT    NOT NULL,
  -- raw float32[384] little-endian, denormalized copy of vec0 data so we
  -- can re-index a corpus (e.g. switch embedding model) without a full
  -- re-extract pass.
  embedding_blob  BLOB,
  UNIQUE (document_id, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_document
  ON rag_chunks(document_id);

CREATE TABLE IF NOT EXISTS rag_queries_log (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- nullable: a NL prompt may be translated before any tab is selected.
  agent_session_id          TEXT,
  query                     TEXT    NOT NULL,
  -- JSON array of rag_chunks.id values that were returned for this query.
  retrieved_chunk_ids_json  TEXT    NOT NULL,
  asked_at                  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_rag_queries_log_session
  ON rag_queries_log(agent_session_id, asked_at DESC);

-- Virtual table for ANN search. Created in a separate statement because
-- SQLite requires the `vec0` module to be registered on the current
-- connection — we register it from Rust before refinery runs migrations.
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_vec USING vec0(embedding float[384]);

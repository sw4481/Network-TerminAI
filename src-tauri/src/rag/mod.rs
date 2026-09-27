//! Plan 12 — Vendor-aware RAG for AI agent completion.
//!
//! Phase 1 lays down:
//! - [`vec`] — register the `sqlite-vec` extension into the SQLite
//!   process (Decision B: safe-wrapper crate, no loose `.dylib`).
//! - [`tags`] — fixed taxonomy validated at the application layer.
//! - [`store`] — `RagStore` write path (documents, tags, chunks +
//!   `rag_chunks_vec` virtual table).
//!
//! Later phases add `bridge` (Phase 3) and `retrieve` (Phase 4); they
//! are intentionally absent here so an unfinished plan can't land
//! `pub mod` declarations that fail to compile.

pub mod bridge;
pub mod retrieve;
pub mod session_tags;
pub mod store;
pub mod tags;
pub mod vec;

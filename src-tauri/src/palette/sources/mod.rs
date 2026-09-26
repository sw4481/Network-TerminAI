//! Per-kind palette source modules.
//!
//! Each source exposes a `search(conn, query, scope, ...) -> Result<Vec<PaletteHit>>`
//! signature and returns `Ok(vec![])` when its backing table is absent so the
//! aggregator can degrade gracefully on partially-migrated DBs (e.g., before
//! Plan 02 / Plan 03 land their schema).

pub mod blocks;
pub mod commands;
pub mod devices;
pub mod notebooks;
pub mod ssh;
pub mod workflows;

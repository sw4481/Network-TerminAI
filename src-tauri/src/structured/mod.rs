//! Structured show-output layer (Plan 05).
//!
//! - `auto_parse`  — invoked when a `show *` block completes; parses raw
//!   output via the existing `ParserBridge` (Plan 00) and persists the result
//!   into `parsed_outputs` (V0032).
//! - `snapshot`    — CRUD on `parsed_snapshots` (Phase 3).
//! - `diff`        — public `diff_snapshots` API consumed by Plans 06 + 08.

pub mod auto_parse;
pub mod diff;
pub mod flatten;
pub mod pipe_filter;
pub mod snapshot;

pub use diff::{diff_snapshots, CellDiff, DiffStatus};

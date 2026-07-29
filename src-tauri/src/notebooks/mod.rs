//! Runnable notebooks (MOPs) — typed cell graph + parser + runtime engine.
//!
//! See `/Plans/03-notebooks-runnable-mops.md` for design rationale.
//!
//! - `model` — cell types and frontmatter shape (serde-friendly).
//! - `parser` — markdown-with-YAML-frontmatter ↔ cell graph round-trip.
//! - `substitution` — `{{var}}` interpolation for command/assertion cells.
//! - `runner` — sequential execution engine (state machine + control channel).

pub mod model;
pub mod parser;
pub mod runner;
pub mod seeds;
pub mod substitution;

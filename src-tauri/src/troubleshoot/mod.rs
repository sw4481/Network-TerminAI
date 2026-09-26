//! Plan 15 — AI-Driven Troubleshooting Tree.
//!
//! Phase 1 ships:
//!   * [`playbook`] — strongly-typed Rust mirror of the YAML schema, parsed
//!     via `serde_yaml::from_str`. The variants of [`playbook::Step`] match
//!     the five `type:` discriminants in the sidecar JSON Schema.
//!   * [`seed`] — first-boot loader that `include_str!`s the six bundled
//!     YAML files and UPSERTs them with `builtin=1`. Idempotent (the
//!     `WHERE builtin=1` clause prevents trampling user-forked rows that
//!     happen to share an id).
//!
//! Phase 2 will add `engine.rs`, `context.rs`, and `live_executor.rs`, all
//! gated by Plan 09's `crate::guardrails::classifier::Tier::T0` — the
//! existing engine name. The plan's pseudocode mentions
//! `GuardrailTier::Tier0..Tier3` for clarity but actual implementation
//! reuses the project-wide [`crate::guardrails::classifier::Tier`] enum.

pub mod context;
pub mod engine;
pub mod live_executor;
pub mod narrator_bridge;
pub mod playbook;
pub mod seed;
pub mod state;

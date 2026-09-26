//! Plan 14 — Session recording.
//!
//! Per-tab opt-in PTY tap that runs a streaming redactor and writes
//! asciinema v2 `.cast` files. Recording is purely additive: when no tab
//! has an active recording, the supervisor does nothing and the PTY's
//! `try_send` tap call is a no-op.

pub mod asciinema;
pub mod patterns;
pub mod redactor;
pub mod supervisor;

//! AI guardrails — blast-radius classifier for commands sent to network
//! devices. See `Plans/09-ai-guardrails-blast-radius.md` for design.
//!
//! Public surface:
//!  * [`rules::Rule`] / [`rules::RuleSet`] — vendor/platform-scoped regex
//!    rules loaded from `builtin_rules.json` plus user-authored DB rows.
//!  * [`classifier::classify`] — pure function that returns a [`Decision`]
//!    given a vendor, platform, and command line.
//!  * [`decisions::record_decision`] — append-only writer into the
//!    `guardrail_decisions` audit table.
//!  * [`hook_points`] — the call sites in NETCONF and SSH-to-device paths
//!    that consult the classifier before sending commands to the wire.
//!    Local PTY tabs are deliberately NOT classified — see
//!    `pty_guardrail_bypass_test.rs` for the scope-guard regression.

pub mod ambiguity;
pub mod classifier;
pub mod decisions;
pub mod hook;
pub mod impact;
pub mod rules;
pub mod shell_split;

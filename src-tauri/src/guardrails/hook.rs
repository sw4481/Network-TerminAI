//! Helper invoked by the NETCONF and SSH-to-device send paths to classify
//! a CLI command and decide whether to proceed (Tier 0) or hand off to the
//! frontend for confirmation (Tier 1+ / Ambiguous).
//!
//! **Scope guard:** This module is only ever called from network-device
//! send paths. Local PTY writes (`src/pty.rs`) deliberately bypass this —
//! see `tests/pty_guardrail_bypass_test.rs` for the regression that
//! enforces it.

use super::classifier::{self, Tier};
use super::decisions::{self, DecisionRecord};
use super::rules::RuleSet;
use anyhow::Result;
use rusqlite::Connection;

pub struct GuardrailContext<'a> {
    pub ruleset: &'a RuleSet,
    pub db: &'a Connection,
    pub vendor: String,
    pub platform: String,
    pub session_id: String,
}

#[derive(Debug, Clone)]
pub enum GuardrailOutcome {
    /// Tier 0 — auto-approved. The send path may proceed immediately. The
    /// decision has already been written to `guardrail_decisions`.
    Proceed { decision_id: String },
    /// Tier 1+/Ambiguous — caller emits a `guardrail:pending` event with
    /// the returned `pending_id` and awaits a frontend resolution before
    /// sending bytes to the wire.
    NeedsConfirmation { pending_id: String, tier: Tier },
}

pub fn classify_and_gate(ctx: &GuardrailContext, command: &str) -> Result<GuardrailOutcome> {
    let d = classifier::classify(ctx.ruleset, &ctx.vendor, &ctx.platform, command);
    match d.tier {
        Tier::T0 => {
            let id = decisions::record_decision(
                ctx.db,
                &DecisionRecord {
                    id: String::new(),
                    session_id: ctx.session_id.clone(),
                    command: command.to_string(),
                    tier: 0,
                    rule_id: d.rule_id,
                    decision: "auto_approved".into(),
                    user_action: Some("proceed".into()),
                    reasoning: d.reasoning,
                },
            )?;
            Ok(GuardrailOutcome::Proceed { decision_id: id })
        }
        _ => {
            let pending_id = uuid::Uuid::new_v4().to_string();
            Ok(GuardrailOutcome::NeedsConfirmation {
                pending_id,
                tier: d.tier,
            })
        }
    }
}

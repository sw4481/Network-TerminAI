//! LLM second-opinion classifier — invoked when the rule engine returns
//! `Tier::Ambiguous` AND the agent's policy permits it. The LLM result is
//! trusted only as far as it RAISES the tier; it can never lower a tier
//! below what the rule engine already decided.

use crate::agent_bridge::{AgentBridge, AgentResponse};
use crate::guardrails::classifier::Tier;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecondOpinion {
    pub tier: u8,
    pub reasoning: String,
}

/// Ask the sidecar to classify the command. Used for ambiguous cases where
/// the rule engine could not decide. Returns the LLM-suggested tier; the
/// caller is responsible for *raising* the rule-engine tier (never lowering).
pub async fn second_opinion(
    bridge: Arc<AgentBridge>,
    vendor: &str,
    platform: &str,
    command: &str,
) -> Result<SecondOpinion> {
    let resp = bridge
        .call(
            "guardrail.classify",
            json!({
                "vendor": vendor,
                "platform": platform,
                "command": command,
            }),
        )
        .await
        .context("agent bridge call guardrail.classify")?;

    match resp {
        AgentResponse::Done { result } => {
            let tier_raw = result
                .get("tier")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| anyhow::anyhow!("missing/invalid `tier` in second-opinion response"))?;
            let tier = (tier_raw as u8).min(3);
            let reasoning = result
                .get("reasoning")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(SecondOpinion { tier, reasoning })
        }
        AgentResponse::Error { message } => Err(anyhow::anyhow!(
            "guardrail.classify returned error: {message}"
        )),
        // Streaming token responses are not used by `call`; treat as infra
        // anomaly.
        other => Err(anyhow::anyhow!(
            "unexpected guardrail.classify response variant: {:?}",
            other
        )),
    }
}

/// Combine a rule-engine decision with an LLM second opinion. The LLM may
/// only raise the tier; if it suggests lower, we keep the rule-engine
/// tier. For Ambiguous, the safety floor is T2 (typed confirm) so an LLM
/// that says "T0/T1" cannot auto-approve unknown commands.
pub fn merge(rule_tier: Tier, llm: &SecondOpinion) -> Tier {
    let llm_tier = match llm.tier {
        0 => Tier::T0,
        1 => Tier::T1,
        2 => Tier::T2,
        3 => Tier::T3,
        _ => Tier::Ambiguous,
    };
    match rule_tier {
        Tier::T0 => Tier::T0, // already auto-approved; LLM cannot raise
        Tier::T1 | Tier::T2 | Tier::T3 => {
            // Allow LLM to raise above the rule engine, but never lower.
            if (llm_tier as u8) > (rule_tier as u8) {
                llm_tier
            } else {
                rule_tier
            }
        }
        Tier::Ambiguous => {
            // Safety floor: never auto-approve an ambiguous command. If LLM
            // says T0/T1, treat as T2 (typed confirm). If LLM says T2/T3,
            // honor it.
            match llm.tier {
                0 | 1 => Tier::T2,
                2 => Tier::T2,
                3 => Tier::T3,
                _ => Tier::T2,
            }
        }
    }
}

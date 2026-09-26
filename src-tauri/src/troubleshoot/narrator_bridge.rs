//! Plan 15 Phase 3 — narrator/conclude bridge.
//!
//! This module is the seam between the troubleshoot engine and the
//! sidecar's `troubleshoot.narrate` / `troubleshoot.conclude` NDJSON
//! handlers. It exists so the integration test (`troubleshoot_narration_test.rs`)
//! can swap in a mock that returns canned JSON without spinning up a
//! real sidecar process or Tauri runtime.
//!
//! ## Why a separate trait?
//!
//! `AgentBridge` is a concrete struct that owns a `SidecarSupervisor`.
//! Tests can't construct one without a real subprocess. A trait gives
//! us a narrow seam — narrate + conclude — that the live impl
//! delegates to `AgentBridge::call` and the mock impl satisfies with
//! `Value` literals.
//!
//! The trait is `Send + Sync` so it can live inside an `Arc` shared
//! across the engine task.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

use super::context::{RunStatus, StepResult};
use crate::agent_bridge::{AgentBridge, AgentResponse};

/// Narrow seam over the sidecar's troubleshoot NDJSON methods.
#[async_trait]
pub trait NarratorBridge: Send + Sync {
    /// Call `troubleshoot.narrate` with the supplied payload. Returns
    /// the result `Value` on success. A sidecar-reported error or
    /// unexpected response shape returns `Ok(Value::Null)` so the
    /// caller can degrade gracefully — narration is advisory.
    async fn narrate(&self, payload: Value) -> Result<Value>;

    /// Call `troubleshoot.conclude` with the supplied payload. Same
    /// semantics as `narrate` — returns `Value::Null` on sidecar
    /// errors so the caller can persist a deterministic placeholder
    /// instead of crashing the run.
    async fn conclude(&self, payload: Value) -> Result<Value>;
}

/// Production implementation backed by the persistent sidecar.
pub struct LiveNarratorBridge {
    pub bridge: Arc<AgentBridge>,
}

impl LiveNarratorBridge {
    pub fn new(bridge: Arc<AgentBridge>) -> Self {
        Self { bridge }
    }
}

#[async_trait]
impl NarratorBridge for LiveNarratorBridge {
    async fn narrate(&self, payload: Value) -> Result<Value> {
        match self.bridge.call("troubleshoot.narrate", payload).await? {
            AgentResponse::Done { result } => Ok(result),
            AgentResponse::Error { message } => {
                tracing::warn!(error = %message, "troubleshoot.narrate sidecar error");
                Ok(Value::Null)
            }
            AgentResponse::Token { .. } => Ok(Value::Null),
        }
    }

    async fn conclude(&self, payload: Value) -> Result<Value> {
        match self.bridge.call("troubleshoot.conclude", payload).await? {
            AgentResponse::Done { result } => Ok(result),
            AgentResponse::Error { message } => {
                tracing::warn!(error = %message, "troubleshoot.conclude sidecar error");
                Ok(Value::Null)
            }
            AgentResponse::Token { .. } => Ok(Value::Null),
        }
    }
}

/// Default conclusion payload used when the sidecar handler is missing
/// or returns garbage. Fields are deliberately shaped like the
/// sidecar's `_coerce_conclusion` defaults so the UI can render the
/// same widget either way.
pub fn default_conclusion(symptom: &str) -> Value {
    serde_json::json!({
        "root_cause": format!(
            "Indeterminate root cause for symptom: {symptom}. Insufficient signal."
        ),
        "confidence": "low",
        "suggested_fix":
            "Re-run the playbook after collecting additional state. Escalate to a human operator if the symptom persists.",
        "evidence": Vec::<String>::new(),
    })
}

/// Coerce whatever the sidecar returned into a payload guaranteed to
/// have the four conclusion fields. The sidecar already does this on
/// its side via `_coerce_conclusion`, but we belt-and-braces here in
/// case the JSON is missing or shape-shifted.
pub fn ensure_conclusion_shape(value: Value, symptom: &str) -> Value {
    let mut obj = match value {
        Value::Object(m) => m,
        _ => return default_conclusion(symptom),
    };
    let default = match default_conclusion(symptom) {
        Value::Object(m) => m,
        _ => unreachable!("default_conclusion always returns an object"),
    };
    for (k, v) in default {
        obj.entry(k).or_insert(v);
    }
    // Force confidence to one of the three allowed values.
    let confidence = obj
        .get("confidence")
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "low".to_string());
    let allowed = matches!(confidence.as_str(), "low" | "medium" | "high");
    obj.insert(
        "confidence".to_string(),
        Value::String(if allowed { confidence } else { "low".to_string() }),
    );
    Value::Object(obj)
}

/// Build the `run_history` payload the sidecar's `troubleshoot.conclude`
/// handler expects. `step_types` is a parallel array — `step_types[i]`
/// is the YAML `type:` discriminant for `results[i]`. We keep the
/// payload small (no full `last_parsed` blobs) so the LLM's context
/// window doesn't drown in noise.
pub fn build_history_payload(results: &[StepResult], step_types: &[&str]) -> Value {
    let zipped = results
        .iter()
        .zip(step_types.iter())
        .map(|(r, t)| {
            serde_json::json!({
                "step_id": r.step_id,
                "step_type": t,
                "status": r.status.as_str(),
                "idx": r.idx,
                "result_json": r.result_json,
            })
        })
        .collect::<Vec<_>>();
    Value::Array(zipped)
}

/// True when the engine produced a terminal status (Completed or
/// Failed). Paused runs do NOT produce a conclusion — the operator
/// might still resume.
pub fn is_terminal(status: RunStatus) -> bool {
    matches!(status, RunStatus::Completed | RunStatus::Failed)
}

/// Produce a shaped conclusion for a terminal run by calling the
/// supplied narrator bridge and forcing the shape via
/// [`ensure_conclusion_shape`]. Errors / null responses fall back to
/// [`default_conclusion`] so the caller always has four well-typed
/// fields to persist.
pub async fn produce_conclusion(
    narrator: &dyn NarratorBridge,
    run_id: &str,
    symptom: &str,
    vendor: &str,
    platform: &str,
    final_status: RunStatus,
    results: &[StepResult],
    step_types: &[&str],
) -> Value {
    let payload = serde_json::json!({
        "run_id": run_id,
        "symptom": symptom,
        "vendor": vendor,
        "platform": platform,
        "status": final_status.as_str(),
        "run_history": build_history_payload(results, step_types),
    });
    let raw = match narrator.conclude(payload).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                run_id = %run_id,
                error = %e,
                "troubleshoot.conclude bridge error; using default conclusion"
            );
            default_conclusion(symptom)
        }
    };
    ensure_conclusion_shape(raw, symptom)
}

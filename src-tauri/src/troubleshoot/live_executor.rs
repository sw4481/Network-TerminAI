//! Plan 15 Phase 2 — production [`StepExecutor`] implementation.
//!
//! Wires the engine to:
//!
//!   * [`crate::guardrails::classifier::classify`] for the
//!     hard-gate classification pass (post variable substitution
//!     — substitution is performed inside the engine; this
//!     executor only sees the substituted command).
//!   * The Plan 00 parser bridge (`parse.request` NDJSON) for
//!     converting raw `show` output into structured JSON that
//!     subsequent `branch` / `assertion` steps can match
//!     against.
//!   * The Plan 12 RAG client (Phase 3 narration enrichment).
//!     Phase 2 uses [`AgentBridge::call`] with a stubbed
//!     `troubleshoot.narrate` method; sidecar handler lands in
//!     Phase 3. A missing handler is tolerated — the executor
//!     returns the literal text.
//!   * Tauri events `troubleshoot:user_prompt` for `user_prompt`
//!     steps. The engine pauses the run; `answer_prompt` is the
//!     resume path.

use anyhow::Result;
use async_trait::async_trait;
use parking_lot::RwLock;
use std::sync::Arc;
use tauri::Emitter;

use super::context::{RunContext, StepResult, StepStatus};
use super::engine::StepExecutor;
use crate::agent_bridge::{AgentBridge, AgentResponse};
use crate::guardrails::classifier::{classify as classify_fn, Tier};
use crate::guardrails::rules::RuleSet;
use crate::parsers::bridge::ParserBridge;

/// Trait alias for "something that can SSH-exec on a tab and
/// return the raw textual output". The production wiring uses
/// the existing Plan 03 PTY runner; the testing surface lets the
/// Phase 2.4 guardrail tests inject a mock that records every
/// call.
#[async_trait]
pub trait SshExec: Send + Sync {
    async fn exec(&self, tab_id: &str, command: &str) -> Result<String>;
}

pub struct LiveStepExecutor<R: tauri::Runtime> {
    pub bridge: Arc<AgentBridge>,
    pub guardrails: Arc<RwLock<RuleSet>>,
    pub parser_bridge: ParserBridge,
    pub ssh: Arc<dyn SshExec>,
    pub vendor: String,
    pub platform: String,
    pub app_handle: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> LiveStepExecutor<R> {
    pub fn new(
        bridge: Arc<AgentBridge>,
        guardrails: Arc<RwLock<RuleSet>>,
        parser_bridge: ParserBridge,
        ssh: Arc<dyn SshExec>,
        vendor: String,
        platform: String,
        app_handle: tauri::AppHandle<R>,
    ) -> Self {
        Self {
            bridge,
            guardrails,
            parser_bridge,
            ssh,
            vendor,
            platform,
            app_handle,
        }
    }
}

#[async_trait]
impl<R: tauri::Runtime> StepExecutor for LiveStepExecutor<R> {
    async fn run_command(
        &self,
        ctx: &mut RunContext,
        command: &str,
    ) -> Result<serde_json::Value> {
        // Engine has already substituted vars and re-classified —
        // we ONLY see Tier-0 commands here. Belt-and-braces:
        // re-classify once more so a misbehaving caller can never
        // bypass the gate. Scoped inside a block so the
        // RwLockReadGuard isn't held across the .await.
        let tier = {
            let rs = self.guardrails.read();
            classify_fn(&rs, &self.vendor, &self.platform, command).tier
        };
        if tier != Tier::T0 {
            anyhow::bail!(
                "LiveStepExecutor::run_command refuses non-Tier0 command (tier={}): {}",
                tier.as_str(),
                command
            );
        }

        let raw = self.ssh.exec(&ctx.tab_id, command).await?;
        let parsed = self
            .parser_bridge
            .parse(&self.vendor, &self.platform, command, &raw)
            .await
            .map(|p| p.data)
            .unwrap_or_else(|_| serde_json::json!({"raw": raw}));
        ctx.last_parsed = Some(parsed.clone());
        Ok(parsed)
    }

    async fn classify(
        &self,
        command: &str,
        vendor: &str,
        platform: &str,
    ) -> Result<Tier> {
        // Scope the RwLockReadGuard inside a block so the future
        // remains Send.
        let tier = {
            let rs = self.guardrails.read();
            classify_fn(&rs, vendor, platform, command).tier
        };
        Ok(tier)
    }

    async fn narrate(
        &self,
        ctx: &RunContext,
        step_id: &str,
        text: &str,
    ) -> Result<String> {
        let payload = serde_json::json!({
            "run_id": ctx.run_id,
            "tab_id": ctx.tab_id,
            "step_id": step_id,
            "text": text,
            "vendor": self.vendor,
            "platform": self.platform,
            "last_parsed": ctx.last_parsed,
        });
        // Phase 3 lands the sidecar handler; for Phase 2 a
        // missing or erroring handler must NOT abort the run —
        // narration is purely informational. Fall back to the
        // literal text.
        match self.bridge.call("troubleshoot.narrate", payload).await {
            Ok(AgentResponse::Done { result }) => {
                let rendered = result
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| text.to_string());
                let _ = self.app_handle.emit(
                    "troubleshoot:narration",
                    serde_json::json!({
                        "run_id": ctx.run_id,
                        "step_id": step_id,
                        "text": rendered,
                    }),
                );
                Ok(rendered)
            }
            _ => Ok(text.to_string()),
        }
    }

    async fn ask_user(
        &self,
        ctx: &RunContext,
        step_id: &str,
        prompt: &str,
    ) -> Result<Option<String>> {
        let _ = self.app_handle.emit(
            "troubleshoot:user_prompt",
            serde_json::json!({
                "run_id": ctx.run_id,
                "step_id": step_id,
                "prompt": prompt,
            }),
        );
        // Always pause: the engine returns control to the Tauri
        // command layer, which awaits `answer_prompt` before the
        // engine resumes. Resume is implemented by re-driving
        // the engine after the answer is captured into
        // ctx.vars.
        Ok(None)
    }

    /// Phase 3 — fire AI narration after every command/assertion/branch
    /// step completes. Skipped for:
    ///
    ///   * `narration` — the engine's `run_narration_step` already calls
    ///     `narrate` for those, double-narrating would emit two events
    ///     for one step.
    ///   * `user_prompt` — narrating "we paused for input" adds noise.
    ///   * Any step whose status is `AwaitingUser` — that's a Tier-1+
    ///     guardrail pause, and emitting an AI explanation about a
    ///     command we DIDN'T run could mislead the operator about
    ///     state. The pause itself is the message.
    ///
    /// Failures are logged and swallowed: narration is advisory.
    async fn on_step_completed(
        &self,
        ctx: &RunContext,
        step_type: &str,
        result: &StepResult,
    ) -> Result<()> {
        // Skip step types the engine narrates separately or that
        // shouldn't generate narration at all.
        if !matches!(step_type, "command" | "assertion" | "branch") {
            return Ok(());
        }
        // Tier-1+ pauses arrive here with status AwaitingUser. Don't
        // narrate them — the pause IS the signal, and a misleading
        // "looks like X" line could obscure that we refused to run.
        if matches!(result.status, StepStatus::AwaitingUser) {
            return Ok(());
        }

        let payload = serde_json::json!({
            "run_id": ctx.run_id,
            "tab_id": ctx.tab_id,
            "step": {
                "id": result.step_id,
                "type": step_type,
            },
            "step_id": result.step_id,
            "step_type": step_type,
            "parsed": result.result_json,
            "vars": ctx.vars,
            "vendor": self.vendor,
            "platform": self.platform,
            "last_parsed": ctx.last_parsed,
        });

        match self.bridge.call("troubleshoot.narrate", payload).await {
            Ok(AgentResponse::Done { result: r }) => {
                let text = r
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let citations: Vec<String> = r
                    .get("citations")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                // Always emit, even when text is empty — the UI can
                // hide empties but a spurious step without ANY event
                // would look like a dropped narration.
                let _ = self.app_handle.emit(
                    "troubleshoot:narration",
                    serde_json::json!({
                        "run_id": ctx.run_id,
                        "step_idx": result.idx,
                        "step_id": result.step_id,
                        "text": text,
                        "citations": citations,
                    }),
                );
            }
            Ok(AgentResponse::Error { message }) => {
                tracing::warn!(
                    run_id = %ctx.run_id,
                    step_id = %result.step_id,
                    error = %message,
                    "troubleshoot.narrate returned error"
                );
                let _ = self.app_handle.emit(
                    "troubleshoot:narration",
                    serde_json::json!({
                        "run_id": ctx.run_id,
                        "step_idx": result.idx,
                        "step_id": result.step_id,
                        "text": "",
                        "citations": Vec::<String>::new(),
                    }),
                );
            }
            Ok(AgentResponse::Token { .. }) => {
                // Non-stream call shouldn't surface Token; ignore.
            }
            Err(e) => {
                tracing::warn!(
                    run_id = %ctx.run_id,
                    step_id = %result.step_id,
                    error = %e,
                    "troubleshoot.narrate infra error"
                );
            }
        }
        Ok(())
    }
}

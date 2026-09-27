//! Plan 15 Phase 2 — deterministic tree walker.
//!
//! `run_tree` walks a [`Playbook`] one step at a time starting from
//! `pb.steps[0]`. The walker is generic over a [`StepExecutor`] trait
//! so the same engine code drives both the production
//! [`super::live_executor::LiveStepExecutor`] and the test-suite
//! `MockExecutor`.
//!
//! ## Guardrail invariant (security-critical)
//!
//! Every `command` step is gated by [`StepExecutor::classify`] BEFORE
//! the executor's `run_command` is called. The classifier returns the
//! existing project-wide [`crate::guardrails::classifier::Tier`] enum.
//! Only `Tier::T0` proceeds to execution. Any other value
//! (`T1`/`T2`/`T3`/`Ambiguous`) emits an `AwaitingUser` step and
//! transitions the run to `RunStatus::Paused` — the hard gate from
//! Plan 09.
//!
//! ## Branch semantics
//!
//! `branch` steps evaluate `expression` (JMESPath) against
//! `ctx.last_parsed`. The result is matched against each
//! `case.when` using `serde_json::Value` equality. First match wins.
//! No matching case → `RunStatus::Failed`.
//!
//! ## Persistence
//!
//! The engine itself does NOT touch the DB; it calls a `record`
//! closure with each `StepResult`. The Tauri command layer wraps
//! that closure in a per-step rusqlite transaction so a panic
//! mid-run never corrupts the steps trail.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use jmespath::{Expression, Variable};
use std::collections::HashMap;
use std::sync::Arc;

use super::context::{RunContext, RunStatus, StepResult, StepStatus};
use super::playbook::{BranchCase, Playbook, Step};
use crate::guardrails::classifier::Tier;

/// Pluggable executor abstraction. Production implementation:
/// [`super::live_executor::LiveStepExecutor`]. Tests construct a
/// mock that records every call and lets them assert on the order
/// in which the engine reaches `run_command`.
#[async_trait]
pub trait StepExecutor: Send + Sync {
    /// Execute a Tier-0 read-only command. Engine has already
    /// substituted `{{var}}` and re-classified the substituted
    /// string; if execution reaches this method the gate has
    /// already cleared.
    async fn run_command(
        &self,
        ctx: &mut RunContext,
        command: &str,
    ) -> Result<serde_json::Value>;

    /// Classify a candidate command line. Must NOT have side
    /// effects; the engine calls this BEFORE `run_command` to
    /// implement the Tier-0 gate.
    async fn classify(
        &self,
        command: &str,
        vendor: &str,
        platform: &str,
    ) -> Result<Tier>;

    /// Render narration text for a `narration` step. Phase 3
    /// adds RAG-enriched output; Phase 2 implementations may
    /// return the literal `text` from the playbook.
    async fn narrate(
        &self,
        ctx: &RunContext,
        step_id: &str,
        text: &str,
    ) -> Result<String>;

    /// Pause and ask the operator a question. `Ok(None)` means
    /// "engine should pause now"; `Ok(Some(answer))` means the
    /// answer was produced synchronously and the run continues.
    async fn ask_user(
        &self,
        ctx: &RunContext,
        step_id: &str,
        prompt: &str,
    ) -> Result<Option<String>>;

    /// Phase 3 — fired AFTER every step the engine walks completes
    /// (regardless of pass/fail/awaiting_user). The default
    /// implementation is a no-op so existing test executors keep
    /// compiling unchanged. The production [`super::live_executor::LiveStepExecutor`]
    /// uses this hook to produce per-step AI narration via the
    /// `troubleshoot.narrate` sidecar method and emit a
    /// `troubleshoot:narration` Tauri event.
    ///
    /// The hook runs INSIDE the engine loop, so an `Err` here aborts
    /// the run. Implementations MUST swallow narration failures
    /// internally — narration is advisory, never load-bearing.
    async fn on_step_completed(
        &self,
        _ctx: &RunContext,
        _step_type: &str,
        _result: &StepResult,
    ) -> Result<()> {
        Ok(())
    }
}

/// The vendor + platform a run targets. Threaded through to
/// `StepExecutor::classify` so the gate runs against the correct
/// rule set.
#[derive(Debug, Clone)]
pub struct RunTarget {
    pub vendor: String,
    pub platform: String,
}

impl RunTarget {
    pub fn from_playbook(pb: &Playbook) -> Self {
        Self {
            vendor: pb.vendor.clone(),
            platform: pb.platform.clone(),
        }
    }
}

/// Walk the playbook from `pb.steps[0]` until the run reaches a
/// terminal status (`Completed` / `Failed`) or pauses
/// (`Paused`). Returns `Ok(())` for both terminal and paused
/// outcomes — the caller should inspect `ctx.status` to decide
/// what to do next. An `Err` is returned only for infrastructure
/// failures (the executor surfaces them).
///
/// `record` is invoked once per step, in execution order, with
/// the step's `StepResult`. The Tauri command layer wraps this
/// closure in a per-step rusqlite transaction.
pub async fn run_tree<F>(
    pb: &Playbook,
    ctx: &mut RunContext,
    exec: Arc<dyn StepExecutor>,
    record: F,
) -> Result<()>
where
    F: FnMut(&StepResult) -> Result<()>,
{
    let start_id = pb.steps.first().map(|s| s.id().to_string());
    run_tree_from(pb, ctx, exec, start_id, 0, record).await
}

/// Resume-aware variant. `start_at_step_id` defaults to
/// `pb.steps[0].id` (set `None` to use the default); `start_idx`
/// is the linear `idx` to resume numbering from so the persisted
/// trail keeps growing without primary-key collisions.
pub async fn run_tree_from<F>(
    pb: &Playbook,
    ctx: &mut RunContext,
    exec: Arc<dyn StepExecutor>,
    start_at_step_id: Option<String>,
    start_idx: i64,
    mut record: F,
) -> Result<()>
where
    F: FnMut(&StepResult) -> Result<()>,
{
    if pb.steps.is_empty() {
        return Err(anyhow!(
            "playbook '{}' has no steps; refusing to run",
            pb.id
        ));
    }
    let target = RunTarget::from_playbook(pb);

    let mut idx: i64 = start_idx;
    let mut current_id: String = start_at_step_id
        .unwrap_or_else(|| pb.steps[0].id().to_string());

    loop {
        let step = pb
            .find_step(&current_id)
            .ok_or_else(|| anyhow!("playbook references missing step id '{}'", current_id))?;
        let step_type = step.type_tag();
        let this_idx = idx;
        idx += 1;

        let outcome = match step {
            Step::Command { id, command, on_pass, on_fail } => {
                run_command_step(
                    ctx,
                    exec.as_ref(),
                    &target,
                    id,
                    command,
                    on_pass.as_deref(),
                    on_fail.as_deref(),
                    this_idx,
                )
                .await?
            }
            Step::Assertion {
                id, expression, expects, on_pass, on_fail,
            } => run_assertion_step(
                ctx,
                id,
                expression,
                expects,
                on_pass.as_deref(),
                on_fail.as_deref(),
                this_idx,
            )?,
            Step::Branch { id, expression, cases } => run_branch_step(
                ctx,
                id,
                expression,
                cases,
                this_idx,
            )?,
            Step::Narration { id, text } => {
                run_narration_step(ctx, exec.as_ref(), id, text, this_idx).await?
            }
            Step::UserPrompt { id, prompt } => {
                run_user_prompt_step(ctx, exec.as_ref(), id, prompt, this_idx).await?
            }
        };

        record(&outcome.result)?;

        // Phase 3 — surface every completed step to the executor's
        // narration hook. Narration is advisory: implementations
        // MUST swallow LLM/network failures internally, so an Err
        // here propagates as a genuine engine bug. Tier-1+ pauses
        // hit `Transition::Pause` BEFORE this point — a paused
        // command step's `result` here has status AwaitingUser, so
        // the executor can decide whether to emit narration for it
        // (the production [`super::live_executor::LiveStepExecutor`]
        // skips AwaitingUser to avoid leaking a narration about a
        // command the operator hasn't yet approved).
        exec.on_step_completed(ctx, step_type, &outcome.result)
            .await?;

        match outcome.transition {
            Transition::Goto(target_id) => {
                current_id = target_id;
            }
            Transition::NaturalFollow => match linear_successor(pb, &current_id) {
                Some(next) => {
                    current_id = next;
                }
                None => {
                    ctx.status = RunStatus::Completed;
                    return Ok(());
                }
            },
            Transition::Pause => {
                ctx.status = RunStatus::Paused;
                return Ok(());
            }
            Transition::Fail => {
                ctx.status = RunStatus::Failed;
                return Ok(());
            }
        }
    }
}

// ------------ per-step helpers ------------

enum Transition {
    /// Jump to a specific step id (branch case, on_pass, on_fail).
    Goto(String),
    /// Fall through to the next sequential step.
    NaturalFollow,
    /// Pause the run with status Paused.
    Pause,
    /// Mark the run Failed and stop walking.
    Fail,
}

struct StepOutcome {
    result: StepResult,
    transition: Transition,
}

/// `command` step: substitute vars, classify, gate on Tier-0,
/// execute, stash parsed result on ctx.last_parsed.
async fn run_command_step(
    ctx: &mut RunContext,
    exec: &dyn StepExecutor,
    target: &RunTarget,
    step_id: &str,
    command: &str,
    on_pass: Option<&str>,
    on_fail: Option<&str>,
    idx: i64,
) -> Result<StepOutcome> {
    // Substitute first, classify the *substituted* string. This is
    // the load-bearing injection defence: if a user authored
    // `{{neighbor}}` and someone passes `vars["neighbor"] =
    // "10.0.0.5 ; reload"`, the classifier sees "show ... ; reload"
    // and refuses.
    let substituted = match substitute(command, &ctx.vars) {
        Ok(s) => s,
        Err(e) => {
            let result = StepResult {
                step_id: step_id.to_string(),
                idx,
                status: StepStatus::Failed,
                result_json: serde_json::json!({
                    "error": format!("variable substitution failed: {e}"),
                    "command": command,
                }),
                next_step_id: on_fail.map(|s| s.to_string()),
            };
            return Ok(StepOutcome {
                result,
                transition: match on_fail {
                    Some(n) => Transition::Goto(n.to_string()),
                    None => Transition::Fail,
                },
            });
        }
    };

    // Shell-chain defence: a network CLI command never contains
    // `;`, `|`, `&&`, `||`, or backticks (a `|` inside `show … |
    // include foo` is the IOS pipe, not a shell pipe — but the IOS
    // pipe is also legitimately part of `show` output filters,
    // and a chained shell command would contain a *space-bounded*
    // semicolon or `&&`. Rather than try to parse the syntax, we
    // classify each shell-split chunk separately: if ANY chunk
    // exceeds Tier-0, the whole command is rejected.
    //
    // This is the load-bearing injection defence for variable
    // substitution. Without it, a `vars["neighbor"] = "10.0.0.5
    // ; reload"` would slip through the classifier (which sees
    // the leading `show ...` and matches the read-only safety
    // default), even though the appended `; reload` chunk would
    // execute on the device.
    let chunks = crate::guardrails::shell_split::split_for_classification(&substituted);
    let mut highest_tier = Tier::T0;
    for chunk in &chunks {
        let chunk_tier = exec
            .classify(chunk, &target.vendor, &target.platform)
            .await?;
        if tier_rank(chunk_tier) > tier_rank(highest_tier) {
            highest_tier = chunk_tier;
        }
    }
    let tier = highest_tier;

    if tier != Tier::T0 {
        // SECURITY GATE: anything that isn't Tier::T0 pauses the run.
        // Ambiguous is included — refuse to auto-run anything we
        // can't prove is read-only.
        let result = StepResult {
            step_id: step_id.to_string(),
            idx,
            status: StepStatus::AwaitingUser,
            result_json: serde_json::json!({
                "command": substituted,
                "tier": tier.as_str(),
                "reason": "guardrail: command above Tier-0 requires explicit user confirmation",
            }),
            next_step_id: None,
        };
        return Ok(StepOutcome { result, transition: Transition::Pause });
    }

    let parsed = match exec.run_command(ctx, &substituted).await {
        Ok(v) => v,
        Err(e) => {
            let result = StepResult {
                step_id: step_id.to_string(),
                idx,
                status: StepStatus::Failed,
                result_json: serde_json::json!({"error": e.to_string(), "command": substituted}),
                next_step_id: on_fail.map(|s| s.to_string()),
            };
            return Ok(StepOutcome {
                result,
                transition: match on_fail {
                    Some(n) => Transition::Goto(n.to_string()),
                    None => Transition::Fail,
                },
            });
        }
    };
    ctx.last_parsed = Some(parsed.clone());

    let next_id = on_pass.map(|s| s.to_string());
    let result = StepResult {
        step_id: step_id.to_string(),
        idx,
        status: StepStatus::Passed,
        result_json: parsed,
        next_step_id: next_id.clone(),
    };
    let transition = match next_id {
        Some(id) => Transition::Goto(id),
        None => Transition::NaturalFollow,
    };
    Ok(StepOutcome { result, transition })
}

/// `assertion` step: evaluate the JMESPath against
/// `ctx.last_parsed`, compare against `expects` for equality.
fn run_assertion_step(
    ctx: &RunContext,
    step_id: &str,
    expression: &str,
    expects: &serde_json::Value,
    on_pass: Option<&str>,
    on_fail: Option<&str>,
    idx: i64,
) -> Result<StepOutcome> {
    let value = jmespath_eval(expression, ctx.last_parsed.as_ref())?;
    let passed = &value == expects;

    let next_id = if passed {
        on_pass.map(|s| s.to_string())
    } else {
        on_fail.map(|s| s.to_string())
    };
    let status = if passed { StepStatus::Passed } else { StepStatus::Failed };
    let result = StepResult {
        step_id: step_id.to_string(),
        idx,
        status,
        result_json: serde_json::json!({
            "expression": expression,
            "actual": value,
            "expected": expects,
            "passed": passed,
        }),
        next_step_id: next_id.clone(),
    };

    let transition = match (passed, next_id) {
        (_, Some(id)) => Transition::Goto(id),
        (true, None) => Transition::NaturalFollow,
        (false, None) => Transition::Fail,
    };
    Ok(StepOutcome { result, transition })
}

/// `branch` step: evaluate `expression` against `ctx.last_parsed`,
/// match against case.when in declaration order, first match wins.
fn run_branch_step(
    ctx: &RunContext,
    step_id: &str,
    expression: &str,
    cases: &[BranchCase],
    idx: i64,
) -> Result<StepOutcome> {
    let value = jmespath_eval(expression, ctx.last_parsed.as_ref())?;
    let matched = cases.iter().find(|c| c.when == value);

    if let Some(case) = matched {
        let result = StepResult {
            step_id: step_id.to_string(),
            idx,
            status: StepStatus::Passed,
            result_json: serde_json::json!({
                "expression": expression,
                "value": value,
                "matched_case": case.when,
                "next": case.next,
            }),
            next_step_id: Some(case.next.clone()),
        };
        Ok(StepOutcome {
            result,
            transition: Transition::Goto(case.next.clone()),
        })
    } else {
        let result = StepResult {
            step_id: step_id.to_string(),
            idx,
            status: StepStatus::Failed,
            result_json: serde_json::json!({
                "expression": expression,
                "value": value,
                "error": "no matching branch case",
            }),
            next_step_id: None,
        };
        Ok(StepOutcome {
            result,
            transition: Transition::Fail,
        })
    }
}

async fn run_narration_step(
    ctx: &RunContext,
    exec: &dyn StepExecutor,
    step_id: &str,
    text: &str,
    idx: i64,
) -> Result<StepOutcome> {
    // Substitute vars in the literal text so `{{neighbor}}` is
    // resolved before narration is shown. Substitution failure is
    // tolerated for narration — we display the unresolved literal
    // rather than failing the run.
    let literal = substitute(text, &ctx.vars).unwrap_or_else(|_| text.to_string());
    let rendered = exec
        .narrate(ctx, step_id, &literal)
        .await
        .unwrap_or_else(|_| literal.clone());
    let display = if rendered.is_empty() { literal } else { rendered };
    let result = StepResult {
        step_id: step_id.to_string(),
        idx,
        status: StepStatus::Passed,
        result_json: serde_json::json!({"text": display}),
        next_step_id: None,
    };
    Ok(StepOutcome {
        result,
        transition: Transition::NaturalFollow,
    })
}

async fn run_user_prompt_step(
    ctx: &mut RunContext,
    exec: &dyn StepExecutor,
    step_id: &str,
    prompt: &str,
    idx: i64,
) -> Result<StepOutcome> {
    match exec.ask_user(ctx, step_id, prompt).await? {
        Some(answer) => {
            ctx.vars.insert(
                format!("answer_{step_id}"),
                serde_json::Value::String(answer.clone()),
            );
            let result = StepResult {
                step_id: step_id.to_string(),
                idx,
                status: StepStatus::Passed,
                result_json: serde_json::json!({"prompt": prompt, "answer": answer}),
                next_step_id: None,
            };
            Ok(StepOutcome {
                result,
                transition: Transition::NaturalFollow,
            })
        }
        None => {
            let result = StepResult {
                step_id: step_id.to_string(),
                idx,
                status: StepStatus::AwaitingUser,
                result_json: serde_json::json!({"prompt": prompt}),
                next_step_id: None,
            };
            Ok(StepOutcome {
                result,
                transition: Transition::Pause,
            })
        }
    }
}

// ------- helpers -------

fn linear_successor(pb: &Playbook, current_id: &str) -> Option<String> {
    let pos = pb.steps.iter().position(|s| s.id() == current_id)?;
    pb.steps.get(pos + 1).map(|s| s.id().to_string())
}

/// Evaluate a JMESPath expression against the optional
/// `ctx.last_parsed`. Missing `last_parsed` → JSON `null`. The
/// returned value is `serde_json::Value` so case.when matching is
/// trivial.
fn jmespath_eval(
    expression: &str,
    source: Option<&serde_json::Value>,
) -> Result<serde_json::Value> {
    let expr: Expression = jmespath::compile(expression)
        .map_err(|e| anyhow!("invalid jmespath '{expression}': {e}"))?;
    let value = source.cloned().unwrap_or(serde_json::Value::Null);
    let var = Variable::from_serializable(&value)
        .map_err(|e| anyhow!("jmespath input not serialisable: {e}"))?;
    let result = expr
        .search(&var)
        .map_err(|e| anyhow!("jmespath search '{expression}': {e}"))?;
    let json = serde_json::to_value(&*result)
        .map_err(|e| anyhow!("jmespath result not serialisable: {e}"))?;
    Ok(json)
}

/// Substitute `{{var}}` references in `template` from the
/// `vars` map. Errors with a list of unresolved names so the
/// caller can report which variable was missing.
pub(crate) fn substitute(
    template: &str,
    vars: &HashMap<String, serde_json::Value>,
) -> Result<String> {
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    let mut missing: Vec<String> = Vec::new();
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(close) = find_close(template, i + 2) {
                let name = template[i + 2..close].trim();
                if let Some(v) = vars.get(name) {
                    out.push_str(&render_var(v));
                } else {
                    missing.push(name.to_string());
                }
                i = close + 2;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    if !missing.is_empty() {
        return Err(anyhow!(
            "unresolved playbook variables: {}",
            missing.join(", ")
        ));
    }
    Ok(out)
}

fn find_close(s: &str, from: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = from;
    while i + 1 < bytes.len() {
        if bytes[i] == b'}' && bytes[i + 1] == b'}' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn render_var(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Rank the tiers for "max" computation across split chunks.
/// Ambiguous outranks T0 because we refuse to auto-run anything
/// we can't prove is safe.
fn tier_rank(t: Tier) -> u8 {
    match t {
        Tier::T0 => 0,
        Tier::Ambiguous => 1,
        Tier::T1 => 2,
        Tier::T2 => 3,
        Tier::T3 => 4,
    }
}

// `split_for_classification` was promoted to `crate::guardrails::shell_split`
// so fan-out, notebook, chain, and troubleshoot call sites all share a
// single audited splitter. The original implementation lived here; see
// `crate::guardrails::shell_split::split_for_classification` for the
// canonical version.

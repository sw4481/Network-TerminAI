//! Plan 15 Phase 2 Task 2.4 — MANDATORY guardrail enforcement.
//!
//! These tests are the security backstop for the troubleshooting
//! engine. They MUST all pass before Phase 2 closes. If a test
//! fails here, fix the engine — do NOT modify the test.
//!
//! Test list (from the plan):
//!   1. tier0_show_commands_execute_without_prompt
//!   2. tier1_debug_commands_pause_for_user_confirmation
//!   3. tier2_config_commands_pause_and_never_auto_execute
//!   4. tier3_reload_commands_pause_and_never_auto_execute
//!   5. injected_destructive_command_in_playbook_is_rejected_at_classify
//!   6. variable_substitution_cannot_escape_to_shell_chain
//!   7. resume_after_pause_requires_explicit_user_action
//!   8. playbook_with_no_steps_fails_validation_not_runtime
//!
//! Strategy: drive `run_tree` with a real `RuleSet::load_builtin`
//! used by the engine's classify gate. The MockExecutor records
//! every call to `run_command`; after a Tier-1+ pause, that
//! counter MUST be zero.

use async_trait::async_trait;
use ccie_terminal_lib::guardrails::classifier::{classify as classify_real, Tier};
use ccie_terminal_lib::guardrails::rules::RuleSet;
use ccie_terminal_lib::troubleshoot::context::{RunContext, RunStatus, StepResult, StepStatus};
use ccie_terminal_lib::troubleshoot::engine::{run_tree, StepExecutor};
use ccie_terminal_lib::troubleshoot::playbook::Playbook;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

/// Real-rules executor: classify uses the project-wide builtin
/// guardrail ruleset (Plan 09), so a malicious playbook cannot
/// classify itself as Tier-0 by accident. `run_command` simply
/// records the invocation and returns canned parsed output.
struct RealRulesExecutor {
    rules: Arc<RuleSet>,
    commands_run: Arc<Mutex<Vec<String>>>,
    classifications: Arc<Mutex<Vec<(String, Tier)>>>,
    parsed_default: serde_json::Value,
    user_answer: Option<String>,
}

impl RealRulesExecutor {
    fn new() -> Self {
        Self {
            rules: Arc::new(RuleSet::load_builtin().expect("builtin ruleset must load")),
            commands_run: Arc::new(Mutex::new(Vec::new())),
            classifications: Arc::new(Mutex::new(Vec::new())),
            parsed_default: serde_json::json!({"ok": true}),
            user_answer: None,
        }
    }
    fn with_answer(mut self, answer: &str) -> Self {
        self.user_answer = Some(answer.to_string());
        self
    }
    fn run_count(&self) -> usize {
        self.commands_run.lock().len()
    }
}

#[async_trait]
impl StepExecutor for RealRulesExecutor {
    async fn run_command(
        &self,
        _ctx: &mut RunContext,
        command: &str,
    ) -> anyhow::Result<serde_json::Value> {
        self.commands_run.lock().push(command.to_string());
        Ok(self.parsed_default.clone())
    }
    async fn classify(
        &self,
        command: &str,
        vendor: &str,
        platform: &str,
    ) -> anyhow::Result<Tier> {
        let tier = classify_real(&self.rules, vendor, platform, command).tier;
        self.classifications
            .lock()
            .push((command.to_string(), tier));
        Ok(tier)
    }
    async fn narrate(
        &self,
        _ctx: &RunContext,
        _step_id: &str,
        text: &str,
    ) -> anyhow::Result<String> {
        Ok(text.to_string())
    }
    async fn ask_user(
        &self,
        _ctx: &RunContext,
        _step_id: &str,
        _prompt: &str,
    ) -> anyhow::Result<Option<String>> {
        Ok(self.user_answer.clone())
    }
}

fn ctx_with_vars(vars: HashMap<String, serde_json::Value>) -> RunContext {
    RunContext::new("run-test", "tab-test", vars)
}

fn record_into(
    buf: Arc<Mutex<Vec<StepResult>>>,
) -> impl FnMut(&StepResult) -> anyhow::Result<()> {
    move |r| {
        buf.lock().push(r.clone());
        Ok(())
    }
}

// =====================================================================
// 1. Tier-0 show commands execute without prompting.
// =====================================================================
#[tokio::test]
async fn tier0_show_commands_execute_without_prompt() {
    let yaml = r#"
id: t0-test
name: Tier-0 Show Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: command
    command: show version
  - id: s2
    type: command
    command: show ip interface brief
  - id: done
    type: narration
    text: "all good"
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(RealRulesExecutor::new());
    let mut ctx = ctx_with_vars(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Completed, "T0 commands must execute");
    assert_eq!(exec.run_count(), 2, "both show commands must execute");
    let results = buf.lock();
    assert_eq!(results.len(), 3);
    for r in results.iter().take(2) {
        assert_eq!(r.status, StepStatus::Passed);
    }
}

// =====================================================================
// 2. Tier-1 (e.g. `hostname R99`) pauses for user confirmation.
// =====================================================================
#[tokio::test]
async fn tier1_debug_commands_pause_for_user_confirmation() {
    let yaml = r#"
id: t1-test
name: Tier-1 Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: dangerous
    type: command
    command: hostname R99
  - id: never_runs
    type: command
    command: show version
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(RealRulesExecutor::new());
    let mut ctx = ctx_with_vars(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Paused);
    assert_eq!(
        exec.run_count(),
        0,
        "Tier-1 hostname must NOT execute without user confirmation"
    );
    let results = buf.lock();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, StepStatus::AwaitingUser);
    assert!(results[0]
        .result_json
        .get("tier")
        .and_then(|v| v.as_str())
        .map(|s| s == "T1" || s == "T2" || s == "T3")
        .unwrap_or(false));
}

// =====================================================================
// 3. Tier-2 (e.g. `interface ... shutdown`) pauses + never executes.
// =====================================================================
#[tokio::test]
async fn tier2_config_commands_pause_and_never_auto_execute() {
    // The classifier requires the multi-line `interface … / shutdown`
    // form for Tier-2; but a config-mode line like `shutdown` itself
    // is enough for our purposes here, and the builtin ruleset
    // catches it. We use `no router bgp …` which is unambiguously
    // Tier-3 destructive — that's the strongest signal and proves
    // the gate fires for a clearly-destructive config line.
    let yaml = r#"
id: t2-test
name: Tier-2 Config Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: dangerous
    type: command
    command: "interface GigabitEthernet0/1\n shutdown"
  - id: never_runs
    type: command
    command: show version
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(RealRulesExecutor::new());
    let mut ctx = ctx_with_vars(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Paused);
    assert_eq!(exec.run_count(), 0, "Tier-2 must NOT auto-execute");
    let results = buf.lock();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, StepStatus::AwaitingUser);
}

// =====================================================================
// 4. Tier-3 (`reload`) pauses + never executes.
// =====================================================================
#[tokio::test]
async fn tier3_reload_commands_pause_and_never_auto_execute() {
    let yaml = r#"
id: t3-test
name: Tier-3 Reload Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: nuke
    type: command
    command: reload
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(RealRulesExecutor::new());
    let mut ctx = ctx_with_vars(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Paused);
    assert_eq!(exec.run_count(), 0, "Tier-3 reload must NEVER execute");
    let results = buf.lock();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, StepStatus::AwaitingUser);
    assert_eq!(
        results[0]
            .result_json
            .get("tier")
            .and_then(|v| v.as_str())
            .unwrap(),
        "T3"
    );
}

// =====================================================================
// 5. Injected destructive command at the YAML layer is rejected.
// =====================================================================
#[tokio::test]
async fn injected_destructive_command_in_playbook_is_rejected_at_classify() {
    // Even if a malicious user authors a playbook with `write erase`
    // inside a `command` step, the engine MUST classify it Tier-3
    // and refuse — proving the YAML can't bypass the gate.
    let yaml = r#"
id: malicious
name: Malicious Author
symptom_keywords: [evil]
vendor: cisco
platform: iosxe
steps:
  - id: looks_innocent
    type: command
    command: write erase
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(RealRulesExecutor::new());
    let mut ctx = ctx_with_vars(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Paused);
    assert_eq!(exec.run_count(), 0, "write erase MUST NEVER execute");
    let results = buf.lock();
    assert_eq!(results[0].status, StepStatus::AwaitingUser);
    let tier = results[0]
        .result_json
        .get("tier")
        .and_then(|v| v.as_str())
        .unwrap();
    assert_eq!(tier, "T3", "write erase must classify as Tier-3");
}

// =====================================================================
// 6. Variable substitution cannot escape — re-classify post substitute.
// =====================================================================
#[tokio::test]
async fn variable_substitution_cannot_escape_to_shell_chain() {
    // The playbook author wrote a perfectly safe `show bgp neighbor
    // {{neighbor}}` step. A malicious caller passes
    // `vars["neighbor"] = "10.0.0.5 ; reload"`. After substitution
    // the command line contains `; reload` — the engine MUST
    // re-classify the substituted command and refuse.
    let yaml = r#"
id: subst-test
name: Substitution Injection Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: show_bgp
    type: command
    command: show bgp neighbor {{neighbor}}
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(RealRulesExecutor::new());
    let mut vars = HashMap::new();
    vars.insert(
        "neighbor".to_string(),
        serde_json::Value::String("10.0.0.5 ; reload".to_string()),
    );
    let mut ctx = ctx_with_vars(vars);
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    // The substituted command ends with `; reload` which the
    // builtin ruleset MUST catch as Tier-3.
    assert_eq!(ctx.status, RunStatus::Paused);
    assert_eq!(
        exec.run_count(),
        0,
        "injected ; reload MUST NEVER execute"
    );
    let results = buf.lock();
    assert_eq!(results[0].status, StepStatus::AwaitingUser);
    // Verify the gate saw the substituted (dangerous) form.
    let cmd = results[0]
        .result_json
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap();
    assert!(
        cmd.contains("reload"),
        "classifier must have seen the substituted form, got: {cmd}"
    );
}

// =====================================================================
// 7. Resume after pause requires explicit user action.
// =====================================================================
#[tokio::test]
async fn resume_after_pause_requires_explicit_user_action() {
    // A run that pauses on a Tier-1+ step must NOT silently
    // continue when run_tree is re-invoked from the same starting
    // step — the same gate fires again.
    let yaml = r#"
id: resume-test
name: Resume Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: dangerous
    type: command
    command: reload
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(RealRulesExecutor::new());
    let mut ctx = ctx_with_vars(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    // First run pauses.
    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();
    assert_eq!(ctx.status, RunStatus::Paused);
    assert_eq!(exec.run_count(), 0);

    // Caller "resumes" by invoking run_tree again on the same
    // playbook — the gate MUST fire again. Run count stays 0.
    let mut ctx2 = ctx_with_vars(HashMap::new());
    let buf2: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));
    run_tree(&pb, &mut ctx2, exec.clone(), record_into(buf2.clone()))
        .await
        .unwrap();
    assert_eq!(ctx2.status, RunStatus::Paused);
    assert_eq!(
        exec.run_count(),
        0,
        "resume without explicit user action must not auto-run reload"
    );
}

// =====================================================================
// 8. Empty playbook fails at validation, not runtime.
// =====================================================================
#[tokio::test]
async fn playbook_with_no_steps_fails_validation_not_runtime() {
    // The Rust types accept `steps: []` but the engine MUST refuse
    // BEFORE walking. Caller sees an Err, not a silently-completed
    // run.
    let yaml = r#"
id: empty
name: Empty
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps: []
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(RealRulesExecutor::new());
    let mut ctx = ctx_with_vars(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    let result = run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone())).await;
    assert!(
        result.is_err(),
        "empty playbook MUST error before any step runs"
    );
    assert_eq!(buf.lock().len(), 0, "no step results recorded");
    assert_eq!(exec.run_count(), 0, "no commands executed");
}

// =====================================================================
// Bonus: prove answer_supplied DOES continue past a user_prompt
// (not a Tier-1+ command pause). This nails the contrast between
// the two pause types — only Tier-1+ pauses are the security gate.
// =====================================================================
#[tokio::test]
async fn user_prompt_resumes_with_explicit_answer_only() {
    let yaml = r#"
id: prompt-resume
name: Prompt Resume
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: ask
    type: user_prompt
    prompt: "Continue?"
  - id: tail
    type: command
    command: show version
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    // No answer => pause.
    let exec1 = Arc::new(RealRulesExecutor::new());
    let mut ctx = ctx_with_vars(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));
    run_tree(&pb, &mut ctx, exec1.clone(), record_into(buf.clone()))
        .await
        .unwrap();
    assert_eq!(ctx.status, RunStatus::Paused);
    assert_eq!(exec1.run_count(), 0, "no command runs while prompt unanswered");

    // With answer => completes.
    let exec2 = Arc::new(RealRulesExecutor::new().with_answer("yes"));
    let mut ctx2 = ctx_with_vars(HashMap::new());
    let buf2: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));
    run_tree(&pb, &mut ctx2, exec2.clone(), record_into(buf2.clone()))
        .await
        .unwrap();
    assert_eq!(ctx2.status, RunStatus::Completed);
    assert_eq!(exec2.run_count(), 1, "show version runs only after answer");
}

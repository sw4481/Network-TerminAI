//! Plan 15 Phase 2 — engine unit tests.
//!
//! Drives `run_tree` with a `MockExecutor` so the test suite never
//! touches a real PTY, sidecar, or DB. Every test asserts BOTH the
//! final `RunStatus` AND the recorded `StepResult` trail so a
//! regression in the order or the gating semantics is caught.

use async_trait::async_trait;
use ccie_terminal_lib::guardrails::classifier::Tier;
use ccie_terminal_lib::troubleshoot::context::{RunContext, RunStatus, StepResult, StepStatus};
use ccie_terminal_lib::troubleshoot::engine::{run_tree, StepExecutor};
use ccie_terminal_lib::troubleshoot::playbook::Playbook;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

/// Records every interaction with the engine so tests can assert
/// on the order + count of `run_command` calls (the security
/// invariant we MUST preserve: any Tier > T0 step never reaches
/// run_command).
#[derive(Default)]
struct MockState {
    commands_run: Vec<String>,
    classifications: Vec<(String, Tier)>,
    narrations: Vec<(String, String)>,
    user_prompts: Vec<String>,
}

struct MockExecutor {
    state: Arc<Mutex<MockState>>,
    parsed_by_cmd: HashMap<String, serde_json::Value>,
    tier_by_cmd: HashMap<String, Tier>,
    /// Default tier when no entry matches in `tier_by_cmd`.
    default_tier: Tier,
    /// Optional answer for ask_user; None pauses.
    user_answer: Option<String>,
}

impl MockExecutor {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(MockState::default())),
            parsed_by_cmd: HashMap::new(),
            tier_by_cmd: HashMap::new(),
            default_tier: Tier::T0,
            user_answer: None,
        }
    }
    fn with_parsed(mut self, command: &str, value: serde_json::Value) -> Self {
        self.parsed_by_cmd.insert(command.to_string(), value);
        self
    }
    fn with_tier(mut self, command: &str, tier: Tier) -> Self {
        self.tier_by_cmd.insert(command.to_string(), tier);
        self
    }
    fn with_default_tier(mut self, tier: Tier) -> Self {
        self.default_tier = tier;
        self
    }
    fn with_user_answer(mut self, answer: &str) -> Self {
        self.user_answer = Some(answer.to_string());
        self
    }
    fn state(&self) -> Arc<Mutex<MockState>> {
        self.state.clone()
    }
}

#[async_trait]
impl StepExecutor for MockExecutor {
    async fn run_command(
        &self,
        _ctx: &mut RunContext,
        command: &str,
    ) -> anyhow::Result<serde_json::Value> {
        self.state.lock().commands_run.push(command.to_string());
        Ok(self
            .parsed_by_cmd
            .get(command)
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    async fn classify(
        &self,
        command: &str,
        _vendor: &str,
        _platform: &str,
    ) -> anyhow::Result<Tier> {
        let tier = self
            .tier_by_cmd
            .get(command)
            .copied()
            .unwrap_or(self.default_tier);
        self.state
            .lock()
            .classifications
            .push((command.to_string(), tier));
        Ok(tier)
    }

    async fn narrate(
        &self,
        _ctx: &RunContext,
        step_id: &str,
        text: &str,
    ) -> anyhow::Result<String> {
        self.state
            .lock()
            .narrations
            .push((step_id.to_string(), text.to_string()));
        Ok(text.to_string())
    }

    async fn ask_user(
        &self,
        _ctx: &RunContext,
        _step_id: &str,
        prompt: &str,
    ) -> anyhow::Result<Option<String>> {
        self.state.lock().user_prompts.push(prompt.to_string());
        Ok(self.user_answer.clone())
    }
}

fn fresh_ctx(vars: HashMap<String, serde_json::Value>) -> RunContext {
    RunContext::new("run-1", "tab-1", vars)
}

fn record_into(buf: Arc<Mutex<Vec<StepResult>>>) -> impl FnMut(&StepResult) -> anyhow::Result<()> {
    move |r| {
        buf.lock().push(r.clone());
        Ok(())
    }
}

const BGP_PLAYBOOK_YAML: &str = r#"
id: bgp-test
name: BGP Test
symptom_keywords: [bgp]
vendor: cisco
platform: iosxe
steps:
  - id: check_state
    type: command
    command: show bgp neighbor {{neighbor}}
  - id: route_on_state
    type: branch
    expression: "session_state"
    cases:
      - when: "Idle (Admin)"
        next: narrate_admin
      - when: "Active"
        next: narrate_active
      - when: "Established"
        next: narrate_ok
  - id: narrate_admin
    type: narration
    text: "Neighbor {{neighbor}} is administratively shut. Run no shutdown."
  - id: narrate_active
    type: narration
    text: "Neighbor {{neighbor}} is Active — TCP not yet established."
  - id: narrate_ok
    type: narration
    text: "Neighbor {{neighbor}} is Established. No fault detected."
"#;

#[tokio::test]
async fn happy_path_bgp_established() {
    let pb = Playbook::parse_yaml(BGP_PLAYBOOK_YAML).unwrap();
    let exec = Arc::new(
        MockExecutor::new().with_parsed(
            "show bgp neighbor 10.0.0.5",
            serde_json::json!({"session_state": "Established"}),
        ),
    );
    let mut vars = HashMap::new();
    vars.insert(
        "neighbor".to_string(),
        serde_json::Value::String("10.0.0.5".to_string()),
    );
    let mut ctx = fresh_ctx(vars);
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Completed);
    let results = buf.lock();
    assert_eq!(results.len(), 3, "command + branch + narrate_ok");
    assert_eq!(results[0].step_id, "check_state");
    assert_eq!(results[1].step_id, "route_on_state");
    assert_eq!(results[2].step_id, "narrate_ok");
    assert!(results[2].result_json["text"]
        .as_str()
        .unwrap()
        .contains("Established"));
}

#[tokio::test]
async fn branch_routes_on_idle_admin() {
    let pb = Playbook::parse_yaml(BGP_PLAYBOOK_YAML).unwrap();
    let exec = Arc::new(MockExecutor::new().with_parsed(
        "show bgp neighbor 10.0.0.5",
        serde_json::json!({"session_state": "Idle (Admin)"}),
    ));
    let mut vars = HashMap::new();
    vars.insert(
        "neighbor".to_string(),
        serde_json::Value::String("10.0.0.5".to_string()),
    );
    let mut ctx = fresh_ctx(vars);
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Completed);
    let results = buf.lock();
    assert_eq!(results[2].step_id, "narrate_admin");
    let text = results[2].result_json["text"].as_str().unwrap();
    assert!(text.contains("administratively shut"));
    assert!(text.contains("no shutdown"));
}

#[tokio::test]
async fn tier1_command_pauses_run_with_awaiting_user() {
    // Synthetic playbook whose first command is `shutdown` (Tier-2).
    let yaml = r#"
id: synthetic
name: Synthetic Tier1+
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: bad
    type: command
    command: shutdown
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(MockExecutor::new().with_tier("shutdown", Tier::T2));
    let state = exec.state();
    let mut ctx = fresh_ctx(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Paused);
    let results = buf.lock();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, StepStatus::AwaitingUser);

    // SECURITY INVARIANT: classify happened, run_command did not.
    let s = state.lock();
    assert_eq!(s.classifications.len(), 1);
    assert_eq!(s.commands_run.len(), 0, "Tier-2 command must not execute");
}

#[tokio::test]
async fn user_prompt_pauses_until_answer() {
    let yaml = r#"
id: prompt-test
name: Prompt Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: ask
    type: user_prompt
    prompt: "Have you escalated?"
  - id: end
    type: narration
    text: "thanks"
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    // user_answer is None by default → pause.
    let exec = Arc::new(MockExecutor::new());
    let mut ctx = fresh_ctx(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Paused);
    let results = buf.lock();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, StepStatus::AwaitingUser);
}

#[tokio::test]
async fn user_prompt_continues_when_answer_supplied() {
    let yaml = r#"
id: prompt-test
name: Prompt Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: ask
    type: user_prompt
    prompt: "Have you escalated?"
  - id: end
    type: narration
    text: "thanks"
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(MockExecutor::new().with_user_answer("yes"));
    let mut ctx = fresh_ctx(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Completed);
    let results = buf.lock();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].step_id, "ask");
    assert_eq!(results[0].status, StepStatus::Passed);
    assert_eq!(results[1].step_id, "end");
}

#[tokio::test]
async fn branch_unmatched_case_fails_run() {
    let pb = Playbook::parse_yaml(BGP_PLAYBOOK_YAML).unwrap();
    let exec = Arc::new(MockExecutor::new().with_parsed(
        "show bgp neighbor 10.0.0.5",
        serde_json::json!({"session_state": "Garbage"}),
    ));
    let mut vars = HashMap::new();
    vars.insert(
        "neighbor".to_string(),
        serde_json::Value::String("10.0.0.5".to_string()),
    );
    let mut ctx = fresh_ctx(vars);
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Failed);
    let results = buf.lock();
    assert_eq!(results[1].step_id, "route_on_state");
    assert_eq!(results[1].status, StepStatus::Failed);
}

#[tokio::test]
async fn empty_playbook_fails_validation_at_runtime() {
    // Playbook with no steps -> serde won't fail on it (schema
    // permits empty array via Rust types), but the engine MUST
    // refuse to walk it.
    let yaml = r#"
id: empty
name: Empty
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps: []
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(MockExecutor::new());
    let mut ctx = fresh_ctx(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    let res = run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone())).await;
    assert!(res.is_err(), "empty playbook should error before walking");
}

#[tokio::test]
async fn ambiguous_command_pauses_like_tier1() {
    let yaml = r#"
id: ambiguous-test
name: Ambiguous Test
symptom_keywords: [test]
vendor: cisco
platform: iosxe
steps:
  - id: weird
    type: command
    command: archive path foo
"#;
    let pb = Playbook::parse_yaml(yaml).unwrap();
    let exec = Arc::new(
        MockExecutor::new()
            .with_default_tier(Tier::Ambiguous)
            .with_tier("archive path foo", Tier::Ambiguous),
    );
    let state = exec.state();
    let mut ctx = fresh_ctx(HashMap::new());
    let buf: Arc<Mutex<Vec<StepResult>>> = Arc::new(Mutex::new(Vec::new()));

    run_tree(&pb, &mut ctx, exec.clone(), record_into(buf.clone()))
        .await
        .unwrap();

    assert_eq!(ctx.status, RunStatus::Paused);
    assert_eq!(state.lock().commands_run.len(), 0);
}

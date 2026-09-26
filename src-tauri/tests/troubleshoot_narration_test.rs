//! Plan 15 Phase 3 — narration + conclusion integration test.
//!
//! Drives `run_tree` with a `MockExecutor` that captures every
//! `on_step_completed` invocation and asserts:
//!
//!   * One narration "event" is produced per command/assertion/branch
//!     step on a happy-path run.
//!   * Narration is NOT produced for narration-typed steps (the engine
//!     calls `narrate` separately for those — see
//!     `run_narration_step`).
//!   * Tier-1+ pauses do NOT produce narration: the engine emits an
//!     AwaitingUser StepResult and the executor's `on_step_completed`
//!     skips it (we don't want to mislead the operator about state we
//!     refused to observe).
//!   * `produce_conclusion` is invoked exactly once per terminal run
//!     and returns a four-field shaped payload.
//!   * The conclusion can be persisted to the DB (via `RunDetails`
//!     read-back, mirroring what `spawn_engine_task` does).
//!
//! No Tauri runtime, no real sidecar, no PTY. The "narration event" is
//! just the executor pushing into a shared Vec — `LiveStepExecutor`
//! emits Tauri events on top of the same hook, and the Tauri emit is
//! a thin tail.

use async_trait::async_trait;
use ccie_terminal_lib::guardrails::classifier::Tier;
use ccie_terminal_lib::troubleshoot::context::{RunContext, RunStatus, StepResult, StepStatus};
use ccie_terminal_lib::troubleshoot::engine::{run_tree, StepExecutor};
use ccie_terminal_lib::troubleshoot::narrator_bridge::{
    is_terminal, produce_conclusion, NarratorBridge,
};
use ccie_terminal_lib::troubleshoot::playbook::Playbook;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Mock executor — captures everything the engine surfaces, including
// the Phase 3 `on_step_completed` hook.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MockState {
    commands_run: Vec<String>,
    classifications: Vec<(String, Tier)>,
    narrations: Vec<(String, String)>,
    user_prompts: Vec<String>,
    /// (step_id, step_type, status) pushed every time
    /// `on_step_completed` fires AND the executor decided narration
    /// applies (i.e. the LiveStepExecutor's filter rules).
    narration_events: Vec<(String, String, StepStatus)>,
}

struct MockExecutor {
    state: Arc<Mutex<MockState>>,
    parsed_by_cmd: HashMap<String, Value>,
    tier_by_cmd: HashMap<String, Tier>,
    default_tier: Tier,
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
    fn with_parsed(mut self, command: &str, value: Value) -> Self {
        self.parsed_by_cmd.insert(command.to_string(), value);
        self
    }
    fn with_tier(mut self, command: &str, tier: Tier) -> Self {
        self.tier_by_cmd.insert(command.to_string(), tier);
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
    ) -> anyhow::Result<Value> {
        self.state.lock().commands_run.push(command.to_string());
        Ok(self
            .parsed_by_cmd
            .get(command)
            .cloned()
            .unwrap_or(Value::Null))
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

    /// Mirrors the production `LiveStepExecutor::on_step_completed`
    /// gating rules so tests assert against the same surface that
    /// ships in production:
    ///
    ///   * Skip narration for non-{command/assertion/branch} steps
    ///     (the engine narrates `narration` separately, and
    ///     user_prompts shouldn't generate narration).
    ///   * Skip narration for AwaitingUser results (Tier-1+ pauses
    ///     mustn't have a misleading narration on top).
    async fn on_step_completed(
        &self,
        _ctx: &RunContext,
        step_type: &str,
        result: &StepResult,
    ) -> anyhow::Result<()> {
        if !matches!(step_type, "command" | "assertion" | "branch") {
            return Ok(());
        }
        if matches!(result.status, StepStatus::AwaitingUser) {
            return Ok(());
        }
        self.state.lock().narration_events.push((
            result.step_id.clone(),
            step_type.to_string(),
            result.status,
        ));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Mock narrator bridge — returns canned conclusion payloads and records
// every call.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MockBridgeState {
    narrate_calls: Vec<Value>,
    conclude_calls: Vec<Value>,
}

struct MockBridge {
    state: Arc<Mutex<MockBridgeState>>,
    canned_conclude: Value,
}

impl MockBridge {
    fn new(canned_conclude: Value) -> Self {
        Self {
            state: Arc::new(Mutex::new(MockBridgeState::default())),
            canned_conclude,
        }
    }
    fn state(&self) -> Arc<Mutex<MockBridgeState>> {
        self.state.clone()
    }
}

#[async_trait]
impl NarratorBridge for MockBridge {
    async fn narrate(&self, payload: Value) -> anyhow::Result<Value> {
        self.state.lock().narrate_calls.push(payload);
        Ok(serde_json::json!({"text": "mock narration", "citations": ["mock-1"]}))
    }
    async fn conclude(&self, payload: Value) -> anyhow::Result<Value> {
        self.state.lock().conclude_calls.push(payload);
        Ok(self.canned_conclude.clone())
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn fresh_ctx(vars: HashMap<String, Value>) -> RunContext {
    RunContext::new("run-1", "tab-1", vars)
}

fn record_into(buf: Arc<Mutex<Vec<(StepResult, &'static str)>>>, pb: Playbook)
    -> impl FnMut(&StepResult) -> anyhow::Result<()>
{
    move |r| {
        let step_type: &'static str = pb
            .find_step(&r.step_id)
            .map(|s| match s.type_tag() {
                "command" => "command",
                "assertion" => "assertion",
                "branch" => "branch",
                "narration" => "narration",
                "user_prompt" => "user_prompt",
                _ => "unknown",
            })
            .unwrap_or("unknown");
        buf.lock().push((r.clone(), step_type));
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
      - when: "Established"
        next: narrate_ok
  - id: narrate_admin
    type: narration
    text: "Neighbor administratively shut. Run no shutdown."
  - id: narrate_ok
    type: narration
    text: "Neighbor is Established."
"#;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn happy_path_emits_narration_per_command_assertion_or_branch_step() {
    let pb = Playbook::parse_yaml(BGP_PLAYBOOK_YAML).unwrap();
    let exec = Arc::new(
        MockExecutor::new().with_parsed(
            "show bgp neighbor 10.0.0.5",
            serde_json::json!({"session_state": "Idle (Admin)"}),
        ),
    );
    let exec_state = exec.state();
    let mut vars = HashMap::new();
    vars.insert("neighbor".into(), Value::String("10.0.0.5".into()));
    let mut ctx = fresh_ctx(vars);

    let history: Arc<Mutex<Vec<(StepResult, &'static str)>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = record_into(history.clone(), pb.clone());

    run_tree(&pb, &mut ctx, exec.clone(), recorder).await.unwrap();

    assert_eq!(ctx.status, RunStatus::Completed);

    // Engine recorded: command, branch, narrate_admin (jumped to via
    // case match), then NaturalFollow to narrate_ok (the next
    // sequential step in the playbook). That's four total — Phase 4
    // will trim the post-Idle (Admin) playbook so it stops after
    // `narrate_admin`, but for now we test what the engine actually
    // does.
    let h = history.lock();
    assert_eq!(h.len(), 4);
    assert_eq!(h[0].1, "command");
    assert_eq!(h[1].1, "branch");
    assert_eq!(h[2].1, "narration");
    assert_eq!(h[3].1, "narration");
    drop(h);

    // Narration events fired by `on_step_completed` are exactly the
    // command + branch — narration steps do NOT trigger the hook
    // (they're already narrated by the engine's run_narration_step).
    let s = exec_state.lock();
    assert_eq!(s.narration_events.len(), 2, "command + branch only");
    assert_eq!(s.narration_events[0].0, "check_state");
    assert_eq!(s.narration_events[0].1, "command");
    assert_eq!(s.narration_events[0].2, StepStatus::Passed);
    assert_eq!(s.narration_events[1].0, "route_on_state");
    assert_eq!(s.narration_events[1].1, "branch");

    // Both narration steps were rendered via the executor's narrate()
    // method (different surface from on_step_completed).
    assert_eq!(s.narrations.len(), 2);
    assert_eq!(s.narrations[0].0, "narrate_admin");
    assert_eq!(s.narrations[1].0, "narrate_ok");
}

#[tokio::test]
async fn tier1_pause_does_not_emit_narration_on_rejected_step() {
    // A playbook whose first command is Tier-2 (`shutdown`). The
    // engine pauses without executing the command. Phase 3 must NOT
    // emit a narration on that AwaitingUser step.
    let yaml = r#"
id: tier1-test
name: Tier-1 test
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
    let exec_state = exec.state();
    let mut ctx = fresh_ctx(HashMap::new());
    let history: Arc<Mutex<Vec<(StepResult, &'static str)>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = record_into(history.clone(), pb.clone());

    run_tree(&pb, &mut ctx, exec.clone(), recorder).await.unwrap();

    assert_eq!(ctx.status, RunStatus::Paused);

    // The command WAS classified, but never executed.
    let s = exec_state.lock();
    assert_eq!(s.classifications.len(), 1);
    assert_eq!(s.commands_run.len(), 0);
    // CRITICAL: no narration event was fired for the rejected step.
    assert_eq!(
        s.narration_events.len(),
        0,
        "Tier-1+ pause must NOT emit narration; it would mislead the operator"
    );
}

#[tokio::test]
async fn produce_conclusion_returns_shaped_payload_once_per_terminal_run() {
    let pb = Playbook::parse_yaml(BGP_PLAYBOOK_YAML).unwrap();
    let exec = Arc::new(MockExecutor::new().with_parsed(
        "show bgp neighbor 10.0.0.5",
        serde_json::json!({"session_state": "Idle (Admin)"}),
    ));
    let mut vars = HashMap::new();
    vars.insert("neighbor".into(), Value::String("10.0.0.5".into()));
    let mut ctx = fresh_ctx(vars);
    let history: Arc<Mutex<Vec<(StepResult, &'static str)>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = record_into(history.clone(), pb.clone());

    run_tree(&pb, &mut ctx, exec.clone(), recorder).await.unwrap();
    assert!(is_terminal(ctx.status));

    let bridge = MockBridge::new(serde_json::json!({
        "root_cause": "Neighbor administratively shut.",
        "confidence": "high",
        "suggested_fix": "Issue 'no shutdown' under the BGP neighbor config.",
        "evidence": ["session_state == Idle (Admin)"],
    }));
    let bridge_state = bridge.state();

    let snapshot: Vec<(StepResult, &'static str)> = history.lock().clone();
    let results: Vec<StepResult> = snapshot.iter().map(|(r, _)| r.clone()).collect();
    let types: Vec<&str> = snapshot.iter().map(|(_, t)| *t).collect();

    let conclusion = produce_conclusion(
        &bridge,
        "run-1",
        "BGP won't peer",
        "cisco",
        "iosxe",
        ctx.status,
        &results,
        &types,
    )
    .await;

    // Exactly four fields, all populated.
    assert!(conclusion.is_object());
    let obj = conclusion.as_object().unwrap();
    assert!(obj.contains_key("root_cause"));
    assert!(obj.contains_key("confidence"));
    assert!(obj.contains_key("suggested_fix"));
    assert!(obj.contains_key("evidence"));
    assert_eq!(obj["confidence"].as_str(), Some("high"));
    assert!(obj["root_cause"]
        .as_str()
        .unwrap()
        .contains("administratively shut"));

    // Exactly ONE conclude call.
    let bs = bridge_state.lock();
    assert_eq!(bs.conclude_calls.len(), 1);
    let payload = &bs.conclude_calls[0];
    // The payload includes the full history so the LLM can reason
    // over what was actually run.
    assert!(payload["run_history"].is_array());
    assert_eq!(payload["symptom"].as_str(), Some("BGP won't peer"));
    assert_eq!(payload["vendor"].as_str(), Some("cisco"));
    assert_eq!(payload["platform"].as_str(), Some("iosxe"));
    assert_eq!(payload["status"].as_str(), Some("completed"));
}

#[tokio::test]
async fn produce_conclusion_falls_back_when_bridge_returns_null() {
    // If the bridge returns Value::Null (sidecar handler missing), we
    // still get a four-field shaped conclusion so the UI doesn't
    // render an empty card.
    struct NullBridge;
    #[async_trait]
    impl NarratorBridge for NullBridge {
        async fn narrate(&self, _payload: Value) -> anyhow::Result<Value> {
            Ok(Value::Null)
        }
        async fn conclude(&self, _payload: Value) -> anyhow::Result<Value> {
            Ok(Value::Null)
        }
    }

    let conclusion = produce_conclusion(
        &NullBridge,
        "run-x",
        "ipsec down",
        "cisco",
        "iosxe",
        RunStatus::Failed,
        &[],
        &[],
    )
    .await;

    let obj = conclusion.as_object().unwrap();
    assert!(obj.contains_key("root_cause"));
    assert!(obj.contains_key("confidence"));
    assert!(obj.contains_key("suggested_fix"));
    assert!(obj.contains_key("evidence"));
    assert_eq!(obj["confidence"].as_str(), Some("low"));
    assert!(obj["root_cause"].as_str().unwrap().contains("ipsec down"));
}

#[tokio::test]
async fn produce_conclusion_clamps_invalid_confidence() {
    let bridge = MockBridge::new(serde_json::json!({
        "root_cause": "x",
        "confidence": "absolutely",
        "suggested_fix": "y",
        "evidence": [],
    }));
    let conclusion = produce_conclusion(
        &bridge,
        "r",
        "s",
        "v",
        "p",
        RunStatus::Completed,
        &[],
        &[],
    )
    .await;
    assert_eq!(conclusion["confidence"].as_str(), Some("low"));
}

// ---------------------------------------------------------------------------
// DB persistence test — mirrors what `spawn_engine_task` does on
// terminal status.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn conclusion_json_persists_to_db_row() {
    use rusqlite::Connection;

    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE troubleshoot_runs (
          id TEXT PRIMARY KEY,
          conclusion_json TEXT
        );
        INSERT INTO troubleshoot_runs (id) VALUES ('run-z');
        "#,
    )
    .unwrap();

    let bridge = MockBridge::new(serde_json::json!({
        "root_cause": "rc",
        "confidence": "medium",
        "suggested_fix": "fix",
        "evidence": ["e1", "e2"],
    }));
    let conclusion = produce_conclusion(
        &bridge,
        "run-z",
        "test",
        "cisco",
        "iosxe",
        RunStatus::Completed,
        &[],
        &[],
    )
    .await;
    let conclusion_str = serde_json::to_string(&conclusion).unwrap();

    conn.execute(
        "UPDATE troubleshoot_runs SET conclusion_json = ?1 WHERE id = ?2",
        rusqlite::params![conclusion_str, "run-z"],
    )
    .unwrap();

    let stored: String = conn
        .query_row(
            "SELECT conclusion_json FROM troubleshoot_runs WHERE id = ?1",
            rusqlite::params!["run-z"],
            |r| r.get(0),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(parsed["confidence"].as_str(), Some("medium"));
    assert_eq!(parsed["root_cause"].as_str(), Some("rc"));
    assert_eq!(parsed["evidence"].as_array().unwrap().len(), 2);
}

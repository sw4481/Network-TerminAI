//! Strongly-typed Rust mirror of the troubleshooting playbook YAML schema.
//!
//! Two reasons the engine deserialises into Rust rather than handing
//! `serde_json::Value` around:
//!
//! 1. **Branch matching** has to happen on a known shape — `cases[].when`
//!    can be string / bool / number / null and we want exhaustive matching
//!    rather than ad-hoc lookups.
//!
//! 2. **Cross-reference safety**: `find_step` is the single chokepoint
//!    used by the engine and the seed loader's smoke check. If a branch
//!    `next:` ever fails to resolve we want a clear `None` rather than a
//!    silent missing key.
//!
//! The structural validation (required fields per type, branch targets
//! resolve, on_pass / on_fail resolve) is mirrored across both layers:
//! the sidecar's `yaml_loader.py` runs it before storing, and Phase 2's
//! engine re-runs it before executing — defence in depth, since user-
//! authored playbooks can be edited outside the app.

use serde::{Deserialize, Serialize};

/// A complete troubleshooting playbook.
///
/// Field order matches the sidecar JSON schema for ergonomic round-tripping:
/// load via `parse_yaml`, mutate, re-emit via `serde_yaml::to_string`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Playbook {
    pub id: String,
    pub name: String,
    pub symptom_keywords: Vec<String>,
    pub vendor: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub steps: Vec<Step>,
}

/// A single step. The `type:` discriminant maps to the five sidecar
/// variants. `serde(tag = "type", rename_all = "snake_case")` means the
/// YAML key `type: command` deserialises into `Step::Command { .. }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Step {
    /// Tier-0 read-only show command. Engine substitutes `{{var}}` from
    /// `RunContext::vars`, then re-classifies post-substitution to defeat
    /// injection (`neighbor = "10.0.0.5 ; reload"` must fail at classify).
    Command {
        id: String,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on_pass: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on_fail: Option<String>,
    },
    /// JMESPath assertion against `ctx.last_parsed`. Engine compares the
    /// evaluated value against `expects` for an exact match.
    Assertion {
        id: String,
        expression: String,
        expects: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on_pass: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on_fail: Option<String>,
    },
    /// Multi-way branch on the value of `expression`. First matching
    /// `case.when` wins.
    Branch {
        id: String,
        expression: String,
        cases: Vec<BranchCase>,
    },
    /// Free-form narration emitted to the side panel. Phase 3 adds RAG
    /// citations; Phase 1 just stores the literal text.
    Narration { id: String, text: String },
    /// Pause the run with a question; resumed by the operator via the
    /// `answer_prompt` Tauri command (Phase 2).
    UserPrompt { id: String, prompt: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BranchCase {
    pub when: serde_json::Value,
    pub next: String,
}

impl Playbook {
    /// Parse a YAML document into a [`Playbook`].
    ///
    /// Errors propagate `serde_yaml`'s parse messages verbatim so callers
    /// can surface them in the editor's gutter (Phase 6).
    pub fn parse_yaml(text: &str) -> anyhow::Result<Self> {
        let pb: Playbook = serde_yaml::from_str(text)?;
        Ok(pb)
    }

    /// Look up a step by its YAML id.
    ///
    /// Returns `None` if no step matches; callers SHOULD treat this as a
    /// programmer error or a corrupted playbook and either refuse to run
    /// or surface a clear validation message.
    pub fn find_step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| Step::id(s) == id)
    }
}

impl Step {
    /// Borrow the step's id without matching every variant explicitly at
    /// every callsite.
    pub fn id(&self) -> &str {
        match self {
            Step::Command { id, .. }
            | Step::Assertion { id, .. }
            | Step::Branch { id, .. }
            | Step::Narration { id, .. }
            | Step::UserPrompt { id, .. } => id,
        }
    }

    /// String tag for the step variant. Mirrors the YAML `type:`
    /// discriminant and the `troubleshoot_steps.step_type` CHECK
    /// constraint. Used by the Phase 3 narration hook to route
    /// command/assertion/branch steps through the LLM narrator and
    /// skip narration/user_prompt.
    pub fn type_tag(&self) -> &'static str {
        match self {
            Step::Command { .. } => "command",
            Step::Assertion { .. } => "assertion",
            Step::Branch { .. } => "branch",
            Step::Narration { .. } => "narration",
            Step::UserPrompt { .. } => "user_prompt",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_playbook() {
        let yaml = r#"
id: smoke
name: Smoke Test
symptom_keywords: [smoke]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: command
    command: show version
  - id: s2
    type: branch
    expression: foo
    cases:
      - when: bar
        next: s3
  - id: s3
    type: narration
    text: ok
"#;
        let pb = Playbook::parse_yaml(yaml).unwrap();
        assert_eq!(pb.id, "smoke");
        assert_eq!(pb.steps.len(), 3);
        assert!(matches!(pb.steps[0], Step::Command { .. }));
        assert!(matches!(pb.steps[1], Step::Branch { .. }));
        assert!(matches!(pb.steps[2], Step::Narration { .. }));
    }

    #[test]
    fn find_step_resolves_by_id() {
        let yaml = r#"
id: lookup
name: Lookup Test
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: a
    type: narration
    text: a
  - id: b
    type: narration
    text: b
"#;
        let pb = Playbook::parse_yaml(yaml).unwrap();
        assert!(pb.find_step("a").is_some());
        assert!(pb.find_step("b").is_some());
        assert!(pb.find_step("c").is_none());
    }

    #[test]
    fn unknown_step_type_fails_to_parse() {
        let yaml = r#"
id: bad
name: Bad
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: bogus
"#;
        assert!(Playbook::parse_yaml(yaml).is_err());
    }
}

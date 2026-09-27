use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandState {
    pub cmd: String,
    pub start_time: i64,  // Unix timestamp
    pub exit_code: Option<i32>,
    #[serde(with = "serde_vecdeque")]
    pub output_preview: VecDeque<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationState {
    Idle,
    Running,
    NeedsAttention,
}

/// Status reported by an in-pane agent (claude/codex) via its lifecycle hooks.
/// This is the authoritative signal for an agent pane's activity indicator —
/// unlike OSC 133 command state, which can't tell a busy agent from an idle
/// one (an interactive agent CLI is a single long-lived foreground process).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    /// The agent is actively processing a turn (UserPromptSubmit / PreToolUse).
    Working,
    /// The agent finished its turn and is waiting for the user (Stop /
    /// Notification idle_prompt / permission_prompt).
    Waiting,
    /// The agent session ended or went fully idle.
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneActivity {
    pub pane_id: String,
    pub tab_id: String,
    pub active_command: Option<CommandState>,
    pub cwd: String,
    pub last_focus_time: Option<i64>,
    pub notification_state: NotificationState,
    pub updated_at: i64,
}

mod serde_vecdeque {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::VecDeque;

    pub fn serialize<S>(v: &VecDeque<String>, s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let vec: Vec<_> = v.iter().cloned().collect();
        vec.serialize(s)
    }

    pub fn deserialize<'de, D>(d: D) -> Result<VecDeque<String>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let vec = Vec::<String>::deserialize(d)?;
        Ok(vec.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_state_serialization() {
        let mut output = VecDeque::new();
        output.push_back("line 1".to_string());
        output.push_back("line 2".to_string());

        let state = CommandState {
            cmd: "pytest tests/".to_string(),
            start_time: 1718753400,
            exit_code: Some(0),
            output_preview: output,
        };

        let json = serde_json::to_string(&state).unwrap();
        let restored: CommandState = serde_json::from_str(&json).unwrap();

        assert_eq!(state, restored);
        assert_eq!(restored.output_preview.len(), 2);

        // Field names MUST be camelCase to match the frontend CommandState
        // interface (src/lib/paneActivity.ts). A snake_case mismatch crashed
        // PaneActivityIndicator with "undefined outputPreview".
        assert!(json.contains("\"startTime\""), "got {json}");
        assert!(json.contains("\"exitCode\""), "got {json}");
        assert!(json.contains("\"outputPreview\""), "got {json}");
        assert!(!json.contains("output_preview"), "got {json}");
    }

    #[test]
    fn test_notification_state_serialization() {
        assert_eq!(
            serde_json::to_string(&NotificationState::Idle).unwrap(),
            r#""idle""#
        );
        assert_eq!(
            serde_json::to_string(&NotificationState::Running).unwrap(),
            r#""running""#
        );
        assert_eq!(
            serde_json::to_string(&NotificationState::NeedsAttention).unwrap(),
            r#""needs_attention""#
        );
    }

    #[test]
    fn test_pane_activity_to_json() {
        let activity = PaneActivity {
            pane_id: "pane-123".to_string(),
            tab_id: "tab-1".to_string(),
            active_command: None,
            cwd: "/home/user".to_string(),
            last_focus_time: Some(1718753400),
            notification_state: NotificationState::Idle,
            updated_at: 1718753400,
        };

        let json = serde_json::to_string(&activity).unwrap();
        assert!(json.contains(r#""paneId":"pane-123""#));
        assert!(json.contains(r#""notificationState":"idle""#));
    }
}

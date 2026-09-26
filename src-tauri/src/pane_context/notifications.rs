use crate::pane_context::CommandState;

/// Notification configuration (future: load from settings)
pub struct NotificationConfig {
    pub min_duration_sec: i64,
    pub notify_on_error: bool,
    pub keyword_triggers: Vec<String>,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            min_duration_sec: 30,
            notify_on_error: true,
            keyword_triggers: vec![
                "error".to_string(),
                "failed".to_string(),
                "timeout".to_string(),
            ],
        }
    }
}

/// Determine if a completed command should trigger a notification.
///
/// Flag as needs-attention when:
/// - Command runs >30s AND completes in non-focused pane
/// - Non-zero exit code in non-focused pane
/// - Output contains keywords (error, failed, timeout)
///
/// Don't flag when:
/// - Duration <5s (quick commands)
/// - Pane is focused (user already looking)
/// - Success + quick (<30s, exit 0, no keywords)
pub fn should_notify(
    command_state: &CommandState,
    is_focused: bool,
    config: &NotificationConfig,
) -> bool {
    // Never notify focused pane (user is looking)
    if is_focused {
        return false;
    }

    let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => return false, // Clock error = don't notify
    };

    let duration = now - command_state.start_time;

    // Ignore very quick commands (<5s)
    if duration < 5 {
        return false;
    }

    // Notify on non-zero exit (if configured)
    if config.notify_on_error {
        if let Some(exit_code) = command_state.exit_code {
            if exit_code != 0 {
                return true;
            }
        }
    }

    // Notify on long-running commands (>min_duration)
    if duration >= config.min_duration_sec {
        return true;
    }

    // Notify on keyword triggers in output
    if !config.keyword_triggers.is_empty() {
        let output_text: String = command_state
            .output_preview
            .iter()
            .map(|s| s.to_lowercase())
            .collect::<Vec<_>>()
            .join("\n");

        for keyword in &config.keyword_triggers {
            if output_text.contains(&keyword.to_lowercase()) {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn make_command(duration_sec: i64, exit_code: Option<i32>, output: &[&str]) -> CommandState {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let mut preview = VecDeque::new();
        for line in output {
            preview.push_back(line.to_string());
        }

        CommandState {
            cmd: "test".to_string(),
            start_time: now - duration_sec,
            exit_code,
            output_preview: preview,
        }
    }

    #[test]
    fn test_no_notify_if_focused() {
        let config = NotificationConfig::default();
        let cmd = make_command(60, Some(1), &["error occurred"]);
        assert!(!should_notify(&cmd, true, &config));
    }

    #[test]
    fn test_no_notify_quick_success() {
        let config = NotificationConfig::default();
        let cmd = make_command(2, Some(0), &["all good"]);
        assert!(!should_notify(&cmd, false, &config));
    }

    #[test]
    fn test_notify_long_duration() {
        let config = NotificationConfig::default();
        let cmd = make_command(45, Some(0), &["done"]);
        assert!(should_notify(&cmd, false, &config));
    }

    #[test]
    fn test_notify_error_exit() {
        let config = NotificationConfig::default();
        let cmd = make_command(10, Some(1), &["failed"]);
        assert!(should_notify(&cmd, false, &config));
    }

    #[test]
    fn test_notify_keyword_in_output() {
        let config = NotificationConfig::default();
        let cmd = make_command(10, Some(0), &["Build succeeded", "Error: deprecated API"]);
        assert!(should_notify(&cmd, false, &config));
    }

    #[test]
    fn test_no_notify_keyword_if_quick_success() {
        let config = NotificationConfig::default();
        let cmd = make_command(2, Some(0), &["No errors found"]);
        // 2 seconds is < 5s threshold, even with keyword
        assert!(!should_notify(&cmd, false, &config));
    }
}

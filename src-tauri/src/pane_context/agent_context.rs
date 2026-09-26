use crate::pane_context::{NotificationState, PaneActivity, PaneContextManager};

/// Build pane context prompt section for agent system prompt.
///
/// Format:
/// ```text
/// ## Current Terminal Context
///
/// Layout: N panes - Pane X (focused), Pane Y (running), Pane Z (idle)
///
/// Focused Pane:
/// - Working Directory: /path
/// - Active Command: cmd (duration)
/// - Recent Output: [lines]
///
/// Other Visible Panes:
/// Pane Y: Running `cmd` (duration)
///   [output preview]
/// ```
pub fn build_pane_context_prompt(
    manager: &PaneContextManager,
    tab_id: &str,
    focused_pane_id: Option<&str>,
) -> String {
    let mut activities = manager.get_all_activities(tab_id);

    if activities.is_empty() {
        return String::new(); // No panes, no context
    }

    // Sort by pane_id so pane numbering is stable across calls. The manager
    // stores panes in a HashMap, whose iteration order is non-deterministic;
    // without this sort, the same pane can render as "Pane 1" or "Pane 2" on
    // different invocations.
    activities.sort_by(|a, b| a.pane_id.cmp(&b.pane_id));

    let mut lines = vec![];
    lines.push("## Current Terminal Context".to_string());
    lines.push("".to_string());

    // Layout summary
    let pane_count = activities.len();
    let running_count = activities
        .iter()
        .filter(|a| a.notification_state == NotificationState::Running)
        .count();

    lines.push(format!(
        "**Layout:** {} pane{} total - {} running",
        pane_count,
        if pane_count == 1 { "" } else { "s" },
        running_count
    ));
    lines.push("".to_string());

    // Focused pane details (if exists)
    if let Some(focused_id) = focused_pane_id {
        if let Some(focused) = activities.iter().find(|a| a.pane_id == focused_id) {
            lines.push("**Focused Pane (where you were invoked):**".to_string());
            lines.push(format!("- Working Directory: {}", focused.cwd));

            if let Some(ref cmd) = focused.active_command {
                let duration = format_duration(cmd.start_time);
                let status = if cmd.exit_code.is_none() {
                    format!("running for {}", duration)
                } else {
                    format!("completed {} ago", duration)
                };
                lines.push(format!("- Active Command: {} ({})", cmd.cmd, status));

                if !cmd.output_preview.is_empty() {
                    lines.push("- Recent Output (last 20 lines):".to_string());
                    lines.push("```".to_string());
                    for line in cmd.output_preview.iter().rev().take(20).rev() {
                        lines.push(line.clone());
                    }
                    lines.push("```".to_string());
                }
            } else {
                lines.push("- No active command".to_string());
            }
            lines.push("".to_string());
        }
    }

    // Other panes (brief summaries)
    let other_panes: Vec<&PaneActivity> = activities
        .iter()
        .filter(|a| Some(a.pane_id.as_str()) != focused_pane_id)
        .collect();

    if !other_panes.is_empty() {
        lines.push("**Other Visible Panes:**".to_string());
        lines.push("".to_string());

        for pane in other_panes {
            if let Some(ref cmd) = pane.active_command {
                let duration = format_duration(cmd.start_time);
                let status = match cmd.exit_code {
                    Some(exit_code) => format!("exit code {}, {} ago", exit_code, duration),
                    None => format!("running for {}", duration),
                };

                lines.push(format!(
                    "**Pane {}:** {} `{}` ({})",
                    short_pane_id(&pane.pane_id),
                    if cmd.exit_code.is_none() {
                        "Running"
                    } else {
                        "Completed"
                    },
                    cmd.cmd,
                    status
                ));
                lines.push(format!("  Working Directory: {}", pane.cwd));

                if !cmd.output_preview.is_empty() {
                    lines.push("  Recent output (last 10 lines):".to_string());
                    for line in cmd.output_preview.iter().rev().take(10).rev() {
                        lines.push(format!("  {}", line));
                    }
                }
                lines.push("".to_string());
            } else {
                lines.push(format!(
                    "**Pane {}:** Idle (cwd: {})",
                    short_pane_id(&pane.pane_id),
                    pane.cwd
                ));
                lines.push("".to_string());
            }
        }
    }

    // Multi-agent context (if other agents are active)
    let active_agents = manager.get_active_agent_sessions();
    let other_agents: Vec<_> = active_agents
        .iter()
        .filter(|session| Some(session.pane_id.as_str()) != focused_pane_id)
        .collect();

    if !other_agents.is_empty() {
        lines.push("".to_string());
        lines.push("## Multi-Agent Context".to_string());
        lines.push("".to_string());
        lines.push("Other agents currently active in this workspace:".to_string());
        lines.push("".to_string());

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        // Build list of pane IDs for finding pane numbers
        let all_pane_ids: Vec<String> = activities.iter().map(|a| a.pane_id.clone()).collect();

        for session in other_agents {
            let elapsed = now - session.started_at;
            let duration_str = if elapsed >= 3600 {
                format!("{}h", elapsed / 3600)
            } else if elapsed >= 60 {
                format!("{}m", elapsed / 60)
            } else {
                format!("{}s", elapsed)
            };

            let status = if session.is_waiting_for_user {
                "waiting for user input"
            } else {
                "active"
            };

            // Find which pane number this is (1-indexed for display)
            if let Some(pane_num) = all_pane_ids.iter().position(|p| p == &session.pane_id) {
                lines.push(format!(
                    "- **Pane {}:** {} ({}, running for {})",
                    pane_num + 1,
                    session.agent_type,
                    status,
                    duration_str
                ));
            }
        }
        lines.push("".to_string());
    }

    lines.push("Use this context to provide more informed assistance.".to_string());
    lines.join("\n")
}

fn format_duration(start_time: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let elapsed = now - start_time;

    if elapsed < 60 {
        format!("{}s", elapsed)
    } else if elapsed < 3600 {
        format!("{}m", elapsed / 60)
    } else {
        format!("{}h", elapsed / 3600)
    }
}

fn short_pane_id(full_id: &str) -> String {
    // "pane-uuid" -> "uuid" (last 6 chars)
    if let Some(idx) = full_id.rfind('-') {
        full_id[idx + 1..].chars().take(6).collect()
    } else {
        full_id.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_parser::ParseEvent;

    #[test]
    fn test_build_empty_context() {
        let manager = PaneContextManager::new();
        let context = build_pane_context_prompt(&manager, "tab-1", None);
        assert_eq!(context, "");
    }

    #[test]
    fn test_build_single_pane_context() {
        let manager = PaneContextManager::new();
        manager.register_pane(
            "pane-1".to_string(),
            "tab-1".to_string(),
            "/home".to_string(),
        );

        let context = build_pane_context_prompt(&manager, "tab-1", Some("pane-1"));
        assert!(context.contains("## Current Terminal Context"));
        assert!(context.contains("1 pane total"));
        assert!(context.contains("Focused Pane"));
        assert!(context.contains("/home"));
    }

    #[test]
    fn test_build_multi_pane_context() {
        let manager = PaneContextManager::new();
        manager.register_pane(
            "pane-1".to_string(),
            "tab-1".to_string(),
            "/home".to_string(),
        );
        manager.register_pane(
            "pane-2".to_string(),
            "tab-1".to_string(),
            "/tmp".to_string(),
        );

        // Simulate command in pane-2
        manager.handle_event(
            "pane-2",
            "tab-1",
            ParseEvent::CommandStart {
                cmd: "tail -f logs".to_string(),
            },
        );

        let context = build_pane_context_prompt(&manager, "tab-1", Some("pane-1"));
        assert!(context.contains("2 panes total"));
        assert!(context.contains("Other Visible Panes"));
        assert!(context.contains("tail -f logs"));
    }

    #[test]
    fn test_build_context_with_multiple_agents() {
        let manager = PaneContextManager::new();
        manager.register_pane(
            "pane-1".to_string(),
            "tab-1".to_string(),
            "/home".to_string(),
        );
        manager.register_pane(
            "pane-2".to_string(),
            "tab-1".to_string(),
            "/project".to_string(),
        );

        manager.register_agent_session("pane-1", "claude-code");
        manager.register_agent_session("pane-2", "ccie-agent");

        manager.set_focus("pane-1");

        let context = build_pane_context_prompt(&manager, "tab-1", Some("pane-1"));

        assert!(context.contains("Multi-Agent Context"));
        assert!(context.contains("ccie-agent"));
        assert!(context.contains("active")); // agent is active

        // Multi-Agent section should only mention Pane 2, not Pane 1
        let multi_agent_section = context.split("## Multi-Agent Context").nth(1).unwrap();
        assert!(multi_agent_section.contains("Pane 2"));
        assert!(!multi_agent_section.contains("claude-code")); // focused pane's agent excluded
    }

    #[test]
    fn test_build_context_without_other_agents() {
        let manager = PaneContextManager::new();
        manager.register_pane(
            "pane-1".to_string(),
            "tab-1".to_string(),
            "/home".to_string(),
        );

        // Only register agent in focused pane
        manager.register_agent_session("pane-1", "claude-code");
        manager.set_focus("pane-1");

        let context = build_pane_context_prompt(&manager, "tab-1", Some("pane-1"));

        // Should NOT have multi-agent section since no other agents
        assert!(!context.contains("Multi-Agent Context"));
    }

    #[test]
    fn test_build_context_with_waiting_agent() {
        let manager = PaneContextManager::new();
        manager.register_pane(
            "pane-1".to_string(),
            "tab-1".to_string(),
            "/home".to_string(),
        );
        manager.register_pane(
            "pane-2".to_string(),
            "tab-1".to_string(),
            "/project".to_string(),
        );

        manager.register_agent_session("pane-1", "claude-code");
        manager.register_agent_session("pane-2", "ccie-agent");

        // Mark pane-2 agent as waiting for user input
        manager.update_agent_activity("pane-2", true);

        manager.set_focus("pane-1");

        let context = build_pane_context_prompt(&manager, "tab-1", Some("pane-1"));

        assert!(context.contains("Multi-Agent Context"));
        assert!(context.contains("ccie-agent"));
        assert!(context.contains("waiting for user input"));
    }
}

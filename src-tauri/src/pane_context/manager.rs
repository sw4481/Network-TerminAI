use crate::command_parser::ParseEvent;
use crate::pane_context::{AgentSessionTracker, AgentStatus, CommandState, NotificationConfig, NotificationState, PaneActivity, should_notify};
use anyhow::{Context, Result};
use parking_lot::RwLock;
use rusqlite::{params, Connection};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

const MAX_OUTPUT_PREVIEW_LINES: usize = 50;

/// Interactive agent CLIs that report their own activity via lifecycle hooks
/// (see `set_agent_status`). These are long-lived foreground processes that
/// never return to the shell prompt while running, so OSC 133 cannot tell a
/// busy agent from an idle one. We must NOT pin their pane to Running on
/// launch — the hooks are the source of truth.
const AGENT_CLIS: &[&str] = &["claude", "codex"];

/// True if the command line launches an interactive agent CLI. Matches on the
/// final path segment of the first whitespace-delimited token, so
/// `/usr/local/bin/claude`, `claude --resume`, and `claude` all match, while
/// `claude-helper` or `myclaude` do not.
fn is_agent_command(cmd: &str) -> bool {
    let Some(first) = cmd.split_whitespace().next() else {
        return false;
    };
    let bin = first.rsplit('/').next().unwrap_or(first);
    AGENT_CLIS.contains(&bin)
}

#[derive(Clone)]
struct PaneState {
    pane_id: String,
    tab_id: String,
    active_command: Option<CommandState>,
    cwd: String,
    last_focus_time: Option<i64>,
    notification_state: NotificationState,
    /// True while a full-screen TUI owns the alternate screen. Suppresses the
    /// Running indicator, which would otherwise stay pinned for the whole
    /// session (the foreground process never emits OSC 133 D until it exits).
    in_alt_screen: bool,
    updated_at: i64,
}

impl PaneState {
    fn to_activity(&self) -> PaneActivity {
        PaneActivity {
            pane_id: self.pane_id.clone(),
            tab_id: self.tab_id.clone(),
            active_command: self.active_command.clone(),
            cwd: self.cwd.clone(),
            last_focus_time: self.last_focus_time,
            notification_state: self.notification_state,
            updated_at: self.updated_at,
        }
    }
}

pub struct PaneContextManager {
    states: Arc<RwLock<HashMap<String, PaneState>>>,
    focused_pane_id: Arc<RwLock<Option<String>>>,
    notification_config: Arc<RwLock<NotificationConfig>>,
    agent_sessions: Arc<AgentSessionTracker>,
}

impl Default for PaneContextManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PaneContextManager {
    pub fn new() -> Self {
        Self {
            states: Arc::new(RwLock::new(HashMap::new())),
            focused_pane_id: Arc::new(RwLock::new(None)),
            notification_config: Arc::new(RwLock::new(NotificationConfig::default())),
            agent_sessions: Arc::new(AgentSessionTracker::new()),
        }
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    /// Initialize or ensure a pane exists in state
    pub fn register_pane(&self, pane_id: String, tab_id: String, cwd: String) {
        let mut states = self.states.write();
        states.entry(pane_id.clone()).or_insert_with(|| PaneState {
            pane_id,
            tab_id,
            active_command: None,
            cwd,
            last_focus_time: None,
            notification_state: NotificationState::Idle,
            in_alt_screen: false,
            updated_at: Self::now(),
        });
    }

    /// Handle a parsed PTY event for a specific pane
    pub fn handle_event(&self, pane_id: &str, tab_id: &str, event: ParseEvent) {
        let mut states = self.states.write();
        let state = states.entry(pane_id.to_string()).or_insert_with(|| PaneState {
            pane_id: pane_id.to_string(),
            tab_id: tab_id.to_string(),
            active_command: None,
            cwd: "/".to_string(),
            last_focus_time: None,
            notification_state: NotificationState::Idle,
            in_alt_screen: false,
            updated_at: Self::now(),
        });

        match event {
            ParseEvent::CommandStart { cmd } => {
                let is_agent = is_agent_command(&cmd);
                let mut output = VecDeque::new();
                output.push_back(format!("$ {}", cmd));

                state.active_command = Some(CommandState {
                    cmd,
                    start_time: Self::now(),
                    exit_code: None,
                    output_preview: output,
                });
                // Do NOT set Running when:
                //  - a full-screen TUI owns the alternate screen (vim/top/…), or
                //  - the command launches an interactive agent CLI (claude/codex).
                // Both are long-lived foreground processes that never emit
                // OSC 133 D until they exit, which would otherwise pin the pane
                // to Running for the whole session. Agent panes are driven
                // instead by lifecycle hooks via `set_agent_status`; everything
                // else stays calm until the agent actually reports activity.
                if !state.in_alt_screen && !is_agent {
                    state.notification_state = NotificationState::Running;
                }
                state.updated_at = Self::now();
            }
            ParseEvent::CommandEnd { exit_code } => {
                if let Some(ref mut cmd_state) = state.active_command {
                    cmd_state.exit_code = exit_code;

                    // Check if should notify
                    let focused = self.focused_pane_id.read();
                    let is_focused = focused.as_ref() == Some(&pane_id.to_string());
                    let config = self.notification_config.read();

                    if should_notify(cmd_state, is_focused, &config) {
                        state.notification_state = NotificationState::NeedsAttention;
                    } else {
                        state.notification_state = NotificationState::Idle;
                    }
                }
                state.updated_at = Self::now();
            }
            ParseEvent::Output(bytes) => {
                if let Some(ref mut cmd_state) = state.active_command {
                    if let Ok(text) = String::from_utf8(bytes) {
                        for line in text.lines() {
                            if !line.trim().is_empty() {
                                cmd_state.output_preview.push_back(line.to_string());
                                if cmd_state.output_preview.len() > MAX_OUTPUT_PREVIEW_LINES {
                                    cmd_state.output_preview.pop_front();
                                }
                            }
                        }
                    }
                }
                state.updated_at = Self::now();
            }
            ParseEvent::Cwd(path) => {
                state.cwd = path;
                state.updated_at = Self::now();
            }
            ParseEvent::EnterAltScreen => {
                state.in_alt_screen = true;
                // Clear any Running state set by the command that launched the
                // TUI (e.g. the `claude` invocation itself). The pane is now an
                // interactive session, not a running batch command.
                if state.notification_state == NotificationState::Running {
                    state.notification_state = NotificationState::Idle;
                }
                state.updated_at = Self::now();
            }
            ParseEvent::ExitAltScreen => {
                state.in_alt_screen = false;
                // The TUI has exited; the launching command is effectively done.
                // Return to Idle so normal OSC 133 tracking resumes cleanly for
                // the next command.
                if state.notification_state == NotificationState::Running {
                    state.notification_state = NotificationState::Idle;
                }
                state.updated_at = Self::now();
            }
        }
    }

    /// Update focused pane (clears notification if pane was needs-attention)
    pub fn set_focus(&self, pane_id: &str) {
        let now = Self::now();
        *self.focused_pane_id.write() = Some(pane_id.to_string());

        let mut states = self.states.write();
        if let Some(state) = states.get_mut(pane_id) {
            state.last_focus_time = Some(now);
            // Clear notification when user focuses the pane
            if state.notification_state == NotificationState::NeedsAttention {
                state.notification_state = NotificationState::Idle;
            }
            state.updated_at = now;
        }
    }

    /// Clear notification state for a pane
    pub fn clear_notification(&self, pane_id: &str) {
        let mut states = self.states.write();
        if let Some(state) = states.get_mut(pane_id) {
            state.notification_state = NotificationState::Idle;
            state.updated_at = Self::now();
        }
    }

    /// Get activity for a specific pane
    pub fn get_activity(&self, pane_id: &str) -> Option<PaneActivity> {
        self.states.read().get(pane_id).map(|s| s.to_activity())
    }

    /// Get all activities for a tab
    pub fn get_all_activities(&self, tab_id: &str) -> Vec<PaneActivity> {
        self.states
            .read()
            .values()
            .filter(|s| s.tab_id == tab_id)
            .map(|s| s.to_activity())
            .collect()
    }

    /// Get all activities across all tabs (for MCP server)
    pub fn get_all_activities_global(&self) -> Vec<PaneActivity> {
        self.states
            .read()
            .values()
            .map(|s| s.to_activity())
            .collect()
    }

    /// Get the currently focused pane ID (for MCP server)
    pub fn get_focused_pane_id(&self) -> Option<String> {
        self.focused_pane_id.read().clone()
    }

    /// Remove pane from state (on close)
    pub fn unregister_pane(&self, pane_id: &str) {
        self.states.write().remove(pane_id);
    }

    /// Persist a pane's activity to database
    pub fn persist_activity(&self, conn: &Connection, pane_id: &str) -> Result<()> {
        let states = self.states.read();
        let state = states
            .get(pane_id)
            .context("pane not found in state")?;

        let active_command_json = state
            .active_command
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        let notification_state_str = match state.notification_state {
            NotificationState::Idle => "idle",
            NotificationState::Running => "running",
            NotificationState::NeedsAttention => "needs_attention",
        };

        conn.execute(
            "INSERT OR REPLACE INTO pane_activity
             (pane_id, tab_id, active_command_json, cwd, last_focus_time, notification_state, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &state.pane_id,
                &state.tab_id,
                active_command_json,
                &state.cwd,
                state.last_focus_time,
                notification_state_str,
                state.updated_at,
            ],
        )?;

        Ok(())
    }

    /// Load activities for a tab from database
    pub fn load_activities(&self, conn: &Connection, tab_id: &str) -> Result<()> {
        let mut stmt = conn.prepare(
            "SELECT pane_id, tab_id, active_command_json, cwd, last_focus_time, notification_state, updated_at
             FROM pane_activity WHERE tab_id = ?1"
        )?;

        let rows = stmt.query_map(params![tab_id], |row| {
            let active_command_json: Option<String> = row.get(2)?;
            let active_command = active_command_json
                .as_ref()
                .and_then(|json| serde_json::from_str(json).ok());

            let notification_state_str: String = row.get(5)?;
            let notification_state = match notification_state_str.as_str() {
                "running" => NotificationState::Running,
                "needs_attention" => NotificationState::NeedsAttention,
                _ => NotificationState::Idle,
            };

            Ok(PaneState {
                pane_id: row.get(0)?,
                tab_id: row.get(1)?,
                active_command,
                cwd: row.get(3)?,
                last_focus_time: row.get(4)?,
                notification_state,
                // Alt-screen is ephemeral runtime state, not persisted.
                in_alt_screen: false,
                updated_at: row.get(6)?,
            })
        })?;

        let mut states = self.states.write();
        for row in rows {
            let state = row?;
            states.insert(state.pane_id.clone(), state);
        }

        Ok(())
    }

    /// Delete pane activity from database (on pane close)
    pub fn delete_activity(&self, conn: &Connection, pane_id: &str) -> Result<()> {
        conn.execute("DELETE FROM pane_activity WHERE pane_id = ?1", params![pane_id])?;
        Ok(())
    }

    /// Authoritative agent activity signal, reported by an in-pane agent
    /// (claude/codex) via its lifecycle hooks. Drives the pane's notification
    /// state directly and keeps the agent-session tracker in sync.
    ///
    /// This deliberately bypasses the alt-screen suppression: an agent that is
    /// explicitly reporting its state is exactly the pane we want a live
    /// indicator on. It also overrides OSC 133 command state, which cannot
    /// distinguish a busy agent from an idle one (the agent CLI is a single
    /// long-lived foreground process).
    pub fn set_agent_status(&self, pane_id: &str, agent_type: &str, status: AgentStatus) {
        // Ensure the agent session is tracked (and its type/waiting flag fresh).
        match status {
            AgentStatus::Working | AgentStatus::Waiting => {
                if self.get_agent_session(pane_id).is_none() {
                    self.agent_sessions.register(pane_id.to_string(), agent_type.to_string());
                }
                self.agent_sessions
                    .update_activity(pane_id, matches!(status, AgentStatus::Waiting));
            }
            AgentStatus::Idle => {
                self.agent_sessions.unregister(pane_id);
            }
        }

        let mut states = self.states.write();
        let state = states.entry(pane_id.to_string()).or_insert_with(|| PaneState {
            pane_id: pane_id.to_string(),
            tab_id: pane_id.to_string(),
            active_command: None,
            cwd: "/".to_string(),
            last_focus_time: None,
            notification_state: NotificationState::Idle,
            in_alt_screen: false,
            updated_at: Self::now(),
        });
        state.notification_state = match status {
            AgentStatus::Working => NotificationState::Running,
            AgentStatus::Waiting => NotificationState::NeedsAttention,
            AgentStatus::Idle => NotificationState::Idle,
        };
        state.updated_at = Self::now();
    }

    /// Register an agent session for a pane
    pub fn register_agent_session(&self, pane_id: &str, agent_type: &str) {
        self.agent_sessions.register(pane_id.to_string(), agent_type.to_string());
    }

    /// Unregister an agent session for a pane
    pub fn unregister_agent_session(&self, pane_id: &str) {
        self.agent_sessions.unregister(pane_id);
    }

    /// Update agent activity and waiting state
    pub fn update_agent_activity(&self, pane_id: &str, is_waiting: bool) {
        self.agent_sessions.update_activity(pane_id, is_waiting);
    }

    /// Get all active agent sessions
    pub fn get_active_agent_sessions(&self) -> Vec<crate::pane_context::AgentSession> {
        self.agent_sessions.get_active_sessions()
    }

    /// Get agent session for a specific pane
    pub fn get_agent_session(&self, pane_id: &str) -> Option<crate::pane_context::AgentSession> {
        self.agent_sessions.get_active_sessions()
            .into_iter()
            .find(|s| s.pane_id == pane_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manager_command_lifecycle() {
        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/home".to_string());

        // Start command
        manager.handle_event(
            "pane-1",
            "tab-1",
            ParseEvent::CommandStart {
                cmd: "sleep 60".to_string(),
            },
        );

        let activity = manager.get_activity("pane-1").unwrap();
        assert!(activity.active_command.is_some());
        assert_eq!(activity.notification_state, NotificationState::Running);

        // Add output
        manager.handle_event(
            "pane-1",
            "tab-1",
            ParseEvent::Output(b"waiting...\n".to_vec()),
        );

        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(activity.active_command.as_ref().unwrap().output_preview.len(), 2); // "$ sleep 60" + "waiting..."

        // End command
        manager.handle_event(
            "pane-1",
            "tab-1",
            ParseEvent::CommandEnd { exit_code: Some(0) },
        );

        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(activity.active_command.as_ref().unwrap().exit_code, Some(0));
    }

    #[test]
    fn test_manager_focus_clears_notification() {
        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/home".to_string());

        // Manually set needs-attention
        {
            let mut states = manager.states.write();
            if let Some(state) = states.get_mut("pane-1") {
                state.notification_state = NotificationState::NeedsAttention;
            }
        }

        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(activity.notification_state, NotificationState::NeedsAttention);

        // Focus should clear it
        manager.set_focus("pane-1");

        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(activity.notification_state, NotificationState::Idle);
        assert!(activity.last_focus_time.is_some());
    }

    /// PROOF TEST: drives the EXACT path the live PTY uses — raw OSC 133
    /// bytes through `Parser::feed`, then each event into `handle_event` —
    /// and verifies a long-running command in an UNFOCUSED pane flips to
    /// NeedsAttention. This is the end-to-end backend contract the
    /// notification bell depends on.
    #[test]
    fn test_osc133_drives_needs_attention_for_long_unfocused_command() {
        use crate::command_parser::Parser;

        let manager = PaneContextManager::new();
        manager.register_pane("pane-bg".to_string(), "tab-1".to_string(), "/".to_string());

        // Focus a DIFFERENT pane so the background pane is unfocused.
        manager.register_pane("pane-fg".to_string(), "tab-1".to_string(), "/".to_string());
        manager.set_focus("pane-fg");

        // Feed the OSC 133 "command start" marker exactly as the zsh
        // integration emits it: ESC ] 133 ; C ; <cmd> BEL
        let mut parser = Parser::new();
        for ev in parser.feed(b"\x1b]133;C;sleep 40\x07") {
            manager.handle_event("pane-bg", "tab-1", ev);
        }

        // Confirm it is running.
        let running = manager.get_activity("pane-bg").unwrap();
        assert_eq!(running.notification_state, NotificationState::Running);

        // Backdate start_time by 40s so the duration heuristic (>30s) fires.
        // The live PTY achieves this with real wall-clock time.
        {
            let mut states = manager.states.write();
            let state = states.get_mut("pane-bg").unwrap();
            let cmd = state.active_command.as_mut().unwrap();
            cmd.start_time -= 40;
        }

        // Feed the OSC 133 "command end" marker: ESC ] 133 ; D ; 0 BEL
        for ev in parser.feed(b"\x1b]133;D;0\x07") {
            manager.handle_event("pane-bg", "tab-1", ev);
        }

        // The 40s exit-0 command in an unfocused pane MUST need attention.
        let done = manager.get_activity("pane-bg").unwrap();
        assert_eq!(
            done.notification_state,
            NotificationState::NeedsAttention,
            "long-running unfocused command should flip to NeedsAttention"
        );
        assert_eq!(done.active_command.as_ref().unwrap().exit_code, Some(0));
    }

    /// PROOF TEST: a quick (<30s) successful command in an unfocused pane
    /// must NOT notify — guards against alert fatigue. This is why the
    /// user's `sleep 20` produced no notification.
    #[test]
    fn test_short_unfocused_command_does_not_notify() {
        use crate::command_parser::Parser;

        let manager = PaneContextManager::new();
        manager.register_pane("pane-bg".to_string(), "tab-1".to_string(), "/".to_string());
        manager.register_pane("pane-fg".to_string(), "tab-1".to_string(), "/".to_string());
        manager.set_focus("pane-fg");

        let mut parser = Parser::new();
        for ev in parser.feed(b"\x1b]133;C;sleep 20\x07") {
            manager.handle_event("pane-bg", "tab-1", ev);
        }
        // Backdate only 20s — below the 30s threshold.
        {
            let mut states = manager.states.write();
            let cmd = states.get_mut("pane-bg").unwrap().active_command.as_mut().unwrap();
            cmd.start_time -= 20;
        }
        for ev in parser.feed(b"\x1b]133;D;0\x07") {
            manager.handle_event("pane-bg", "tab-1", ev);
        }

        let done = manager.get_activity("pane-bg").unwrap();
        assert_eq!(
            done.notification_state,
            NotificationState::Idle,
            "20s exit-0 command must NOT notify (below 30s threshold)"
        );
    }

    /// PROOF TEST (the reported bug): launching a full-screen TUI like
    /// `claude` enters the alternate screen and then never returns to the
    /// shell prompt until you quit, so OSC 133 `D` never fires. The pane must
    /// NOT be pinned to Running for the whole session. We drive the real
    /// parser path: alt-screen enter, then a CommandStart.
    #[test]
    fn test_alt_screen_suppresses_running_indicator() {
        use crate::command_parser::Parser;

        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/".to_string());

        let mut parser = Parser::new();
        // `claude` switches to the alternate screen, THEN the shell integration
        // may report the command. (Order can vary; both feeds go through.)
        for ev in parser.feed(b"\x1b[?1049h") {
            manager.handle_event("pane-1", "tab-1", ev);
        }
        for ev in parser.feed(b"\x1b]133;C;claude\x07") {
            manager.handle_event("pane-1", "tab-1", ev);
        }

        let activity = manager.get_activity("pane-1").unwrap();
        assert_ne!(
            activity.notification_state,
            NotificationState::Running,
            "a TUI in the alternate screen must not show a permanent Running indicator"
        );
    }

    /// After the TUI exits (alt-screen restored), normal OSC 133 command
    /// tracking must resume — a subsequent real command shows Running again.
    #[test]
    fn test_running_resumes_after_alt_screen_exit() {
        use crate::command_parser::Parser;

        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/".to_string());
        manager.set_focus("pane-1");

        let mut parser = Parser::new();
        for ev in parser.feed(b"\x1b[?1049h\x1b]133;C;claude\x07") {
            manager.handle_event("pane-1", "tab-1", ev);
        }
        // Quit the TUI: alternate screen restored.
        for ev in parser.feed(b"\x1b[?1049l") {
            manager.handle_event("pane-1", "tab-1", ev);
        }
        // A normal long command afterwards must track as Running again.
        for ev in parser.feed(b"\x1b]133;C;npm run build\x07") {
            manager.handle_event("pane-1", "tab-1", ev);
        }

        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(
            activity.notification_state,
            NotificationState::Running,
            "ordinary commands after the TUI exits must track normally"
        );
    }

    #[test]
    fn test_manager_get_all_activities_filters_by_tab() {
        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/home".to_string());
        manager.register_pane("pane-2".to_string(), "tab-1".to_string(), "/tmp".to_string());
        manager.register_pane("pane-3".to_string(), "tab-2".to_string(), "/var".to_string());

        let tab1_activities = manager.get_all_activities("tab-1");
        assert_eq!(tab1_activities.len(), 2);

        let tab2_activities = manager.get_all_activities("tab-2");
        assert_eq!(tab2_activities.len(), 1);
    }

    #[test]
    fn test_manager_persistence() {
        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/home".to_string());

        manager.handle_event(
            "pane-1",
            "tab-1",
            ParseEvent::CommandStart {
                cmd: "ls -la".to_string(),
            },
        );

        // Create test database
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

        // Create minimal schema for test
        conn.execute(
            "CREATE TABLE tabs (id TEXT PRIMARY KEY, title TEXT, shell_cmd TEXT, cwd TEXT, tab_type TEXT)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES ('tab-1', 'test', 'bash', '/tmp', 'terminal')",
            [],
        ).unwrap();
        conn.execute(
            "CREATE TABLE pane_activity (
                pane_id TEXT PRIMARY KEY,
                tab_id TEXT NOT NULL,
                active_command_json TEXT,
                cwd TEXT NOT NULL,
                last_focus_time INTEGER,
                notification_state TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(tab_id) REFERENCES tabs(id) ON DELETE CASCADE
            )",
            [],
        ).unwrap();

        // Persist
        manager.persist_activity(&conn, "pane-1").unwrap();

        // Verify database
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM pane_activity WHERE pane_id = ?1", params!["pane-1"], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // Create new manager and load
        let manager2 = PaneContextManager::new();
        manager2.load_activities(&conn, "tab-1").unwrap();

        let activity = manager2.get_activity("pane-1").unwrap();
        assert_eq!(activity.pane_id, "pane-1");
        assert_eq!(activity.notification_state, NotificationState::Running);
        assert!(activity.active_command.is_some());
        assert_eq!(activity.active_command.unwrap().cmd, "ls -la");
    }

    #[test]
    fn test_manager_agent_session_lifecycle() {
        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/home".to_string());

        manager.register_agent_session("pane-1", "claude-code");
        let sessions = manager.get_active_agent_sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].agent_type, "claude-code");

        let session = manager.get_agent_session("pane-1");
        assert!(session.is_some());
        assert_eq!(session.unwrap().agent_type, "claude-code");

        manager.unregister_agent_session("pane-1");
        assert!(manager.get_active_agent_sessions().is_empty());
        assert!(manager.get_agent_session("pane-1").is_none());
    }

    /// Part B: the authoritative agent signal. A `claude`/`codex` lifecycle
    /// hook reports working/waiting/idle. This must drive the notification
    /// state directly (it is the source of truth for an agent pane) AND must
    /// override the alt-screen suppression — agent panes are exactly where we
    /// want a live indicator.
    #[test]
    fn test_set_agent_status_drives_notification_state() {
        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/home".to_string());

        // working -> Running, and registers an agent session.
        manager.set_agent_status("pane-1", "claude-code", AgentStatus::Working);
        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(activity.notification_state, NotificationState::Running);
        let session = manager.get_agent_session("pane-1").expect("session registered");
        assert_eq!(session.agent_type, "claude-code");
        assert!(!session.is_waiting_for_user);

        // waiting -> NeedsAttention (the user needs to act), session marked waiting.
        manager.set_agent_status("pane-1", "claude-code", AgentStatus::Waiting);
        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(activity.notification_state, NotificationState::NeedsAttention);
        assert!(manager.get_agent_session("pane-1").unwrap().is_waiting_for_user);

        // idle -> Idle, session cleared (turn fully done / agent exited).
        manager.set_agent_status("pane-1", "claude-code", AgentStatus::Idle);
        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(activity.notification_state, NotificationState::Idle);
    }

    /// PROOF TEST (the reported bug, corrected): launching an interactive
    /// agent CLI like `claude` emits OSC 133 CommandStart but, sitting idle,
    /// fires NO lifecycle hook and never returns to the shell prompt (no
    /// CommandEnd). The pane must therefore stay calm (Idle) on launch — NOT
    /// pinned to Running — and only light up when a hook reports activity.
    #[test]
    fn test_agent_cli_command_does_not_set_running() {
        use crate::command_parser::Parser;

        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/".to_string());

        let mut parser = Parser::new();
        for ev in parser.feed(b"\x1b]133;C;claude\x07") {
            manager.handle_event("pane-1", "tab-1", ev);
        }

        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(
            activity.notification_state,
            NotificationState::Idle,
            "launching an agent CLI must NOT pin the pane to Running"
        );
    }

    /// After an agent CLI launch (calm baseline), a hook reporting `working`
    /// must still drive the indicator to Running.
    #[test]
    fn test_agent_hook_drives_state_after_calm_launch() {
        use crate::command_parser::Parser;

        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/".to_string());

        let mut parser = Parser::new();
        for ev in parser.feed(b"\x1b]133;C;claude\x07") {
            manager.handle_event("pane-1", "tab-1", ev);
        }
        // Calm at launch...
        assert_eq!(manager.get_activity("pane-1").unwrap().notification_state, NotificationState::Idle);
        // ...then a hook fires.
        manager.set_agent_status("pane-1", "claude-code", AgentStatus::Working);
        assert_eq!(manager.get_activity("pane-1").unwrap().notification_state, NotificationState::Running);
    }

    #[test]
    fn test_is_agent_command_matching() {
        assert!(is_agent_command("claude"));
        assert!(is_agent_command("claude --resume"));
        assert!(is_agent_command("/usr/local/bin/claude"));
        assert!(is_agent_command("$HOME/.local/bin/claude --model opus"));
        assert!(is_agent_command("codex"));
        // No false positives.
        assert!(!is_agent_command("claude-helper"));
        assert!(!is_agent_command("myclaude"));
        assert!(!is_agent_command("npm run build"));
        assert!(!is_agent_command("vim claude.txt"));
        assert!(!is_agent_command(""));
    }

    /// A NON-agent command must still set Running as before (no regression).
    #[test]
    fn test_normal_command_still_sets_running() {
        use crate::command_parser::Parser;

        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/".to_string());

        let mut parser = Parser::new();
        for ev in parser.feed(b"\x1b]133;C;npm run build\x07") {
            manager.handle_event("pane-1", "tab-1", ev);
        }
        assert_eq!(manager.get_activity("pane-1").unwrap().notification_state, NotificationState::Running);
    }

    /// An agent reporting status must show through even if the pane is in the
    /// alternate screen (some TUIs do use it). The agent signal is authoritative.
    #[test]
    fn test_set_agent_status_overrides_alt_screen_suppression() {
        let manager = PaneContextManager::new();
        manager.register_pane("pane-1".to_string(), "tab-1".to_string(), "/".to_string());
        manager.handle_event("pane-1", "tab-1", ParseEvent::EnterAltScreen);

        manager.set_agent_status("pane-1", "codex", AgentStatus::Working);
        let activity = manager.get_activity("pane-1").unwrap();
        assert_eq!(
            activity.notification_state,
            NotificationState::Running,
            "explicit agent working status must show despite alt-screen"
        );
    }
}

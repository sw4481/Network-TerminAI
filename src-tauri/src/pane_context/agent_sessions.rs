use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

const SESSION_TIMEOUT_SECS: i64 = 300; // 5 minutes

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub pane_id: String,
    pub agent_type: String,
    pub started_at: i64,
    pub last_activity: i64,
    pub is_waiting_for_user: bool,
}

pub struct AgentSessionTracker {
    sessions: Arc<RwLock<HashMap<String, AgentSession>>>, // key: pane_id
}

impl Default for AgentSessionTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSessionTracker {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    pub fn get_active_sessions(&self) -> Vec<AgentSession> {
        self.sessions.read().values().cloned().collect()
    }

    pub fn register(&self, pane_id: String, agent_type: String) {
        let now = Self::now();
        let session = AgentSession {
            pane_id: pane_id.clone(),
            agent_type,
            started_at: now,
            last_activity: now,
            is_waiting_for_user: false,
        };
        self.sessions.write().insert(pane_id, session);
    }

    pub fn unregister(&self, pane_id: &str) {
        self.sessions.write().remove(pane_id);
    }

    pub fn update_activity(&self, pane_id: &str, is_waiting: bool) {
        let mut sessions = self.sessions.write();
        if let Some(session) = sessions.get_mut(pane_id) {
            session.last_activity = Self::now();
            session.is_waiting_for_user = is_waiting;
        }
    }

    /// Remove sessions inactive for more than SESSION_TIMEOUT_SECS. Returns count removed.
    pub fn cleanup_stale(&self) -> usize {
        let now = Self::now();
        let mut sessions = self.sessions.write();
        let before_count = sessions.len();
        sessions.retain(|_, session| now - session.last_activity < SESSION_TIMEOUT_SECS);
        before_count - sessions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tracker_initializes_empty() {
        let tracker = AgentSessionTracker::new();
        assert!(tracker.get_active_sessions().is_empty());
    }

    #[test]
    fn test_register_and_unregister_session() {
        let tracker = AgentSessionTracker::new();

        tracker.register("pane-1".to_string(), "claude-code".to_string());
        let sessions = tracker.get_active_sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].pane_id, "pane-1");
        assert_eq!(sessions[0].agent_type, "claude-code");
        assert!(!sessions[0].is_waiting_for_user);

        tracker.unregister("pane-1");
        assert!(tracker.get_active_sessions().is_empty());
    }

    #[test]
    fn test_update_activity_and_waiting_state() {
        let tracker = AgentSessionTracker::new();
        tracker.register("pane-1".to_string(), "ccie-agent".to_string());

        let initial = tracker.get_active_sessions()[0].clone();

        std::thread::sleep(std::time::Duration::from_secs(1));
        tracker.update_activity("pane-1", false);

        let updated = tracker.get_active_sessions()[0].clone();
        assert!(updated.last_activity > initial.last_activity);
        assert!(!updated.is_waiting_for_user);

        tracker.update_activity("pane-1", true);
        let waiting = tracker.get_active_sessions()[0].clone();
        assert!(waiting.is_waiting_for_user);
    }

    #[test]
    fn test_cleanup_stale_sessions() {
        let tracker = AgentSessionTracker::new();
        tracker.register("pane-1".to_string(), "agent-a".to_string());
        tracker.register("pane-2".to_string(), "agent-b".to_string());

        // Manually set pane-1 to be stale (>5 minutes old)
        {
            let mut sessions = tracker.sessions.write();
            if let Some(session) = sessions.get_mut("pane-1") {
                session.last_activity = AgentSessionTracker::now() - 400; // 400s ago
            }
        }

        let removed = tracker.cleanup_stale();
        assert_eq!(removed, 1);

        let active = tracker.get_active_sessions();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].pane_id, "pane-2");
    }
}

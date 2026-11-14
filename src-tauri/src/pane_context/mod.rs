pub mod agent_context;
pub mod agent_sessions;
pub mod foreground;
pub mod manager;
pub mod notification_config;
pub mod notifications;
pub mod types;

pub use agent_context::build_pane_context_prompt;
pub use agent_sessions::{AgentSession, AgentSessionTracker};
pub use manager::PaneContextManager;
pub use notification_config::{
    load_notification_preferences, save_notification_preferences, NotificationPreferences,
};
pub use notifications::{should_notify, NotificationConfig};
pub use types::{AgentStatus, CommandState, NotificationState, PaneActivity};

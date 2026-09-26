pub mod types;
pub mod notifications;
pub mod manager;
pub mod agent_context;
pub mod agent_sessions;
pub mod notification_config;
pub mod foreground;

pub use types::{AgentStatus, CommandState, NotificationState, PaneActivity};
pub use notifications::{NotificationConfig, should_notify};
pub use manager::PaneContextManager;
pub use agent_context::build_pane_context_prompt;
pub use agent_sessions::{AgentSession, AgentSessionTracker};
pub use notification_config::{NotificationPreferences, load_notification_preferences, save_notification_preferences};

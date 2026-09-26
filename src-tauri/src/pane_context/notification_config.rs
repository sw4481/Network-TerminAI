use serde::{Deserialize, Serialize};
use rusqlite::{Connection, params};
use anyhow::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    pub min_duration_secs: i64,
    pub notify_on_nonzero_exit: bool,
    pub notify_on_agent_output: bool,
    pub keyword_triggers: Vec<String>,
    pub ignore_commands: Vec<String>,
    pub enable_sound: bool,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            min_duration_secs: 30,
            notify_on_nonzero_exit: true,
            notify_on_agent_output: true,
            keyword_triggers: vec!["error".to_string(), "failed".to_string(), "timeout".to_string()],
            ignore_commands: vec!["tail".to_string(), "watch".to_string(), "top".to_string(), "htop".to_string()],
            enable_sound: false,
        }
    }
}

pub fn load_notification_preferences(db: &Connection) -> Result<NotificationPreferences> {
    let mut stmt = db.prepare(
        "SELECT min_duration_secs, notify_on_nonzero_exit, notify_on_agent_output,
                keyword_triggers_json, ignore_commands_json, enable_sound
         FROM notification_preferences WHERE id = 1"
    )?;

    let row = stmt.query_row([], |row| {
        let keyword_json: String = row.get(3)?;
        let ignore_json: String = row.get(4)?;

        Ok(NotificationPreferences {
            min_duration_secs: row.get(0)?,
            notify_on_nonzero_exit: row.get::<_, i64>(1)? != 0,
            notify_on_agent_output: row.get::<_, i64>(2)? != 0,
            keyword_triggers: serde_json::from_str(&keyword_json).unwrap_or_default(),
            ignore_commands: serde_json::from_str(&ignore_json).unwrap_or_default(),
            enable_sound: row.get::<_, i64>(5)? != 0,
        })
    });

    match row {
        Ok(prefs) => Ok(prefs),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(NotificationPreferences::default()),
        Err(e) => Err(e.into()),
    }
}

pub fn save_notification_preferences(db: &Connection, prefs: &NotificationPreferences) -> Result<()> {
    let keyword_json = serde_json::to_string(&prefs.keyword_triggers)?;
    let ignore_json = serde_json::to_string(&prefs.ignore_commands)?;

    db.execute(
        "INSERT OR REPLACE INTO notification_preferences
         (id, min_duration_secs, notify_on_nonzero_exit, notify_on_agent_output,
          keyword_triggers_json, ignore_commands_json, enable_sound)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            prefs.min_duration_secs,
            if prefs.notify_on_nonzero_exit { 1 } else { 0 },
            if prefs.notify_on_agent_output { 1 } else { 0 },
            keyword_json,
            ignore_json,
            if prefs.enable_sound { 1 } else { 0 }
        ],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_notification_preferences_default() {
        let prefs = NotificationPreferences::default();
        assert_eq!(prefs.min_duration_secs, 30);
        assert!(prefs.notify_on_nonzero_exit);
        assert!(prefs.notify_on_agent_output);
        assert_eq!(prefs.keyword_triggers, vec!["error", "failed", "timeout"]);
        assert_eq!(prefs.ignore_commands, vec!["tail", "watch", "top", "htop"]);
        assert!(!prefs.enable_sound);
    }

    #[test]
    fn test_save_and_load_preferences() {
        let db = Connection::open_in_memory().unwrap();

        // Create table (migration will do this in prod, but we need it for test)
        db.execute(
            "CREATE TABLE notification_preferences (
                id INTEGER PRIMARY KEY,
                min_duration_secs INTEGER NOT NULL,
                notify_on_nonzero_exit INTEGER NOT NULL,
                notify_on_agent_output INTEGER NOT NULL,
                keyword_triggers_json TEXT NOT NULL,
                ignore_commands_json TEXT NOT NULL,
                enable_sound INTEGER NOT NULL
            )",
            [],
        ).unwrap();

        let mut prefs = NotificationPreferences::default();
        prefs.min_duration_secs = 60;
        prefs.keyword_triggers = vec!["panic".to_string()];

        save_notification_preferences(&db, &prefs).unwrap();
        let loaded = load_notification_preferences(&db).unwrap();

        assert_eq!(loaded.min_duration_secs, 60);
        assert_eq!(loaded.keyword_triggers, vec!["panic"]);
        assert_eq!(loaded.ignore_commands, vec!["tail", "watch", "top", "htop"]);
    }
}

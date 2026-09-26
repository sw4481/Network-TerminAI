use crate::heartbeat::types::*;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

pub struct HeartbeatRepo;

impl HeartbeatRepo {
    pub fn create_heartbeat(
        conn: &Connection,
        name: &str,
        description: &str,
        interval_minutes: u32,
        retention_days: u32,
    ) -> Result<Heartbeat> {
        if retention_days < 1 {
            anyhow::bail!("retention_days must be >= 1");
        }
        if interval_minutes < 1 {
            anyhow::bail!("interval_minutes must be >= 1");
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;

        conn.execute(
            "INSERT INTO heartbeats (id, name, description, interval_minutes, retention_days, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
            params![&id, name, description, interval_minutes, retention_days, now],
        )
        .context("insert heartbeat")?;

        Self::get_heartbeat(conn, &id)?
            .ok_or_else(|| anyhow::anyhow!("readback after insert"))
    }

    pub fn get_heartbeat(conn: &Connection, id: &str) -> Result<Option<Heartbeat>> {
        let row = conn
            .query_row(
                "SELECT id, name, description, interval_minutes, retention_days, enabled, next_run_at, created_at, updated_at
                 FROM heartbeats WHERE id = ?1",
                [id],
                |row| {
                    Ok(Heartbeat {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        interval_minutes: row.get::<_, i64>(3)? as u32,
                        retention_days: row.get::<_, i64>(4)? as u32,
                        enabled: row.get::<_, i64>(5)? != 0,
                        next_run_at: row.get(6)?,
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn add_check(
        conn: &Connection,
        heartbeat_id: &str,
        check_group_name: &str,
        agent_id: &str,
        agent_prompt: &str,
        sort_order: i32,
    ) -> Result<HeartbeatCheck> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;

        conn.execute(
            "INSERT INTO heartbeat_checks (id, heartbeat_id, check_group_name, agent_id, agent_prompt, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![&id, heartbeat_id, check_group_name, agent_id, agent_prompt, sort_order, now],
        )
        .context("insert heartbeat_check")?;

        Self::get_check(conn, &id)?
            .ok_or_else(|| anyhow::anyhow!("readback after insert"))
    }

    pub fn get_check(conn: &Connection, id: &str) -> Result<Option<HeartbeatCheck>> {
        let row = conn
            .query_row(
                "SELECT id, heartbeat_id, check_group_name, agent_id, agent_prompt, sort_order, created_at
                 FROM heartbeat_checks WHERE id = ?1",
                [id],
                Self::map_check_row,
            )
            .optional()?;
        Ok(row)
    }

    pub fn get_checks(conn: &Connection, heartbeat_id: &str) -> Result<Vec<HeartbeatCheck>> {
        let mut stmt = conn.prepare(
            "SELECT id, heartbeat_id, check_group_name, agent_id, agent_prompt, sort_order, created_at
             FROM heartbeat_checks WHERE heartbeat_id = ?1 ORDER BY sort_order",
        )?;
        let rows = stmt
            .query_map([heartbeat_id], Self::map_check_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn map_check_row(row: &rusqlite::Row) -> rusqlite::Result<HeartbeatCheck> {
        Ok(HeartbeatCheck {
            id: row.get(0)?,
            heartbeat_id: row.get(1)?,
            check_group_name: row.get(2)?,
            agent_id: row.get(3)?,
            agent_prompt: row.get(4)?,
            sort_order: row.get(5)?,
            created_at: row.get(6)?,
        })
    }

    pub fn list_heartbeats(conn: &Connection) -> Result<Vec<Heartbeat>> {
        let mut stmt = conn.prepare(
            "SELECT id, name, description, interval_minutes, retention_days, enabled, next_run_at, created_at, updated_at
             FROM heartbeats ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], Self::map_heartbeat_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_heartbeat_with_checks(conn: &Connection, id: &str) -> Result<Option<HeartbeatDetail>> {
        let heartbeat = match Self::get_heartbeat(conn, id)? {
            Some(h) => h,
            None => return Ok(None),
        };
        let checks = Self::get_checks(conn, id)?;
        Ok(Some(HeartbeatDetail { heartbeat, checks }))
    }

    pub fn update_heartbeat(
        conn: &Connection,
        id: &str,
        name: &str,
        description: &str,
        interval_minutes: u32,
        retention_days: u32,
    ) -> Result<()> {
        if retention_days < 1 {
            anyhow::bail!("retention_days must be >= 1");
        }
        if interval_minutes < 1 {
            anyhow::bail!("interval_minutes must be >= 1");
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;

        let n = conn.execute(
            "UPDATE heartbeats SET name = ?1, description = ?2, interval_minutes = ?3, retention_days = ?4, updated_at = ?5 WHERE id = ?6",
            params![name, description, interval_minutes, retention_days, now, id],
        )?;
        if n == 0 {
            anyhow::bail!("heartbeat id={id} not found");
        }
        Ok(())
    }

    pub fn update_checks(conn: &Connection, heartbeat_id: &str, checks: Vec<(String, String, String, i32)>) -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM heartbeat_checks WHERE heartbeat_id = ?1", [heartbeat_id])?;

        for (group_name, agent_id, prompt, sort_order) in checks {
            Self::add_check(&tx, heartbeat_id, &group_name, &agent_id, &prompt, sort_order)?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn delete_heartbeat(conn: &Connection, id: &str) -> Result<()> {
        let n = conn.execute("DELETE FROM heartbeats WHERE id = ?1", [id])?;
        if n == 0 {
            anyhow::bail!("heartbeat id={id} not found");
        }
        Ok(())
    }

    pub fn set_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
        let n = conn.execute(
            "UPDATE heartbeats SET enabled = ?1 WHERE id = ?2",
            params![enabled as i64, id],
        )?;
        if n == 0 {
            anyhow::bail!("heartbeat id={id} not found");
        }
        Ok(())
    }

    pub fn set_next_run(conn: &Connection, id: &str, next_run_at: Option<i64>) -> Result<()> {
        let n = conn.execute(
            "UPDATE heartbeats SET next_run_at = ?1 WHERE id = ?2",
            params![next_run_at, id],
        )?;
        if n == 0 {
            anyhow::bail!("heartbeat id={id} not found");
        }
        Ok(())
    }

    fn map_heartbeat_row(row: &rusqlite::Row) -> rusqlite::Result<Heartbeat> {
        Ok(Heartbeat {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            interval_minutes: row.get::<_, i64>(3)? as u32,
            retention_days: row.get::<_, i64>(4)? as u32,
            enabled: row.get::<_, i64>(5)? != 0,
            next_run_at: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }

    // Execution methods
    pub fn get_execution_history(conn: &Connection, heartbeat_id: &str, limit: Option<u32>) -> Result<Vec<HeartbeatExecution>> {
        let limit_val = limit.unwrap_or(u32::MAX) as i64;
        let mut stmt = conn.prepare(
            "SELECT id, heartbeat_id, status, started_at, completed_at, duration_ms, overall_severity
             FROM heartbeat_executions
             WHERE heartbeat_id = ?1
             ORDER BY started_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![heartbeat_id, limit_val], Self::map_execution_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_execution_detail(conn: &Connection, execution_id: &str) -> Result<Option<ExecutionDetail>> {
        let execution = match Self::get_execution(conn, execution_id)? {
            Some(e) => e,
            None => return Ok(None),
        };

        // Group findings by check_id, then by check_group_name
        let mut stmt = conn.prepare(
            "SELECT f.id, f.check_id, f.severity, f.title, f.message, f.metadata_json, c.check_group_name
             FROM heartbeat_findings f
             JOIN heartbeat_checks c ON f.check_id = c.id
             WHERE f.execution_id = ?1
             ORDER BY c.sort_order, f.created_at",
        )?;

        let findings: Vec<(String, String, String, String, String, String, String)> = stmt
            .query_map([execution_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Group by check_id
        let mut groups_map: std::collections::HashMap<String, (String, Vec<FindingDetail>)> = std::collections::HashMap::new();

        for (f_id, check_id, severity, title, message, metadata_json, group_name) in findings {
            let metadata = serde_json::from_str(&metadata_json).ok();
            let finding = FindingDetail {
                id: f_id,
                severity,
                title,
                message,
                metadata,
            };

            groups_map
                .entry(check_id.clone())
                .or_insert_with(|| (group_name, Vec::new()))
                .1
                .push(finding);
        }

        let mut check_groups: Vec<CheckGroup> = groups_map
            .into_iter()
            .map(|(check_id, (group_name, findings))| {
                // Compute overall severity for this group
                let severity = Self::compute_max_severity(&findings.iter().map(|f| f.severity.as_str()).collect::<Vec<_>>());
                CheckGroup {
                    id: check_id,
                    name: group_name,
                    severity,
                    findings,
                }
            })
            .collect();

        // Sort by severity (most severe first)
        check_groups.sort_by(|a, b| Self::compare_severity(&b.severity, &a.severity));

        Ok(Some(ExecutionDetail {
            execution,
            check_groups,
        }))
    }

    pub fn get_execution(conn: &Connection, id: &str) -> Result<Option<HeartbeatExecution>> {
        let row = conn
            .query_row(
                "SELECT id, heartbeat_id, status, started_at, completed_at, duration_ms, overall_severity
                 FROM heartbeat_executions WHERE id = ?1",
                [id],
                Self::map_execution_row,
            )
            .optional()?;
        Ok(row)
    }

    pub fn prune_old_executions(conn: &Connection, heartbeat_id: &str, retention_days: u32) -> Result<usize> {
        let cutoff = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64
            - (retention_days as i64 * 86400);

        let n = conn.execute(
            "DELETE FROM heartbeat_executions WHERE heartbeat_id = ?1 AND started_at < ?2",
            params![heartbeat_id, cutoff],
        )?;
        Ok(n)
    }

    fn map_execution_row(row: &rusqlite::Row) -> rusqlite::Result<HeartbeatExecution> {
        Ok(HeartbeatExecution {
            id: row.get(0)?,
            heartbeat_id: row.get(1)?,
            status: row.get(2)?,
            started_at: row.get(3)?,
            completed_at: row.get(4)?,
            duration_ms: row.get(5)?,
            overall_severity: row.get(6)?,
        })
    }

    // Suggestion methods
    pub fn create_suggestion(
        conn: &Connection,
        heartbeat_id: &str,
        suggestion_type: &str,
        description: &str,
        proposed_checks_json: &str,
    ) -> Result<HeartbeatSuggestion> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;

        conn.execute(
            "INSERT INTO heartbeat_suggestions (id, heartbeat_id, suggestion_type, description, proposed_checks_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&id, heartbeat_id, suggestion_type, description, proposed_checks_json, now],
        )
        .context("insert heartbeat_suggestion")?;

        Self::get_suggestion(conn, &id)?
            .ok_or_else(|| anyhow::anyhow!("readback after insert"))
    }

    pub fn get_suggestions(conn: &Connection, heartbeat_id: &str, include_dismissed: bool) -> Result<Vec<HeartbeatSuggestion>> {
        let sql = if include_dismissed {
            "SELECT id, heartbeat_id, suggestion_type, description, proposed_checks_json, created_at, dismissed_at
             FROM heartbeat_suggestions
             WHERE heartbeat_id = ?1
             ORDER BY created_at DESC"
        } else {
            "SELECT id, heartbeat_id, suggestion_type, description, proposed_checks_json, created_at, dismissed_at
             FROM heartbeat_suggestions
             WHERE heartbeat_id = ?1 AND dismissed_at IS NULL
             ORDER BY created_at DESC"
        };

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map([heartbeat_id], Self::map_suggestion_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn dismiss_suggestion(conn: &Connection, id: &str) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;

        let n = conn.execute(
            "UPDATE heartbeat_suggestions SET dismissed_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        if n == 0 {
            anyhow::bail!("suggestion id={id} not found");
        }
        Ok(())
    }

    fn get_suggestion(conn: &Connection, id: &str) -> Result<Option<HeartbeatSuggestion>> {
        let row = conn
            .query_row(
                "SELECT id, heartbeat_id, suggestion_type, description, proposed_checks_json, created_at, dismissed_at
                 FROM heartbeat_suggestions WHERE id = ?1",
                [id],
                Self::map_suggestion_row,
            )
            .optional()?;
        Ok(row)
    }

    fn map_suggestion_row(row: &rusqlite::Row) -> rusqlite::Result<HeartbeatSuggestion> {
        Ok(HeartbeatSuggestion {
            id: row.get(0)?,
            heartbeat_id: row.get(1)?,
            suggestion_type: row.get(2)?,
            description: row.get(3)?,
            proposed_checks_json: row.get(4)?,
            created_at: row.get(5)?,
            dismissed_at: row.get(6)?,
        })
    }

    // Helper methods
    fn compute_max_severity(severities: &[&str]) -> String {
        let order = ["critical", "error", "warning", "info", "ok"];
        for sev in &order {
            if severities.contains(sev) {
                return sev.to_string();
            }
        }
        "ok".to_string()
    }

    fn compare_severity(a: &str, b: &str) -> std::cmp::Ordering {
        let order = ["critical", "error", "warning", "info", "ok"];
        let a_idx = order.iter().position(|&s| s == a).unwrap_or(999);
        let b_idx = order.iter().position(|&s| s == b).unwrap_or(999);
        a_idx.cmp(&b_idx)
    }
}

#[cfg(test)]
#[path = "repo_tests.rs"]
mod tests;

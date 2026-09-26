use crate::fanout::model::{
    CsvImportResult, DeviceKind, DeviceResultRow, FanoutGroup, FanoutMember, FanoutRunDetail,
    FanoutRunSummary,
};
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

/// Fan-out persistence layer. Holds no state; every method takes a borrowed
/// `Connection` so the caller controls locking. Multi-statement operations
/// run inside a transaction.
pub struct FanoutStore;

impl FanoutStore {
    pub fn create_group(
        conn: &mut Connection,
        name: &str,
        description: Option<&str>,
    ) -> Result<FanoutGroup> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        conn.execute(
            "INSERT INTO fanout_groups (id, name, description) VALUES (?1, ?2, ?3)",
            params![&id, name, description],
        )
        .context("insert fanout_groups")?;
        Self::get_group(conn, &id)
    }

    pub fn get_group(conn: &Connection, id: &str) -> Result<FanoutGroup> {
        conn.query_row(
            "SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
                    (SELECT COUNT(*) FROM fanout_group_members m WHERE m.group_id = g.id)
             FROM fanout_groups g WHERE g.id = ?1",
            [id],
            |row| {
                Ok(FanoutGroup {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    member_count: row.get(5)?,
                })
            },
        )
        .context("get_group")
    }

    pub fn list_groups(conn: &Connection) -> Result<Vec<FanoutGroup>> {
        let mut stmt = conn.prepare(
            "SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
                    (SELECT COUNT(*) FROM fanout_group_members m WHERE m.group_id = g.id)
             FROM fanout_groups g
             ORDER BY g.name COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(FanoutGroup {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    member_count: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn update_group(
        conn: &Connection,
        id: &str,
        name: Option<&str>,
        description: Option<Option<&str>>,
    ) -> Result<()> {
        if let Some(n) = name {
            conn.execute(
                "UPDATE fanout_groups SET name=?1, updated_at=strftime('%s','now') WHERE id=?2",
                params![n, id],
            )?;
        }
        if let Some(d) = description {
            conn.execute(
                "UPDATE fanout_groups SET description=?1, updated_at=strftime('%s','now') WHERE id=?2",
                params![d, id],
            )?;
        }
        Ok(())
    }

    pub fn delete_group(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM fanout_groups WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn add_member(
        conn: &Connection,
        group_id: &str,
        device_id: &str,
        device_kind: DeviceKind,
    ) -> Result<()> {
        conn.execute(
            "INSERT OR IGNORE INTO fanout_group_members (group_id, device_id, device_kind)
             VALUES (?1, ?2, ?3)",
            params![group_id, device_id, device_kind.as_str()],
        )?;
        Ok(())
    }

    pub fn add_members_bulk(
        conn: &mut Connection,
        group_id: &str,
        members: &[(String, DeviceKind)],
    ) -> Result<usize> {
        let tx = conn.transaction()?;
        let mut added = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO fanout_group_members (group_id, device_id, device_kind)
                 VALUES (?1, ?2, ?3)",
            )?;
            for (id, kind) in members {
                added += stmt.execute(params![group_id, id, kind.as_str()])?;
            }
        }
        tx.commit()?;
        Ok(added)
    }

    pub fn remove_member(
        conn: &Connection,
        group_id: &str,
        device_id: &str,
        device_kind: DeviceKind,
    ) -> Result<()> {
        conn.execute(
            "DELETE FROM fanout_group_members
             WHERE group_id=?1 AND device_id=?2 AND device_kind=?3",
            params![group_id, device_id, device_kind.as_str()],
        )?;
        Ok(())
    }

    pub fn list_members(conn: &Connection, group_id: &str) -> Result<Vec<FanoutMember>> {
        let mut stmt = conn.prepare(
            "SELECT m.device_id,
                    m.device_kind,
                    m.added_at,
                    COALESCE(s.name, n.name)         AS display_name,
                    COALESCE(s.host, n.host)         AS host
             FROM fanout_group_members m
             LEFT JOIN ssh_connections   s ON m.device_kind='ssh'     AND s.id = m.device_id
             LEFT JOIN netconf_devices   n ON m.device_kind='netconf' AND CAST(n.id AS TEXT) = m.device_id
             WHERE m.group_id = ?1
             ORDER BY display_name COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map([group_id], |row| {
                let kind_str: String = row.get(1)?;
                let kind = DeviceKind::parse(&kind_str).map_err(|_| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::from(format!("bad device_kind {kind_str}")),
                    )
                })?;
                Ok(FanoutMember {
                    device_id: row.get(0)?,
                    device_kind: kind,
                    added_at: row.get(2)?,
                    display_name: row
                        .get::<_, Option<String>>(3)?
                        .unwrap_or_else(|| "(unknown)".to_string()),
                    host: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Resolve a CSV identifier (id or name) for a given device kind.
    /// Returns (device_id, display_name) on success.
    pub fn resolve_identifier(
        conn: &Connection,
        kind: DeviceKind,
        identifier: &str,
    ) -> Result<Option<(String, String)>> {
        match kind {
            DeviceKind::Ssh => {
                // try id, then name
                if let Some(row) = conn
                    .query_row(
                        "SELECT id, name FROM ssh_connections WHERE id = ?1",
                        [identifier],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()?
                {
                    return Ok(Some(row));
                }
                let row = conn
                    .query_row(
                        "SELECT id, name FROM ssh_connections WHERE LOWER(name)=LOWER(?1)",
                        [identifier],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()?;
                Ok(row)
            }
            DeviceKind::Netconf => {
                if let Ok(id) = identifier.parse::<i64>() {
                    if let Some(row) = conn
                        .query_row(
                            "SELECT id, name FROM netconf_devices WHERE id = ?1",
                            [id],
                            |r| Ok((r.get::<_, i64>(0)?.to_string(), r.get::<_, String>(1)?)),
                        )
                        .optional()?
                    {
                        return Ok(Some(row));
                    }
                }
                let row = conn
                    .query_row(
                        "SELECT id, name FROM netconf_devices WHERE LOWER(name)=LOWER(?1)",
                        [identifier],
                        |r| Ok((r.get::<_, i64>(0)?.to_string(), r.get::<_, String>(1)?)),
                    )
                    .optional()?;
                Ok(row)
            }
        }
    }

    /// Import group members from a CSV body.
    /// Header row required: `device_kind,identifier`.
    pub fn import_csv(
        conn: &mut Connection,
        group_id: &str,
        csv_body: &str,
    ) -> Result<CsvImportResult> {
        let mut warnings = Vec::new();
        let mut to_add: Vec<(String, DeviceKind)> = Vec::new();

        let mut lines = csv_body.lines().enumerate();
        // Skip header row (best-effort: if first line doesn't look like a header, treat as data)
        if let Some((_, first)) = lines.next() {
            let trimmed = first.trim().to_lowercase();
            if !(trimmed.starts_with("device_kind") && trimmed.contains("identifier")) {
                // first line was data — re-process
                Self::process_csv_line(0, first, conn, &mut to_add, &mut warnings)?;
            }
        }
        for (idx, line) in lines {
            Self::process_csv_line(idx, line, conn, &mut to_add, &mut warnings)?;
        }

        let added = Self::add_members_bulk(conn, group_id, &to_add)?;
        Ok(CsvImportResult { added, warnings })
    }

    fn process_csv_line(
        idx: usize,
        line: &str,
        conn: &Connection,
        to_add: &mut Vec<(String, DeviceKind)>,
        warnings: &mut Vec<String>,
    ) -> Result<()> {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return Ok(());
        }
        let parts: Vec<&str> = trimmed.splitn(2, ',').map(|s| s.trim()).collect();
        if parts.len() < 2 {
            warnings.push(format!("line {}: malformed row '{}'", idx + 1, line));
            return Ok(());
        }
        let kind = match DeviceKind::parse(parts[0]) {
            Ok(k) => k,
            Err(e) => {
                warnings.push(format!("line {}: {}", idx + 1, e));
                return Ok(());
            }
        };
        match Self::resolve_identifier(conn, kind, parts[1])? {
            Some((id, _)) => to_add.push((id, kind)),
            None => warnings.push(format!(
                "line {}: no {} device matching '{}'",
                idx + 1,
                kind.as_str(),
                parts[1]
            )),
        }
        Ok(())
    }

    // ---------- runs ----------

    pub fn insert_run_row(
        conn: &Connection,
        run_id: &str,
        group_id: Option<&str>,
        command: &str,
        params_json: &str,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO fanout_runs (id, group_id, command, status, params_json)
             VALUES (?1, ?2, ?3, 'running', ?4)",
            params![run_id, group_id, command, params_json],
        )?;
        Ok(())
    }

    pub fn insert_pending_result(
        conn: &Connection,
        run_id: &str,
        device_id: &str,
        kind: DeviceKind,
        attempt: i64,
    ) -> Result<()> {
        conn.execute(
            "INSERT OR IGNORE INTO fanout_run_results
                (run_id, device_id, device_kind, attempt_number, status)
             VALUES (?1, ?2, ?3, ?4, 'pending')",
            params![run_id, device_id, kind.as_str(), attempt],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finalize_result(
        conn: &Connection,
        run_id: &str,
        device_id: &str,
        kind: DeviceKind,
        attempt: i64,
        status: &str,
        block_id: Option<&str>,
        parsed_output_id: Option<&str>,
        error: Option<&str>,
        started_at: Option<i64>,
        ended_at: Option<i64>,
    ) -> Result<()> {
        conn.execute(
            "UPDATE fanout_run_results
                SET status=?1, block_id=?2, parsed_output_id=?3, error=?4,
                    started_at=COALESCE(started_at, ?5), ended_at=?6
              WHERE run_id=?7 AND device_id=?8 AND device_kind=?9 AND attempt_number=?10",
            params![
                status,
                block_id,
                parsed_output_id,
                error,
                started_at,
                ended_at,
                run_id,
                device_id,
                kind.as_str(),
                attempt
            ],
        )?;
        Ok(())
    }

    pub fn finalize_run(
        conn: &Connection,
        run_id: &str,
        succeeded: usize,
        failed: usize,
        cancelled: usize,
    ) -> Result<()> {
        let total = succeeded + failed + cancelled;
        let status = if succeeded == total {
            "success"
        } else if failed == total {
            "failed"
        } else if cancelled == total {
            "cancelled"
        } else {
            "partial"
        };
        conn.execute(
            "UPDATE fanout_runs
                SET status=?1, ended_at=strftime('%s','now')
              WHERE id=?2",
            params![status, run_id],
        )?;
        Ok(())
    }

    pub fn list_runs(conn: &Connection, limit: i64) -> Result<Vec<FanoutRunSummary>> {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.group_id, r.command, r.status, r.started_at, r.ended_at,
                    (SELECT COUNT(DISTINCT device_id || ':' || device_kind)
                       FROM fanout_run_results WHERE run_id=r.id) AS total,
                    (SELECT COUNT(*) FROM fanout_run_results
                       WHERE run_id=r.id AND status='success') AS succeeded,
                    (SELECT COUNT(*) FROM fanout_run_results
                       WHERE run_id=r.id AND status IN ('failed','timeout','blocked_by_guardrail')) AS failed
             FROM fanout_runs r
             ORDER BY r.started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit], |row| {
                Ok(FanoutRunSummary {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    command: row.get(2)?,
                    status: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    total: row.get(6)?,
                    succeeded: row.get(7)?,
                    failed: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_run_summary(conn: &Connection, run_id: &str) -> Result<FanoutRunSummary> {
        conn.query_row(
            "SELECT r.id, r.group_id, r.command, r.status, r.started_at, r.ended_at,
                    (SELECT COUNT(DISTINCT device_id || ':' || device_kind)
                       FROM fanout_run_results WHERE run_id=r.id) AS total,
                    (SELECT COUNT(*) FROM fanout_run_results
                       WHERE run_id=r.id AND status='success') AS succeeded,
                    (SELECT COUNT(*) FROM fanout_run_results
                       WHERE run_id=r.id AND status IN ('failed','timeout','blocked_by_guardrail')) AS failed
             FROM fanout_runs r WHERE r.id = ?1",
            [run_id],
            |row| {
                Ok(FanoutRunSummary {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    command: row.get(2)?,
                    status: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    total: row.get(6)?,
                    succeeded: row.get(7)?,
                    failed: row.get(8)?,
                })
            },
        )
        .context("get_run_summary")
    }

    pub fn get_run_detail(conn: &Connection, run_id: &str) -> Result<FanoutRunDetail> {
        let summary = Self::get_run_summary(conn, run_id)?;
        let mut stmt = conn.prepare(
            "SELECT r.device_id, r.device_kind, r.attempt_number, r.status, r.error,
                    r.block_id, r.parsed_output_id, r.started_at, r.ended_at,
                    COALESCE(s.name, n.name) AS display_name
             FROM fanout_run_results r
             LEFT JOIN ssh_connections   s ON r.device_kind='ssh'     AND s.id = r.device_id
             LEFT JOIN netconf_devices   n ON r.device_kind='netconf' AND CAST(n.id AS TEXT) = r.device_id
             WHERE r.run_id = ?1
             ORDER BY display_name COLLATE NOCASE, r.attempt_number ASC",
        )?;
        let devices = stmt
            .query_map([run_id], |row| {
                let kind_str: String = row.get(1)?;
                let kind = DeviceKind::parse(&kind_str).map_err(|_| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::from(format!("bad device_kind {kind_str}")),
                    )
                })?;
                Ok(DeviceResultRow {
                    device_id: row.get(0)?,
                    device_kind: kind,
                    attempt_number: row.get(2)?,
                    status: row.get(3)?,
                    error: row.get(4)?,
                    block_id: row.get(5)?,
                    parsed_output_id: row.get(6)?,
                    started_at: row.get(7)?,
                    ended_at: row.get(8)?,
                    display_name: row
                        .get::<_, Option<String>>(9)?
                        .unwrap_or_else(|| "(unknown)".to_string()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(FanoutRunDetail { summary, devices })
    }

    /// Mark any `running`/`pending` runs as `failed` with synthesized errors on
    /// their pending/running results. Called at app startup to clean up runs
    /// interrupted by a crash.
    pub fn cleanup_orphan_runs(conn: &Connection) -> Result<usize> {
        let mut stmt =
            conn.prepare("SELECT id FROM fanout_runs WHERE status='running' AND ended_at IS NULL")?;
        let orphan_ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let count = orphan_ids.len();
        for run_id in orphan_ids {
            conn.execute(
                "UPDATE fanout_run_results
                    SET status='failed',
                        error=COALESCE(error, 'interrupted: app restart'),
                        ended_at=strftime('%s','now')
                  WHERE run_id=?1 AND status IN ('pending','running')",
                [&run_id],
            )?;
            conn.execute(
                "UPDATE fanout_runs
                    SET status='failed',
                        ended_at=strftime('%s','now')
                  WHERE id=?1",
                [&run_id],
            )?;
        }
        Ok(count)
    }

    /// Determine the next attempt_number for a (run, device) tuple.
    pub fn next_attempt_number(
        conn: &Connection,
        run_id: &str,
        device_id: &str,
        kind: DeviceKind,
    ) -> Result<i64> {
        let n: Option<i64> = conn
            .query_row(
                "SELECT MAX(attempt_number) FROM fanout_run_results
                  WHERE run_id=?1 AND device_id=?2 AND device_kind=?3",
                params![run_id, device_id, kind.as_str()],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok(n.unwrap_or(0) + 1)
    }

    // ---------- test helpers (compiled in test/dev) ----------

    #[doc(hidden)]
    pub fn seed_test_ssh(conn: &Connection, name: &str, host: &str) -> Result<String> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        conn.execute(
            "INSERT INTO ssh_connections (id, name, host, user, port)
             VALUES (?1, ?2, ?3, 'admin', 22)",
            params![&id, name, host],
        )?;
        Ok(id)
    }

    #[doc(hidden)]
    pub fn seed_test_netconf(conn: &Connection, name: &str, host: &str) -> Result<String> {
        conn.execute(
            "INSERT INTO netconf_devices (name, host, port, username, platform, hostkey_verify)
             VALUES (?1, ?2, 830, 'admin', 'iosxe', 0)",
            params![name, host],
        )?;
        let id: i64 = conn.last_insert_rowid();
        if id <= 0 {
            return Err(anyhow!("seed_test_netconf: no rowid"));
        }
        Ok(id.to_string())
    }
}

//! Append-only writer + reader for the `guardrail_decisions` table.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct DecisionRecord {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub tier: u8,
    pub rule_id: Option<String>,
    pub decision: String,
    pub user_action: Option<String>,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionRow {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub tier: u8,
    pub rule_id: Option<String>,
    pub decision: String,
    pub user_action: Option<String>,
    pub reasoning: String,
    pub decided_at: i64,
}

pub fn record_decision(conn: &Connection, d: &DecisionRecord) -> Result<String> {
    let id = if d.id.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        d.id.clone()
    };
    conn.execute(
        "INSERT INTO guardrail_decisions
           (id, session_id, command, tier, rule_id, decision, user_action, reasoning)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            id,
            d.session_id,
            d.command,
            d.tier as i64,
            d.rule_id,
            d.decision,
            d.user_action,
            d.reasoning,
        ],
    )?;
    Ok(id)
}

pub fn list_decisions(
    conn: &Connection,
    session_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<DecisionRow>> {
    let (sql, has_filter) = match session_id {
        Some(_) => (
            "SELECT id, session_id, command, tier, rule_id, decision, user_action, reasoning, decided_at
             FROM guardrail_decisions WHERE session_id = ?1
             ORDER BY decided_at DESC LIMIT ?2 OFFSET ?3",
            true,
        ),
        None => (
            "SELECT id, session_id, command, tier, rule_id, decision, user_action, reasoning, decided_at
             FROM guardrail_decisions
             ORDER BY decided_at DESC LIMIT ?1 OFFSET ?2",
            false,
        ),
    };
    let mut stmt = conn.prepare(sql)?;
    let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<DecisionRow> {
        Ok(DecisionRow {
            id: r.get(0)?,
            session_id: r.get(1)?,
            command: r.get(2)?,
            tier: r.get::<_, i64>(3)? as u8,
            rule_id: r.get(4)?,
            decision: r.get(5)?,
            user_action: r.get(6)?,
            reasoning: r.get(7)?,
            decided_at: r.get(8)?,
        })
    };
    let rows: Vec<DecisionRow> = if has_filter {
        stmt.query_map(params![session_id.unwrap(), limit as i64, offset as i64], map_row)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map(params![limit as i64, offset as i64], map_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

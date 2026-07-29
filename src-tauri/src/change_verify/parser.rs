//! Plan 05 / Plan 06 contract reconciliation.
//!
//! Plan 06's spec calls for `crate::structured::parse_and_store(...)`, but
//! Plan 05's frozen public API only exposes `auto_parse::on_block_completed`,
//! which requires a pre-existing `command_blocks` row. Rather than mutate the
//! frozen surface (which Plans 06 + 08 both consume), this module provides a
//! Plan 06-local `parse_and_store` that synthesizes the required block row
//! and threads through the existing parser + upsert helpers.

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::sync::Arc;
use uuid::Uuid;

use crate::structured::auto_parse::{upsert_parsed_output, Parser};

/// Parse `raw` for `command` against `(vendor, platform)`, persist into
/// `parsed_outputs`, and return the new row's id.
///
/// Synthesizes a `command_blocks` row (required by V0032's `UNIQUE` /
/// `REFERENCES command_blocks(id)` constraints on `parsed_outputs`). The
/// caller's `tab_id` MUST reference a real `tabs.id` because
/// `command_blocks.tab_id` is FK-enforced.
///
/// Acquires the DB lock in short scoped blocks between async calls — never
/// held across `.await`.
pub async fn parse_and_store(
    db: Arc<Mutex<Connection>>,
    parser: &dyn Parser,
    tab_id: &str,
    vendor: &str,
    platform: &str,
    command: &str,
    raw: &str,
) -> Result<i64> {
    // parse() is async — release the lock before awaiting it.
    let parsed = parser
        .parse(vendor, platform, command, raw)
        .await
        .with_context(|| format!("parse {command}"))?;

    let block_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let data_json = parsed.data.to_string();

    let conn = db.lock();
    // Synthetic block (satisfies parsed_outputs' FK). Tagged so list_blocks()
    // keeps it out of the user's scrollback — it isn't a typed shell command.
    conn.execute(
        "INSERT INTO command_blocks(id, tab_id, cmd, output, started_at, ended_at, block_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'change_verify')",
        params![&block_id, tab_id, command, raw.as_bytes(), now],
    )
    .context("insert synthetic command_blocks row")?;

    let id = upsert_parsed_output(
        &conn,
        &block_id,
        &parsed.parser,
        command,
        vendor,
        platform,
        &data_json,
    )
    .context("upsert_parsed_output")?;
    Ok(id)
}

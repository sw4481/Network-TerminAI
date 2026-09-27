//! Auto-parse a completed `show *` block via the sidecar `ParserBridge`,
//! persisting the result into `parsed_outputs`. Idempotent: a second call
//! for the same `block_id` updates the existing row in place because of the
//! `UNIQUE(block_id)` constraint defined in V0032.
//!
//! Vendor / platform are passed in by the caller (the frontend tracks tab
//! vendor/platform in-memory; they are not persisted on the Rust side).

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::sync::Arc;

/// Trait that lets tests substitute a deterministic parser without spinning
/// up the real sidecar bridge.
#[async_trait::async_trait]
pub trait Parser: Send + Sync {
    async fn parse(
        &self,
        vendor: &str,
        platform: &str,
        command: &str,
        raw: &str,
    ) -> Result<crate::parsers::bridge::ParsedOutput>;
}

#[async_trait::async_trait]
impl Parser for crate::parsers::bridge::ParserBridge {
    async fn parse(
        &self,
        vendor: &str,
        platform: &str,
        command: &str,
        raw: &str,
    ) -> Result<crate::parsers::bridge::ParsedOutput> {
        crate::parsers::bridge::ParserBridge::parse(self, vendor, platform, command, raw).await
    }
}

/// Read the (cmd, output) for a block from the DB.
fn read_block(conn: &Connection, block_id: &str) -> Result<(String, String)> {
    let row = conn.query_row(
        "SELECT cmd, output FROM command_blocks WHERE id = ?1",
        params![block_id],
        |r| Ok::<(String, String), rusqlite::Error>((r.get(0)?, r.get(1)?)),
    )?;
    Ok(row)
}

/// Upsert a parsed_outputs row keyed on block_id.
pub fn upsert_parsed_output(
    conn: &Connection,
    block_id: &str,
    parser: &str,
    command: &str,
    vendor: &str,
    platform: &str,
    data_json: &str,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO parsed_outputs(block_id, parser, command, vendor, platform, data_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(block_id) DO UPDATE SET
           parser   = excluded.parser,
           command  = excluded.command,
           vendor   = excluded.vendor,
           platform = excluded.platform,
           data_json= excluded.data_json,
           created_at = strftime('%s','now')",
        params![block_id, parser, command, vendor, platform, data_json],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Fetch the parsed_outputs row for a block, if any.
pub struct ParsedOutputRow {
    pub id: i64,
    pub block_id: String,
    pub parser: String,
    pub command: String,
    pub vendor: String,
    pub platform: String,
    pub data_json: String,
    pub created_at: i64,
}

pub fn get_parsed_output(conn: &Connection, block_id: &str) -> Result<Option<ParsedOutputRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, block_id, parser, command, vendor, platform, data_json, created_at
         FROM parsed_outputs WHERE block_id = ?1",
    )?;
    let mut rows = stmt.query(params![block_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(ParsedOutputRow {
            id: row.get(0)?,
            block_id: row.get(1)?,
            parser: row.get(2)?,
            command: row.get(3)?,
            vendor: row.get(4)?,
            platform: row.get(5)?,
            data_json: row.get(6)?,
            created_at: row.get(7)?,
        }))
    } else {
        Ok(None)
    }
}

/// List parsed_outputs whose blocks belong to a given tab.
pub fn list_parsed_outputs_for_tab(
    conn: &Connection,
    tab_id: &str,
) -> Result<Vec<ParsedOutputRow>> {
    let mut stmt = conn.prepare(
        "SELECT po.id, po.block_id, po.parser, po.command, po.vendor, po.platform, po.data_json, po.created_at
         FROM parsed_outputs po
         JOIN command_blocks cb ON cb.id = po.block_id
         WHERE cb.tab_id = ?1
         ORDER BY po.created_at DESC",
    )?;
    let rows = stmt
        .query_map(params![tab_id], |row| {
            Ok(ParsedOutputRow {
                id: row.get(0)?,
                block_id: row.get(1)?,
                parser: row.get(2)?,
                command: row.get(3)?,
                vendor: row.get(4)?,
                platform: row.get(5)?,
                data_json: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Run auto-parse for a completed block. Skips silently if:
///   - the command does not start with `show ` (case-insensitive),
///   - vendor or platform is "unknown" / empty,
///   - or the parser bridge returns an error (e.g. no template available).
///
/// Idempotent: a second call updates the existing parsed_outputs row.
pub async fn on_block_completed(
    db: Arc<Mutex<Connection>>,
    parser: &dyn Parser,
    block_id: &str,
    vendor: &str,
    platform: &str,
) -> Result<()> {
    let (cmd, output) = {
        let conn = db.lock();
        read_block(&conn, block_id).map_err(|e| anyhow!("read_block({block_id}): {e}"))?
    };

    let cmd_trimmed = cmd.trim();
    if !cmd_trimmed.to_lowercase().starts_with("show ") {
        return Ok(());
    }
    if vendor.is_empty()
        || platform.is_empty()
        || vendor == "unknown"
        || platform == "unknown"
    {
        tracing::debug!(%block_id, "auto_parse skipped: no vendor/platform on tab");
        return Ok(());
    }

    let parsed = match parser.parse(vendor, platform, cmd_trimmed, &output).await {
        Ok(p) => p,
        Err(e) => {
            tracing::info!(%block_id, error = %e, "auto_parse: no parser available");
            return Ok(());
        }
    };

    let data_json = parsed.data.to_string();
    {
        let conn = db.lock();
        upsert_parsed_output(
            &conn,
            block_id,
            &parsed.parser,
            cmd_trimmed,
            vendor,
            platform,
            &data_json,
        )?;
    }
    Ok(())
}

/// Parse output captured directly from an interactive SSH session (no
/// OSC-133 command block exists). Creates a synthetic `command_blocks` row so
/// the parsed result still satisfies the `parsed_outputs.block_id` FK and
/// flows through the existing Structured tab / snapshot / diff UI unchanged,
/// then runs the same parse + upsert path as [`on_block_completed`].
///
/// Returns the synthetic block id on success. Unlike the block-completion
/// hook, parser errors are PROPAGATED: this path is user-invoked, so a parse
/// failure should surface to the UI rather than be silently swallowed.
pub async fn parse_and_store_adhoc(
    db: Arc<Mutex<Connection>>,
    parser: &dyn Parser,
    tab_id: &str,
    command: &str,
    output: &str,
    vendor: &str,
    platform: &str,
) -> Result<String> {
    let cmd_trimmed = command.trim();

    // Parse FIRST so a failure leaves no orphan synthetic block behind.
    let parsed = parser
        .parse(vendor, platform, cmd_trimmed, output)
        .await
        .map_err(|e| anyhow!("parse failed: {e}"))?;

    let block_id = format!("ssh-adhoc-{}", uuid::Uuid::new_v4());
    let data_json = parsed.data.to_string();
    {
        let conn = db.lock();
        // Synthetic block satisfies the parsed_outputs.block_id FK so the
        // result flows through the same Structured tab / snapshot / diff UI.
        // Tagged `ssh_adhoc` so list_blocks() keeps it out of the user's
        // scrollback (it isn't a command they typed in the shell).
        conn.execute(
            "INSERT INTO command_blocks (id, tab_id, cmd, output, exit_code, started_at, ended_at, cwd, block_source)
             VALUES (?1, ?2, ?3, ?4, 0, strftime('%s','now'), strftime('%s','now'), '/', 'ssh_adhoc')",
            params![block_id, tab_id, cmd_trimmed, output],
        )
        .map_err(|e| anyhow!("insert synthetic block: {e}"))?;
        upsert_parsed_output(
            &conn,
            &block_id,
            &parsed.parser,
            cmd_trimmed,
            vendor,
            platform,
            &data_json,
        )?;
    }
    Ok(block_id)
}

pub mod testing {
    use super::*;
    use crate::parsers::bridge::ParsedOutput;

    pub struct FakeParser {
        payload: String,
        parser_name: String,
    }

    impl FakeParser {
        pub fn new(payload: &str) -> Self {
            Self {
                payload: payload.to_string(),
                parser_name: "genie".to_string(),
            }
        }

        pub fn with_name(mut self, name: &str) -> Self {
            self.parser_name = name.to_string();
            self
        }
    }

    #[async_trait::async_trait]
    impl Parser for FakeParser {
        async fn parse(
            &self,
            _v: &str,
            _p: &str,
            _c: &str,
            _r: &str,
        ) -> Result<ParsedOutput> {
            Ok(ParsedOutput {
                parser: self.parser_name.clone(),
                data: serde_json::from_str(&self.payload)?,
            })
        }
    }

    /// Always returns Err — used to verify that auto_parse swallows parser errors silently.
    pub struct FailingParser;

    #[async_trait::async_trait]
    impl Parser for FailingParser {
        async fn parse(
            &self,
            _v: &str,
            _p: &str,
            _c: &str,
            _r: &str,
        ) -> Result<ParsedOutput> {
            Err(anyhow!("no template"))
        }
    }
}

//! `intent_templates` CRUD layer.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Copy)]
#[serde(rename_all = "lowercase")]
pub enum IntentKind {
    Golden,
    Jinja,
}

impl IntentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            IntentKind::Golden => "golden",
            IntentKind::Jinja => "jinja",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "golden" => Ok(IntentKind::Golden),
            "jinja" => Ok(IntentKind::Jinja),
            other => Err(format!("unknown intent kind {other}")),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Copy)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum MatchMode {
    #[default]
    Baseline,
    Partial,
}

impl MatchMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            MatchMode::Baseline => "baseline",
            MatchMode::Partial => "partial",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "baseline" => Ok(MatchMode::Baseline),
            "partial" => Ok(MatchMode::Partial),
            other => Err(format!("unknown match mode {other}")),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct IntentSelector {
    /// Target a saved fan-out group by id — drift runs against every member.
    /// Highest precedence in `resolve_selector`.
    #[serde(default)]
    pub group_id: Option<String>,
    /// Target a single saved SSH connection by id.
    #[serde(default)]
    pub ssh_connection_id: Option<String>,
    /// Legacy explicit device list (`ssh:<uuid>` / `netconf:<id>` tokens).
    /// Retained for back-compat with templates authored before group/ssh
    /// selection existed.
    #[serde(default)]
    pub device_ids: Vec<String>,
    /// Legacy block-tag selection. No longer settable from the UI; resolution
    /// support was removed when the broken block_tags join was dropped.
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IntentTemplate {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub platform: String,
    pub kind: IntentKind,
    pub body: String,
    #[serde(default)]
    pub vars_yaml: String,
    #[serde(default)]
    pub selector: IntentSelector,
    #[serde(default)]
    pub match_mode: MatchMode,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// Stateless repo: every method takes a borrowed `Connection` so callers
/// (Tauri command handlers) own the lock. Mirrors the pattern used in
/// `fanout::store::FanoutStore`.
pub struct IntentRepo;

impl IntentRepo {
    /// Insert a new template; returns the generated id.
    pub fn create(conn: &Connection, mut tpl: IntentTemplate) -> Result<String> {
        if tpl.id.is_empty() {
            tpl.id = uuid::Uuid::new_v4().to_string();
        }
        let selector_json = serde_json::to_string(&tpl.selector)?;
        conn.execute(
            "INSERT INTO intent_templates
                (id, name, vendor, platform, kind, body, vars_yaml, selector_json, match_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &tpl.id,
                &tpl.name,
                &tpl.vendor,
                &tpl.platform,
                tpl.kind.as_str(),
                &tpl.body,
                &tpl.vars_yaml,
                &selector_json,
                tpl.match_mode.as_str(),
            ],
        )
        .context("insert intent_templates")?;
        Ok(tpl.id)
    }

    pub fn get(conn: &Connection, id: &str) -> Result<Option<IntentTemplate>> {
        let row = conn
            .query_row(
                "SELECT id, name, vendor, platform, kind, body, vars_yaml, selector_json,
                        created_at, updated_at, match_mode
                 FROM intent_templates WHERE id = ?1",
                [id],
                Self::map_row,
            )
            .optional()?;
        Ok(row)
    }

    pub fn list_all(conn: &Connection) -> Result<Vec<IntentTemplate>> {
        let mut stmt = conn.prepare(
            "SELECT id, name, vendor, platform, kind, body, vars_yaml, selector_json,
                    created_at, updated_at, match_mode
             FROM intent_templates
             ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map([], Self::map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_filtered(
        conn: &Connection,
        vendor: Option<&str>,
        platform: Option<&str>,
    ) -> Result<Vec<IntentTemplate>> {
        let mut sql = String::from(
            "SELECT id, name, vendor, platform, kind, body, vars_yaml, selector_json,
                    created_at, updated_at, match_mode
             FROM intent_templates WHERE 1=1",
        );
        let mut args: Vec<String> = Vec::new();
        if let Some(v) = vendor {
            sql.push_str(" AND vendor = ?");
            args.push(v.to_string());
        }
        if let Some(p) = platform {
            sql.push_str(" AND platform = ?");
            args.push(p.to_string());
        }
        sql.push_str(" ORDER BY name COLLATE NOCASE");
        let mut stmt = conn.prepare(&sql)?;
        let row_iter = stmt.query_map(rusqlite::params_from_iter(args.iter()), Self::map_row)?;
        Ok(row_iter.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn update_body(conn: &Connection, id: &str, body: &str) -> Result<()> {
        let n = conn.execute(
            "UPDATE intent_templates
                SET body = ?1, updated_at = strftime('%s','now')
              WHERE id = ?2",
            params![body, id],
        )?;
        if n == 0 {
            anyhow::bail!("intent_template id={id} not found");
        }
        Ok(())
    }

    pub fn update_vars(conn: &Connection, id: &str, vars_yaml: &str) -> Result<()> {
        let n = conn.execute(
            "UPDATE intent_templates
                SET vars_yaml = ?1, updated_at = strftime('%s','now')
              WHERE id = ?2",
            params![vars_yaml, id],
        )?;
        if n == 0 {
            anyhow::bail!("intent_template id={id} not found");
        }
        Ok(())
    }

    pub fn update_selector(conn: &Connection, id: &str, selector: &IntentSelector) -> Result<()> {
        let json = serde_json::to_string(selector)?;
        let n = conn.execute(
            "UPDATE intent_templates
                SET selector_json = ?1, updated_at = strftime('%s','now')
              WHERE id = ?2",
            params![&json, id],
        )?;
        if n == 0 {
            anyhow::bail!("intent_template id={id} not found");
        }
        Ok(())
    }

    pub fn update_match_mode(conn: &Connection, id: &str, mode: MatchMode) -> Result<()> {
        let n = conn.execute(
            "UPDATE intent_templates
                SET match_mode = ?1, updated_at = strftime('%s','now')
              WHERE id = ?2",
            params![mode.as_str(), id],
        )?;
        if n == 0 {
            anyhow::bail!("intent_template id={id} not found");
        }
        Ok(())
    }

    pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<()> {
        let n = conn.execute(
            "UPDATE intent_templates
                SET name = ?1, updated_at = strftime('%s','now')
              WHERE id = ?2",
            params![name, id],
        )?;
        if n == 0 {
            anyhow::bail!("intent_template id={id} not found");
        }
        Ok(())
    }

    pub fn delete(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM intent_templates WHERE id = ?1", [id])?;
        Ok(())
    }

    fn map_row(row: &rusqlite::Row) -> rusqlite::Result<IntentTemplate> {
        let kind_str: String = row.get(4)?;
        let kind = IntentKind::parse(&kind_str).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::from(format!("bad intent kind {kind_str}")),
            )
        })?;
        let selector_json: String = row.get(7)?;
        let selector: IntentSelector = serde_json::from_str(&selector_json).unwrap_or_default();
        let match_mode_str: String = row.get(10)?;
        let match_mode = MatchMode::parse(&match_mode_str).unwrap_or_default();
        Ok(IntentTemplate {
            id: row.get(0)?,
            name: row.get(1)?,
            vendor: row.get(2)?,
            platform: row.get(3)?,
            kind,
            body: row.get(5)?,
            vars_yaml: row.get(6)?,
            selector,
            match_mode,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    }
}

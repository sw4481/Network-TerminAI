//! FTS5 full-text search across scrollback, AI history, and skills.
//!
//! Uses SQLite FTS5 for fast, ranked full-text search with BM25 scoring.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

/// Search result for a command block
#[derive(Debug, Clone, Serialize)]
pub struct CommandBlockResult {
    pub id: String,
    pub tab_id: String,
    pub cmd: String,
    pub output_snippet: String, // First ~200 chars of output
    pub started_at: i64,
    pub rank: f64, // FTS5 BM25 rank (higher is better)
}

/// Search result for an AI message
#[derive(Debug, Clone, Serialize)]
pub struct AiMessageResult {
    pub id: String,
    pub tab_id: Option<String>,
    pub role: String,
    pub content_snippet: String, // First ~200 chars of content
    pub created_at: i64,
    pub rank: f64,
}

/// Search result for a skill
#[derive(Debug, Clone, Serialize)]
pub struct SkillResult {
    pub id: String,
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    pub rank: f64,
}

/// Combined search results from all sources
#[derive(Debug, Clone, Serialize)]
pub struct SearchResults {
    pub commands: Vec<CommandBlockResult>,
    pub ai_messages: Vec<AiMessageResult>,
    pub skills: Vec<SkillResult>,
}

/// Search command blocks by command or output text.
///
/// Uses FTS5 for full-text search with BM25 ranking.
/// Returns results ordered by relevance (highest rank first).
pub fn search_commands(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<CommandBlockResult>> {
    let escaped_query = escape_fts5_query(query);
    let mut stmt = conn.prepare(
        "SELECT cb.id, cb.tab_id, cb.cmd, cb.output, cb.started_at, bm25(command_blocks_fts) as rank
         FROM command_blocks cb
         JOIN command_blocks_fts ON command_blocks_fts.rowid = cb.rowid
         WHERE command_blocks_fts MATCH ?
         ORDER BY rank DESC
         LIMIT ?",
    )?;

    let results = stmt
        .query_map(params![escaped_query, limit], |row| {
            let output: Vec<u8> = row.get(3)?;
            let output_str = String::from_utf8_lossy(&output);
            let output_snippet = truncate_snippet(&output_str, 200);

            Ok(CommandBlockResult {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                output_snippet,
                started_at: row.get(4)?,
                rank: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Search AI conversation messages.
///
/// Searches both user and assistant messages across all tabs.
pub fn search_ai_messages(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<AiMessageResult>> {
    let escaped_query = escape_fts5_query(query);
    let mut stmt = conn.prepare(
        "SELECT am.id, am.tab_id, am.role, am.content, am.created_at, bm25(ai_messages_fts) as rank
         FROM ai_messages am
         JOIN ai_messages_fts ON ai_messages_fts.rowid = am.rowid
         WHERE ai_messages_fts MATCH ?
         ORDER BY rank DESC
         LIMIT ?",
    )?;

    let results = stmt
        .query_map(params![escaped_query, limit], |row| {
            let content: String = row.get(3)?;
            let content_snippet = truncate_snippet(&content, 200);

            Ok(AiMessageResult {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                role: row.get(2)?,
                content_snippet,
                created_at: row.get(4)?,
                rank: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Search skills by name, description, when_to_use, or playbook content.
pub fn search_skills(conn: &Connection, query: &str, limit: usize) -> Result<Vec<SkillResult>> {
    let escaped_query = escape_fts5_query(query);
    let mut stmt = conn.prepare(
        "SELECT s.id, s.name, s.description, s.when_to_use, bm25(skills_fts) as rank
         FROM skills s
         JOIN skills_fts ON skills_fts.rowid = s.rowid
         WHERE skills_fts MATCH ? AND s.enabled = 1
         ORDER BY rank DESC
         LIMIT ?",
    )?;

    let results = stmt
        .query_map(params![escaped_query, limit], |row| {
            Ok(SkillResult {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                when_to_use: row.get(3)?,
                rank: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Search all sources (commands, AI messages, skills) and return combined results.
///
/// Each result set is independently ranked and limited.
pub fn search_all(conn: &Connection, query: &str, limit: usize) -> Result<SearchResults> {
    let commands = search_commands(conn, query, limit)?;
    let ai_messages = search_ai_messages(conn, query, limit)?;
    let skills = search_skills(conn, query, limit)?;

    Ok(SearchResults {
        commands,
        ai_messages,
        skills,
    })
}

/// Truncate text to max_len characters, adding "..." if truncated.
fn truncate_snippet(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        format!("{}...", &text[..max_len])
    }
}

/// Escape FTS5 special characters in search query.
/// FTS5 uses quotes for phrases, * for prefix matching, etc.
/// This function wraps the query in quotes to treat it as a phrase search.
fn escape_fts5_query(query: &str) -> String {
    // Escape double quotes in the query, then wrap in quotes for phrase search
    format!("\"{}\"", query.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_snippet() {
        assert_eq!(truncate_snippet("short", 100), "short");
        assert_eq!(
            truncate_snippet("a".repeat(100).as_str(), 50),
            format!("{}...", "a".repeat(50))
        );
        assert_eq!(truncate_snippet("exactly 10", 10), "exactly 10");
        assert_eq!(truncate_snippet("exactly 11!", 10), "exactly 11...");
    }
}

//! SQLite-backed readers/writers for `api_history` and `api_saved_requests`.
//!
//! The `api_send_request` command already inserts every attempt into
//! `api_history` (see `commands.rs::write_history_row`). This module adds
//! the read side plus CRUD for starred saved requests.
//!
//! Design notes:
//!   * `history_body` returns raw bytes (not base64) — the Tauri command
//!     layer is the only place that base64-encodes for the wire.
//!   * Saved request names are validated to prevent path-traversal-like
//!     shenanigans if anyone ever stores them in filenames later.
//!   * `lookup_latest_response` (used by the chaining resolver) never
//!     returns error-shaped rows: a status_code of 0 means the transport
//!     failed, and chaining into a failure would produce garbage.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Summary row shown in the history drawer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryRow {
    pub id: String,
    pub tab_id: Option<String>,
    pub saved_request_id: Option<String>,
    pub target_id: Option<String>,
    pub environment: Option<String>,
    pub method: String,
    pub url: String,
    pub status_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub sent_at: i64,
}

/// Full detail including body bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryDetail {
    #[serde(flatten)]
    pub summary: HistoryRow,
    pub request_headers_json: String,
    #[serde(with = "opt_bytes_as_base64")]
    pub request_body: Option<Vec<u8>>,
    pub response_headers_json: Option<String>,
    #[serde(with = "opt_bytes_as_base64")]
    pub response_body: Option<Vec<u8>>,
    pub response_body_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedRequestRow {
    pub id: String,
    pub name: String,
    pub target_id: Option<String>,
    pub environment: Option<String>,
    pub method: String,
    pub url: String,
    pub headers_json: String,
    pub query_json: String,
    pub body_kind: String,
    pub body_text: Option<String>,
    pub collection_id: Option<String>,
    pub folder_path: String,
    pub display_name: String,
    pub auth_json: String,
    pub collection_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Validate a saved-request name. Allows letters / digits / `-` / `_` /
/// space / dot. Rejects anything that could confuse a filename or SQL
/// LIKE pattern. 1..=128 chars.
pub fn validate_saved_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("saved request name is empty"));
    }
    if trimmed.len() > 128 {
        return Err(anyhow!(
            "saved request name too long ({} > 128)",
            trimmed.len()
        ));
    }
    for c in trimmed.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' || c == '.';
        if !ok {
            return Err(anyhow!(
                "saved request name contains invalid character: {c:?}"
            ));
        }
    }
    Ok(())
}

// ---- History read-side ---------------------------------------------------

pub struct HistoryFilter {
    pub tab_id: Option<String>,
    pub saved_request_id: Option<String>,
    pub limit: usize,
    pub offset: usize,
}

impl Default for HistoryFilter {
    fn default() -> Self {
        Self {
            tab_id: None,
            saved_request_id: None,
            limit: 100,
            offset: 0,
        }
    }
}

pub fn list_history(conn: &Connection, f: &HistoryFilter) -> Result<Vec<HistoryRow>> {
    // We build the WHERE clause dynamically rather than stuffing every
    // filter into a single prepared statement, so the SQL stays readable.
    let mut sql = String::from(
        "SELECT id, tab_id, saved_request_id, target_id, environment, \
                method, url, status_code, duration_ms, error, sent_at \
         FROM api_history",
    );
    let mut where_clauses: Vec<&'static str> = Vec::new();
    if f.tab_id.is_some() {
        where_clauses.push("tab_id = ?");
    }
    if f.saved_request_id.is_some() {
        where_clauses.push("saved_request_id = ?");
    }
    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY sent_at DESC, id DESC LIMIT ? OFFSET ?");

    let mut stmt = conn.prepare(&sql)?;
    // Build the params vector in the same order as the WHERE clause + limit/offset.
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(t) = &f.tab_id {
        params_vec.push(Box::new(t.clone()));
    }
    if let Some(s) = &f.saved_request_id {
        params_vec.push(Box::new(s.clone()));
    }
    params_vec.push(Box::new(f.limit as i64));
    params_vec.push(Box::new(f.offset as i64));
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();

    let rows = stmt
        .query_map(params_refs.as_slice(), |r| {
            Ok(HistoryRow {
                id: r.get(0)?,
                tab_id: r.get(1)?,
                saved_request_id: r.get(2)?,
                target_id: r.get(3)?,
                environment: r.get(4)?,
                method: r.get(5)?,
                url: r.get(6)?,
                status_code: r.get(7)?,
                duration_ms: r.get(8)?,
                error: r.get(9)?,
                sent_at: r.get(10)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_history_detail(conn: &Connection, id: &str) -> Result<Option<HistoryDetail>> {
    conn.query_row(
        "SELECT id, tab_id, saved_request_id, target_id, environment, \
                method, url, status_code, duration_ms, error, sent_at, \
                request_headers_json, request_body, \
                response_headers_json, response_body, response_body_truncated \
         FROM api_history WHERE id = ?",
        params![id],
        |r| {
            Ok(HistoryDetail {
                summary: HistoryRow {
                    id: r.get(0)?,
                    tab_id: r.get(1)?,
                    saved_request_id: r.get(2)?,
                    target_id: r.get(3)?,
                    environment: r.get(4)?,
                    method: r.get(5)?,
                    url: r.get(6)?,
                    status_code: r.get(7)?,
                    duration_ms: r.get(8)?,
                    error: r.get(9)?,
                    sent_at: r.get(10)?,
                },
                request_headers_json: r.get(11)?,
                request_body: r.get(12)?,
                response_headers_json: r.get(13)?,
                response_body: r.get(14)?,
                response_body_truncated: r.get::<_, i64>(15)? != 0,
            })
        },
    )
    .optional()
    .context("get_history_detail")
}

// ---- Saved-requests CRUD -------------------------------------------------

pub struct NewSavedRequest<'a> {
    pub name: &'a str,
    pub target_id: Option<&'a str>,
    pub environment: Option<&'a str>,
    pub method: &'a str,
    pub url: &'a str,
    pub headers_json: &'a str,
    pub query_json: &'a str,
    pub body_kind: &'a str,
    pub body_text: Option<&'a str>,
}

pub fn save_request(conn: &Connection, r: NewSavedRequest) -> Result<SavedRequestRow> {
    validate_saved_name(r.name)?;
    let name = r.name.trim();

    // Upsert by name so "save" is idempotent and resave on a starred
    // request updates it in place (predictable UX for users who tweak
    // and re-save under the same name).
    let id: String = match conn
        .query_row(
            "SELECT id FROM api_saved_requests WHERE name = ?",
            params![name],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        Some(existing) => existing,
        None => Uuid::new_v4().to_string(),
    };

    conn.execute(
        "INSERT INTO api_saved_requests (id, name, target_id, environment, \
                                          method, url, headers_json, query_json, \
                                          body_kind, body_text, collection_id, folder_path, \
                                          display_name, auth_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, '{\"type\":\"none\"}', strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET \
             name = excluded.name, \
             target_id = excluded.target_id, \
             environment = excluded.environment, \
             method = excluded.method, \
             url = excluded.url, \
             headers_json = excluded.headers_json, \
             query_json = excluded.query_json, \
             body_kind = excluded.body_kind, \
             body_text = excluded.body_text, \
             collection_id = NULL, \
             folder_path = '', \
             display_name = excluded.display_name, \
             auth_json = '{\"type\":\"none\"}', \
             updated_at = strftime('%s','now')",
        params![
            id,
            name,
            r.target_id,
            r.environment,
            r.method,
            r.url,
            r.headers_json,
            r.query_json,
            r.body_kind,
            r.body_text,
            name,
        ],
    )
    .context("upsert saved_request")?;

    get_saved_by_id(conn, &id)?
        .ok_or_else(|| anyhow!("saved request disappeared after upsert: {id}"))
}

pub fn list_saved_requests(conn: &Connection) -> Result<Vec<SavedRequestRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, target_id, environment, method, url, \
                headers_json, query_json, body_kind, body_text, \
                collection_id, folder_path, display_name, auth_json, \
                (SELECT name FROM api_request_collections c WHERE c.id = api_saved_requests.collection_id), \
                created_at, updated_at \
         FROM api_saved_requests ORDER BY collection_id IS NOT NULL, name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SavedRequestRow {
                id: r.get(0)?,
                name: r.get(1)?,
                target_id: r.get(2)?,
                environment: r.get(3)?,
                method: r.get(4)?,
                url: r.get(5)?,
                headers_json: r.get(6)?,
                query_json: r.get(7)?,
                body_kind: r.get(8)?,
                body_text: r.get(9)?,
                collection_id: r.get(10)?,
                folder_path: r.get(11)?,
                display_name: r.get(12)?,
                auth_json: r.get(13)?,
                collection_name: r.get(14)?,
                created_at: r.get(15)?,
                updated_at: r.get(16)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// List only the saved-request rows owned by one imported collection.
/// Folder/display-name ordering matches the collection's flat endpoint picker.
pub fn list_saved_requests_for_collection(
    conn: &Connection,
    collection_id: &str,
) -> Result<Vec<SavedRequestRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, target_id, environment, method, url, \
                headers_json, query_json, body_kind, body_text, \
                collection_id, folder_path, display_name, auth_json, \
                (SELECT name FROM api_request_collections c WHERE c.id = api_saved_requests.collection_id), \
                created_at, updated_at \
         FROM api_saved_requests WHERE collection_id = ?1 \
         ORDER BY folder_path COLLATE NOCASE, display_name COLLATE NOCASE, id",
    )?;
    let rows = stmt
        .query_map(params![collection_id], |r| {
            Ok(SavedRequestRow {
                id: r.get(0)?,
                name: r.get(1)?,
                target_id: r.get(2)?,
                environment: r.get(3)?,
                method: r.get(4)?,
                url: r.get(5)?,
                headers_json: r.get(6)?,
                query_json: r.get(7)?,
                body_kind: r.get(8)?,
                body_text: r.get(9)?,
                collection_id: r.get(10)?,
                folder_path: r.get(11)?,
                display_name: r.get(12)?,
                auth_json: r.get(13)?,
                collection_name: r.get(14)?,
                created_at: r.get(15)?,
                updated_at: r.get(16)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_saved_by_id(conn: &Connection, id: &str) -> Result<Option<SavedRequestRow>> {
    conn.query_row(
        "SELECT id, name, target_id, environment, method, url, \
                headers_json, query_json, body_kind, body_text, \
                collection_id, folder_path, display_name, auth_json, \
                (SELECT name FROM api_request_collections c WHERE c.id = api_saved_requests.collection_id), \
                created_at, updated_at \
         FROM api_saved_requests WHERE id = ?",
        params![id],
        |r| {
            Ok(SavedRequestRow {
                id: r.get(0)?,
                name: r.get(1)?,
                target_id: r.get(2)?,
                environment: r.get(3)?,
                method: r.get(4)?,
                url: r.get(5)?,
                headers_json: r.get(6)?,
                query_json: r.get(7)?,
                body_kind: r.get(8)?,
                body_text: r.get(9)?,
                collection_id: r.get(10)?,
                folder_path: r.get(11)?,
                display_name: r.get(12)?,
                auth_json: r.get(13)?,
                collection_name: r.get(14)?,
                created_at: r.get(15)?,
                updated_at: r.get(16)?,
            })
        },
    )
    .optional()
    .context("get_saved_by_id")
}

pub fn get_saved_by_name(conn: &Connection, name: &str) -> Result<Option<SavedRequestRow>> {
    conn.query_row(
        "SELECT id, name, target_id, environment, method, url, \
                headers_json, query_json, body_kind, body_text, \
                collection_id, folder_path, display_name, auth_json, \
                (SELECT name FROM api_request_collections c WHERE c.id = api_saved_requests.collection_id), \
                created_at, updated_at \
         FROM api_saved_requests WHERE name = ?",
        params![name],
        |r| {
            Ok(SavedRequestRow {
                id: r.get(0)?,
                name: r.get(1)?,
                target_id: r.get(2)?,
                environment: r.get(3)?,
                method: r.get(4)?,
                url: r.get(5)?,
                headers_json: r.get(6)?,
                query_json: r.get(7)?,
                body_kind: r.get(8)?,
                body_text: r.get(9)?,
                collection_id: r.get(10)?,
                folder_path: r.get(11)?,
                display_name: r.get(12)?,
                auth_json: r.get(13)?,
                collection_name: r.get(14)?,
                created_at: r.get(15)?,
                updated_at: r.get(16)?,
            })
        },
    )
    .optional()
    .context("get_saved_by_name")
}

pub fn delete_saved_request(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM api_saved_requests WHERE id = ?", params![id])?;
    Ok(())
}

// ---- Response chaining lookup -------------------------------------------

/// Look up the most recent SUCCESSFUL response body for the saved request
/// with the given name. Returns `None` if no such row exists yet OR the
/// last attempt had `status_code = 0` (transport failure — chaining into
/// a failure is worse than a clear "missing" error).
pub fn lookup_latest_response_body(conn: &Connection, saved_name: &str) -> Result<Option<Vec<u8>>> {
    let body: Option<Vec<u8>> = conn
        .query_row(
            "SELECT h.response_body \
             FROM api_history h \
             JOIN api_saved_requests s ON s.id = h.saved_request_id \
             WHERE s.name = ? \
               AND h.status_code IS NOT NULL \
               AND h.status_code != 0 \
             ORDER BY h.sent_at DESC, h.id DESC \
             LIMIT 1",
            params![saved_name],
            |r| r.get(0),
        )
        .optional()?;
    Ok(body)
}

// ---- serde helpers -------------------------------------------------------

mod opt_bytes_as_base64 {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(b) => s.serialize_str(&STANDARD.encode(b)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        let opt = Option::<String>::deserialize(d)?;
        match opt {
            Some(s) => STANDARD
                .decode(s.as_bytes())
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

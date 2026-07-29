//! Diff two `parsed_outputs` rows directly (Plan 06 reconciliation).
//!
//! Plan 05's `diff_snapshots` takes `parsed_snapshots` ids (the named-pin
//! table). Plan 06's pre/post change-verification stores the underlying
//! `parsed_outputs.id` directly in `change_snapshot_results.parsed_output_id`
//! — no intermediate snapshot pin. This helper bypasses the `parsed_snapshots`
//! join and reuses Plan 05's alignment+diff logic via the now-`pub(crate)`
//! helpers in `crate::structured::diff`.

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::sync::Arc;

use crate::structured::diff::{
    as_list_of_dicts, diff_list_of_dicts, diff_nested_dict, lookup_schema_key, pick_alignment_key,
    CellDiff,
};

struct OutputData {
    parser: String,
    command: String,
    vendor: String,
    platform: String,
    data: Value,
}

fn load_output(conn: &Connection, parsed_output_id: i64) -> Result<OutputData> {
    let row = conn
        .query_row(
            "SELECT parser, command, vendor, platform, data_json
             FROM parsed_outputs WHERE id = ?1",
            params![parsed_output_id],
            |r| {
                Ok::<(String, String, String, String, String), rusqlite::Error>((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                ))
            },
        )
        .map_err(|e| anyhow!("parsed_output {parsed_output_id} not found: {e}"))?;

    let data: Value = serde_json::from_str(&row.4).map_err(|e| anyhow!("invalid data_json: {e}"))?;
    Ok(OutputData {
        parser: row.0,
        command: row.1,
        vendor: row.2,
        platform: row.3,
        data,
    })
}

/// Diff two `parsed_outputs` rows and return a flat list of cell-level
/// differences. Mirrors `crate::structured::diff::diff_snapshots` but takes
/// raw `parsed_outputs.id`s instead of `parsed_snapshots.id`s.
pub fn diff_outputs(
    a_parsed_output_id: i64,
    b_parsed_output_id: i64,
    db: Arc<Mutex<Connection>>,
) -> Result<Vec<CellDiff>> {
    let conn = db.lock();
    let a = load_output(&conn, a_parsed_output_id)?;
    let b = load_output(&conn, b_parsed_output_id)?;

    let a_is_list = a.data.is_array();
    let b_is_list = b.data.is_array();
    if a_is_list != b_is_list {
        return Err(anyhow!(
            "data shapes mismatch: a is {} but b is {}",
            if a_is_list { "list" } else { "dict" },
            if b_is_list { "list" } else { "dict" }
        ));
    }

    if a_is_list {
        let a_rows = as_list_of_dicts(&a.data).ok_or_else(|| anyhow!("a is not list-of-dicts"))?;
        let b_rows = as_list_of_dicts(&b.data).ok_or_else(|| anyhow!("b is not list-of-dicts"))?;
        let key = lookup_schema_key(&conn, &a.parser, &a.command, &a.vendor, &a.platform)?
            .or_else(|| pick_alignment_key(&a_rows, &b_rows))
            .ok_or_else(|| anyhow!("no usable alignment key for list-of-dicts diff"))?;
        Ok(diff_list_of_dicts(a_rows, b_rows, &key))
    } else {
        Ok(diff_nested_dict(&a.data, &b.data))
    }
}

//! Diff engine — public API consumed by Plans 06 + 08.
//!
//! Implementation lands in Phase 4. This file provides the stable public
//! types so earlier phases can compile against them.

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::structured::flatten;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    Added,
    Removed,
    Changed,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CellDiff {
    pub row_key: String,
    pub column: String,
    pub status: DiffStatus,
    pub a: Option<serde_json::Value>,
    pub b: Option<serde_json::Value>,
}

/// Fetch a parsed_snapshots row joined with parsed_outputs.
struct SnapshotData {
    parser: String,
    command: String,
    vendor: String,
    platform: String,
    data: serde_json::Value,
}

fn load_snapshot(conn: &Connection, snapshot_id: i64) -> Result<SnapshotData> {
    let row = conn
        .query_row(
            "SELECT po.parser, po.command, po.vendor, po.platform, po.data_json
         FROM parsed_snapshots ps
         JOIN parsed_outputs po ON po.id = ps.parsed_output_id
         WHERE ps.id = ?1",
            params![snapshot_id],
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
        .map_err(|e| anyhow!("snapshot {snapshot_id} not found: {e}"))?;

    let data: serde_json::Value =
        serde_json::from_str(&row.4).map_err(|e| anyhow!("invalid data_json: {e}"))?;
    Ok(SnapshotData {
        parser: row.0,
        command: row.1,
        vendor: row.2,
        platform: row.3,
        data,
    })
}

/// Look up an alignment key from `parse_schemas`, if any.
pub(crate) fn lookup_schema_key(
    conn: &Connection,
    parser: &str,
    command: &str,
    vendor: &str,
    platform: &str,
) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT schema_json FROM parse_schemas
         WHERE parser=?1 AND command=?2 AND vendor=?3 AND platform=?4",
    )?;
    let mut rows = stmt.query(params![parser, command, vendor, platform])?;
    if let Some(row) = rows.next()? {
        let json: String = row.get(0)?;
        let parsed: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| anyhow!("schema_json: {e}"))?;
        Ok(parsed
            .get("key")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    } else {
        Ok(None)
    }
}

/// Determine the alignment key for a list-of-dicts: first column whose
/// values are unique across both sides.
pub(crate) fn pick_alignment_key(
    a: &[serde_json::Map<String, serde_json::Value>],
    b: &[serde_json::Map<String, serde_json::Value>],
) -> Option<String> {
    let mut columns: Vec<String> = Vec::new();
    for row in a.iter().chain(b.iter()) {
        for k in row.keys() {
            if !columns.contains(k) {
                columns.push(k.clone());
            }
        }
    }
    for col in &columns {
        let unique_a = a
            .iter()
            .filter_map(|r| r.get(col).map(|v| v.to_string()))
            .collect::<std::collections::HashSet<_>>()
            .len()
            == a.len();
        let unique_b = b
            .iter()
            .filter_map(|r| r.get(col).map(|v| v.to_string()))
            .collect::<std::collections::HashSet<_>>()
            .len()
            == b.len();
        if unique_a && unique_b {
            return Some(col.clone());
        }
    }
    None
}

pub(crate) fn as_list_of_dicts(
    v: &serde_json::Value,
) -> Option<Vec<serde_json::Map<String, serde_json::Value>>> {
    let arr = v.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let object = item.as_object()?;
        out.push(object.clone());
    }
    Some(out)
}

pub(crate) fn diff_list_of_dicts(
    a: Vec<serde_json::Map<String, serde_json::Value>>,
    b: Vec<serde_json::Map<String, serde_json::Value>>,
    key: &str,
) -> Vec<CellDiff> {
    let mut out: Vec<CellDiff> = Vec::new();
    let mut a_map: BTreeMap<String, &serde_json::Map<String, serde_json::Value>> = BTreeMap::new();
    let mut b_map: BTreeMap<String, &serde_json::Map<String, serde_json::Value>> = BTreeMap::new();
    for row in a.iter() {
        if let Some(k) = row.get(key).and_then(|v| {
            if v.is_string() {
                v.as_str().map(|s| s.to_string())
            } else {
                Some(v.to_string())
            }
        }) {
            a_map.insert(k, row);
        }
    }
    for row in b.iter() {
        if let Some(k) = row.get(key).and_then(|v| {
            if v.is_string() {
                v.as_str().map(|s| s.to_string())
            } else {
                Some(v.to_string())
            }
        }) {
            b_map.insert(k, row);
        }
    }

    let mut all_keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    all_keys.extend(a_map.keys().cloned());
    all_keys.extend(b_map.keys().cloned());

    let mut all_columns: Vec<String> = Vec::new();
    for row in a.iter().chain(b.iter()) {
        for k in row.keys() {
            if !all_columns.contains(k) {
                all_columns.push(k.clone());
            }
        }
    }

    for row_key in all_keys {
        let a_row = a_map.get(&row_key).copied();
        let b_row = b_map.get(&row_key).copied();
        for col in &all_columns {
            let a_val = a_row.and_then(|r| r.get(col)).cloned();
            let b_val = b_row.and_then(|r| r.get(col)).cloned();
            let status = match (&a_val, &b_val) {
                (Some(_), None) => DiffStatus::Removed,
                (None, Some(_)) => DiffStatus::Added,
                (Some(av), Some(bv)) if av == bv => DiffStatus::Unchanged,
                (Some(_), Some(_)) => DiffStatus::Changed,
                (None, None) => continue,
            };
            out.push(CellDiff {
                row_key: row_key.clone(),
                column: col.clone(),
                status,
                a: a_val,
                b: b_val,
            });
        }
    }
    out
}

pub(crate) fn diff_nested_dict(a: &serde_json::Value, b: &serde_json::Value) -> Vec<CellDiff> {
    let a_rows = flatten::flatten_to_rows(a, "");
    let b_rows = flatten::flatten_to_rows(b, "");
    let a_map: BTreeMap<String, serde_json::Value> =
        a_rows.into_iter().map(|r| (r.key, r.value)).collect();
    let b_map: BTreeMap<String, serde_json::Value> =
        b_rows.into_iter().map(|r| (r.key, r.value)).collect();
    let mut all_keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    all_keys.extend(a_map.keys().cloned());
    all_keys.extend(b_map.keys().cloned());
    let mut out = Vec::new();
    for k in all_keys {
        let av = a_map.get(&k).cloned();
        let bv = b_map.get(&k).cloned();
        let status = match (&av, &bv) {
            (Some(_), None) => DiffStatus::Removed,
            (None, Some(_)) => DiffStatus::Added,
            (Some(x), Some(y)) if x == y => DiffStatus::Unchanged,
            (Some(_), Some(_)) => DiffStatus::Changed,
            (None, None) => continue,
        };
        out.push(CellDiff {
            row_key: k,
            column: "value".to_string(),
            status,
            a: av,
            b: bv,
        });
    }
    out
}

/// Diff two `parsed_snapshots` rows and return a flat list of cell-level
/// differences.
///
/// Public API — consumed by Plan 06 (pre/post change verification) and
/// Plan 08 (config intent drift). Do not change the signature without
/// coordinating updates across both downstream plans.
pub fn diff_snapshots(
    a_snapshot_id: i64,
    b_snapshot_id: i64,
    db: Arc<Mutex<Connection>>,
) -> Result<Vec<CellDiff>> {
    let conn = db.lock();
    let a = load_snapshot(&conn, a_snapshot_id)?;
    let b = load_snapshot(&conn, b_snapshot_id)?;

    // Same-shape check.
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

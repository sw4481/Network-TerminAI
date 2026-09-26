//! Plan 05 Phase 4 — public `diff_snapshots` API tests.
//!
//! These tests exercise every alignment branch:
//!   - list-of-dicts row added / removed / changed / identical
//!   - nested-dict (Genie shape) flattened diff
//!   - parse_schemas alignment-key override
//!   - first-unique-column auto-detection
//!   - shape mismatch error

use ccie_terminal_lib::db;
use ccie_terminal_lib::structured::{auto_parse, diff_snapshots, snapshot, DiffStatus};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::sync::Arc;
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Arc<Mutex<Connection>>) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    (dir, Arc::new(Mutex::new(conn)))
}

fn seed_tab(db: &Arc<Mutex<Connection>>, tab_id: &str) {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, 'tab', '/bin/zsh', '/')",
        params![tab_id],
    )
    .unwrap();
}

fn seed_block(db: &Arc<Mutex<Connection>>, tab_id: &str, cmd: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at, cwd)
         VALUES (?, ?, ?, '', 1, '/')",
        params![id, tab_id, cmd],
    )
    .unwrap();
    id
}

/// Insert a parsed_output row directly, bypassing the bridge.
fn insert_parsed(
    db: &Arc<Mutex<Connection>>,
    block_id: &str,
    parser: &str,
    cmd: &str,
    payload: serde_json::Value,
) {
    let conn = db.lock();
    auto_parse::upsert_parsed_output(
        &conn,
        block_id,
        parser,
        cmd,
        "cisco",
        "iosxe",
        &payload.to_string(),
    )
    .unwrap();
}

fn pin(db: &Arc<Mutex<Connection>>, block_id: &str, name: &str) -> i64 {
    let conn = db.lock();
    snapshot::create(&conn, block_id, name).unwrap()
}

fn make_pair_list(
    db: &Arc<Mutex<Connection>>,
    a: serde_json::Value,
    b: serde_json::Value,
    cmd: &str,
) -> (i64, i64) {
    seed_tab(db, "t1");
    let b1 = seed_block(db, "t1", cmd);
    let b2 = seed_block(db, "t1", cmd);
    insert_parsed(db, &b1, "textfsm", cmd, a);
    insert_parsed(db, &b2, "textfsm", cmd, b);
    (pin(db, &b1, "a"), pin(db, &b2, "b"))
}

#[test]
fn diff_list_of_dicts_row_added() {
    let (_dir, db) = open_test_db();
    let a = serde_json::json!([
        {"interface":"Gi1","status":"up"},
        {"interface":"Gi2","status":"up"}
    ]);
    let b = serde_json::json!([
        {"interface":"Gi1","status":"up"},
        {"interface":"Gi2","status":"up"},
        {"interface":"Gi3","status":"up"}
    ]);
    let (ai, bi) = make_pair_list(&db, a, b, "show ip int br");
    let cells = diff_snapshots(ai, bi, db.clone()).unwrap();
    let added = cells
        .iter()
        .filter(|c| c.status == DiffStatus::Added)
        .collect::<Vec<_>>();
    assert!(added.iter().any(|c| c.row_key == "Gi3"));
}

#[test]
fn diff_list_of_dicts_row_removed() {
    let (_dir, db) = open_test_db();
    let a = serde_json::json!([
        {"interface":"Gi1","status":"up"},
        {"interface":"Gi2","status":"up"}
    ]);
    let b = serde_json::json!([
        {"interface":"Gi2","status":"up"}
    ]);
    let (ai, bi) = make_pair_list(&db, a, b, "show ip int br");
    let cells = diff_snapshots(ai, bi, db.clone()).unwrap();
    assert!(cells
        .iter()
        .any(|c| c.row_key == "Gi1" && c.status == DiffStatus::Removed));
}

#[test]
fn diff_list_of_dicts_cell_changed() {
    let (_dir, db) = open_test_db();
    let a = serde_json::json!([
        {"interface":"Gi1","status":"up"}
    ]);
    let b = serde_json::json!([
        {"interface":"Gi1","status":"down"}
    ]);
    let (ai, bi) = make_pair_list(&db, a, b, "show ip int br");
    let cells = diff_snapshots(ai, bi, db.clone()).unwrap();
    let changed: Vec<_> = cells
        .iter()
        .filter(|c| c.status == DiffStatus::Changed)
        .collect();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].row_key, "Gi1");
    assert_eq!(changed[0].column, "status");
}

#[test]
fn diff_list_of_dicts_identical_returns_all_unchanged() {
    let (_dir, db) = open_test_db();
    let v = serde_json::json!([
        {"interface":"Gi1","status":"up"}
    ]);
    let (ai, bi) = make_pair_list(&db, v.clone(), v, "show ip int br");
    let cells = diff_snapshots(ai, bi, db.clone()).unwrap();
    assert!(cells.iter().all(|c| c.status == DiffStatus::Unchanged));
}

#[test]
fn diff_nested_dict_genie_shape() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let b1 = seed_block(&db, "t1", "show ip route");
    let b2 = seed_block(&db, "t1", "show ip route");
    insert_parsed(
        &db,
        &b1,
        "genie",
        "show ip route",
        serde_json::json!({
            "vrf":{"default":{"address_family":{"ipv4":{"routes":{"10.0.0.0/24":{"nexthop":"R1"}}}}}}
        }),
    );
    insert_parsed(
        &db,
        &b2,
        "genie",
        "show ip route",
        serde_json::json!({
            "vrf":{"default":{"address_family":{"ipv4":{"routes":{"10.0.0.0/24":{"nexthop":"R2"}}}}}}
        }),
    );
    let ai = pin(&db, &b1, "a");
    let bi = pin(&db, &b2, "b");
    let cells = diff_snapshots(ai, bi, db.clone()).unwrap();
    let changed: Vec<_> = cells
        .iter()
        .filter(|c| c.status == DiffStatus::Changed)
        .collect();
    assert_eq!(changed.len(), 1);
    assert!(changed[0].row_key.ends_with("nexthop"));
}

#[test]
fn diff_uses_parse_schemas_key_when_present() {
    let (_dir, db) = open_test_db();
    // Insert a parse_schemas row with key="port" (different from default "interface").
    {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO parse_schemas(parser, command, vendor, platform, schema_json)
             VALUES ('textfsm','show ports','cisco','iosxe','{\"key\":\"port\"}')",
            [],
        )
        .unwrap();
    }
    seed_tab(&db, "t1");
    let b1 = seed_block(&db, "t1", "show ports");
    let b2 = seed_block(&db, "t1", "show ports");
    // Both rows share the same `port` value but different `name` values —
    // alignment key MUST be `port` per the schema, not `name`.
    insert_parsed(
        &db,
        &b1,
        "textfsm",
        "show ports",
        serde_json::json!([{"port":"1","name":"a"}]),
    );
    insert_parsed(
        &db,
        &b2,
        "textfsm",
        "show ports",
        serde_json::json!([{"port":"1","name":"b"}]),
    );
    let ai = pin(&db, &b1, "a");
    let bi = pin(&db, &b2, "b");
    let cells = diff_snapshots(ai, bi, db.clone()).unwrap();
    // port column: unchanged ("1" == "1"); name column: changed.
    let name_changed = cells
        .iter()
        .find(|c| c.column == "name")
        .expect("expected name cell");
    assert_eq!(name_changed.status, DiffStatus::Changed);
}

#[test]
fn diff_falls_back_to_first_unique_column() {
    let (_dir, db) = open_test_db();
    let a = serde_json::json!([
        {"intf":"Gi1","mtu":1500},
        {"intf":"Gi2","mtu":1500}
    ]);
    let b = serde_json::json!([
        {"intf":"Gi1","mtu":9000},
        {"intf":"Gi2","mtu":1500}
    ]);
    let (ai, bi) = make_pair_list(&db, a, b, "show interfaces");
    let cells = diff_snapshots(ai, bi, db.clone()).unwrap();
    let changed: Vec<_> = cells
        .iter()
        .filter(|c| c.status == DiffStatus::Changed)
        .collect();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].row_key, "Gi1");
    assert_eq!(changed[0].column, "mtu");
}

#[test]
fn diff_raises_when_data_shapes_mismatch() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let b1 = seed_block(&db, "t1", "show foo");
    let b2 = seed_block(&db, "t1", "show foo");
    insert_parsed(&db, &b1, "textfsm", "show foo", serde_json::json!([{"x":1}]));
    insert_parsed(&db, &b2, "genie", "show foo", serde_json::json!({"x":1}));
    let ai = pin(&db, &b1, "a");
    let bi = pin(&db, &b2, "b");
    let err = diff_snapshots(ai, bi, db.clone()).unwrap_err();
    assert!(err.to_string().contains("shapes mismatch"));
}

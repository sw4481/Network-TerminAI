//! V0050 — terraform_state_cache + drift_checks + drift_exceptions.
//! Verifies the migration applies cleanly and creates all three tables,
//! the project/checked_at index, and the drift_exceptions uniqueness constraint.

use ccie_terminal_lib::db;
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

#[test]
fn migration_creates_phase3_tables() {
    let (_dir, conn) = open_test_db();
    let names: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table'
             AND name IN ('terraform_state_cache','drift_checks','drift_exceptions')",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(names.contains(&"terraform_state_cache".to_string()));
    assert!(names.contains(&"drift_checks".to_string()));
    assert!(names.contains(&"drift_exceptions".to_string()));
}

#[test]
fn drift_exceptions_unique_per_resource() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO drift_exceptions (id, project_path, resource_address, created_at)
         VALUES ('e1', '/infra', 'aws_security_group.alb', 1)",
        [],
    )
    .unwrap();
    let dup = conn.execute(
        "INSERT INTO drift_exceptions (id, project_path, resource_address, created_at)
         VALUES ('e2', '/infra', 'aws_security_group.alb', 2)",
        [],
    );
    assert!(dup.is_err(), "duplicate (project_path, resource_address) must be rejected");
    // A different resource in the same project is allowed.
    conn.execute(
        "INSERT INTO drift_exceptions (id, project_path, resource_address, created_at)
         VALUES ('e3', '/infra', 'aws_security_group.web', 3)",
        params![],
    )
    .unwrap();
}

#[test]
fn migration_creates_drift_checks_index() {
    let (_dir, conn) = open_test_db();
    let indexes: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='index'
             AND tbl_name='drift_checks' AND name='idx_drift_checks_project'",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        indexes.contains(&"idx_drift_checks_project".to_string()),
        "Missing idx_drift_checks_project index"
    );
}

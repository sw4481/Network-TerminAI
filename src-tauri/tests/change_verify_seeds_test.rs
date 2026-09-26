use ccie_terminal_lib::change_verify::seeds::seed_if_first_run;
use ccie_terminal_lib::db;
use rusqlite::Connection;
use tempfile::TempDir;

fn open_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

#[test]
fn seeds_four_bundles_on_first_run() {
    let (_dir, mut db) = open_db();
    let n = seed_if_first_run(&mut db).unwrap();
    assert_eq!(n, 4);
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM check_bundles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 4);
}

#[test]
fn second_run_is_idempotent() {
    let (_dir, mut db) = open_db();
    let first = seed_if_first_run(&mut db).unwrap();
    let second = seed_if_first_run(&mut db).unwrap();
    assert_eq!(first, 4);
    assert_eq!(second, 0);
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM check_bundles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 4, "must remain 4 after second invocation");
}

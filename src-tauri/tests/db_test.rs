use ccie_terminal_lib::db;
use tempfile::TempDir;

#[test]
fn opens_and_migrates_fresh_db() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");

    let conn = db::open_and_migrate(&db_path).expect("open_and_migrate");

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_placeholder'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

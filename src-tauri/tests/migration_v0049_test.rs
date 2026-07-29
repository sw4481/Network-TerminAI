use ccie_terminal_lib::db;
use tempfile::TempDir;

/// V0049 adds command_blocks.iac_execution_id, the link column that IaC Phase 1
/// code already reads (blocks.rs SELECTs it) and writes (iac_process_block
/// UPDATEs it). It was missing from every migration — only present ad-hoc on the
/// original dev machine — so fresh databases broke block loading entirely.
#[test]
fn test_v0049_adds_iac_execution_id_column() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");

    let conn = db::open_and_migrate(&db_path).expect("open_and_migrate");

    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(command_blocks)")
        .expect("prepare schema query")
        .query_map([], |row| row.get(1))
        .expect("query_map failed")
        .filter_map(Result::ok)
        .collect();

    assert!(
        columns.contains(&"iac_execution_id".to_string()),
        "Missing iac_execution_id column on a freshly-migrated database"
    );

    // The column must be selectable/updatable exactly as the app uses it,
    // mirroring iac_process_block's UPDATE and blocks.rs's SELECT.
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, created_at) VALUES ('t1', 't', 'zsh', '/tmp', 0)",
        [],
    )
    .expect("insert tab");
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at) \
         VALUES ('b1', 't1', 'terraform apply', X'', 0)",
        [],
    )
    .expect("insert block");
    conn.execute(
        "UPDATE command_blocks SET iac_execution_id = 'exec-1' WHERE id = 'b1'",
        [],
    )
    .expect("update iac_execution_id");

    let linked: Option<String> = conn
        .query_row(
            "SELECT iac_execution_id FROM command_blocks WHERE id = 'b1'",
            [],
            |row| row.get(0),
        )
        .expect("select iac_execution_id");
    assert_eq!(linked.as_deref(), Some("exec-1"));

    // Index for fast lookup by execution id.
    let indexes: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='command_blocks'")
        .expect("prepare index query")
        .query_map([], |row| row.get(0))
        .expect("query_map failed")
        .filter_map(Result::ok)
        .collect();
    assert!(
        indexes.contains(&"idx_command_blocks_iac_execution".to_string()),
        "Missing idx_command_blocks_iac_execution index"
    );
}

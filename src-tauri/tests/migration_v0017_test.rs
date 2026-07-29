use ccie_terminal_lib::db;
use tempfile::TempDir;

#[test]
fn test_v0017_enhances_command_blocks_schema() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");

    let conn = db::open_and_migrate(&db_path).expect("open_and_migrate");

    // Check that new columns exist
    let schema_query = "PRAGMA table_info(command_blocks)";
    let mut stmt = conn
        .prepare(schema_query)
        .expect("Failed to prepare schema query");

    let columns: Vec<String> = stmt
        .query_map([], |row| row.get(1))
        .expect("query_map failed")
        .filter_map(Result::ok)
        .collect();

    // Verify all expected columns exist
    assert!(columns.contains(&"id".to_string()), "Missing id column");
    assert!(columns.contains(&"tab_id".to_string()), "Missing tab_id column");
    assert!(columns.contains(&"cmd".to_string()), "Missing cmd column");
    assert!(columns.contains(&"output".to_string()), "Missing output column");
    assert!(columns.contains(&"exit_code".to_string()), "Missing exit_code column");
    assert!(columns.contains(&"started_at".to_string()), "Missing started_at column");
    assert!(columns.contains(&"ended_at".to_string()), "Missing ended_at column");

    // Verify new columns exist
    assert!(
        columns.contains(&"cwd".to_string()),
        "Missing new cwd column"
    );
    assert!(
        columns.contains(&"output_line_count".to_string()),
        "Missing new output_line_count column"
    );
    assert!(
        columns.contains(&"is_bookmarked".to_string()),
        "Missing new is_bookmarked column"
    );
    assert!(
        columns.contains(&"ai_analysis".to_string()),
        "Missing new ai_analysis column"
    );
    assert!(
        columns.contains(&"duration_ms".to_string()),
        "Missing new duration_ms column"
    );

    // Check that indexes were created
    let index_query = "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='command_blocks'";
    let mut stmt = conn
        .prepare(index_query)
        .expect("Failed to prepare index query");

    let indexes: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .expect("query_map failed")
        .filter_map(Result::ok)
        .collect();

    assert!(
        indexes.contains(&"idx_blocks_bookmark".to_string()),
        "Missing idx_blocks_bookmark index"
    );
    assert!(
        indexes.contains(&"idx_blocks_timestamp".to_string()),
        "Missing idx_blocks_timestamp index"
    );
}

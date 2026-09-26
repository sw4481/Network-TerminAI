use ccie_terminal_lib::notebooks::seeds::{
    already_seeded, ensure_seed_marker_table, mark_seeded, seed_builtin_runnable_notebooks,
    SEED_MARKDOWN,
};
use rusqlite::Connection;

fn schema() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE notebooks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            vendor TEXT,
            platform TEXT,
            frontmatter_json TEXT NOT NULL DEFAULT '{}',
            body_markdown TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE TABLE notebook_cells (
            notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
            idx INTEGER NOT NULL,
            cell_type TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (notebook_id, idx)
        );
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn seeds_all_ten_on_first_call() {
    let conn = schema();
    let n = seed_builtin_runnable_notebooks(&conn).unwrap();
    assert_eq!(n, 10);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notebooks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 10);
}

#[test]
fn second_call_is_idempotent_and_returns_zero() {
    let conn = schema();
    seed_builtin_runnable_notebooks(&conn).unwrap();
    let n2 = seed_builtin_runnable_notebooks(&conn).unwrap();
    assert_eq!(n2, 0, "second call must report 0 imports");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notebooks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 10, "no duplicate rows after second call");
}

#[test]
fn marker_flag_blocks_resseed() {
    let conn = schema();
    ensure_seed_marker_table(&conn).unwrap();
    mark_seeded(&conn).unwrap();
    assert!(already_seeded(&conn).unwrap());
    let n = seed_builtin_runnable_notebooks(&conn).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn each_seed_has_distinct_title() {
    let conn = schema();
    seed_builtin_runnable_notebooks(&conn).unwrap();
    let mut stmt = conn.prepare("SELECT title FROM notebooks").unwrap();
    let titles: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|t| t.unwrap())
        .collect();
    let unique: std::collections::HashSet<_> = titles.iter().collect();
    assert_eq!(unique.len(), titles.len(), "duplicate seed titles: {titles:?}");
    assert_eq!(titles.len(), SEED_MARKDOWN.len());
}

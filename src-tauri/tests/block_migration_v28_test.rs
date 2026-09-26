//! V0028 (block_tags / block_pins / block_shares + collapsed column) migration
//! regression test.
//!
//! Verifies that upgrading a legacy DB sitting at V0027 to V0028 leaves the
//! existing `command_blocks` rows untouched, while the new tables exist and
//! are empty-but-present.

use ccie_terminal_lib::db;
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn has_table(conn: &Connection, table: &str) -> bool {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            [table],
            |r| r.get(0),
        )
        .unwrap();
    n > 0
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    cols.iter().any(|c| c == column)
}

fn has_index(conn: &Connection, name: &str) -> bool {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?",
            [name],
            |r| r.get(0),
        )
        .unwrap();
    n > 0
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn v0028_preserves_legacy_blocks_and_creates_new_tables() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("legacy.db");

    // Step 1 — migrate to V0027 (the schema right before this plan).
    {
        let conn = db::open_and_migrate_to(&db_path, 27).expect("migrate to V0027");

        // V0028's pieces must NOT exist yet.
        assert!(!has_table(&conn, "block_tags"), "block_tags should not exist at V0027");
        assert!(!has_table(&conn, "block_pins"), "block_pins should not exist at V0027");
        assert!(!has_table(&conn, "block_shares"), "block_shares should not exist at V0027");
        assert!(
            !has_column(&conn, "command_blocks", "collapsed"),
            "collapsed column should not exist at V0027"
        );

        // Seed a legacy tab + two legacy command_blocks rows. Use only columns
        // present at V0027 (i.e. V0002 + V0017 schema): id, tab_id, cmd, cwd,
        // output, exit_code, started_at, ended_at, output_line_count,
        // is_bookmarked, ai_analysis, duration_ms.
        conn.execute(
            "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, ?, ?, ?)",
            params!["legacy-tab", "legacy", "/bin/zsh", "/legacy"],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO command_blocks
                (id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at,
                 output_line_count, is_bookmarked, ai_analysis, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "blk-1",
                "legacy-tab",
                "show version",
                "/home/eng",
                b"Cisco IOS XE Software, Version 17.9.1".to_vec(),
                0_i64,
                1_700_000_000_i64,
                1_700_000_001_i64,
                3_i64,
                1_i64, // bookmarked
                "ai notes",
                1_500_i64,
            ],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO command_blocks
                (id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at,
                 output_line_count, is_bookmarked, ai_analysis, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "blk-2",
                "legacy-tab",
                "show ip int brief",
                "/home/eng",
                b"GigabitEthernet0/0/0".to_vec(),
                1_i64, // failed
                1_700_000_002_i64,
                1_700_000_003_i64,
                7_i64,
                0_i64,
                Option::<String>::None,
                250_i64,
            ],
        )
        .unwrap();
    } // close conn so the file handle is released before re-opening

    // Step 2 — re-open and migrate to latest, which applies V0028 on top of
    // the seeded legacy data.
    let conn = db::open_and_migrate(&db_path).expect("apply V0028 on top");

    // Step 3a — new tables exist and are empty.
    for t in ["block_tags", "block_pins", "block_shares"] {
        assert!(has_table(&conn, t), "table `{}` missing after V0028", t);
        let n = count(&conn, &format!("SELECT COUNT(*) FROM {}", t));
        assert_eq!(n, 0, "expected `{}` to be empty after V0028, got {}", t, n);
    }

    // Step 3b — block_tags index landed.
    assert!(has_index(&conn, "idx_block_tags_tag"), "idx_block_tags_tag missing");

    // Step 3c — `collapsed` column added with default 0; defaulted on legacy rows.
    assert!(
        has_column(&conn, "command_blocks", "collapsed"),
        "collapsed column missing after V0028"
    );
    let collapsed_blk1: i64 = conn
        .query_row(
            "SELECT collapsed FROM command_blocks WHERE id = ?",
            ["blk-1"],
            |r| r.get(0),
        )
        .unwrap();
    let collapsed_blk2: i64 = conn
        .query_row(
            "SELECT collapsed FROM command_blocks WHERE id = ?",
            ["blk-2"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(collapsed_blk1, 0, "legacy row blk-1 should default to collapsed=0");
    assert_eq!(collapsed_blk2, 0, "legacy row blk-2 should default to collapsed=0");

    // Step 3d — every other legacy column survived untouched on both rows.
    let (cmd, cwd, exit_code, started_at, ended_at, line_count, bookmarked, ai, dur): (
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<String>,
        i64,
    ) = conn
        .query_row(
            "SELECT cmd, cwd, exit_code, started_at, ended_at,
                    output_line_count, is_bookmarked, ai_analysis, duration_ms
             FROM command_blocks WHERE id = ?",
            ["blk-1"],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(cmd, "show version");
    assert_eq!(cwd, "/home/eng");
    assert_eq!(exit_code, 0);
    assert_eq!(started_at, 1_700_000_000);
    assert_eq!(ended_at, 1_700_000_001);
    assert_eq!(line_count, 3);
    assert_eq!(bookmarked, 1);
    assert_eq!(ai.as_deref(), Some("ai notes"));
    assert_eq!(dur, 1_500);

    // Output BLOB round-trips intact.
    let output: Vec<u8> = conn
        .query_row(
            "SELECT output FROM command_blocks WHERE id = ?",
            ["blk-1"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(output, b"Cisco IOS XE Software, Version 17.9.1".to_vec());

    // The second row's NULL ai_analysis is still NULL (not coerced to '').
    let ai2: Option<String> = conn
        .query_row(
            "SELECT ai_analysis FROM command_blocks WHERE id = ?",
            ["blk-2"],
            |r| r.get(0),
        )
        .unwrap();
    assert!(ai2.is_none(), "legacy NULL ai_analysis must remain NULL");

    // Tab is intact and still owns both blocks.
    let n_blocks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM command_blocks WHERE tab_id = ?",
            ["legacy-tab"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n_blocks, 2);
}

#[test]
fn v0028_inserts_into_new_tables_after_upgrade() {
    // Sanity: after V0028 lands on a legacy DB, the new tables actually accept
    // writes that reference the pre-existing rows (i.e. the FKs to
    // command_blocks(id) resolve).
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("upgrade_then_write.db");

    {
        let conn = db::open_and_migrate_to(&db_path, 27).expect("migrate to V0027");
        conn.execute(
            "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, ?, ?, ?)",
            params!["t", "t", "/bin/zsh", "/"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO command_blocks (id, tab_id, cmd, cwd, output, started_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params!["blk-x", "t", "show clock", "/", b"".to_vec(), 1_i64],
        )
        .unwrap();
    }

    let conn = db::open_and_migrate(&db_path).expect("apply V0028");

    conn.execute(
        "INSERT INTO block_tags (block_id, tag) VALUES (?, ?)",
        params!["blk-x", "site-atl"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO block_pins (block_id, position) VALUES (?, ?)",
        params!["blk-x", 0_i64],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO block_shares (share_id, block_id, payload_json) VALUES (?, ?, ?)",
        params!["share-1", "blk-x", "{}"],
    )
    .unwrap();

    assert_eq!(count(&conn, "SELECT COUNT(*) FROM block_tags"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM block_pins"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM block_shares"), 1);
}

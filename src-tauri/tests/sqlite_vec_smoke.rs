//! Plan 12 Phase 1 Task 1.2 — sqlite-vec extension loads and the `vec0`
//! virtual table can be created + queried end-to-end. Decision B path
//! (safe-wrapper crate `sqlite-vec`) — see `docs/rag/sqlite-vec-research.md`.
//!
//! `sqlite3_auto_extension` only affects connections opened AFTER it is
//! registered, so the test calls `register_vec_auto_extension()` BEFORE
//! `Connection::open_in_memory()`.

use rusqlite::Connection;

#[test]
fn vec0_virtual_table_creates_and_queries() {
    ccie_terminal_lib::rag::vec::register_vec_auto_extension();
    let conn = Connection::open_in_memory().unwrap();
    ccie_terminal_lib::rag::vec::enable_vec_extension(&conn).expect("load vec0");

    conn.execute_batch(
        "CREATE VIRTUAL TABLE t USING vec0(embedding float[4]);
         INSERT INTO t(rowid, embedding) VALUES
            (1, '[1,2,3,4]'),
            (2, '[4,3,2,1]');",
    )
    .unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT rowid, distance FROM t
             WHERE embedding MATCH '[1,2,3,4]'
             ORDER BY distance LIMIT 2",
        )
        .unwrap();
    let rows: Vec<(i64, f64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();

    assert_eq!(rows.len(), 2);
    // Row 1 is identical to the query so its distance must be the smallest.
    assert_eq!(rows[0].0, 1);
    assert!(
        rows[0].1 < rows[1].1,
        "expected row 1 (identical) to beat row 2; got {:?}",
        rows
    );
}

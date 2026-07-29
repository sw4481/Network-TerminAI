//! Plan 12 Phase 1 Task 1.3 — V0039 migration applies cleanly with
//! sqlite-vec registered, creating the `rag_chunks_vec` virtual table
//! plus the four regular RAG tables.

use rusqlite::Connection;

#[test]
fn migrations_apply_with_vec0() {
    ccie_terminal_lib::rag::vec::register_vec_auto_extension();
    let mut conn = Connection::open_in_memory().unwrap();
    ccie_terminal_lib::rag::vec::enable_vec_extension(&conn).unwrap();
    ccie_terminal_lib::db::apply_migrations(&mut conn).unwrap();

    // The vec0 virtual table is created by V0039 — assert it exists.
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='rag_chunks_vec'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "rag_chunks_vec virtual table missing after V0039");

    // The regular tables created by V0039 must also be present.
    for table in [
        "rag_documents",
        "rag_document_tags",
        "rag_chunks",
        "rag_queries_log",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "expected table {table} after V0039");
    }
}

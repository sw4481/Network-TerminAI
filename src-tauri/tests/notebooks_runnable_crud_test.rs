use ccie_terminal_lib::commands::notebooks_runnable::{
    delete_runnable_impl, export_markdown_impl, get_runnable_impl, import_markdown_impl,
    list_runnable_impl,
};
use rusqlite::Connection;

const FIXTURE: &str = include_str!("../src/notebooks/tests/fixtures/bgp_peer_bringup.mop.md");

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
fn import_get_export_round_trip_is_byte_stable() {
    let conn = schema();
    let id = import_markdown_impl(&conn, FIXTURE).expect("import");
    assert!(id.starts_with("nb-"));

    let dto = get_runnable_impl(&conn, &id).expect("get");
    assert_eq!(dto.frontmatter.title, "BGP Peer Bringup");
    assert_eq!(dto.frontmatter.vendor.as_deref(), Some("cisco"));
    assert!(dto.cells.iter().any(|c| matches!(
        c,
        ccie_terminal_lib::notebooks::model::NotebookCell::Assertion { .. }
    )));

    let exported = export_markdown_impl(&conn, &id).expect("export");
    assert_eq!(exported, FIXTURE, "body_markdown must round-trip byte-stable");
}

#[test]
fn list_filters_by_vendor() {
    let conn = schema();
    let id1 = import_markdown_impl(&conn, FIXTURE).unwrap();

    // Tweak the second import to a different vendor.
    let mut alt = FIXTURE.replace("vendor: cisco", "vendor: juniper");
    alt = alt.replace("BGP Peer Bringup", "BGP Peer Bringup (Juniper)");
    let id2 = import_markdown_impl(&conn, &alt).unwrap();

    let cisco = list_runnable_impl(&conn, Some("cisco"), None).unwrap();
    assert_eq!(cisco.len(), 1);
    assert_eq!(cisco[0].id, id1);

    let juniper = list_runnable_impl(&conn, Some("juniper"), None).unwrap();
    assert_eq!(juniper.len(), 1);
    assert_eq!(juniper[0].id, id2);

    let all = list_runnable_impl(&conn, None, None).unwrap();
    assert_eq!(all.len(), 2);
    // Each summary must report the cell count as > 0.
    assert!(all.iter().all(|s| s.cell_count > 0));
}

#[test]
fn delete_removes_notebook_and_cells() {
    let conn = schema();
    let id = import_markdown_impl(&conn, FIXTURE).unwrap();
    delete_runnable_impl(&conn, &id).unwrap();
    let err = get_runnable_impl(&conn, &id).unwrap_err();
    assert!(err.to_lowercase().contains("query") || err.to_lowercase().contains("no rows"));

    // Cells should also be gone (FK CASCADE).
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notebook_cells WHERE notebook_id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn cell_count_in_summary_matches_cell_rows() {
    let conn = schema();
    let id = import_markdown_impl(&conn, FIXTURE).unwrap();
    let row_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notebook_cells WHERE notebook_id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .unwrap();
    let summary = list_runnable_impl(&conn, None, None).unwrap();
    let s = summary.iter().find(|s| s.id == id).unwrap();
    assert_eq!(s.cell_count, row_count);
}

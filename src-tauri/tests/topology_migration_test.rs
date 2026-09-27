//! Plan 13 Phase 1 Task 1.1 — V0040 migration creates the topology + neighbor
//! cache tables and seeds the default "Global" graph.

use ccie_terminal_lib::db;
use tempfile::TempDir;

fn open_test_db() -> (TempDir, rusqlite::Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

#[test]
fn v0040_seeds_global_graph() {
    let (_dir, conn) = open_test_db();

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM topology_graphs WHERE name='Global'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "expected the seeded 'Global' topology_graphs row");
}

#[test]
fn v0040_creates_all_tables() {
    let (_dir, conn) = open_test_db();

    for table in [
        "topology_graphs",
        "topology_nodes",
        "topology_edges",
        "neighbor_cache",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "expected table {table} after V0040");
    }
}

#[test]
fn v0040_cascade_delete_removes_nodes_and_edges() {
    let (_dir, conn) = open_test_db();
    // Sanity: open_and_migrate already enables PRAGMA foreign_keys = ON.
    // Seed two nodes and one edge against the seeded Global graph.
    let g = "00000000-0000-0000-0000-0000000000g1";
    conn.execute(
        "INSERT INTO topology_nodes (graph_id, device_ref, device_kind, label) VALUES (?1, 'R1', 'ssh', 'R1')",
        [g],
    ).unwrap();
    conn.execute(
        "INSERT INTO topology_nodes (graph_id, device_ref, device_kind, label) VALUES (?1, 'R2', 'discovered', 'R2')",
        [g],
    ).unwrap();
    conn.execute(
        "INSERT INTO topology_edges (graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol)
         VALUES (?1, 'R1', 'Gi0/1', 'R2', 'Gi0/2', 'cdp')",
        [g],
    ).unwrap();

    // Delete the parent graph row.
    conn.execute("DELETE FROM topology_graphs WHERE id = ?1", [g]).unwrap();

    let nodes: i64 = conn.query_row(
        "SELECT COUNT(*) FROM topology_nodes WHERE graph_id = ?1",
        [g],
        |r| r.get(0),
    ).unwrap();
    let edges: i64 = conn.query_row(
        "SELECT COUNT(*) FROM topology_edges WHERE graph_id = ?1",
        [g],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(nodes, 0, "expected ON DELETE CASCADE to remove topology_nodes");
    assert_eq!(edges, 0, "expected ON DELETE CASCADE to remove topology_edges");
}

#[test]
fn v0040_creates_expected_indexes() {
    let (_dir, conn) = open_test_db();
    for idx in [
        "idx_topo_nodes_graph",
        "idx_topo_edges_graph",
        "idx_topo_edges_proto",
        "idx_neighbor_cache_captured",
    ] {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name = ?1",
            [idx],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(n, 1, "expected index {idx} after V0040");
    }
}

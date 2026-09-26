//! Plan 13 Phase 1.3 — graph CRUD + edge canonicalisation coverage.

use ccie_terminal_lib::db;
use ccie_terminal_lib::topology::{
    graph, TopologyEdge, TopologyNode, GLOBAL_GRAPH_ID,
};
use rusqlite::Connection;
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

#[test]
fn create_and_list_graphs_includes_seeded_global() {
    let (_dir, conn) = open_test_db();

    // Seeded by the migration, must appear in list_graphs.
    let initial = graph::list_graphs(&conn).unwrap();
    assert!(
        initial.iter().any(|g| g.id == GLOBAL_GRAPH_ID),
        "Global graph must be seeded by V0040: {initial:?}"
    );

    graph::create_graph(&conn, "lab-1", "Lab 1", Some("east-coast lab")).unwrap();
    let graphs = graph::list_graphs(&conn).unwrap();
    assert!(graphs.iter().any(|g| g.id == "lab-1"));

    let fetched = graph::get_graph(&conn, "lab-1").unwrap().unwrap();
    assert_eq!(fetched.name, "Lab 1");
    assert_eq!(fetched.description.as_deref(), Some("east-coast lab"));
}

#[test]
fn delete_graph_cascades_nodes_and_edges() {
    let (_dir, conn) = open_test_db();
    graph::create_graph(&conn, "lab-1", "Lab 1", None).unwrap();

    graph::upsert_node(
        &conn,
        &TopologyNode {
            graph_id: "lab-1".into(),
            device_ref: "R1".into(),
            device_kind: "ssh".into(),
            label: "R1".into(),
            vendor: None,
            platform: None,
            mgmt_ip: None,
        },
    )
    .unwrap();
    graph::upsert_node(
        &conn,
        &TopologyNode {
            graph_id: "lab-1".into(),
            device_ref: "R2".into(),
            device_kind: "discovered".into(),
            label: "R2".into(),
            vendor: None,
            platform: None,
            mgmt_ip: None,
        },
    )
    .unwrap();
    graph::upsert_edge(
        &conn,
        &TopologyEdge {
            graph_id: "lab-1".into(),
            a_device_ref: "R1".into(),
            a_port: "Gi0/1".into(),
            b_device_ref: "R2".into(),
            b_port: "Gi0/2".into(),
            protocol: "cdp".into(),
            captured_at: 0,
        },
    )
    .unwrap();

    assert_eq!(graph::list_nodes(&conn, "lab-1").unwrap().len(), 2);
    assert_eq!(graph::list_edges(&conn, "lab-1").unwrap().len(), 1);

    graph::delete_graph(&conn, "lab-1").unwrap();
    assert_eq!(graph::list_nodes(&conn, "lab-1").unwrap().len(), 0);
    assert_eq!(graph::list_edges(&conn, "lab-1").unwrap().len(), 0);
    assert!(graph::get_graph(&conn, "lab-1").unwrap().is_none());
}

#[test]
fn upsert_edge_canonicalises_direction() {
    let (_dir, conn) = open_test_db();
    let g = GLOBAL_GRAPH_ID;

    // Both observations of the same physical link, captured from each end.
    let edge_from_r2 = TopologyEdge {
        graph_id: g.into(),
        a_device_ref: "R2".into(),
        a_port: "Gi0/2".into(),
        b_device_ref: "R1".into(),
        b_port: "Gi0/1".into(),
        protocol: "cdp".into(),
        captured_at: 0,
    };
    let edge_from_r1 = TopologyEdge {
        graph_id: g.into(),
        a_device_ref: "R1".into(),
        a_port: "Gi0/1".into(),
        b_device_ref: "R2".into(),
        b_port: "Gi0/2".into(),
        protocol: "cdp".into(),
        captured_at: 0,
    };

    graph::upsert_edge(&conn, &edge_from_r2).unwrap();
    graph::upsert_edge(&conn, &edge_from_r1).unwrap();

    let edges = graph::list_edges(&conn, g).unwrap();
    assert_eq!(edges.len(), 1, "bidirectional observations must collapse");
    assert_eq!(edges[0].a_device_ref, "R1", "R1 < R2 lexicographically");
    assert_eq!(edges[0].a_port, "Gi0/1");
    assert_eq!(edges[0].b_device_ref, "R2");
    assert_eq!(edges[0].b_port, "Gi0/2");
}

#[test]
fn upsert_edge_keeps_parallel_links_distinct() {
    let (_dir, conn) = open_test_db();
    let g = GLOBAL_GRAPH_ID;

    // Two parallel links between the same device pair must remain
    // distinct because the PK includes the port columns.
    graph::upsert_edge(
        &conn,
        &TopologyEdge {
            graph_id: g.into(),
            a_device_ref: "R1".into(),
            a_port: "Gi0/1".into(),
            b_device_ref: "R2".into(),
            b_port: "Gi0/2".into(),
            protocol: "cdp".into(),
            captured_at: 0,
        },
    )
    .unwrap();
    graph::upsert_edge(
        &conn,
        &TopologyEdge {
            graph_id: g.into(),
            a_device_ref: "R1".into(),
            a_port: "Gi0/3".into(),
            b_device_ref: "R2".into(),
            b_port: "Gi0/4".into(),
            protocol: "cdp".into(),
            captured_at: 0,
        },
    )
    .unwrap();

    let edges = graph::list_edges(&conn, g).unwrap();
    assert_eq!(edges.len(), 2, "parallel links must not collapse");
}

#[test]
fn upsert_node_replaces_metadata() {
    let (_dir, conn) = open_test_db();
    let n1 = TopologyNode {
        graph_id: GLOBAL_GRAPH_ID.into(),
        device_ref: "R1".into(),
        device_kind: "ssh".into(),
        label: "R1".into(),
        vendor: None,
        platform: None,
        mgmt_ip: None,
    };
    graph::upsert_node(&conn, &n1).unwrap();

    let n2 = TopologyNode {
        graph_id: GLOBAL_GRAPH_ID.into(),
        device_ref: "R1".into(),
        device_kind: "ssh".into(),
        label: "Router-1".into(),
        vendor: Some("cisco".into()),
        platform: Some("ISR4451".into()),
        mgmt_ip: Some("10.0.0.1".into()),
    };
    graph::upsert_node(&conn, &n2).unwrap();

    let nodes = graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap();
    let r1 = nodes.iter().find(|n| n.device_ref == "R1").unwrap();
    assert_eq!(r1.label, "Router-1");
    assert_eq!(r1.vendor.as_deref(), Some("cisco"));
    assert_eq!(r1.mgmt_ip.as_deref(), Some("10.0.0.1"));
}

#[test]
fn clear_graph_preserves_graph_row() {
    let (_dir, conn) = open_test_db();
    graph::create_graph(&conn, "lab-1", "Lab 1", None).unwrap();
    graph::upsert_node(
        &conn,
        &TopologyNode {
            graph_id: "lab-1".into(),
            device_ref: "R1".into(),
            device_kind: "ssh".into(),
            label: "R1".into(),
            vendor: None,
            platform: None,
            mgmt_ip: None,
        },
    )
    .unwrap();

    graph::clear_graph(&conn, "lab-1").unwrap();
    assert_eq!(graph::list_nodes(&conn, "lab-1").unwrap().len(), 0);
    assert!(graph::get_graph(&conn, "lab-1").unwrap().is_some());
}

//! Plan 13 Phase 1.3 — integration coverage for `topology::ingest`.
//!
//! These tests exercise the SQL pipeline end-to-end against a fresh
//! migrated DB; they do NOT spawn the Python sidecar (the parser/normaliser
//! has its own pytest coverage in Phase 1.2).

use ccie_terminal_lib::db;
use ccie_terminal_lib::topology::{
    cache, graph, ingest, NeighborRecord, GLOBAL_GRAPH_ID,
};
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

fn cdp_record(local_port: &str, neighbor_name: &str, neighbor_port: &str) -> NeighborRecord {
    NeighborRecord {
        protocol: "cdp".into(),
        local_port: local_port.into(),
        neighbor_name: neighbor_name.into(),
        neighbor_port: neighbor_port.into(),
        neighbor_mgmt_ip: Some("10.0.0.2".into()),
        neighbor_platform: Some("ISR4451".into()),
        neighbor_vendor: Some("cisco".into()),
        capabilities: vec!["Router".into()],
    }
}

#[test]
fn ingest_writes_cache_and_global_graph() {
    let (_dir, conn) = open_test_db();

    let records = vec![cdp_record("Gi0/1", "R2", "Gi0/2")];

    let summary = ingest::ingest_neighbors(
        &conn,
        "R1",
        "ssh",
        "show cdp neighbors detail",
        "<<raw cdp output>>",
        &records,
    )
    .unwrap();

    assert_eq!(summary.nodes_added, 1, "one neighbor in batch");
    assert_eq!(summary.edges_added, 1);
    assert!(summary.cache_updated);

    // 1. neighbor_cache row exists with parsed_json containing neighbor name.
    let row = cache::get_neighbor_cache(&conn, "R1", "ssh", "show cdp neighbors detail")
        .unwrap()
        .expect("neighbor_cache row missing");
    assert!(
        row.parsed_json.contains("R2"),
        "parsed_json should contain neighbor name; got: {}",
        row.parsed_json
    );

    // 2. Global graph has 2 nodes (R1 source + R2 neighbor) and 1 edge.
    let nodes = graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap();
    let refs: Vec<&str> = nodes.iter().map(|n| n.device_ref.as_str()).collect();
    assert!(refs.contains(&"R1"), "expected R1 source node, got {refs:?}");
    // Neighbor should be canonicalised to its mgmt_ip (10.0.0.2) since
    // ingest prefers mgmt_ip over hostname when present.
    assert!(
        refs.contains(&"10.0.0.2"),
        "expected neighbor by mgmt_ip 10.0.0.2, got {refs:?}"
    );
    assert_eq!(nodes.len(), 2);

    let edges = graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].protocol, "cdp");
}

#[test]
fn ingest_promotes_kind_via_ssh_connections_lookup() {
    let (_dir, conn) = open_test_db();

    // Seed an ssh_connections row whose `host` matches the neighbor's mgmt_ip
    // so promotion picks `ssh` instead of `discovered`.
    conn.execute(
        "INSERT INTO ssh_connections(name, host, user, port) VALUES (?1, ?2, ?3, ?4)",
        params!["lab-r2", "10.0.0.2", "admin", 22],
    )
    .unwrap();

    let records = vec![cdp_record("Gi0/1", "R2", "Gi0/2")];
    ingest::ingest_neighbors(
        &conn,
        "R1",
        "ssh",
        "show cdp neighbors detail",
        "<<raw>>",
        &records,
    )
    .unwrap();

    let nodes = graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap();
    let neighbor = nodes
        .iter()
        .find(|n| n.device_ref == "10.0.0.2")
        .expect("neighbor node missing");
    assert_eq!(neighbor.device_kind, "ssh", "promotion should pick ssh");
}

#[test]
fn ingest_promotes_kind_when_only_hostname_matches() {
    let (_dir, conn) = open_test_db();

    // Seed an ssh_connections row keyed by HOSTNAME (not IP). The neighbor
    // advertises BOTH mgmt_ip ("10.0.0.5") and hostname ("R5"); ingest
    // canonicalises the device_ref to the IP, but promotion must still
    // recognise the saved connection by hostname.
    conn.execute(
        "INSERT INTO ssh_connections(name, host, user, port) VALUES (?1, ?2, ?3, ?4)",
        params!["lab-r5", "R5", "admin", 22],
    )
    .unwrap();

    let mut rec = cdp_record("Gi0/1", "R5", "Gi0/2");
    rec.neighbor_mgmt_ip = Some("10.0.0.5".into());
    let records = vec![rec];

    ingest::ingest_neighbors(
        &conn,
        "R1",
        "ssh",
        "show cdp neighbors detail",
        "<<raw>>",
        &records,
    )
    .unwrap();

    let nodes = graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap();
    // device_ref is canonicalised to mgmt_ip, but device_kind should still
    // be promoted to "ssh" via the hostname match.
    let neighbor = nodes
        .iter()
        .find(|n| n.device_ref == "10.0.0.5")
        .expect("neighbor node by mgmt_ip missing");
    assert_eq!(
        neighbor.device_kind, "ssh",
        "promotion should match on hostname even when device_ref is the IP"
    );
}

#[test]
fn ingest_falls_back_to_discovered_when_unknown() {
    let (_dir, conn) = open_test_db();

    let mut rec = cdp_record("Gi0/1", "R2", "Gi0/2");
    rec.neighbor_mgmt_ip = None; // force lookup against neighbor_name
    let records = vec![rec];

    ingest::ingest_neighbors(
        &conn,
        "R1",
        "ssh",
        "show cdp neighbors detail",
        "<<raw>>",
        &records,
    )
    .unwrap();

    let nodes = graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap();
    let neighbor = nodes
        .iter()
        .find(|n| n.device_ref == "R2")
        .expect("neighbor node by hostname missing");
    assert_eq!(neighbor.device_kind, "discovered");
}

#[test]
fn ingest_is_idempotent_on_repeated_calls() {
    let (_dir, conn) = open_test_db();
    let records = vec![cdp_record("Gi0/1", "R2", "Gi0/2")];

    for _ in 0..3 {
        ingest::ingest_neighbors(
            &conn,
            "R1",
            "ssh",
            "show cdp neighbors detail",
            "<<raw>>",
            &records,
        )
        .unwrap();
    }

    let nodes = graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap();
    let edges = graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(nodes.len(), 2, "repeated ingest should not duplicate nodes");
    assert_eq!(edges.len(), 1, "repeated ingest should not duplicate edges");
}

#[test]
fn ingest_routing_protocols_substitute_port_placeholders() {
    // Plan 13 Phase 5 Task 5.2 — BGP/OSPF/IS-IS records lack one or both
    // ports. The ingest layer must substitute `peer:<...>` placeholders so
    // the canonical edge primary key stays unique across multiple peers.
    let (_dir, conn) = open_test_db();

    let bgp_a = NeighborRecord {
        protocol: "bgp".into(),
        local_port: "".into(),
        neighbor_name: "10.0.0.2".into(),
        neighbor_port: "".into(),
        neighbor_mgmt_ip: Some("10.0.0.2".into()),
        neighbor_platform: None,
        neighbor_vendor: None,
        capabilities: vec![],
    };
    let bgp_b = NeighborRecord {
        protocol: "bgp".into(),
        local_port: "".into(),
        neighbor_name: "10.0.0.3".into(),
        neighbor_port: "".into(),
        neighbor_mgmt_ip: Some("10.0.0.3".into()),
        neighbor_platform: None,
        neighbor_vendor: None,
        capabilities: vec![],
    };

    ingest::ingest_neighbors(
        &conn,
        "R1",
        "ssh",
        "show ip bgp summary",
        "<raw>",
        &[bgp_a, bgp_b],
    )
    .unwrap();

    let edges = graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(edges.len(), 2, "two distinct BGP peers must produce two edges");
    let mut ports: Vec<String> = edges
        .iter()
        .flat_map(|e| vec![e.a_port.clone(), e.b_port.clone()])
        .collect();
    ports.sort();
    // Each edge should have one peer:<source> port and one peer:<peer_ip> port.
    assert!(
        ports.iter().filter(|p| p.starts_with("peer:")).count() == 4,
        "all four port slots must be peer:<...> placeholders, got {:?}",
        ports,
    );
    assert!(ports.iter().any(|p| p == "peer:R1"));
    assert!(ports.iter().any(|p| p == "peer:10.0.0.2"));
    assert!(ports.iter().any(|p| p == "peer:10.0.0.3"));
    let protocols: Vec<&str> = edges.iter().map(|e| e.protocol.as_str()).collect();
    assert!(protocols.iter().all(|p| *p == "bgp"));
}

#[test]
fn ingest_ospf_substitutes_only_neighbor_port_placeholder() {
    // OSPF reports the local interface but not the neighbor's port. The
    // local_port should be preserved as-is; only neighbor_port gets
    // substituted with `peer:<source_device_ref>`.
    let (_dir, conn) = open_test_db();

    let ospf = NeighborRecord {
        protocol: "ospf".into(),
        local_port: "GigabitEthernet0/0/0".into(),
        neighbor_name: "172.18.197.242".into(),
        neighbor_port: "".into(),
        neighbor_mgmt_ip: Some("172.19.197.93".into()),
        neighbor_platform: None,
        neighbor_vendor: None,
        capabilities: vec![],
    };

    ingest::ingest_neighbors(
        &conn,
        "R1",
        "ssh",
        "show ip ospf neighbor",
        "<raw>",
        &[ospf],
    )
    .unwrap();

    let edges = graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(edges.len(), 1);
    let e = &edges[0];
    // Edge canonicalisation may swap a/b; make the assertion direction-
    // agnostic by collecting the (port, ref) pairs.
    let pairs = vec![
        (e.a_device_ref.clone(), e.a_port.clone()),
        (e.b_device_ref.clone(), e.b_port.clone()),
    ];
    assert!(
        pairs.iter().any(|(r, p)| r == "R1" && p == "GigabitEthernet0/0/0"),
        "R1's local interface must be preserved, got {:?}",
        pairs,
    );
    assert!(
        pairs
            .iter()
            .any(|(_, p)| p == "peer:R1"),
        "neighbor's port must be substituted with peer:R1, got {:?}",
        pairs,
    );
    assert_eq!(e.protocol, "ospf");
}

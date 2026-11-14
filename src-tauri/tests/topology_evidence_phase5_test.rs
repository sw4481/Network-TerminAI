use ccie_terminal_lib::{
    db,
    topology::{graph, ingest, NeighborRecord, TopologyNode, GLOBAL_GRAPH_ID},
};
use rusqlite::Connection;
use serde_json::{json, Value};

fn database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("synthetic.db")).unwrap();
    (dir, conn)
}
fn source() -> TopologyNode {
    TopologyNode {
        graph_id: GLOBAL_GRAPH_ID.into(),
        device_ref: "192.0.2.1".into(),
        device_kind: "ssh".into(),
        label: "source".into(),
        vendor: None,
        platform: None,
        mgmt_ip: None,
    }
}
fn record(state: &str, established: bool, peer: &str) -> NeighborRecord {
    serde_json::from_value(json!({
        "protocol":"bgp", "local_port":"", "neighbor_name":peer,
        "neighbor_port":"", "neighbor_mgmt_ip":null,
        "neighbor_platform":null, "neighbor_vendor":null, "capabilities":[],
        "routing":{"state":state, "established":established, "peer_address":peer,
            "vrf":"default", "address_family":"ipv4 unicast", "instance":null,
            "level":null,"scope_supported":true}
    }))
    .unwrap()
}
fn snapshot(conn: &Connection) -> Value {
    serde_json::to_value(graph::snapshot(conn, GLOBAL_GRAPH_ID).unwrap()).unwrap()
}
#[test]
fn eigrp_migration_preserves_existing_receipts_and_attempt_authority() {
    use ccie_terminal_lib::topology::evidence::CaptureEvidence;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("upgrade.db");
    let mut conn = db::open_and_migrate_to(&path, 100).unwrap();
    let old = json!({"source_ref":"saved", "protocol":"cdp", "source_command":"show cdp neighbors detail", "attempted_at":123, "status":"failed", "observations":[]}).to_string();
    conn.execute(
        "INSERT INTO topology_capture_evidence(graph_id,source_ref,protocol,source_command,attempt_id,evidence_json) VALUES(?1,'saved','cdp','show cdp neighbors detail','preserved-owner',?2)",
        rusqlite::params![GLOBAL_GRAPH_ID, old],
    ).unwrap();
    db::apply_migrations(&mut conn).unwrap();
    let retained: String = conn.query_row(
        "SELECT evidence_json FROM topology_capture_evidence WHERE source_ref='saved'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(retained, old);
    CaptureEvidence::require_owner(&conn, GLOBAL_GRAPH_ID, "saved", "show cdp neighbors detail", "preserved-owner").unwrap();
    CaptureEvidence::attempt(&conn, GLOBAL_GRAPH_ID, "saved", "show ip eigrp neighbors", "incomplete").unwrap();
    assert!(conn.execute(
        "INSERT INTO topology_capture_evidence(graph_id,source_ref,protocol,source_command,evidence_json) VALUES(?1,'saved','rip','unsupported','{}')",
        [GLOBAL_GRAPH_ID],
    ).is_err());
    drop(conn);
    let conn = db::open_and_migrate(&path).unwrap();
    assert_eq!(CaptureEvidence::list(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 2);
    conn.execute("DELETE FROM topology_graphs WHERE id=?1", [GLOBAL_GRAPH_ID]).unwrap();
    assert!(CaptureEvidence::list(&conn, GLOBAL_GRAPH_ID).unwrap().is_empty());
}

#[test]
fn eigrp_preserves_as_identity_scope_history_and_never_creates_management_targets() {
    use ccie_terminal_lib::topology::evidence::CaptureEvidence;
    let (_dir, conn) = database();
    let src = source();
    let command = "show ip eigrp neighbors";
    let rows: Vec<NeighborRecord> = ["100", "200", "300"].into_iter().map(|instance| {
        let mut row = record("up", true, "192.0.2.2");
        row.protocol = "eigrp".into();
        row.local_port = "GigabitEthernet1".into();
        let routing = row.routing.as_mut().unwrap();
        routing.instance = Some(instance.into());
        if instance == "300" {
            routing.vrf = Some("blue".into());
            routing.scope_supported = false;
        }
        row
    }).collect();
    let token = CaptureEvidence::attempt(&conn, &src.graph_id, &src.device_ref, command, "incomplete").unwrap();
    let result = ingest::ingest_owned_capture(&conn, &src, command, "synthetic", &rows, &token).unwrap();
    assert_eq!(result.edges_added, 2, "unsupported VRF remains evidence only");
    let peers: Vec<_> = graph::list_nodes(&conn, &src.graph_id).unwrap().into_iter()
        .filter(|node| node.device_ref != src.device_ref).collect();
    assert_eq!(peers.len(), 2, "same peer in different AS must not merge");
    assert!(peers.iter().all(|node| node.device_ref.starts_with("routing:") && node.mgmt_ip.is_none() && node.device_kind == "discovered"));
    let edges = graph::list_edges(&conn, &src.graph_id).unwrap();
    assert!(edges.iter().all(|edge| edge.protocol == "eigrp" && (edge.a_port == "GigabitEthernet1" || edge.b_port == "GigabitEthernet1")));
    let receipts = CaptureEvidence::list(&conn, &src.graph_id).unwrap();
    assert_eq!(receipts[0].protocol, "eigrp");
    assert_eq!(receipts[0].observations.len(), 3);
    conn.execute("UPDATE topology_edges SET captured_at=123", []).unwrap();
    let failed = CaptureEvidence::attempt(&conn, &src.graph_id, &src.device_ref, command, "incomplete").unwrap();
    CaptureEvidence::finish(&conn, &src.graph_id, &src.device_ref, command, &failed, "failed").unwrap();
    let receipts = CaptureEvidence::list(&conn, &src.graph_id).unwrap();
    assert_eq!(receipts[0].status, "failed");
    assert_eq!(receipts[0].observations.len(), 3);
    let empty = CaptureEvidence::attempt(&conn, &src.graph_id, &src.device_ref, command, "incomplete").unwrap();
    ingest::ingest_owned_capture(&conn, &src, command, "synthetic empty", &[], &empty).unwrap();
    let receipts = CaptureEvidence::list(&conn, &src.graph_id).unwrap();
    assert_eq!(receipts[0].status, "completed");
    assert!(receipts[0].observations.iter().all(|row| !row.in_latest_capture));
    assert!(graph::list_edges(&conn, &src.graph_id).unwrap().iter().all(|edge| edge.captured_at == 123));
}

#[test]
fn prefix_count_and_state_changes_replace_latest_peer_evidence_not_identity_history() {
    let (_dir, conn) = database();
    for state in ["0", "1", "200", "Idle", "Established"] {
        ingest::ingest_neighbors_into_graph(
            &conn,
            &source(),
            "show ip bgp summary",
            state,
            &[record(state, state != "Idle", "192.0.2.2")],
        )
        .unwrap();
        let snap = snapshot(&conn);
        let observations = snap["capture_evidence"][0]["observations"]
            .as_array()
            .unwrap();
        assert_eq!(observations.len(), 1, "state is not peer identity");
        assert_eq!(observations[0]["record"]["routing"]["state"], state);
        assert_eq!(observations[0]["in_latest_capture"], true);
    }
}

#[test]
fn idle_is_retained_as_evidence_but_not_an_adjacency_or_management_target() {
    let (_dir, conn) = database();
    let summary = ingest::ingest_neighbors_into_graph(
        &conn,
        &source(),
        "show ip bgp summary",
        "synthetic",
        &[
            record("Idle", false, "192.0.2.2"),
            record("0", true, "192.0.2.3"),
        ],
    )
    .unwrap();
    assert_eq!(
        summary.edges_added, 1,
        "Idle is not an established adjacency"
    );
    let snap = snapshot(&conn);
    assert_eq!(
        snap["capture_evidence"][0]["observations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let nodes = graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap();
    let peer = nodes
        .iter()
        .find(|n| n.device_ref != source().device_ref)
        .unwrap();
    assert!(peer.device_ref.starts_with("routing:"));
    assert!(peer.mgmt_ip.is_none());
    assert_eq!(peer.device_kind, "discovered");
    let edge = &graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap()[0];
    assert!(edge.a_port.starts_with("peer:") && edge.b_port.starts_with("peer:"));
}
#[test]
fn empty_success_retains_history_and_does_not_refresh_old_edge_time() {
    let (_dir, conn) = database();
    let src = source();
    ingest::ingest_neighbors_into_graph(
        &conn,
        &src,
        "show ip bgp summary",
        "first",
        &[record("Established", true, "192.0.2.2")],
    )
    .unwrap();
    conn.execute("UPDATE topology_edges SET captured_at=123", [])
        .unwrap();
    ingest::ingest_neighbors_into_graph(&conn, &src, "show ip bgp summary", "empty", &[]).unwrap();
    let snap = snapshot(&conn);
    assert_eq!(snap["edges"].as_array().unwrap().len(), 1);
    assert_eq!(snap["edges"][0]["captured_at"], 123);
    assert_eq!(snap["capture_evidence"][0]["status"], "completed");
    assert_eq!(
        snap["capture_evidence"][0]["observations"][0]["in_latest_capture"],
        false
    );
}
#[test]
fn scoped_routing_contexts_and_alias_conflicts_never_merge_with_l2() {
    let (_dir, conn) = database();
    let src = source();
    let mut unsupported = serde_json::to_value(record("Established", true, "192.0.2.2")).unwrap();
    unsupported["routing"]["vrf"] = json!("blue");
    unsupported["routing"]["scope_supported"] = json!(false);
    let unsupported: NeighborRecord = serde_json::from_value(unsupported).unwrap();
    ingest::ingest_neighbors_into_graph(
        &conn,
        &src,
        "show ip bgp summary",
        "synthetic",
        &[unsupported],
    )
    .unwrap();
    assert!(graph::list_edges(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
    for name in ["switch.a.example", "switch.b.example"] {
        let row = serde_json::from_value(json!({"protocol":"cdp","local_port":"Gi1","neighbor_name":name,"neighbor_port":"Gi2","neighbor_mgmt_ip":"192.0.2.2","neighbor_platform":null,"neighbor_vendor":null})).unwrap();
        ingest::ingest_neighbors_into_graph(
            &conn,
            &src,
            "show cdp neighbors detail",
            "synthetic",
            &[row],
        )
        .unwrap();
    }
    let snap = snapshot(&conn);
    let captures = snap["capture_evidence"].as_array().unwrap();
    let l2 = captures.iter().find(|c| c["protocol"] == "cdp").unwrap();
    assert_eq!(
        l2["observations"].as_array().unwrap().len(),
        2,
        "conflicting full aliases stay distinct"
    );
    assert_eq!(graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 1);
}

#[test]
fn failed_and_incomplete_receipts_retain_last_seen_times_across_reopen() {
    use ccie_terminal_lib::topology::evidence::CaptureEvidence;
    let (dir, conn) = database();
    let src = source();
    ingest::ingest_neighbors_into_graph(
        &conn,
        &src,
        "show ip bgp summary",
        "synthetic",
        &[record("Established", true, "192.0.2.2")],
    )
    .unwrap();
    let old = snapshot(&conn)["capture_evidence"][0]["observations"][0]["captured_at"].clone();
    for status in ["failed", "unsupported", "incomplete"] {
        CaptureEvidence::attempt(
            &conn,
            GLOBAL_GRAPH_ID,
            &src.device_ref,
            "show ip bgp summary",
            status,
        )
        .unwrap();
        let receipt = &snapshot(&conn)["capture_evidence"][0];
        assert_eq!(receipt["status"], status);
        assert_eq!(receipt["observations"][0]["captured_at"], old);
        assert_eq!(graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 1);
    }
    drop(conn);
    let conn = db::open_and_migrate(&dir.path().join("synthetic.db")).unwrap();
    assert_eq!(
        snapshot(&conn)["capture_evidence"][0]["status"],
        "incomplete"
    );
    assert_eq!(
        snapshot(&conn)["capture_evidence"][0]["observations"][0]["captured_at"],
        old
    );
}

#[test]
fn receipt_graph_scope_clear_delete_and_late_failure_are_atomic() {
    use ccie_terminal_lib::topology::evidence::CaptureEvidence;
    let (_dir, conn) = database();
    graph::create_graph(&conn, "other", "other", None).unwrap();
    let src = source();
    ingest::ingest_neighbors_into_graph(
        &conn,
        &src,
        "show ip bgp summary",
        "first",
        &[record("Established", true, "192.0.2.2")],
    )
    .unwrap();
    let before = snapshot(&conn);
    assert!(CaptureEvidence::list(&conn, "other").unwrap().is_empty());
    conn.execute_batch("CREATE TRIGGER synthetic_receipt_failure BEFORE UPDATE ON topology_capture_evidence BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    assert!(ingest::ingest_neighbors_into_graph(
        &conn,
        &src,
        "show ip bgp summary",
        "second",
        &[record("Established", true, "192.0.2.3")]
    )
    .is_err());
    assert_eq!(snapshot(&conn), before);
    conn.execute_batch("DROP TRIGGER synthetic_receipt_failure")
        .unwrap();
    graph::clear_graph(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert!(CaptureEvidence::list(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
    let mut other = src;
    other.graph_id = "other".into();
    ingest::ingest_neighbors_into_graph(
        &conn,
        &other,
        "show ip bgp summary",
        "synthetic",
        &[record("Idle", false, "192.0.2.2")],
    )
    .unwrap();
    graph::delete_graph(&conn, "other").unwrap();
    assert!(CaptureEvidence::list(&conn, "other").unwrap().is_empty());
}

#[test]
fn receipt_size_limit_rolls_back_cache_and_graph_without_discarding_history() {
    let (_dir, conn) = database();
    let src = source();
    ingest::ingest_neighbors_into_graph(
        &conn,
        &src,
        "show ip bgp summary",
        "first",
        &[record("Established", true, "192.0.2.2")],
    )
    .unwrap();
    let before = snapshot(&conn);
    let huge = record("Idle", false, &"x".repeat(2 * 1024 * 1024));
    assert!(ingest::ingest_neighbors_into_graph(
        &conn,
        &src,
        "show ip bgp summary",
        "second",
        &[huge]
    )
    .is_err());
    assert_eq!(snapshot(&conn), before);
    let raw: String = conn
        .query_row(
            "SELECT raw_output FROM neighbor_cache WHERE source_cmd='show ip bgp summary'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(raw, "first");
    ingest::ingest_neighbors_into_graph(
        &conn,
        &src,
        "show ip bgp summary",
        "recovered",
        &[record("42", true, "192.0.2.2")],
    )
    .unwrap();
    assert_eq!(
        snapshot(&conn)["capture_evidence"][0]["observations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn superseded_collector_cannot_commit_cache_graph_receipt_or_terminal_outcome() {
    use ccie_terminal_lib::topology::evidence::CaptureEvidence;
    let (_dir, conn) = database();
    let src = source();
    let command = "show ip bgp summary";
    let old = CaptureEvidence::attempt(
        &conn,
        GLOBAL_GRAPH_ID,
        &src.device_ref,
        command,
        "incomplete",
    )
    .unwrap();
    let current = CaptureEvidence::attempt(
        &conn,
        GLOBAL_GRAPH_ID,
        &src.device_ref,
        command,
        "incomplete",
    )
    .unwrap();
    assert_ne!(old, current);
    ingest::ingest_owned_capture(
        &conn,
        &src,
        command,
        "newer",
        &[record("42", true, "192.0.2.2")],
        &current,
    )
    .unwrap();
    let before = snapshot(&conn);
    assert!(ingest::ingest_owned_capture(
        &conn,
        &src,
        command,
        "older",
        &[record("Idle", false, "192.0.2.3")],
        &old
    )
    .is_err());
    assert!(CaptureEvidence::finish(
        &conn,
        GLOBAL_GRAPH_ID,
        &src.device_ref,
        command,
        &old,
        "failed"
    )
    .is_err());
    assert!(CaptureEvidence::finish(
        &conn,
        GLOBAL_GRAPH_ID,
        &src.device_ref,
        command,
        &old,
        "unsupported"
    )
    .is_err());
    assert_eq!(snapshot(&conn), before);
    let raw: String = conn
        .query_row(
            "SELECT raw_output FROM neighbor_cache WHERE source_cmd=?1",
            [command],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(raw, "newer");
    assert!(CaptureEvidence::finish(
        &conn,
        GLOBAL_GRAPH_ID,
        &src.device_ref,
        "show ip ospf neighbor",
        &current,
        "failed"
    )
    .is_err());
    let next = CaptureEvidence::attempt(
        &conn,
        GLOBAL_GRAPH_ID,
        &src.device_ref,
        command,
        "incomplete",
    )
    .unwrap();
    CaptureEvidence::finish(
        &conn,
        GLOBAL_GRAPH_ID,
        &src.device_ref,
        command,
        &next,
        "failed",
    )
    .unwrap();
    assert_eq!(snapshot(&conn)["capture_evidence"][0]["status"], "failed");
}

#[test]
fn repeated_full_capture_state_churn_stays_bounded_and_refreshable() {
    let (_dir, conn) = database();
    for state in ["1", "2", "3", "4", "5", "6"] {
        let records: Vec<_> = (0..1200)
            .map(|n| record(state, true, &format!("198.18.{}.{}", n / 256, n % 256)))
            .collect();
        ingest::ingest_neighbors_into_graph(
            &conn,
            &source(),
            "show ip bgp summary",
            state,
            &records,
        )
        .unwrap();
        let snap = snapshot(&conn);
        let observations = snap["capture_evidence"][0]["observations"]
            .as_array()
            .unwrap();
        assert_eq!(observations.len(), 1200);
        assert!(observations
            .iter()
            .all(|o| o["record"]["routing"]["state"] == state && o["in_latest_capture"] == true));
    }
}

#[test]
fn source_scoped_logical_identity_does_not_merge_duplicate_address_owners() {
    let (_dir, conn) = database();
    let mut second = source();
    second.device_ref = "192.0.2.9".into();
    for src in [source(), second] {
        ingest::ingest_neighbors_into_graph(
            &conn,
            &src,
            "show ip bgp summary",
            "synthetic",
            &[record("Established", true, "192.0.2.2")],
        )
        .unwrap();
    }
    let peers: Vec<_> = graph::list_nodes(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .into_iter()
        .filter(|n| n.device_ref.starts_with("routing:"))
        .collect();
    assert_eq!(peers.len(), 2);
    assert!(peers
        .iter()
        .all(|n| n.mgmt_ip.is_none() && n.device_kind == "discovered"));
}

#[test]
fn direct_looking_and_multihop_or_loopback_peers_remain_logical_without_address_proof() {
    let (_dir, conn) = database();
    for peer in ["192.0.2.2", "203.0.113.99"] {
        ingest::ingest_neighbors_into_graph(
            &conn,
            &source(),
            "show ip bgp summary",
            "synthetic",
            &[record("Established", true, peer)],
        )
        .unwrap();
    }
    let edges = graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(edges.len(), 2);
    assert!(edges.iter().all(|e| e.protocol == "bgp"
        && e.a_port.starts_with("peer:")
        && e.b_port.starts_with("peer:")));
}

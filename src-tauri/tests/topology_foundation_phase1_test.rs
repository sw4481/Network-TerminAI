use ccie_terminal_lib::topology::{
    CaptureOutcome, CaptureStatus, DiscoveryStatus, DiscoverySummary, NodePosition, TopologyNode,
};
use ccie_terminal_lib::{commands::topology::DiscoveryDevice, parsers::bridge::NeighborCapture};
use ccie_terminal_lib::{
    db,
    topology::{graph, ingest, NeighborRecord, GLOBAL_GRAPH_ID},
};
use rusqlite::Connection;

fn source(graph_id: &str) -> TopologyNode {
    TopologyNode {
        graph_id: graph_id.into(),
        device_ref: "192.0.2.10".into(),
        device_kind: "ssh".into(),
        label: "synthetic display name".into(),
        vendor: Some("cisco".into()),
        platform: Some("iosxe".into()),
        mgmt_ip: Some("192.0.2.10".into()),
    }
}

fn position(device_ref: &str, x: f64, y: f64) -> NodePosition {
    NodePosition {
        device_ref: device_ref.into(),
        x,
        y,
    }
}

fn database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("topology.db")).unwrap();
    (dir, conn)
}

fn record(protocol: &str) -> NeighborRecord {
    NeighborRecord {
        protocol: protocol.into(),
        local_port: "Gi1".into(),
        neighbor_name: "synthetic-peer".into(),
        neighbor_port: "Gi2".into(),
        neighbor_mgmt_ip: None,
        neighbor_platform: None,
        neighbor_vendor: None,
        capabilities: vec![],
        routing: None,
    }
}

#[test]
fn rejected_capture_rolls_back_cache_source_and_preceding_records() {
    let (_dir, conn) = database();
    let records = [record("cdp"), record("invalid-protocol")];
    assert!(ingest::ingest_neighbors(
        &conn,
        "synthetic-source",
        "ssh",
        "show cdp neighbors detail",
        "synthetic output",
        &records
    )
    .is_err());
    let cached: i64 = conn
        .query_row("SELECT count(*) FROM neighbor_cache", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cached, 0, "rejected capture must not update cache");
    assert!(graph::list_nodes(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
    assert!(graph::list_edges(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
}

#[test]
fn fresh_database_has_graph_scoped_layout_storage() {
    let (_dir, conn) = database();
    let exists: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='topology_node_positions'", [], |r| r.get(0)).unwrap();
    assert_eq!(exists, 1, "durable topology positions table is required");
}

#[test]
fn explicit_graph_and_global_wrapper_remain_isolated() {
    let (_dir, conn) = database();
    for id in ["graph-a", "graph-b"] {
        graph::create_graph(&conn, id, id, None).unwrap();
    }
    let source = source("graph-a");
    let summary = ingest::ingest_neighbors_into_graph(
        &conn,
        &source,
        "show cdp neighbors detail",
        "synthetic",
        &[record("cdp")],
    )
    .unwrap();
    assert_eq!(summary.nodes_added, 1);
    let nodes = graph::list_nodes(&conn, "graph-a").unwrap();
    assert_eq!(nodes.len(), 2);
    assert!(graph::list_nodes(&conn, "graph-b").unwrap().is_empty());
    assert!(graph::list_nodes(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
    let saved = nodes
        .iter()
        .find(|n| n.device_ref == source.device_ref)
        .unwrap();
    assert_eq!(saved.label, source.label);
    assert_eq!(saved.vendor, source.vendor);
    assert_eq!(saved.platform, source.platform);
    ingest::ingest_neighbors(
        &conn,
        "automatic-source",
        "ssh",
        "show lldp neighbors detail",
        "synthetic",
        &[record("lldp")],
    )
    .unwrap();
    assert_eq!(graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 1);
    assert_eq!(graph::list_edges(&conn, "graph-a").unwrap().len(), 1);
    assert!(graph::list_edges(&conn, "graph-b").unwrap().is_empty());
    // Compatibility fields are processed-row counts, including a repeated observation.
    let repeat = ingest::ingest_neighbors_into_graph(
        &conn,
        &source,
        "show cdp neighbors detail",
        "synthetic",
        &[record("cdp")],
    )
    .unwrap();
    assert_eq!(repeat.nodes_added, 1);
    assert_eq!(graph::list_nodes(&conn, "graph-a").unwrap().len(), 2);
}

#[test]
fn deleted_or_invalid_destination_cannot_update_cache() {
    let (_dir, conn) = database();
    assert!(ingest::ingest_neighbors_into_graph(
        &conn,
        &source("missing"),
        "show cdp neighbors detail",
        "synthetic",
        &[]
    )
    .is_err());
    let cached: i64 = conn
        .query_row("SELECT count(*) FROM neighbor_cache", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cached, 0);
}

#[test]
fn rejected_refresh_preserves_previous_cache_and_graph() {
    let (_dir, conn) = database();
    let source = source(GLOBAL_GRAPH_ID);
    ingest::ingest_neighbors_into_graph(
        &conn,
        &source,
        "show cdp neighbors detail",
        "original",
        &[record("cdp")],
    )
    .unwrap();
    assert!(ingest::ingest_neighbors_into_graph(
        &conn,
        &source,
        "show cdp neighbors detail",
        "replacement",
        &[record("invalid")]
    )
    .is_err());
    let raw: String = conn
        .query_row("SELECT raw_output FROM neighbor_cache", [], |r| r.get(0))
        .unwrap();
    assert_eq!(raw, "original");
    assert_eq!(graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 2);
    assert_eq!(
        graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap()[0].protocol,
        "cdp"
    );
}

#[test]
fn empty_capture_persists_source_and_cache_without_deleting_historical_links() {
    let (_dir, conn) = database();
    let source = source(GLOBAL_GRAPH_ID);
    ingest::ingest_neighbors_into_graph(
        &conn,
        &source,
        "show cdp neighbors detail",
        "synthetic",
        &[record("cdp")],
    )
    .unwrap();
    let summary = ingest::ingest_neighbors_into_graph(
        &conn,
        &source,
        "show cdp neighbors detail",
        "Total cdp entries displayed : 0",
        &[],
    )
    .unwrap();
    assert_eq!(summary.nodes_added, 0);
    assert!(summary.cache_updated);
    assert_eq!(graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 1);
}

#[test]
fn layout_round_trips_and_is_scoped_by_graph_reference_not_kind() {
    let (dir, conn) = database();
    for id in ["a", "b"] {
        graph::create_graph(&conn, id, id, None).unwrap();
        let mut node = source(id);
        graph::upsert_node(&conn, &node).unwrap();
        node.device_kind = "discovered".into();
        graph::upsert_node(&conn, &node).unwrap();
    }
    graph::save_layout(&conn, "a", &[position("192.0.2.10", -10.5, 20.25)]).unwrap();
    graph::save_layout(&conn, "b", &[position("192.0.2.10", 500.0, 600.0)]).unwrap();
    graph::save_layout(&conn, "a", &[position("192.0.2.10", -30.5, 40.25)]).unwrap();
    drop(conn);
    let conn = db::open_and_migrate(&dir.path().join("topology.db")).unwrap();
    let a = graph::list_positions(&conn, "a").unwrap();
    assert_eq!(a.len(), 1);
    assert_eq!((a[0].x, a[0].y), (-30.5, 40.25));
    assert_eq!(graph::list_positions(&conn, "b").unwrap()[0].x, 500.0);
    graph::reset_layout(&conn, "a").unwrap();
    assert!(graph::list_positions(&conn, "a").unwrap().is_empty());
    assert_eq!(graph::list_positions(&conn, "b").unwrap().len(), 1);
    graph::delete_graph(&conn, "b").unwrap();
    assert!(graph::list_positions(&conn, "b").unwrap().is_empty());
}

#[test]
fn invalid_layout_batch_is_atomic_and_never_crosses_graphs() {
    let (_dir, conn) = database();
    graph::upsert_node(&conn, &source(GLOBAL_GRAPH_ID)).unwrap();
    graph::save_layout(&conn, GLOBAL_GRAPH_ID, &[position("192.0.2.10", 1.0, 2.0)]).unwrap();
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(graph::save_layout(
            &conn,
            GLOBAL_GRAPH_ID,
            &[
                position("192.0.2.10", 4.0, 5.0),
                position("192.0.2.10", invalid, 1.0)
            ]
        )
        .is_err());
        assert!(graph::save_layout(
            &conn,
            GLOBAL_GRAPH_ID,
            &[position("192.0.2.10", 1.0, invalid)]
        )
        .is_err());
    }
    assert!(graph::save_layout(
        &conn,
        GLOBAL_GRAPH_ID,
        &[
            position("192.0.2.10", 7.0, 8.0),
            position("foreign-node", 1.0, 2.0)
        ]
    )
    .is_err());
    assert!(graph::save_layout(&conn, "missing", &[]).is_err());
    assert_eq!(
        graph::list_positions(&conn, GLOBAL_GRAPH_ID).unwrap()[0].x,
        1.0
    );
    graph::clear_graph(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert!(graph::list_positions(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
    assert!(
        graph::save_layout(&conn, GLOBAL_GRAPH_ID, &[position("192.0.2.10", 1.0, 2.0)]).is_err()
    );
}

#[test]
fn database_write_failure_rolls_back_entire_layout_batch() {
    let (_dir, conn) = database();
    let a = source(GLOBAL_GRAPH_ID);
    let mut b = a.clone();
    b.device_ref = "second".into();
    graph::upsert_node(&conn, &a).unwrap();
    graph::upsert_node(&conn, &b).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_second_position BEFORE INSERT ON topology_node_positions WHEN NEW.device_ref = 'second' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    assert!(graph::save_layout(
        &conn,
        GLOBAL_GRAPH_ID,
        &[
            position(&a.device_ref, 1.0, 2.0),
            position(&b.device_ref, 3.0, 4.0)
        ]
    )
    .is_err());
    assert!(graph::list_positions(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
}

#[test]
fn populated_legacy_upgrade_preserves_rows_and_enables_cascade() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("legacy.db");
    {
        let conn = db::open_and_migrate_to(&path, 96).unwrap();
        // Seed using the legacy schema, not the current protocol-key writer.
        conn.execute(
            "INSERT INTO topology_nodes(graph_id, device_ref, device_kind, label)
             VALUES (?1, 'legacy-source', 'ssh', 'legacy-source'),
                    (?1, 'synthetic-peer', 'discovered', 'synthetic-peer')",
            [GLOBAL_GRAPH_ID],
        ).unwrap();
        conn.execute(
            "INSERT INTO topology_edges(graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol)
             VALUES (?1, 'legacy-source', 'Gi1', 'synthetic-peer', 'Gi2', 'cdp')",
            [GLOBAL_GRAPH_ID],
        ).unwrap();
        conn.execute_batch(
            "INSERT INTO neighbor_cache(device_ref, device_kind, source_cmd, raw_output, parsed_json)
             VALUES ('legacy-source', 'ssh', 'show cdp neighbors detail', 'legacy capture', '[]')",
        ).unwrap();
    }
    let conn = db::open_and_migrate(&path).unwrap();
    assert_eq!(graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 2);
    assert_eq!(
        graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap()[0].protocol,
        "cdp"
    );
    let raw: String = conn
        .query_row("SELECT raw_output FROM neighbor_cache", [], |r| r.get(0))
        .unwrap();
    assert_eq!(raw, "legacy capture");
    graph::save_layout(
        &conn,
        GLOBAL_GRAPH_ID,
        &[position("legacy-source", 1.0, 2.0)],
    )
    .unwrap();
    graph::delete_graph(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert!(graph::list_positions(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
}

fn outcome(status: CaptureStatus, records: u32) -> CaptureOutcome {
    CaptureOutcome {
        protocol: "cdp".into(),
        status,
        records,
        error: None,
    }
}

#[test]
fn discovery_distinguishes_failed_partial_empty_and_completed() {
    let failed = DiscoverySummary::from_captures(vec![
        outcome(CaptureStatus::Failed, 0),
        outcome(CaptureStatus::Unsupported, 0),
    ]);
    assert_eq!(failed.status, DiscoveryStatus::Failed);
    assert!(!failed.cache_updated);
    let empty = DiscoverySummary::from_captures(vec![
        outcome(CaptureStatus::Completed, 0),
        outcome(CaptureStatus::Completed, 0),
    ]);
    assert_eq!(empty.status, DiscoveryStatus::Completed);
    assert!(empty.cache_updated);
    assert_eq!(empty.nodes_added, 0);
    let partial = DiscoverySummary::from_captures(vec![
        outcome(CaptureStatus::Completed, 2),
        outcome(CaptureStatus::Failed, 0),
    ]);
    assert_eq!(partial.status, DiscoveryStatus::Partial);
    assert_eq!(partial.nodes_added, 2);
    let complete = DiscoverySummary::from_captures(vec![
        outcome(CaptureStatus::Completed, 2),
        outcome(CaptureStatus::Completed, 3),
    ]);
    assert_eq!(complete.status, DiscoveryStatus::Completed);
    assert_eq!(complete.nodes_added, 5);
    assert_eq!(complete.edges_added, 5);
    assert_eq!(serde_json::to_value(&partial).unwrap()["status"], "partial");
}

#[test]
fn capture_bridge_requires_explicit_truthful_status() {
    assert!(NeighborCapture::from_response(serde_json::json!({"records": []})).is_err());
    assert!(
        NeighborCapture::from_response(serde_json::json!({"status": "failed", "records": []}))
            .is_err()
    );
    assert!(NeighborCapture::from_response(
        serde_json::json!({"status": "unsupported", "records": [record("cdp")]})
    )
    .is_err());
    assert!(NeighborCapture::from_response(
        serde_json::json!({"status": "completed", "records": []})
    )
    .is_ok());
    assert!(NeighborCapture::from_response(
        serde_json::json!({"status": "unsupported", "records": []})
    )
    .is_ok());
}

#[test]
fn saved_profile_and_host_are_authoritative_before_transport() {
    let (_dir, conn) = database();
    conn.execute("INSERT INTO ssh_connections (id,name,host,port,user,vendor,platform) VALUES ('saved','Friendly label','192.0.2.20',22,'operator','cisco','iosxe')", []).unwrap();
    let device = DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, "saved").unwrap();
    assert_eq!(device.source.device_ref, "192.0.2.20");
    assert_eq!(device.source.label, "Friendly label");
    assert_eq!(device.source.vendor.as_deref(), Some("cisco"));
    assert_eq!(device.source.platform.as_deref(), Some("iosxe"));
    assert!(device.supports_manual_collection());
    assert!(DiscoveryDevice::load(&conn, "missing", "saved").is_err());
    conn.execute(
        "UPDATE ssh_connections SET vendor='juniper', platform='junos' WHERE id='saved'",
        [],
    )
    .unwrap();
    assert!(!DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, "saved")
        .unwrap()
        .supports_manual_collection());
    conn.execute(
        "UPDATE ssh_connections SET vendor='cisco', platform='nxos' WHERE id='saved'",
        [],
    )
    .unwrap();
    assert!(!DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, "saved")
        .unwrap()
        .supports_manual_collection());
}

#[test]
fn saved_dns_reference_is_not_invented_management_ip() {
    let (_dir, conn) = database();
    conn.execute("INSERT INTO ssh_connections (id,name,host,port,user,vendor,platform) VALUES ('dns','Synthetic DNS label','switch.example.test',22,'operator','cisco','iosxe')", []).unwrap();
    let device = DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, "dns").unwrap();
    assert_eq!(device.source.device_ref, "switch.example.test");
    assert!(
        device.source.mgmt_ip.is_none(),
        "DNS host is a reference, not observed management IP"
    );
}

#[test]
fn manual_remote_observation_cannot_overwrite_collected_saved_profile() {
    let (_dir, conn) = database();
    conn.execute("INSERT INTO ssh_connections (id,name,host,port,user,vendor,platform) VALUES ('a','Authoritative A','192.0.2.10',22,'operator','cisco','iosxe'), ('b','Authoritative B','192.0.2.11',22,'operator','cisco','iosxe')", []).unwrap();
    graph::create_graph(&conn, "selected", "Selected", None).unwrap();
    let a = DiscoveryDevice::load(&conn, "selected", "a")
        .unwrap()
        .source;
    let b = DiscoveryDevice::load(&conn, "selected", "b")
        .unwrap()
        .source;
    ingest::ingest_neighbors_into_graph(
        &conn,
        &a,
        "show cdp neighbors detail",
        "synthetic empty",
        &[],
    )
    .unwrap();
    let mut remote = record("cdp");
    remote.neighbor_name = "Remote name".into();
    remote.neighbor_mgmt_ip = Some(a.device_ref.clone());
    remote.neighbor_vendor = Some("remote-vendor".into());
    remote.neighbor_platform = Some("remote-model-not-parser-profile".into());
    let summary = ingest::ingest_neighbors_into_graph(
        &conn,
        &b,
        "show cdp neighbors detail",
        "synthetic remote report",
        &[remote],
    )
    .unwrap();
    assert_eq!(summary.nodes_added, 1);
    let saved = graph::list_nodes(&conn, "selected")
        .unwrap()
        .into_iter()
        .find(|node| node.device_ref == a.device_ref && node.device_kind == "ssh")
        .unwrap();
    assert_eq!(saved.label, a.label);
    assert_eq!(saved.vendor, a.vendor);
    assert_eq!(saved.platform, a.platform);
    assert_eq!(graph::list_edges(&conn, "selected").unwrap().len(), 1);
    assert!(graph::list_nodes(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
}

#[test]
fn manual_self_neighbor_cannot_overwrite_current_source_profile() {
    let (_dir, conn) = database();
    conn.execute("INSERT INTO ssh_connections (id,name,host,port,user,vendor,platform) VALUES ('a','Authoritative A','192.0.2.10',22,'operator','cisco','iosxe')", []).unwrap();
    let a = DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, "a")
        .unwrap()
        .source;
    let mut remote = record("cdp");
    remote.neighbor_name = "Remote self label".into();
    remote.neighbor_mgmt_ip = Some(a.device_ref.clone());
    remote.neighbor_vendor = None;
    remote.neighbor_platform = Some("advertised model".into());
    ingest::ingest_neighbors_into_graph(
        &conn,
        &a,
        "show cdp neighbors detail",
        "synthetic self report",
        &[remote],
    )
    .unwrap();
    let saved = graph::list_nodes(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .into_iter()
        .find(|node| node.device_ref == a.device_ref && node.device_kind == "ssh")
        .unwrap();
    assert_eq!(saved.label, a.label);
    assert_eq!(saved.vendor, a.vendor);
    assert_eq!(saved.platform, a.platform);
}

#[test]
fn legacy_automatic_neighbor_upsert_keeps_existing_replacement_semantics() {
    let (_dir, conn) = database();
    conn.execute("INSERT INTO ssh_connections (id,name,host,port,user,vendor,platform) VALUES ('a','Authoritative A','192.0.2.10',22,'operator','cisco','iosxe')", []).unwrap();
    let a = DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, "a")
        .unwrap()
        .source;
    graph::upsert_node(&conn, &a).unwrap();
    let mut remote = record("cdp");
    remote.neighbor_name = "Legacy observed label".into();
    remote.neighbor_mgmt_ip = Some(a.device_ref.clone());
    remote.neighbor_vendor = Some("observed-vendor".into());
    remote.neighbor_platform = Some("observed-model".into());
    ingest::ingest_neighbors(
        &conn,
        "automatic-source",
        "ssh",
        "show cdp neighbors detail",
        "synthetic",
        &[remote.clone()],
    )
    .unwrap();
    let saved = graph::list_nodes(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .into_iter()
        .find(|node| node.device_ref == a.device_ref && node.device_kind == "ssh")
        .unwrap();
    assert_eq!(saved.label, remote.neighbor_name);
    assert_eq!(saved.vendor, remote.neighbor_vendor);
    assert_eq!(saved.platform, remote.neighbor_platform);
}

#[test]
fn manual_discovery_rejects_host_with_multiple_saved_ports_before_transport() {
    let (_dir, conn) = database();
    conn.execute("INSERT INTO ssh_connections (id,name,host,port,user,vendor,platform) VALUES ('a','Endpoint A','192.0.2.10',22,'operator','cisco','iosxe'), ('b','Endpoint B','192.0.2.10',2222,'operator','cisco','iosxe')", []).unwrap();
    for id in ["a", "b"] {
        let result = DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, id);
        assert!(
            result.is_err(),
            "host-only graph identity must not merge different saved ports"
        );
        let error = result.err().unwrap().to_string();
        assert!(
            error.contains("multiple SSH ports"),
            "actionable sanitized ambiguity message: {error}"
        );
        assert!(!error.contains("192.0.2.10"));
    }
    assert!(graph::list_nodes(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
}

#[test]
fn same_saved_host_and_port_with_alternative_users_is_one_endpoint() {
    let (_dir, conn) = database();
    conn.execute("INSERT INTO ssh_connections (id,name,host,port,user,vendor,platform) VALUES ('a','Account A','192.0.2.10',22,'alice','cisco','iosxe'), ('b','Account B','192.0.2.10',22,'bob','cisco','iosxe')", []).unwrap();
    assert_eq!(
        DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, "a")
            .unwrap()
            .source
            .device_ref,
        "192.0.2.10"
    );
    assert_eq!(
        DiscoveryDevice::load(&conn, GLOBAL_GRAPH_ID, "b")
            .unwrap()
            .source
            .device_ref,
        "192.0.2.10"
    );
}

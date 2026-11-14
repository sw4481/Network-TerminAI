use ccie_terminal_lib::{
    db,
    topology::{graph, interchange::TopologyImporter, TopologyEdge, GLOBAL_GRAPH_ID},
};
use rusqlite::Connection;
use serde_json::{json, Value};

fn database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("topology.db")).unwrap();
    (dir, conn)
}

fn fixtures() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!(
        "../../sidecar/tests/fixtures/sc2_native_topology_phase0_cases.json"
    ))
    .unwrap()["cases"]
        .as_array()
        .unwrap()
        .clone()
}

fn content(case: &Value) -> String {
    case.get("raw_json")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| case["map"].to_string())
}

fn simple_map() -> Value {
    json!({"source.example":{"node_details":{"ip":"192.0.2.1","platform":"IOS XE","vendor":"cisco","model":"model","serial":"serial","os_version":"17"},"peers":{"peer.example":{"ip":"192.0.2.2","connections":[["Gi1","Gi2"]],"protocols":["cdp"]}}}})
}

fn native() -> Value {
    json!({"format":"terminai-topology","version":1,"snapshot":{
        "graph":{"id":"original","name":"Original","description":"declared description","created_at":123,"updated_at":456},
        "nodes":[
            {"graph_id":"original","device_ref":"source.example","device_kind":"ssh","label":"<source & \"quoted\">","vendor":"cisco","platform":"IOS XE","mgmt_ip":"192.0.2.1"},
            {"graph_id":"original","device_ref":"source.example","device_kind":"netconf","label":"alternative kind","vendor":null,"platform":null,"mgmt_ip":null},
            {"graph_id":"original","device_ref":"peer.example","device_kind":"discovered","label":"peer","vendor":null,"platform":null,"mgmt_ip":null}],
        "edges":[{"graph_id":"original","a_device_ref":"source.example","a_port":"Gi1","b_device_ref":"peer.example","b_port":"Gi2","protocol":"cdp","captured_at":0},
                 {"graph_id":"original","a_device_ref":"source.example","a_port":"Gi1","b_device_ref":"peer.example","b_port":"Gi2","protocol":"lldp","captured_at":789}],
        "positions":[{"device_ref":"source.example","x":-12.5,"y":101.25},{"device_ref":"peer.example","x":42.0,"y":0.0}]
    }})
}

fn row_counts(conn: &Connection) -> Vec<i64> {
    [
        "topology_graphs",
        "topology_nodes",
        "topology_edges",
        "topology_node_positions",
        "neighbor_cache",
    ]
    .iter()
    .map(|t| {
        conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
            .unwrap()
    })
    .collect()
}

#[test]
fn native_v1_rejects_local_collection_receipts_instead_of_silently_losing_them() {
    let (_dir, conn) = database();
    let mut input = native();
    input["snapshot"]["capture_evidence"] = json!([{
        "source_ref":"source.example", "protocol":"cdp", "source_command":"show cdp neighbors detail",
        "attempted_at":123, "status":"completed", "observations":[]
    }]);
    let before = row_counts(&conn);
    assert!(TopologyImporter::preview(&input.to_string())
        .unwrap_err()
        .to_string()
        .contains("local collection receipts"));
    assert!(TopologyImporter::import(&conn, &input.to_string(), "not imported").is_err());
    assert_eq!(row_counts(&conn), before);
}

#[test]
fn frozen_fixture_acceptance_and_rejection_leave_no_partial_graphs() {
    let (_dir, conn) = database();
    for case in fixtures() {
        let before = row_counts(&conn);
        let result = TopologyImporter::preview(&content(&case));
        if case["expected"]["valid"] == true {
            let preview = result.unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
            assert_eq!(preview.format, "sc2");
            let snapshot =
                TopologyImporter::import(&conn, &content(&case), case["name"].as_str().unwrap())
                    .unwrap();
            assert_eq!(snapshot.nodes.len(), preview.node_count);
            assert_eq!(snapshot.edges.len(), preview.edge_count);
            assert!(snapshot.edges.iter().all(|e| e.captured_at == 0));
            assert_ne!(snapshot.graph.id, GLOBAL_GRAPH_ID);
        } else {
            assert!(result.is_err(), "{}", case["name"]);
            assert!(TopologyImporter::import(&conn, &content(&case), "bad").is_err());
            assert_eq!(row_counts(&conn), before);
        }
    }
    assert!(graph::list_nodes(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
}

#[test]
fn aligned_protocols_parallel_ports_and_reverse_claims_keep_three_observations() {
    let (_dir, conn) = database();
    let case = &fixtures()[0];
    let input = content(case);
    let p = TopologyImporter::preview(&input).unwrap();
    assert_eq!((p.node_count, p.edge_count, p.placeholder_count), (2, 3, 0));
    let s = TopologyImporter::import(&conn, &input, "parallel").unwrap();
    assert_eq!(s.edges.iter().filter(|e| e.protocol == "cdp").count(), 1);
    assert_eq!(s.edges.iter().filter(|e| e.protocol == "lldp").count(), 2);
    assert!(s.edges.iter().all(|e| e.a_device_ref == "core-α.example"));
}

#[test]
fn absent_protocol_unknown_eigrp_and_missing_peer_placeholder_are_truthful() {
    let (_dir, conn) = database();
    for (index, protocol) in [(1, "unknown"), (2, "eigrp")] {
        let input = content(&fixtures()[index]);
        let p = TopologyImporter::preview(&input).unwrap();
        assert_eq!(p.placeholder_count, 1);
        let s = TopologyImporter::import(&conn, &input, protocol).unwrap();
        assert_eq!(s.edges[0].protocol, protocol);
        assert_eq!(s.edges[0].captured_at, 0);
        let provenance = s.import_provenance.unwrap();
        assert_eq!(
            provenance
                .node_metadata
                .iter()
                .filter(|n| n.placeholder)
                .count(),
            1
        );
        assert_eq!(provenance.format, "sc2");
    }
}

#[test]
fn unknown_raw_protocol_and_supported_inventory_survive_native_roundtrip() {
    let (_dir, conn) = database();
    let mut input = simple_map();
    input["source.example"]["peers"]["peer.example"]["protocols"] = json!(["vendor-special"]);
    input["source.example"]["node_details"]["metadata"] =
        json!({"unrelated_record":"do not persist"});
    let p = TopologyImporter::preview(&input.to_string()).unwrap();
    assert!(p.warnings.iter().any(|w| w.contains("protocol")));
    let first = TopologyImporter::import(&conn, &input.to_string(), "first").unwrap();
    assert_eq!(first.edges[0].protocol, "unknown");
    let provenance = first.import_provenance.as_ref().unwrap();
    assert_eq!(
        provenance.unsupported_protocols[0].raw_protocol,
        "vendor-special"
    );
    let meta = provenance
        .node_metadata
        .iter()
        .find(|n| n.device_ref == "source.example")
        .unwrap();
    assert_eq!(meta.model.as_deref(), Some("model"));
    assert_eq!(meta.serial.as_deref(), Some("serial"));
    assert_eq!(meta.os_version.as_deref(), Some("17"));
    assert!(!serde_json::to_string(&first)
        .unwrap()
        .contains("do not persist"));
    let envelope = json!({"format":"terminai-topology","version":1,"snapshot":first});
    let second = TopologyImporter::import(&conn, &envelope.to_string(), "second").unwrap();
    assert_ne!(second.graph.id, first.graph.id);
    assert_eq!(
        serde_json::to_value(second.import_provenance).unwrap(),
        serde_json::to_value(first.import_provenance).unwrap()
    );
}

#[test]
fn native_roundtrip_preserves_declared_data_except_new_graph_identity_and_name() {
    let (_dir, conn) = database();
    let input = native();
    let p = TopologyImporter::preview(&input.to_string()).unwrap();
    assert_eq!(
        (p.format.as_str(), p.node_count, p.edge_count),
        ("native", 3, 2)
    );
    let imported = TopologyImporter::import(&conn, &input.to_string(), "New graph").unwrap();
    assert_ne!(imported.graph.id, "original");
    assert_eq!(imported.graph.name, "New graph");
    assert_eq!(
        (imported.graph.created_at, imported.graph.updated_at),
        (123, 456)
    );
    assert_eq!(
        imported.graph.description.as_deref(),
        Some("declared description")
    );
    let receipt = imported.import_provenance.as_ref().unwrap();
    assert_eq!(receipt.source_graph_id.as_deref(), Some("original"));
    let mut expected = input["snapshot"].clone();
    expected["graph"]["id"] = json!(imported.graph.id);
    expected["graph"]["name"] = json!("New graph");
    for field in ["nodes", "edges"] {
        for row in expected[field].as_array_mut().unwrap() {
            row["graph_id"] = json!(imported.graph.id);
        }
        expected[field]
            .as_array_mut()
            .unwrap()
            .sort_by_key(Value::to_string);
    }
    expected["positions"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(Value::to_string);
    expected["import_provenance"] = serde_json::to_value(receipt).unwrap();
    let mut actual = serde_json::to_value(&imported).unwrap();
    for field in ["nodes", "edges", "positions"] {
        actual[field]
            .as_array_mut()
            .unwrap()
            .sort_by_key(Value::to_string);
    }
    assert_eq!(actual, expected);
    let reload = graph::snapshot(&conn, &imported.graph.id).unwrap();
    assert_eq!(
        serde_json::to_value(reload).unwrap(),
        serde_json::to_value(imported).unwrap()
    );
}

#[test]
fn rejects_supplied_protocol_misalignment_types_and_malformed_connections() {
    let cases = [
        json!(null),
        json!("lldp"),
        json!([]),
        json!(["cdp", "lldp"]),
        json!([null]),
        json!([1]),
        json!([""]),
    ];
    for protocols in cases {
        let mut map = simple_map();
        map["source.example"]["peers"]["peer.example"]["protocols"] = protocols;
        let error = TopologyImporter::preview(&map.to_string())
            .unwrap_err()
            .to_string();
        assert!(error.contains("protocol"), "{error}");
    }
    for pair in [
        json!(["Gi1"]),
        json!(["a", "b", "c"]),
        json!([1, "b"]),
        json!(null),
    ] {
        let mut map = simple_map();
        map["source.example"]["peers"]["peer.example"]["connections"] = json!([pair]);
        assert!(TopologyImporter::preview(&map.to_string()).is_err());
    }
}

#[test]
fn rejects_non_maps_urls_archives_device_inventory_and_malformed_unicode() {
    for input in [
        "[]",
        "null",
        "42",
        "\"https://example.invalid/map.json\"",
        "https://example.invalid/map.json",
        "PK\u{0003}\u{0004}",
        r#"{"name":"device","interfaces":[],"credentials":{}}"#,
        r#"{"r":{"node_details":{},"peers":[]}}"#,
        r#"{"r":{"node_details":{"ip":"\uD800"},"peers":{}}}"#,
    ] {
        assert!(
            TopologyImporter::preview(input).is_err(),
            "accepted {input}"
        );
    }
    let input = content(&fixtures()[7]);
    let p = TopologyImporter::preview(&input).unwrap();
    assert_eq!(p.node_count, 1);
}

#[test]
fn rejects_native_bad_versions_references_duplicate_rows_protocols_and_positions() {
    let original = native();
    let mut cases = Vec::new();
    let mut v = original.clone();
    v["version"] = json!(2);
    cases.push(v);
    let mut v = original.clone();
    v["snapshot"]["nodes"][0]["graph_id"] = json!("other");
    cases.push(v);
    let mut v = original.clone();
    v["snapshot"]["edges"][0]["b_device_ref"] = json!("missing");
    cases.push(v);
    let mut v = original.clone();
    v["snapshot"]["edges"][0]["protocol"] = json!("invented");
    cases.push(v);
    let mut v = original.clone();
    v["snapshot"]["positions"][0]["device_ref"] = json!("missing");
    cases.push(v);
    let mut v = original.clone();
    v["snapshot"]["positions"][0]["x"] = json!("NaN");
    cases.push(v);
    let mut v = original.clone();
    v["snapshot"]["nodes"][0]["device_kind"] = json!("invented");
    cases.push(v);
    let mut v = original.clone();
    v["snapshot"]["edges"][0]["captured_at"] = json!(-1);
    cases.push(v);
    let mut v = original.clone();
    let duplicate = v["snapshot"]["nodes"][0].clone();
    v["snapshot"]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    cases.push(v);
    let mut v = original.clone();
    let duplicate = v["snapshot"]["edges"][0].clone();
    v["snapshot"]["edges"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    cases.push(v);
    let mut v = original.clone();
    let duplicate = v["snapshot"]["positions"][0].clone();
    v["snapshot"]["positions"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    cases.push(v);
    for value in cases {
        assert!(
            TopologyImporter::preview(&value.to_string()).is_err(),
            "{value}"
        );
    }
}

#[test]
fn input_node_connection_string_and_metadata_limits_are_authoritative() {
    assert!(TopologyImporter::preview(&" ".repeat(10 * 1024 * 1024 + 1)).is_err());
    let mut map = serde_json::Map::new();
    for i in 0..2000 {
        map.insert(format!("node-{i}"), json!({"node_details":{},"peers":{}}));
    }
    assert_eq!(
        TopologyImporter::preview(&Value::Object(map.clone()).to_string())
            .unwrap()
            .node_count,
        2000
    );
    map.insert("overflow".into(), json!({"node_details":{},"peers":{}}));
    assert!(TopologyImporter::preview(&Value::Object(map).to_string()).is_err());
    let mut value = simple_map();
    value["source.example"]["peers"]["peer.example"]
        .as_object_mut()
        .unwrap()
        .remove("protocols");
    value["source.example"]["peers"]["peer.example"]["connections"] =
        json!(vec![["a", "b"]; 10000]);
    assert_eq!(
        TopologyImporter::preview(&value.to_string())
            .unwrap()
            .edge_count,
        1
    );
    value["source.example"]["peers"]["peer.example"]["connections"]
        .as_array_mut()
        .unwrap()
        .push(json!(["a", "b"]));
    assert!(TopologyImporter::preview(&value.to_string()).is_err());
    let mut value = simple_map();
    value["source.example"]["node_details"]["platform"] = json!("α".repeat(513));
    assert!(TopologyImporter::preview(&value.to_string()).is_err());
    let mut value = simple_map();
    value["source.example"]["node_details"]["metadata"] =
        json!({"padding":vec!["x".repeat(1024);20]});
    assert!(TopologyImporter::preview(&value.to_string()).is_err());
}

#[test]
fn placeholders_count_towards_node_limit_and_map_references_are_not_shortname_merged() {
    let mut value = serde_json::Map::new();
    for i in 0..2000 {
        value.insert(format!("node-{i}"), json!({"node_details":{},"peers":{}}));
    }
    value.get_mut("node-0").unwrap()["peers"] = json!({"missing":{"connections":[]}});
    assert!(TopologyImporter::preview(&Value::Object(value).to_string()).is_err());
    let p = TopologyImporter::preview(&content(&fixtures()[3])).unwrap();
    assert_eq!((p.node_count, p.placeholder_count), (2, 0));
}

#[test]
fn import_revalidates_does_not_write_cache_and_duplicate_names_do_not_mutate() {
    let (_dir, conn) = database();
    let input = simple_map().to_string();
    TopologyImporter::preview(&input).unwrap();
    let before = row_counts(&conn);
    assert!(TopologyImporter::import(&conn, "{} malformed", "bad").is_err());
    assert_eq!(row_counts(&conn), before);
    for name in ["", "   ", "\0", &"x".repeat(257)] {
        assert!(TopologyImporter::import(&conn, &input, name).is_err());
    }
    TopologyImporter::import(&conn, &input, "one").unwrap();
    let before = row_counts(&conn);
    assert!(TopologyImporter::import(&conn, &input, "one").is_err());
    assert_eq!(row_counts(&conn), before);
    assert_eq!(before[4], 0);
}

#[test]
fn transaction_rolls_back_graph_nodes_edges_positions_and_provenance_on_late_failure() {
    let (_dir, conn) = database();
    conn.execute_batch("CREATE TRIGGER fail_provenance BEFORE INSERT ON topology_import_provenance BEGIN SELECT RAISE(ABORT, 'synthetic late failure'); END;").unwrap();
    let before = row_counts(&conn);
    assert!(TopologyImporter::import(&conn, &native().to_string(), "rollback").is_err());
    assert_eq!(row_counts(&conn), before);
    let n: i64 = conn
        .query_row("SELECT count(*) FROM topology_import_provenance", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn provenance_survives_reopen_and_delete_cascades_but_clear_removes_import_receipt() {
    let (dir, conn) = database();
    let s = TopologyImporter::import(&conn, &simple_map().to_string(), "persisted").unwrap();
    let id = s.graph.id.clone();
    drop(conn);
    let conn = db::open_and_migrate(&dir.path().join("topology.db")).unwrap();
    assert_eq!(
        serde_json::to_value(graph::snapshot(&conn, &id).unwrap()).unwrap(),
        serde_json::to_value(s).unwrap()
    );
    graph::clear_graph(&conn, &id).unwrap();
    assert!(graph::snapshot(&conn, &id)
        .unwrap()
        .import_provenance
        .is_none());
    let second = TopologyImporter::import(&conn, &simple_map().to_string(), "delete").unwrap();
    graph::delete_graph(&conn, &second.graph.id).unwrap();
    let n: i64 = conn
        .query_row("SELECT count(*) FROM topology_import_provenance", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn populated_v0097_upgrade_preserves_surviving_rows_and_adds_protocol_key() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("legacy.db");
    let conn = db::open_and_migrate_to(&path, 97).unwrap();
    conn.execute("INSERT INTO topology_nodes(graph_id,device_ref,device_kind,label) VALUES (?1,'a','ssh','A'),(?1,'b','discovered','B')",[GLOBAL_GRAPH_ID]).unwrap();
    conn.execute("INSERT INTO topology_edges(graph_id,a_device_ref,a_port,b_device_ref,b_port,protocol,captured_at) VALUES (?1,'b','p2','a','p1','cdp',123)",[GLOBAL_GRAPH_ID]).unwrap();
    conn.execute(
        "INSERT INTO topology_node_positions(graph_id,device_ref,x,y) VALUES (?1,'a',10,20)",
        [GLOBAL_GRAPH_ID],
    )
    .unwrap();
    drop(conn);
    let conn = db::open_and_migrate(&path).unwrap();
    let edges = graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(
        (
            &*edges[0].a_device_ref,
            &*edges[0].protocol,
            edges[0].captured_at
        ),
        ("b", "cdp", 123)
    );
    for protocol in ["lldp", "eigrp", "unknown"] {
        conn.execute("INSERT INTO topology_edges(graph_id,a_device_ref,a_port,b_device_ref,b_port,protocol,captured_at) VALUES (?1,'b','p2','a','p1',?2,0)",rusqlite::params![GLOBAL_GRAPH_ID,protocol]).unwrap();
    }
    assert_eq!(graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 4);
    assert_eq!(graph::list_nodes(&conn, GLOBAL_GRAPH_ID).unwrap().len(), 2);
    assert_eq!(
        graph::list_positions(&conn, GLOBAL_GRAPH_ID).unwrap().len(),
        1
    );
    let fk: Option<String> = conn
        .query_row("PRAGMA foreign_key_check", [], |r| r.get(0))
        .optional()
        .unwrap();
    assert!(fk.is_none());
    graph::delete_graph(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert!(graph::list_edges(&conn, GLOBAL_GRAPH_ID)
        .unwrap()
        .is_empty());
}

#[test]
fn native_observation_upserts_preserve_protocol_and_current_timestamp_semantics() {
    let (_dir, conn) = database();
    for protocol in ["cdp", "lldp", "eigrp", "unknown", "isis"] {
        let edge = TopologyEdge {
            graph_id: GLOBAL_GRAPH_ID.into(),
            a_device_ref: "b".into(),
            a_port: "p2".into(),
            b_device_ref: "a".into(),
            b_port: "p1".into(),
            protocol: protocol.into(),
            captured_at: 0,
        };
        graph::upsert_edge(&conn, &edge).unwrap();
        graph::upsert_edge(&conn, &edge).unwrap();
    }
    let edges = graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(edges.len(), 5);
    assert!(edges
        .iter()
        .all(|e| e.captured_at > 0 && e.a_device_ref == "a"));
    let edge = TopologyEdge {
        captured_at: 123,
        protocol: "cdp".into(),
        ..edges[0].clone()
    };
    graph::upsert_edge(&conn, &edge).unwrap();
    assert_eq!(
        graph::list_edges(&conn, GLOBAL_GRAPH_ID)
            .unwrap()
            .iter()
            .find(|e| e.protocol == "cdp")
            .unwrap()
            .captured_at,
        123
    );
}

#[test]
fn native_envelope_field_names_remain_valid_exact_sc2_node_keys() {
    let map = json!({"format":{"node_details":{},"peers":{}},"version":{"node_details":{},"peers":{}},"snapshot":{"node_details":{},"peers":{}}});
    assert_eq!(
        TopologyImporter::preview(&map.to_string())
            .unwrap()
            .node_count,
        3
    );
}

#[test]
fn duplicate_json_keys_cannot_hide_invalid_protocols_or_replace_map_nodes() {
    for content in [
        r#"{"r":{"node_details":{},"peers":{}},"r":{"node_details":{},"peers":{}}}"#,
        r#"{"r":{"node_details":{},"peers":{"p":{"connections":[["a","b"]],"protocols":null,"protocols":["cdp"]}}}}"#,
    ] {
        assert!(TopologyImporter::preview(content).is_err());
    }
}

#[test]
fn exact_byte_limit_and_native_provenance_limits_are_checked() {
    let input = format!("{{}}{}", " ".repeat(10 * 1024 * 1024 - 2));
    assert!(TopologyImporter::preview(&input).is_ok());
    assert!(TopologyImporter::preview(&(input + " ")).is_err());
    let mut value = native();
    value["snapshot"]["import_provenance"] =
        json!({"format":"sc2","imported_at":1,"node_metadata":[],"unsupported_protocols":[]});
    assert!(TopologyImporter::preview(&value.to_string()).is_ok());
    for receipt in [
        json!({"format":"invented","imported_at":1,"node_metadata":[],"unsupported_protocols":[]}),
        json!({"format":"sc2","imported_at":-1,"node_metadata":[],"unsupported_protocols":[]}),
        json!({"format":"sc2","imported_at":1,"node_metadata":vec![json!({"device_ref":"x","placeholder":false});2001],"unsupported_protocols":[]}),
        json!({"format":"sc2","imported_at":1,"node_metadata":[],"unsupported_protocols":vec![json!({"a_device_ref":"x","a_port":"a","b_device_ref":"y","b_port":"b","raw_protocol":"unsupported"});10001]}),
    ] {
        value["snapshot"]["import_provenance"] = receipt;
        assert!(TopologyImporter::preview(&value.to_string()).is_err());
    }
}

#[test]
fn failed_late_migration_rolls_back_edge_rebuild_and_keeps_v0097_rows() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("rollback.db");
    let conn = db::open_and_migrate_to(&path, 97).unwrap();
    conn.execute(
        "INSERT INTO topology_edges(graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol, captured_at)
         VALUES (?1, 'before-a', 'one', 'before-b', 'two', 'cdp', 321)",
        [GLOBAL_GRAPH_ID],
    ).unwrap();
    // Force the final DDL statement to fail after the rebuild has run.
    conn.execute_batch("CREATE TABLE topology_import_provenance (synthetic_existing TEXT)")
        .unwrap();
    drop(conn);
    assert!(db::open_and_migrate(&path).is_err());
    let conn = db::open_and_migrate_to(&path, 97).unwrap();
    let edges = graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].captured_at, 321);
    let protocol_pk: i64 = conn
        .query_row(
            "SELECT pk FROM pragma_table_info('topology_edges') WHERE name = 'protocol'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        protocol_pk, 0,
        "legacy edge schema must survive failed migration"
    );
    let latest: i64 = conn
        .query_row(
            "SELECT MAX(version) FROM refinery_schema_history",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(latest, 97);
    let rebuilt: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='topology_edges_v0098'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rebuilt, 0);
}

#[test]
fn total_provenance_size_is_bounded_before_any_database_write() {
    let mut input = native();
    let metadata: Vec<Value> = (0..2000).map(|i| json!({"device_ref":format!("historical-{i}"),"placeholder":false,"model":"x".repeat(1024),"os_version":"y".repeat(1024)})).collect();
    input["snapshot"]["import_provenance"] =
        json!({"format":"sc2","imported_at":1,"node_metadata":metadata,"unsupported_protocols":[]});
    let error = TopologyImporter::preview(&input.to_string()).unwrap_err();
    assert!(error.to_string().contains("2 MiB"));
    let (_dir, conn) = database();
    let before = row_counts(&conn);
    assert!(TopologyImporter::import(&conn, &input.to_string(), "too much metadata").is_err());
    assert_eq!(row_counts(&conn), before);
}

use rusqlite::OptionalExtension;

use super::super::{evidence::CaptureEvidence, graph, ingest, TopologyNode, GLOBAL_GRAPH_ID};
use super::*;
use std::{collections::HashMap, time::Duration};

fn connection() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open_and_migrate(&dir.path().join("synthetic.db")).unwrap();
    (dir, conn)
}
pub(crate) fn vault(conn: &Connection) -> Arc<VaultState> {
    let vault = Arc::new(VaultState::new(
        Arc::new(crate::vault::InMemoryKeyringStore::new()),
        Duration::from_secs(600),
    ));
    conn.execute("INSERT INTO vault_envelopes(id,name,kdf_params_json,salt_blob) VALUES('synthetic-envelope','synthetic','{}',zeroblob(16))", []).unwrap();
    vault.lock.unlock(
        "synthetic-envelope",
        Zeroizing::new([7; 32]),
        "synthetic-session".into(),
    );
    vault
}
pub(crate) fn secret(
    conn: &Connection,
    vault: &VaultState,
    value: &str,
    versioned: bool,
) -> String {
    vault
        .store
        .add_secret(
            conn,
            &vault.lock,
            "synthetic-envelope",
            "snmp_community",
            "synthetic",
            Zeroizing::new(value.as_bytes().to_vec()),
            if versioned {
                HashMap::from([("format".into(), serde_json::json!("topology-snmp-v1"))])
            } else {
                HashMap::new()
            },
        )
        .unwrap()
        .id
}
pub(crate) const V3: &str = r#"{"schema":1,"version":"3","username":"synthetic","auth_key":"synthetic-auth","priv_key":"synthetic-priv"}"#;
pub(crate) fn output(protocol_records: bool) -> String {
    let captures: Vec<_> = ["cdp", "lldp"].into_iter().map(|protocol| {
        serde_json::json!({"protocol":protocol,"status":"completed","records":if protocol_records { vec![serde_json::json!({"protocol":protocol,"local_port":"Gi1","neighbor_name":"peer","neighbor_port":"Gi2","neighbor_mgmt_ip":"192.0.2.2","neighbor_platform":null,"neighbor_vendor":null,"capabilities":[]})] } else { vec![] },
            "observations":if protocol_records { vec![serde_json::json!({"index":if protocol=="cdp" {vec![1,1]} else {vec![0,11,1]},"neighbor_name":"peer","local_port_id":"Gi1","local_port_description":"Gi1","remote_port_id":"Gi2","remote_port_description":"Gi2","remote_port_subtype":5,"local_ifindex":1,"mapping":if protocol=="cdp" {"cdpCacheIfIndex"} else {"ifName"},"reason":null,"management_addresses":["192.0.2.2"],"management_indexes":[[1,4,192,0,2,2]]})] } else { vec![] },"error":null})
    }).collect();
    serde_json::json!({"captures":captures}).to_string()
}

#[test]
fn snmp_versioned_credentials_require_exact_mode_and_one_unlocked_envelope() {
    let (_dir, conn) = connection();
    let vault = vault(&conn);
    let id = secret(&conn, &vault, V3, true);
    let unselected = secret(&conn, &vault, V3, true);
    assert!(Credential::read(&conn, &vault, &id, CollectionMode::SnmpV3).is_ok());
    assert!(
        conn.query_row(
            "SELECT last_used_at FROM vault_secrets WHERE id=?1",
            [&unselected],
            |r| r.get::<_, Option<i64>>(0)
        )
        .unwrap()
        .is_none(),
        "unselected secret must not be read"
    );
    assert!(Credential::read(&conn, &vault, &id, CollectionMode::SnmpV2c).is_err());
    let legacy = secret(&conn, &vault, "legacy-community", false);
    assert!(Credential::read(&conn, &vault, &legacy, CollectionMode::SnmpV2c).is_err());
    vault.lock.lock("synthetic-envelope");
    assert!(Credential::read(&conn, &vault, &id, CollectionMode::SnmpV3)
        .err()
        .expect("expected locked rejection")
        .contains("unlock"));
}

#[test]
fn snmp_credential_schema_validation_and_stdin_shape() {
    let credential = Credential::parse(V3.as_bytes(), CollectionMode::SnmpV3).unwrap();
    let request = credential.request("192.0.2.1").unwrap();
    let json: serde_json::Value = serde_json::from_slice(&request).unwrap();
    assert_eq!(json["host"], "192.0.2.1");
    assert!(json["credential"].get("port").is_none());
    assert!(json["credential"].get("context").is_none());
    for bad in [
        r#"{"schema":1,"version":"2c","community":"x","port":0}"#,
        r#"{"schema":2,"version":"2c","community":"x"}"#,
        r#"{"schema":1,"version":"2c","community":"x","host":"bad"}"#,
    ] {
        assert!(Credential::parse(bad.as_bytes(), CollectionMode::SnmpV2c).is_err());
    }
    assert!(Credential::parse(
        br#"{"schema":1,"version":"2c","community":"explicit"}"#,
        CollectionMode::SnmpV2c
    )
    .is_ok());
    for length in [255, 256] {
        let credential =
            serde_json::json!({"schema":1,"version":"2c","community":"x".repeat(length)});
        assert_eq!(
            Credential::parse(credential.to_string().as_bytes(), CollectionMode::SnmpV2c).is_ok(),
            length == 255
        );
    }
}

#[test]
fn snmp_release_resolution_never_falls_back_to_checkout() {
    assert!(Worker::resolve(None, false).is_err());
    let worker = Worker::resolve(Some(PathBuf::from("/trusted/bundle/python")), false).unwrap();
    assert!(worker.source.is_none());
}

#[test]
fn snmp_worker_output_is_independently_bounded_and_typed() {
    assert_eq!(decode(&output(true)).unwrap().len(), 2);
    assert!(decode(&output(false)).is_ok());
    for mutate in [
        "duplicate",
        "protocol",
        "records",
        "routing",
        "unknown",
        "unresolved",
        "bad_ip",
        "bad_index",
        "bad_mapping",
        "forged_receipt_metadata",
        "extra_capture",
    ] {
        let mut value: serde_json::Value = serde_json::from_str(&output(true)).unwrap();
        match mutate {
            "duplicate" => value["captures"][1]["protocol"] = "cdp".into(),
            "protocol" => value["captures"][0]["records"][0]["protocol"] = "bgp".into(),
            "records" => value["captures"][0]["status"] = "failed".into(),
            "routing" => value["captures"][0]["records"][0]["routing"] = serde_json::json!({}),
            "unknown" => value["captures"][0]["request"] = "not allowed".into(),
            "unresolved" => {
                value["captures"][0]["observations"][0]["reason"] = "unresolved_local_port".into()
            }
            "bad_ip" => value["captures"][0]["records"][0]["neighbor_mgmt_ip"] = "not-ip".into(),
            "bad_index" => {
                value["captures"][0]["observations"][0]["index"] = serde_json::json!([1])
            }
            "bad_mapping" => {
                value["captures"][0]["observations"][0]["mapping"] = "untrusted text".into()
            }
            "forged_receipt_metadata" => {
                value["captures"][0]["observations"][0]["captured_at"] = 1.into()
            }
            _ => {
                value["captures"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({}));
            }
        }
        assert!(decode(&value.to_string()).is_err(), "accepted {mutate}");
    }
    assert!(decode(&" ".repeat(2 * 1024 * 1024 + 1)).is_err());
    let mut failed: serde_json::Value = serde_json::from_str(&output(false)).unwrap();
    failed["captures"][0]["status"] = "failed".into();
    failed["captures"][0]["error"] = "synthetic-secret-must-not-propagate".into();
    assert!(!decode(&failed.to_string()).unwrap()[0]
        .error
        .as_ref()
        .unwrap()
        .contains("synthetic-secret"));
}

#[test]
fn snmp_source_authority_and_failed_history_are_independent_of_cli() {
    let (_dir, conn) = connection();
    let source = TopologyNode {
        graph_id: GLOBAL_GRAPH_ID.into(),
        device_ref: "192.0.2.1".into(),
        device_kind: "ssh".into(),
        label: "saved".into(),
        vendor: None,
        platform: None,
        mgmt_ip: None,
    };
    let capture = decode(&output(true)).unwrap().remove(0);
    let cli = "show cdp neighbors detail";
    let ssh = CaptureEvidence::attempt(
        &conn,
        GLOBAL_GRAPH_ID,
        &source.device_ref,
        cli,
        "incomplete",
    )
    .unwrap();
    ingest::ingest_owned_capture(&conn, &source, cli, "old CLI", &capture.records, &ssh).unwrap();
    let snmp = CaptureEvidence::attempt(
        &conn,
        GLOBAL_GRAPH_ID,
        &source.device_ref,
        "snmp:cdp",
        "incomplete",
    )
    .unwrap();
    CaptureEvidence::require_owner(&conn, GLOBAL_GRAPH_ID, &source.device_ref, cli, &ssh).unwrap();
    ingest::ingest_owned_snmp_capture(
        &conn,
        &source,
        "snmp:cdp",
        "safe normalized SNMP",
        &capture,
        &snmp,
    )
    .unwrap();
    let before = CaptureEvidence::list(&conn, GLOBAL_GRAPH_ID).unwrap();
    let old = before
        .iter()
        .find(|r| r.source_command == "snmp:cdp")
        .unwrap();
    let observations = serde_json::to_value(&old.observations).unwrap();
    let newer = CaptureEvidence::attempt(
        &conn,
        GLOBAL_GRAPH_ID,
        &source.device_ref,
        "snmp:cdp",
        "incomplete",
    )
    .unwrap();
    assert!(ingest::ingest_owned_snmp_capture(
        &conn, &source, "snmp:cdp", "stale", &capture, &snmp
    )
    .is_err());
    CaptureEvidence::finish_with_snmp(
        &conn,
        GLOBAL_GRAPH_ID,
        &source.device_ref,
        "snmp:cdp",
        &newer,
        "failed",
        Some(&[]),
    )
    .unwrap();
    let after = CaptureEvidence::list(&conn, GLOBAL_GRAPH_ID).unwrap();
    assert_eq!(after.len(), 2);
    assert_eq!(
        serde_json::to_value(after.iter().find(|r| r.source_command == cli).unwrap()).unwrap(),
        serde_json::to_value(before.iter().find(|r| r.source_command == cli).unwrap()).unwrap()
    );
    assert_eq!(
        serde_json::to_value(
            &after
                .iter()
                .find(|r| r.source_command == "snmp:cdp")
                .unwrap()
                .observations
        )
        .unwrap(),
        observations
    );
    let retained = after
        .iter()
        .find(|r| r.source_command == "snmp:cdp")
        .unwrap();
    assert_eq!(
        retained.snmp_observations.len(),
        1,
        "empty failed result cannot erase table provenance"
    );
    assert_eq!(
        retained.snmp_observations[0].captured_at,
        old.snmp_observations[0].captured_at
    );
    assert!(!retained.snmp_observations[0].in_latest_attempt);
    let token = CaptureEvidence::attempt(
        &conn,
        GLOBAL_GRAPH_ID,
        &source.device_ref,
        "snmp:cdp",
        "incomplete",
    )
    .unwrap();
    let mut unresolved = capture.observations.clone();
    unresolved[0].reason = Some("unresolved_local_port".into());
    CaptureEvidence::finish_with_snmp(
        &conn,
        GLOBAL_GRAPH_ID,
        &source.device_ref,
        "snmp:cdp",
        &token,
        "failed",
        Some(&unresolved),
    )
    .unwrap();
    let retained = CaptureEvidence::list(&conn, GLOBAL_GRAPH_ID).unwrap();
    let retained = retained
        .iter()
        .find(|r| r.source_command == "snmp:cdp")
        .unwrap();
    assert_eq!(
        retained.snmp_observations.len(),
        2,
        "failed partial evidence coexists with old safe evidence"
    );
    assert!(retained
        .snmp_observations
        .iter()
        .any(|o| o.reason.is_none() && !o.in_latest_attempt));
    assert!(retained
        .snmp_observations
        .iter()
        .any(|o| o.reason.is_some() && o.in_latest_attempt));
    let empty = decode(&output(false)).unwrap().remove(0);
    let token = CaptureEvidence::attempt(
        &conn,
        GLOBAL_GRAPH_ID,
        &source.device_ref,
        "snmp:cdp",
        "incomplete",
    )
    .unwrap();
    ingest::ingest_owned_snmp_capture(&conn, &source, "snmp:cdp", "empty complete", &empty, &token)
        .unwrap();
    let after = CaptureEvidence::list(&conn, GLOBAL_GRAPH_ID).unwrap();
    let old = after
        .iter()
        .find(|r| r.source_command == "snmp:cdp")
        .unwrap();
    assert!(!old.observations[0].in_latest_capture);
    assert_eq!(
        graph::list_edges(&conn, GLOBAL_GRAPH_ID).unwrap().len(),
        1,
        "empty capture never deletes historical graph edges"
    );
    let cache: i64 = conn.query_row("SELECT count(*) FROM neighbor_cache WHERE source_cmd IN ('snmp:cdp','show cdp neighbors detail')", [], |r|r.get(0)).unwrap();
    assert_eq!(cache, 2);
}

#[test]
fn snmp_migration_100_preserves_populated_99_receipts_and_attempt_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("upgrade.db");
    let mut conn = crate::db::open_and_migrate_to(&path, 99).unwrap();
    let json = serde_json::json!({"source_ref":"saved","protocol":"cdp","source_command":"show cdp neighbors detail","attempted_at":123,"status":"failed","observations":[]}).to_string();
    conn.execute("INSERT INTO topology_capture_evidence(graph_id,source_ref,protocol,attempt_id,evidence_json) VALUES(?1,'saved','cdp','preserved-owner',?2)", rusqlite::params![GLOBAL_GRAPH_ID,json]).unwrap();
    crate::db::apply_migrations(&mut conn).unwrap();
    let (command, owner, retained): (String, String, String) = conn
        .query_row(
            "SELECT source_command,attempt_id,evidence_json FROM topology_capture_evidence",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (command.as_str(), owner.as_str(), retained.as_str()),
        (
            "show cdp neighbors detail",
            "preserved-owner",
            json.as_str()
        )
    );
    CaptureEvidence::require_owner(&conn, GLOBAL_GRAPH_ID, "saved", &command, &owner).unwrap();
    CaptureEvidence::attempt(&conn, GLOBAL_GRAPH_ID, "saved", "snmp:cdp", "incomplete").unwrap();
    assert_eq!(
        CaptureEvidence::list(&conn, GLOBAL_GRAPH_ID).unwrap().len(),
        2
    );
    conn.execute("DELETE FROM topology_graphs WHERE id=?1", [GLOBAL_GRAPH_ID])
        .unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM topology_capture_evidence", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
}

#[cfg(unix)]
#[tokio::test]
async fn snmp_trusted_python_bootstrap_uses_isolated_import_and_stdin_not_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let package = dir.path().join("ccie_sidecar");
    std::fs::create_dir_all(package.join("topology")).unwrap();
    std::fs::write(package.join("__init__.py"), "").unwrap();
    std::fs::write(package.join("topology/__init__.py"), "").unwrap();
    let output = output(false);
    let script = format!("import json,os,sys\nassert sys.flags.isolated == 1\nassert os.getcwd() == '/'\nassert 'PYTHONPATH' not in os.environ\nrequest=json.loads(sys.stdin.buffer.read(16385))\nassert set(request)=={{'host','credential'}}\nassert request['host']=='192.0.2.1'\nassert request['credential']['auth_key']=='synthetic-auth'\nassert len(sys.argv)==1\nsys.stdout.write({})\n", serde_json::to_string(&output).unwrap());
    std::fs::write(package.join("topology/snmp_worker.py"), script).unwrap();
    let mut worker = Worker::production().unwrap();
    worker.source = Some(dir.path().to_path_buf());
    let processes = discovery_transport::DiscoveryProcesses::default();
    let credential = Credential::parse(V3.as_bytes(), CollectionMode::SnmpV3).unwrap();
    let result = worker
        .run(
            "192.0.2.1",
            &credential,
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(5),
            &processes,
        )
        .await
        .unwrap();
    assert_eq!(result.len(), 2);
    processes.shutdown().unwrap();
}

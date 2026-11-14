use super::*;
use std::sync::atomic::AtomicUsize;

fn setup(count: usize, parse: Parse) -> (tempfile::TempDir, Arc<TopologyDiscoveryService>) {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open_and_migrate(&dir.path().join("synthetic.db")).unwrap();
    for i in 0..count {
        conn.execute("INSERT INTO ssh_connections(id,name,host,port,user,vendor,platform) VALUES (?1,?1,?2,22,'synthetic','cisco','iosxe')", rusqlite::params![format!("id{i}"), format!("192.0.2.{}", i + 1)]).unwrap();
    }
    let parser = ParserBridge::new(Arc::new(crate::agent_bridge::AgentBridge::new(
        "/never-run".into(),
        vec![],
    )));
    let mut service = TopologyDiscoveryService::new(Arc::new(Mutex::new(conn)), parser);
    service.execute =
        Arc::new(|target, _, _, _| Box::pin(async move { Ok(target.0.host.clone()) }));
    service.parse = parse;
    (dir, Arc::new(service))
}
fn request(count: usize, depth: u8) -> DiscoveryRequest {
    DiscoveryRequest {
        graph_id: super::super::GLOBAL_GRAPH_ID.into(),
        seed_ids: vec!["id0".into()],
        eligible_ids: (0..count).map(|i| format!("id{i}")).collect(),
        passwords: (0..count)
            .map(|i| (format!("id{i}"), "synthetic-password".into()))
            .collect(),
        max_depth: depth,
        include_routing: false,
        collection_mode: CollectionMode::Ssh,
        snmp_secret_id: None,
    }
}
fn neighbor(protocol: &str, host: &str) -> NeighborRecord {
    NeighborRecord {
        protocol: protocol.into(),
        local_port: "Gi1".into(),
        neighbor_name: host.into(),
        neighbor_port: "Gi2".into(),
        neighbor_mgmt_ip: Some(host.into()),
        neighbor_platform: None,
        neighbor_vendor: None,
        capabilities: vec![],
        routing: None,
    }
}
fn capture(records: Vec<NeighborRecord>) -> NeighborCapture {
    NeighborCapture {
        status: CaptureStatus::Completed,
        records,
    }
}
async fn finish(service: &TopologyDiscoveryService, id: &str) -> DiscoveryReport {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let report = service.status(Some(id)).unwrap().unwrap();
            if !report.state.is_active() {
                return report;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn seeds_only_default_and_one_hop_bfs_preserve_cycles_and_depth() {
    let calls = Arc::new(Mutex::new(vec![]));
    let seen = calls.clone();
    let parse: Parse = Arc::new(move |protocol, _, _, _, raw, _| {
        seen.lock().push(raw.clone());
        Box::pin(async move {
            Ok(capture(match raw.as_str() {
                "192.0.2.1" => vec![neighbor(&protocol, "192.0.2.2")],
                "192.0.2.2" => vec![
                    neighbor(&protocol, "192.0.2.1"),
                    neighbor(&protocol, "192.0.2.3"),
                ],
                _ => vec![],
            }))
        })
    });
    let (_dir, service) = setup(3, parse);
    let first = service.start(request(3, 0)).unwrap();
    let report = finish(&service, &first.run_id).await;
    assert_eq!(report.devices.len(), 1);
    assert!(report.not_dialed.iter().any(|n| n.reason.contains("depth")));
    calls.lock().clear();
    let run = service.start(request(3, 1)).unwrap();
    let report = finish(&service, &run.run_id).await;
    assert_eq!(
        report
            .devices
            .iter()
            .map(|r| r.connection_id.as_str())
            .collect::<Vec<_>>(),
        ["id0", "id1"]
    );
    assert_eq!(report.devices[1].depth, 1);
    assert_eq!(calls.lock().len(), 4);
    assert!(report.not_dialed.iter().any(|n| n.reference == "192.0.2.3"));
}

#[tokio::test]
async fn fifty_attempt_cap_counts_failed_devices_and_four_device_concurrency() {
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let parse: Parse = Arc::new(|protocol, _, _, _, raw, _| {
        Box::pin(async move {
            Ok(capture(if raw == "192.0.2.1" {
                (2..=61)
                    .map(|i| neighbor(&protocol, &format!("192.0.2.{i}")))
                    .collect()
            } else {
                vec![]
            }))
        })
    });
    let (_dir, mut service) = setup(61, parse);
    let a = active.clone();
    let p = peak.clone();
    Arc::get_mut(&mut service).unwrap().execute = Arc::new(move |target, _, _, _| {
        let a = a.clone();
        let p = p.clone();
        Box::pin(async move {
            let now = a.fetch_add(1, Ordering::SeqCst) + 1;
            p.fetch_max(now, Ordering::SeqCst);
            tokio::task::yield_now().await;
            a.fetch_sub(1, Ordering::SeqCst);
            if target.0.host == "192.0.2.1" {
                Ok(target.0.host.clone())
            } else {
                Err("Synthetic unreachable target".into())
            }
        })
    });
    let run = service.start(request(61, 1)).unwrap();
    let report = finish(&service, &run.run_id).await;
    assert_eq!(report.devices.len(), 50);
    assert_eq!(
        report
            .devices
            .iter()
            .filter(|r| r.status == "failed")
            .count(),
        49
    );
    assert_eq!(peak.load(Ordering::SeqCst), 4);
    assert!(report
        .not_dialed
        .iter()
        .any(|n| n.reason.contains("50-device")));
}

#[tokio::test]
async fn exact_unique_saved_identity_and_eligible_scope_gate_followups() {
    let parse: Parse = Arc::new(|protocol, _, _, _, _, _| {
        Box::pin(async move {
            Ok(capture(vec![
                neighbor(&protocol, "192.0.2.2"),
                neighbor(&protocol, "192.0.2.3"),
                neighbor(&protocol, "unsaved.example"),
                neighbor(&protocol, ""),
            ]))
        })
    });
    let (_dir, service) = setup(3, parse);
    service.db.lock().execute("INSERT INTO ssh_connections(id,name,host,port) VALUES ('duplicate','duplicate','192.0.2.2',2222)", []).unwrap();
    let mut scope = request(3, 1);
    scope.eligible_ids.remove(2);
    scope.passwords.remove("id2");
    let run = service.start(scope).unwrap();
    let report = finish(&service, &run.run_id).await;
    assert_eq!(report.devices.len(), 1);
    for reason in ["Ambiguous", "outside", "No exact", "Missing"] {
        assert!(
            report.not_dialed.iter().any(|n| n.reason.contains(reason)),
            "missing {reason}"
        );
    }
    assert_eq!(normalize_host("CORE.Example."), "core.example");
    assert_eq!(normalize_host("2001:db8:0:0::1"), "2001:db8::1");
    assert_ne!(normalize_host("core"), normalize_host("core.example"));
}

#[tokio::test]
async fn missing_management_address_is_not_dialed_even_when_name_matches_saved_host() {
    let parse: Parse = Arc::new(|protocol, _, _, _, _, _| {
        Box::pin(async move {
            let mut row = neighbor(&protocol, "192.0.2.2");
            row.neighbor_mgmt_ip = None;
            Ok(capture(vec![row]))
        })
    });
    let (_dir, service) = setup(2, parse);
    let run = service.start(request(2, 1)).unwrap();
    let report = finish(&service, &run.run_id).await;
    assert_eq!(report.devices.len(), 1);
    assert!(report
        .not_dialed
        .iter()
        .any(|row| row.reason.contains("Missing neighbor management address")));
}

#[tokio::test]
async fn snapshot_keeps_endpoint_metadata_and_password_after_saved_profile_changes() {
    let parse: Parse = Arc::new(|_, _, _, _, _, _| Box::pin(async { Ok(capture(vec![])) }));
    let (_dir, service) = setup(1, parse);
    let mut req = request(1, 0);
    let scope = service.snapshot(&mut req, None).unwrap();
    service.db.lock().execute("UPDATE ssh_connections SET host='192.0.2.99',port=2222,user='changed',platform='junos' WHERE id='id0'", []).unwrap();
    let profile = scope.profiles.get("id0").unwrap();
    let target = &profile.target.as_ref().unwrap().0;
    assert_eq!(
        (
            &*target.host,
            target.port,
            &*target.username,
            &*target.password
        ),
        ("192.0.2.1", 22, "synthetic", "synthetic-password")
    );
    assert_eq!(profile.source.platform.as_deref(), Some("iosxe"));
    assert!(req.passwords.is_empty());
}

#[tokio::test]
async fn selected_seed_with_duplicate_host_stays_undialed_in_host_keyed_graph() {
    let parse: Parse = Arc::new(|_, _, _, _, _, _| {
        Box::pin(async { panic!("ambiguous host must not reach parser") })
    });
    let (_dir, service) = setup(1, parse);
    service.db.lock().execute("INSERT INTO ssh_connections(id,name,host,port) VALUES ('duplicate','duplicate','192.0.2.1',2222)", []).unwrap();
    let run = service.start(request(1, 0)).unwrap();
    let report = finish(&service, &run.run_id).await;
    assert!(report.devices.is_empty());
    assert!(report
        .not_dialed
        .iter()
        .any(|row| row.reason.contains("Ambiguous")));
}

#[tokio::test]
async fn active_start_reports_existing_and_stop_rejects_late_parse_without_releasing_admission() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let (e, r, c) = (entered.clone(), release.clone(), calls.clone());
    let parse: Parse = Arc::new(move |protocol, _, _, _, _, _| {
        let (e, r, c) = (e.clone(), r.clone(), c.clone());
        Box::pin(async move {
            c.fetch_add(1, Ordering::SeqCst);
            e.notify_one();
            r.notified().await;
            Ok(capture(vec![neighbor(&protocol, "192.0.2.2")]))
        })
    });
    let (_dir, service) = setup(2, parse);
    let run = service.start(request(2, 1)).unwrap();
    entered.notified().await;
    assert_eq!(service.start(request(0, 2)).unwrap().run_id, run.run_id);
    assert!(service.cancel("wrong-run").is_err());
    service.cancel(&run.run_id).unwrap();
    assert_eq!(
        finish(&service, &run.run_id).await.state,
        RunState::Cancelled
    );
    assert_eq!(service.parser_slot.available_permits(), 0);
    assert!(graph::list_nodes(&service.db.lock(), &run.graph_id)
        .unwrap()
        .is_empty());
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(2), async {
        while service.parser_slot.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(graph::list_nodes(&service.db.lock(), &run.graph_id)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn expired_run_stops_admission_and_device_parser_deadline_rejects_late_reply() {
    assert_eq!(DEVICE_TIME, Duration::from_secs(90));
    assert_eq!(RUN_TIME, Duration::from_secs(900));
    let parse: Parse = Arc::new(|_, _, _, _, _, _| {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok(capture(vec![]))
        })
    });
    let (_dir, service) = setup(1, parse);
    let mut req = request(1, 0);
    let scope = service.snapshot(&mut req, None).unwrap();
    let cancel = CancellationToken::new();
    let report = DiscoveryReport {
        run_id: "deadline".into(),
        graph_id: req.graph_id.clone(),
        state: RunState::Running,
        max_depth: 0,
        collection_mode: CollectionMode::Ssh,
        devices: vec![],
        not_dialed: vec![],
        additional_not_dialed: 0,
        nodes_processed: 0,
        edges_processed: 0,
        parser_admission_ms: 0,
        parser_reply_ms: 0,
    };
    *service.current.lock() = Some(Run {
        report,
        cancel: cancel.clone(),
    });
    service
        .clone()
        .run(
            "deadline".into(),
            vec!["id0".into()],
            scope,
            cancel.clone(),
            Instant::now() - Duration::from_millis(1),
        )
        .await;
    let report = service.status(None).unwrap().unwrap();
    assert_eq!(report.state, RunState::TimedOut);
    assert!(report.devices.is_empty());
    let scope = service.snapshot(&mut request(1, 0), None).unwrap();
    let profile = scope.profiles.get("id0").unwrap();
    let result = service
        .parse_capture(
            "deadline",
            profile,
            "cdp",
            COMMANDS[0].1,
            String::new(),
            None,
            cancel,
            Instant::now() + Duration::from_millis(20),
        )
        .await;
    assert!(result.unwrap_err().contains("deadline"));
    assert_eq!(service.parser_slot.available_permits(), 0);
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(service.parser_slot.available_permits(), 1);
    assert!(graph::list_nodes(&service.db.lock(), &req.graph_id)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn new_run_waits_for_cancelled_parser_and_measures_admission_head_of_line() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let (e, r, c) = (entered.clone(), release.clone(), calls.clone());
    let parse: Parse = Arc::new(move |_, _, _, _, _, _| {
        let (e, r, c) = (e.clone(), r.clone(), c.clone());
        Box::pin(async move {
            if c.fetch_add(1, Ordering::SeqCst) == 0 {
                e.notify_one();
                r.notified().await;
            }
            Ok(capture(vec![]))
        })
    });
    let (_dir, service) = setup(1, parse);
    let first = service.start(request(1, 0)).unwrap();
    entered.notified().await;
    service.cancel(&first.run_id).unwrap();
    finish(&service, &first.run_id).await;
    let second = service.start(request(1, 0)).unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    release.notify_one();
    let report = finish(&service, &second.run_id).await;
    assert_eq!(report.state, RunState::Completed);
    assert!(
        report.parser_admission_ms >= 20,
        "bounded parser admission must expose shared waiting"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn cancellation_retains_committed_capture_and_destination() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (e, r) = (entered.clone(), release.clone());
    let parse: Parse = Arc::new(move |protocol, _, _, _, _, _| {
        let (e, r) = (e.clone(), r.clone());
        Box::pin(async move {
            if protocol == "lldp" {
                e.notify_one();
                r.notified().await;
            }
            Ok(capture(vec![neighbor(&protocol, "192.0.2.2")]))
        })
    });
    let (_dir, service) = setup(2, parse);
    graph::create_graph(&service.db.lock(), "owned-graph", "owned", None).unwrap();
    let mut req = request(2, 0);
    req.graph_id = "owned-graph".into();
    let run = service.start(req).unwrap();
    entered.notified().await;
    service.cancel(&run.run_id).unwrap();
    let report = finish(&service, &run.run_id).await;
    assert_eq!(report.nodes_processed, 1);
    assert_eq!(
        graph::list_edges(&service.db.lock(), "owned-graph")
            .unwrap()
            .len(),
        1
    );
    assert!(
        graph::list_nodes(&service.db.lock(), super::super::GLOBAL_GRAPH_ID)
            .unwrap()
            .is_empty()
    );
    let receipts =
        super::super::evidence::CaptureEvidence::list(&service.db.lock(), "owned-graph").unwrap();
    assert_eq!(
        receipts
            .iter()
            .find(|r| r.protocol == "cdp")
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(
        receipts
            .iter()
            .find(|r| r.protocol == "lldp")
            .unwrap()
            .status,
        "incomplete"
    );
    let before = serde_json::to_value(&receipts).unwrap();
    release.notify_one();
    let _settled = service.parser_slot.clone().acquire_owned().await.unwrap();
    assert_eq!(
        serde_json::to_value(
            super::super::evidence::CaptureEvidence::list(&service.db.lock(), "owned-graph")
                .unwrap()
        )
        .unwrap(),
        before,
        "late parser cannot refresh receipt after Stop"
    );
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("synthetic-password"));
    assert!(!serialized.contains("SSHPASS"));
}

#[tokio::test]
async fn successful_empty_partial_and_unsupported_captures_are_truthful() {
    let parse: Parse = Arc::new(|protocol, _, _, _, _, _| {
        Box::pin(async move {
            if protocol == "cdp" {
                Ok(capture(vec![]))
            } else {
                Ok(NeighborCapture {
                    status: CaptureStatus::Unsupported,
                    records: vec![],
                })
            }
        })
    });
    let (_dir, service) = setup(1, parse);
    let run = service.start(request(1, 0)).unwrap();
    let report = finish(&service, &run.run_id).await;
    assert_eq!(report.devices[0].status, "partial");
    assert_eq!(
        report.devices[0].captures[0].status,
        CaptureStatus::Completed
    );
    assert_eq!(report.nodes_processed, 0);
    assert_eq!(
        graph::list_nodes(&service.db.lock(), &run.graph_id)
            .unwrap()
            .len(),
        1
    );
    service.shutdown().unwrap();
    assert!(service.start(request(1, 0)).is_err());
}

#[tokio::test]
async fn routing_is_opt_in_and_never_admits_a_saved_peer_for_recursion() {
    let commands = Arc::new(Mutex::new(vec![]));
    let seen = commands.clone();
    let parse: Parse = Arc::new(move |protocol, _, _, command, _, _| {
        seen.lock().push(command);
        Box::pin(async move {
            if matches!(protocol.as_str(), "bgp" | "ospf" | "isis" | "eigrp") {
                let mut row = neighbor(&protocol, "192.0.2.2");
                row.neighbor_mgmt_ip = None;
                row.local_port.clear();
                row.neighbor_port.clear();
                row.routing = Some(super::super::evidence::RoutingEvidence {
                    state: "Established".into(),
                    established: true,
                    peer_address: Some("192.0.2.2".into()),
                    vrf: Some("default".into()),
                    address_family: Some("ipv4 unicast".into()),
                    instance: None,
                    level: None,
                    scope_supported: true,
                    interface_association: None,
                });
                Ok(capture(vec![row]))
            } else {
                Ok(capture(vec![]))
            }
        })
    });
    let (_dir, service) = setup(2, parse);
    let run = service.start(request(2, 1)).unwrap();
    assert_eq!(finish(&service, &run.run_id).await.devices.len(), 1);
    assert_eq!(commands.lock().len(), 2);
    commands.lock().clear();
    let mut req = request(2, 1);
    req.include_routing = true;
    let run = service.start(req).unwrap();
    let report = finish(&service, &run.run_id).await;
    assert_eq!(
        report.devices.len(),
        1,
        "routing peer is not a management crawl target"
    );
    assert_eq!(report.devices[0].captures.len(), 6);
    assert_eq!(report.devices[0].status, "completed");
    assert_eq!(commands.lock().len(), 6);
    assert!(commands
        .lock()
        .iter()
        .any(|c| c == "show ip eigrp neighbors"));
    assert_eq!(report.edges_processed, 4);
    let receipts =
        super::super::evidence::CaptureEvidence::list(&service.db.lock(), &run.graph_id).unwrap();
    assert_eq!(receipts.len(), 6);
    assert!(receipts.iter().all(|r| r.status == "completed"));
    assert!(receipts
        .iter()
        .any(|r| r.protocol == "eigrp" && r.source_command == "show ip eigrp neighbors"));
}

#[tokio::test]
async fn eigrp_missing_evidence_or_unsupported_parser_never_creates_links() {
    for unsupported in [false, true] {
        let parse: Parse = Arc::new(move |protocol, _, _, _, _, _| {
            Box::pin(async move {
                if protocol == "eigrp" {
                    if unsupported {
                        Ok(NeighborCapture {
                            status: CaptureStatus::Unsupported,
                            records: vec![],
                        })
                    } else {
                        Ok(capture(vec![neighbor("eigrp", "192.0.2.2")]))
                    }
                } else {
                    Ok(capture(vec![]))
                }
            })
        });
        let (_dir, service) = setup(2, parse);
        let mut req = request(2, 1);
        req.include_routing = true;
        let run = service.start(req).unwrap();
        let report = finish(&service, &run.run_id).await;
        assert_eq!(report.devices.len(), 1);
        let outcome = report.devices[0]
            .captures
            .iter()
            .find(|c| c.protocol == "eigrp")
            .unwrap();
        assert_eq!(
            outcome.status,
            if unsupported {
                CaptureStatus::Unsupported
            } else {
                CaptureStatus::Failed
            }
        );
        let conn = service.db.lock();
        assert!(graph::list_edges(&conn, &run.graph_id).unwrap().is_empty());
        let receipts = super::super::evidence::CaptureEvidence::list(&conn, &run.graph_id).unwrap();
        let receipt = receipts.iter().find(|c| c.protocol == "eigrp").unwrap();
        assert_eq!(
            receipt.status,
            if unsupported { "unsupported" } else { "failed" }
        );
        assert!(receipt.observations.is_empty());
    }
}

#[tokio::test]
async fn newer_compatibility_capture_supersedes_waiting_native_parser() {
    use super::super::evidence::CaptureEvidence;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let started = entered.clone();
    let resume = release.clone();
    let parse: Parse = Arc::new(move |protocol, _, _, _, _, _| {
        let started = started.clone();
        let resume = resume.clone();
        Box::pin(async move {
            if protocol == "cdp" {
                started.notify_one();
                resume.notified().await;
            }
            Ok(capture(vec![neighbor(&protocol, "192.0.2.2")]))
        })
    });
    let (_dir, service) = setup(1, parse);
    let run = service.start(request(1, 0)).unwrap();
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    {
        let conn = service.db.lock();
        let src = DiscoveryDevice::load(&conn, &run.graph_id, "id0")
            .unwrap()
            .source;
        let token = CaptureEvidence::attempt(
            &conn,
            &run.graph_id,
            &src.device_ref,
            "show cdp neighbors detail",
            "incomplete",
        )
        .unwrap();
        ingest::ingest_owned_capture(
            &conn,
            &src,
            "show cdp neighbors detail",
            "newer compatibility capture",
            &[neighbor("cdp", "192.0.2.9")],
            &token,
        )
        .unwrap();
    }
    release.notify_one();
    let report = finish(&service, &run.run_id).await;
    assert_eq!(report.devices[0].captures[0].status, CaptureStatus::Failed);
    let conn = service.db.lock();
    let receipts = CaptureEvidence::list(&conn, &run.graph_id).unwrap();
    let cdp = receipts.iter().find(|r| r.protocol == "cdp").unwrap();
    assert_eq!(cdp.status, "completed");
    assert_eq!(cdp.observations.len(), 1);
    assert_eq!(cdp.observations[0].record.neighbor_name, "192.0.2.9");
    let cached: String = conn
        .query_row(
            "SELECT raw_output FROM neighbor_cache WHERE source_cmd='show cdp neighbors detail'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cached, "newer compatibility capture");
}

#[tokio::test]
async fn invalid_capture_and_unsupported_parser_record_terminal_receipts() {
    let parse: Parse = Arc::new(|protocol, _, _, _, _, _| {
        Box::pin(async move {
            if protocol == "cdp" {
                Ok(capture(vec![neighbor("bgp", "192.0.2.2")]))
            } else {
                Ok(NeighborCapture {
                    status: CaptureStatus::Unsupported,
                    records: vec![],
                })
            }
        })
    });
    let (_dir, service) = setup(1, parse);
    let run = service.start(request(1, 0)).unwrap();
    finish(&service, &run.run_id).await;
    let conn = service.db.lock();
    let receipts = super::super::evidence::CaptureEvidence::list(&conn, &run.graph_id).unwrap();
    assert_eq!(
        receipts
            .iter()
            .find(|r| r.protocol == "cdp")
            .unwrap()
            .status,
        "failed"
    );
    assert_eq!(
        receipts
            .iter()
            .find(|r| r.protocol == "lldp")
            .unwrap()
            .status,
        "unsupported"
    );
    assert!(graph::list_edges(&conn, &run.graph_id).unwrap().is_empty());
}

#[tokio::test]
async fn failed_refresh_preserves_history_but_invalidates_its_freshness() {
    let fail = Arc::new(AtomicBool::new(false));
    let phase = fail.clone();
    let parse: Parse = Arc::new(move |protocol, _, _, _, _, _| {
        let fail = phase.load(Ordering::SeqCst);
        Box::pin(async move {
            if fail {
                Err("Synthetic parser failure".into())
            } else {
                Ok(capture(vec![neighbor(&protocol, "192.0.2.2")]))
            }
        })
    });
    let (_dir, service) = setup(1, parse);
    let first = service.start(request(1, 0)).unwrap();
    finish(&service, &first.run_id).await;
    let old = graph::list_edges(&service.db.lock(), &first.graph_id).unwrap();
    fail.store(true, Ordering::SeqCst);
    let second = service.start(request(1, 0)).unwrap();
    let report = finish(&service, &second.run_id).await;
    assert_eq!(report.devices[0].status, "failed");
    assert_eq!(
        serde_json::to_value(graph::list_edges(&service.db.lock(), &first.graph_id).unwrap())
            .unwrap(),
        serde_json::to_value(old).unwrap()
    );
    let receipts =
        super::super::evidence::CaptureEvidence::list(&service.db.lock(), &first.graph_id).unwrap();
    assert!(receipts
        .iter()
        .all(|r| r.status == "failed" && r.observations.len() == 1));
}

#[tokio::test]
async fn routing_interface_snapshot_is_once_optional_and_never_blocks_logical_captures() {
    for fail in [false, true] {
        let parsed = Arc::new(Mutex::new(vec![]));
        let seen = parsed.clone();
        let parse: Parse = Arc::new(move |protocol, _, _, _, _, interfaces| {
            seen.lock().push((protocol, interfaces));
            Box::pin(async { Ok(capture(vec![])) })
        });
        let (_dir, mut service) = setup(1, parse);
        let executed = Arc::new(Mutex::new(vec![]));
        let seen = executed.clone();
        Arc::get_mut(&mut service).unwrap().execute = Arc::new(move |_, command, _, _| {
            seen.lock().push(command.clone());
            Box::pin(async move {
                if command == "show ip interface" && fail {
                    Err("unavailable".into())
                } else {
                    Ok("synthetic-interface-projection".into())
                }
            })
        });
        let mut req = request(1, 0);
        req.include_routing = true;
        let run = service.start(req).unwrap();
        assert_eq!(
            finish(&service, &run.run_id).await.devices[0].status,
            "completed"
        );
        assert_eq!(
            executed
                .lock()
                .iter()
                .filter(|c| c.as_str() == "show ip interface")
                .count(),
            1
        );
        assert_eq!(parsed.lock().len(), 6);
        for (protocol, interfaces) in parsed.lock().iter() {
            let expected =
                if !fail && matches!(protocol.as_str(), "bgp" | "ospf" | "isis" | "eigrp") {
                    Some("synthetic-interface-projection")
                } else {
                    None
                };
            assert_eq!(interfaces.as_deref(), expected);
        }
    }
}

#[test]
fn snmp_platform_guard_precedes_worker_and_vault_access() {
    let parse: Parse =
        Arc::new(|_, _, _, _, _, _| Box::pin(async { panic!("SNMP must not use shared parser") }));
    let (_dir, service) = setup(1, parse);
    let mut req = request(1, 0);
    req.collection_mode = CollectionMode::SnmpV3;
    assert_eq!(
        service.start(req).err().as_deref(),
        Some(if cfg!(unix) {
            "Topology SNMP worker unavailable"
        } else {
            "Topology SNMP discovery is unsupported on this platform"
        })
    );
    assert!(service.status(None).unwrap().is_none());
}

fn snmp_service(count: usize) -> (tempfile::TempDir, Arc<TopologyDiscoveryService>, String) {
    let parse: Parse =
        Arc::new(|_, _, _, _, _, _| Box::pin(async { panic!("SNMP must not use shared parser") }));
    let (dir, mut service) = setup(count, parse);
    let vault = snmp::tests::vault(&service.db.lock());
    let secret = snmp::tests::secret(&service.db.lock(), &vault, snmp::tests::V3, true);
    let inner = Arc::get_mut(&mut service).unwrap();
    inner.vault = Some(vault);
    inner.execute = Arc::new(|_, _, _, _| Box::pin(async { panic!("SNMP must not use SSH") }));
    inner.snmp_execute = Some(Arc::new(|_, _, _, _| {
        Box::pin(async { snmp::decode(&snmp::tests::output(false)) })
    }));
    (dir, service, secret)
}
fn snmp_request(count: usize, id: &str) -> DiscoveryRequest {
    let mut req = request(count, 0);
    req.passwords.clear();
    req.collection_mode = CollectionMode::SnmpV3;
    req.snmp_secret_id = Some(id.into());
    req
}
#[tokio::test]
async fn snmp_saved_hosts_ignore_ssh_vendor_password_and_port_and_report_secret_free_mode() {
    let (_dir, mut service, secret) = snmp_service(1);
    service.db.lock().execute("UPDATE ssh_connections SET vendor='juniper',platform='junos',user=NULL,port=0 WHERE id='id0'", []).unwrap();
    let calls = Arc::new(Mutex::new(vec![]));
    let seen = calls.clone();
    Arc::get_mut(&mut service).unwrap().snmp_execute =
        Some(Arc::new(move |host, credential, _, _| {
            seen.lock().push(host);
            Box::pin(async move {
                assert!(matches!(&*credential, snmp::Credential::V3 { .. }));
                snmp::decode(&snmp::tests::output(false))
            })
        }));
    let started = service.start(snmp_request(1, &secret)).unwrap();
    let report = finish(&service, &started.run_id).await;
    assert_eq!(report.collection_mode, CollectionMode::SnmpV3);
    assert_eq!(report.devices[0].status, "completed");
    assert_eq!(&*calls.lock(), &["192.0.2.1"]);
    let json = serde_json::to_string(&report).unwrap();
    for secret in [&secret, "synthetic-auth", "synthetic-priv"] {
        assert!(!json.contains(secret));
    }
    let receipts =
        super::super::evidence::CaptureEvidence::list(&service.db.lock(), &started.graph_id)
            .unwrap();
    assert!(receipts
        .iter()
        .all(|r| r.source_command.starts_with("snmp:")));
}
#[tokio::test]
async fn snmp_invalid_mode_legacy_locked_and_routing_requests_never_execute() {
    let (_dir, mut service, secret) = snmp_service(1);
    Arc::get_mut(&mut service).unwrap().snmp_execute = Some(Arc::new(|_, _, _, _| {
        Box::pin(async { panic!("rejected request must not execute") })
    }));
    let mut req = snmp_request(1, &secret);
    req.include_routing = true;
    assert!(service.start(req).is_err());
    let mut req = snmp_request(1, &secret);
    req.collection_mode = CollectionMode::SnmpV2c;
    assert!(service.start(req).is_err());
    let legacy = snmp::tests::secret(
        &service.db.lock(),
        service.vault.as_ref().unwrap(),
        "legacy",
        false,
    );
    assert!(service.start(snmp_request(1, &legacy)).is_err());
    let mut req = snmp_request(1, &secret);
    req.snmp_secret_id = None;
    assert!(service.start(req).is_err());
    service
        .vault
        .as_ref()
        .unwrap()
        .lock
        .lock("synthetic-envelope");
    assert!(service.start(snmp_request(1, &secret)).is_err());
    assert!(service.status(None).unwrap().is_none());
    assert!(super::super::evidence::CaptureEvidence::list(
        &service.db.lock(),
        super::super::GLOBAL_GRAPH_ID
    )
    .unwrap()
    .is_empty());
}
#[tokio::test]
async fn snmp_partial_failure_preserves_old_observations_and_provenance_is_visible() {
    let (_dir, mut service, secret) = snmp_service(1);
    let phase = Arc::new(AtomicBool::new(false));
    let p = phase.clone();
    Arc::get_mut(&mut service).unwrap().snmp_execute = Some(Arc::new(move |_, _, _, _| {
        let failed = p.load(Ordering::SeqCst);
        Box::pin(async move {
            let mut value: serde_json::Value =
                serde_json::from_str(&snmp::tests::output(true)).unwrap();
            if failed {
                value["captures"][0]["status"] = "failed".into();
                value["captures"][0]["records"] = serde_json::json!([]);
                value["captures"][0]["observations"][0]["reason"] = "unresolved_local_port".into();
                value["captures"][1]["records"] = serde_json::json!([]);
                value["captures"][1]["observations"] = serde_json::json!([]);
            }
            snmp::decode(&value.to_string())
        })
    }));
    let first = service.start(snmp_request(1, &secret)).unwrap();
    finish(&service, &first.run_id).await;
    let before =
        super::super::evidence::CaptureEvidence::list(&service.db.lock(), &first.graph_id).unwrap();
    phase.store(true, Ordering::SeqCst);
    let second = service.start(snmp_request(1, &secret)).unwrap();
    let report = finish(&service, &second.run_id).await;
    assert_eq!(report.devices[0].status, "partial");
    let after =
        super::super::evidence::CaptureEvidence::list(&service.db.lock(), &first.graph_id).unwrap();
    let cdp = after.iter().find(|r| r.protocol == "cdp").unwrap();
    assert_eq!(
        serde_json::to_value(&cdp.observations).unwrap(),
        serde_json::to_value(
            &before
                .iter()
                .find(|r| r.protocol == "cdp")
                .unwrap()
                .observations
        )
        .unwrap()
    );
    assert_eq!(cdp.snmp_observations.len(), 2);
    assert!(cdp
        .snmp_observations
        .iter()
        .any(|o| o.reason.as_deref() == Some("unresolved_local_port") && o.in_latest_attempt));
    assert!(cdp
        .snmp_observations
        .iter()
        .any(|o| o.reason.is_none() && !o.in_latest_attempt));
    assert!(
        !after
            .iter()
            .find(|r| r.protocol == "lldp")
            .unwrap()
            .observations[0]
            .in_latest_capture
    );
}
#[tokio::test]
async fn snmp_cancelled_late_worker_cannot_refresh_graph_or_receipts() {
    let (_dir, mut service, secret) = snmp_service(1);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (e, r) = (entered.clone(), release.clone());
    Arc::get_mut(&mut service).unwrap().snmp_execute = Some(Arc::new(move |_, _, _, _| {
        let (e, r) = (e.clone(), r.clone());
        Box::pin(async move {
            e.notify_one();
            r.notified().await;
            snmp::decode(&snmp::tests::output(true))
        })
    }));
    let first = service.start(snmp_request(1, &secret)).unwrap();
    entered.notified().await;
    service.cancel(&first.run_id).unwrap();
    let before = serde_json::to_value(
        super::super::evidence::CaptureEvidence::list(&service.db.lock(), &first.graph_id).unwrap(),
    )
    .unwrap();
    release.notify_one();
    assert_eq!(
        finish(&service, &first.run_id).await.state,
        RunState::Cancelled
    );
    assert!(graph::list_edges(&service.db.lock(), &first.graph_id)
        .unwrap()
        .is_empty());
    assert_eq!(
        serde_json::to_value(
            super::super::evidence::CaptureEvidence::list(&service.db.lock(), &first.graph_id)
                .unwrap()
        )
        .unwrap(),
        before
    );
}

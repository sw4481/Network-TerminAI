use ccie_terminal_lib::{
    agent_bridge::AgentBridge,
    db,
    parsers::bridge::ParserBridge,
    topology::{
        discovery::{DiscoveryRequest, RunState, TopologyDiscoveryService},
        GLOBAL_GRAPH_ID,
    },
};
use parking_lot::Mutex;
use std::{collections::HashMap, sync::Arc, time::Duration};

fn request(ids: &[&str]) -> DiscoveryRequest {
    DiscoveryRequest {
        graph_id: GLOBAL_GRAPH_ID.into(),
        seed_ids: ids.iter().map(|s| s.to_string()).collect(),
        eligible_ids: ids.iter().map(|s| s.to_string()).collect(),
        passwords: HashMap::new(),
        max_depth: 0,
        include_routing: false,
        collection_mode: Default::default(),
        snmp_secret_id: None,
    }
}

#[tokio::test]
async fn unsupported_saved_profiles_never_spawn_transport_or_parser() {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("synthetic.db")).unwrap();
    conn.execute("INSERT INTO ssh_connections(id,name,host,port,vendor,platform) VALUES ('unsupported','synthetic','192.0.2.1',22,'juniper','junos')", []).unwrap();
    let db = Arc::new(Mutex::new(conn));
    // This program must never run. The saved platform, not caller input, gates IO.
    let parser = ParserBridge::new(Arc::new(AgentBridge::new("/does-not-exist".into(), vec![])));
    let service = Arc::new(TopologyDiscoveryService::new(db.clone(), parser));
    let started = service.start(request(&["unsupported"])).unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let report = service.status(Some(&started.run_id)).unwrap().unwrap();
            if !report.state.is_active() {
                break report;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completed.state, RunState::Completed);
    assert_eq!(completed.devices.len(), 1);
    assert_eq!(completed.devices[0].status, "unsupported");
    assert!(
        ccie_terminal_lib::topology::graph::list_nodes(&db.lock(), GLOBAL_GRAPH_ID)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn invalid_scope_is_rejected_before_io_and_new_service_has_no_running_job() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Mutex::new(
        db::open_and_migrate(&dir.path().join("synthetic.db")).unwrap(),
    ));
    let parser = ParserBridge::new(Arc::new(AgentBridge::new("/does-not-exist".into(), vec![])));
    let service = Arc::new(TopologyDiscoveryService::new(db, parser));
    assert!(service.status(None).unwrap().is_none());
    assert!(service.start(request(&[])).is_err());
    let mut invalid = request(&["synthetic"]);
    invalid.max_depth = 2;
    assert!(service.start(invalid).is_err());
    let mut invalid = request(&["synthetic"]);
    invalid.eligible_ids.clear();
    assert!(service.start(invalid).is_err());
    assert!(service.status(None).unwrap().is_none());
}

use ccie_terminal_lib::drift::intent::{IntentKind, IntentRepo, IntentSelector, IntentTemplate, MatchMode};
use ccie_terminal_lib::drift::runner;
use ccie_terminal_lib::fanout::events::FanoutEvent;
use ccie_terminal_lib::fanout::executor::{EventSink, Executor, NoopParse};
use ccie_terminal_lib::fanout::store::FanoutStore;
use ccie_terminal_lib::fanout::worker::{
    DeviceWorker, MockWorkerFactory, WorkerError, WorkerFactory, WorkerOutcome,
};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;

struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, _event: &FanoutEvent) {}
}

/// Worker factory that returns canned stdout per device id.
#[derive(Clone)]
struct CannedFactory {
    outputs: std::collections::HashMap<String, String>,
}

impl CannedFactory {
    fn new(map: std::collections::HashMap<String, String>) -> Self {
        Self { outputs: map }
    }
}

#[async_trait::async_trait]
impl WorkerFactory for CannedFactory {
    fn create(
        &self,
        _kind: ccie_terminal_lib::fanout::model::DeviceKind,
        creds: ccie_terminal_lib::fanout::auth::DeviceCreds,
    ) -> Box<dyn DeviceWorker> {
        let host = match creds {
            ccie_terminal_lib::fanout::auth::DeviceCreds::Ssh { host, .. } => host,
            ccie_terminal_lib::fanout::auth::DeviceCreds::Netconf { host, .. } => host,
        };
        let stdout = self
            .outputs
            .get(&host)
            .cloned()
            .unwrap_or_else(|| "no-canned-output\n".to_string());
        Box::new(CannedWorker { stdout })
    }
}

struct CannedWorker {
    stdout: String,
}

#[async_trait::async_trait]
impl DeviceWorker for CannedWorker {
    async fn run(
        &self,
        _command: &str,
        _timeout: Duration,
    ) -> Result<WorkerOutcome, WorkerError> {
        Ok(WorkerOutcome {
            raw_output: self.stdout.clone(),
            duration_ms: 1,
        })
    }
}

fn open_db() -> Arc<Mutex<rusqlite::Connection>> {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let path = tmp.path().to_path_buf();
    std::mem::forget(tmp);
    Arc::new(Mutex::new(
        ccie_terminal_lib::db::open_and_migrate(&path).unwrap(),
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_on_demand_emits_in_sync_and_drift_reports() {
    let db = open_db();

    // Seed two SSH devices and one intent matching both via explicit ids.
    let (id_aligned, id_drifted, template_id) = {
        let conn = db.lock();
        let id_a = FanoutStore::seed_test_ssh(&conn, "aligned", "10.0.0.1").unwrap();
        let id_d = FanoutStore::seed_test_ssh(&conn, "drifted", "10.0.0.2").unwrap();
        let t = IntentRepo::create(
            &conn,
            IntentTemplate {
                id: String::new(),
                name: "core-golden".into(),
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                kind: IntentKind::Golden,
                body: "hostname core-01\n!\nntp server 1.1.1.1\n".to_string(),
                vars_yaml: String::new(),
                selector: IntentSelector {
                    device_ids: vec![format!("ssh:{id_a}"), format!("ssh:{id_d}")],
                    tags: vec![],
                    ..Default::default()
                },
                match_mode: MatchMode::Baseline,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap();
        (id_a, id_d, t)
    };

    // Aligned device returns the exact intent; drifted device has an extra
    // ip name-server line.
    let mut canned = std::collections::HashMap::new();
    canned.insert(
        "10.0.0.1".to_string(),
        "hostname core-01\n!\nntp server 1.1.1.1\n".to_string(),
    );
    canned.insert(
        "10.0.0.2".to_string(),
        "hostname core-01\n!\nntp server 1.1.1.1\nip name-server 8.8.8.8\n".to_string(),
    );
    let factory = CannedFactory::new(canned);
    let executor = Executor::new(
        db.clone(),
        Arc::new(factory),
        Arc::new(NoopSink),
        Arc::new(NoopParse),
    );

    let reports = runner::run_on_demand(db.clone(), executor, &template_id)
        .await
        .unwrap();
    assert_eq!(reports.len(), 2);

    // One in_sync, one drift
    let aligned = reports
        .iter()
        .find(|r| r.device_id == id_aligned)
        .expect("aligned report missing");
    let drifted = reports
        .iter()
        .find(|r| r.device_id == id_drifted)
        .expect("drifted report missing");
    assert_eq!(aligned.status, "in_sync");
    assert_eq!(aligned.severity, "none");
    assert_eq!(drifted.status, "drift");
    assert_eq!(drifted.severity, "destructive");
    assert!(drifted
        .diff_patch
        .as_ref()
        .unwrap()
        .blocks
        .iter()
        .flat_map(|b| &b.changes)
        .any(|c| matches!(c, ccie_terminal_lib::drift::diff::LineChange::Delete { line }
            if line.contains("ip name-server"))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_on_demand_records_error_when_device_fails() {
    let db = open_db();
    let (template_id, _ssh_id) = {
        let conn = db.lock();
        let id = FanoutStore::seed_test_ssh(&conn, "x", "10.5.5.5").unwrap();
        let t = IntentRepo::create(
            &conn,
            IntentTemplate {
                id: String::new(),
                name: "t".into(),
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                kind: IntentKind::Golden,
                body: "hostname x\n".into(),
                vars_yaml: String::new(),
                selector: IntentSelector {
                    device_ids: vec![format!("ssh:{id}")],
                    tags: vec![],
                    ..Default::default()
                },
                match_mode: MatchMode::Baseline,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap();
        (t, id)
    };

    // Failing factory: every worker returns Auth error.
    let factory = MockWorkerFactory::failing(
        Duration::from_millis(5),
        WorkerError::Auth("bad creds".into()),
    );
    let executor = Executor::new(
        db.clone(),
        Arc::new(factory),
        Arc::new(NoopSink),
        Arc::new(NoopParse),
    );
    let reports = runner::run_on_demand(db, executor, &template_id)
        .await
        .unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].status, "error");
    assert_eq!(reports[0].severity, "error");
    assert!(reports[0].error_msg.is_some());
}

#[test]
fn resolve_selector_expands_a_fanout_group_to_its_members() {
    use ccie_terminal_lib::fanout::model::DeviceKind;

    let db = open_db();
    let conn = db.lock();
    // Two SSH devices in a group.
    let a = FanoutStore::seed_test_ssh(&conn, "atl-1", "10.0.0.1").unwrap();
    let b = FanoutStore::seed_test_ssh(&conn, "atl-2", "10.0.0.2").unwrap();
    drop(conn);
    let group_id = {
        let mut conn = db.lock();
        let g = FanoutStore::create_group(&mut conn, "site-atl", None).unwrap();
        FanoutStore::add_member(&conn, &g.id, &a, DeviceKind::Ssh).unwrap();
        FanoutStore::add_member(&conn, &g.id, &b, DeviceKind::Ssh).unwrap();
        g.id
    };

    let tpl = IntentTemplate {
        id: "t".into(),
        name: "t".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        kind: IntentKind::Golden,
        body: String::new(),
        vars_yaml: String::new(),
        selector: IntentSelector {
            group_id: Some(group_id),
            ..Default::default()
        },
        match_mode: MatchMode::Baseline,
        created_at: 0,
        updated_at: 0,
    };

    let conn = db.lock();
    let members = runner::resolve_selector(&conn, &tpl).unwrap();
    let mut ids: Vec<String> = members.into_iter().map(|m| m.device_id).collect();
    ids.sort();
    let mut want = vec![a, b];
    want.sort();
    assert_eq!(ids, want);
}

#[test]
fn resolve_selector_targets_a_single_ssh_connection() {
    let db = open_db();
    let conn = db.lock();
    let id = FanoutStore::seed_test_ssh(&conn, "core-01", "10.9.9.9").unwrap();
    drop(conn);

    let tpl = IntentTemplate {
        id: "t".into(),
        name: "t".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        kind: IntentKind::Golden,
        body: String::new(),
        vars_yaml: String::new(),
        selector: IntentSelector {
            ssh_connection_id: Some(id.clone()),
            ..Default::default()
        },
        match_mode: MatchMode::Baseline,
        created_at: 0,
        updated_at: 0,
    };

    let conn = db.lock();
    let members = runner::resolve_selector(&conn, &tpl).unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].device_id, id);
    assert_eq!(members[0].display_name, "core-01");
}

#[test]
fn resolve_selector_group_takes_precedence_over_ssh_and_device_ids() {
    use ccie_terminal_lib::fanout::model::DeviceKind;
    let db = open_db();
    let conn = db.lock();
    let grp_dev = FanoutStore::seed_test_ssh(&conn, "g1", "10.0.0.1").unwrap();
    let other = FanoutStore::seed_test_ssh(&conn, "other", "10.0.0.2").unwrap();
    drop(conn);
    let group_id = {
        let mut conn = db.lock();
        let g = FanoutStore::create_group(&mut conn, "g", None).unwrap();
        FanoutStore::add_member(&conn, &g.id, &grp_dev, DeviceKind::Ssh).unwrap();
        g.id
    };

    let tpl = IntentTemplate {
        id: "t".into(), name: "t".into(), vendor: "cisco".into(), platform: "iosxe".into(),
        kind: IntentKind::Golden, body: String::new(), vars_yaml: String::new(),
        selector: IntentSelector {
            group_id: Some(group_id),
            ssh_connection_id: Some(other.clone()),
            device_ids: vec![format!("ssh:{other}")],
            ..Default::default()
        },
        match_mode: MatchMode::Baseline,
        created_at: 0, updated_at: 0,
    };

    let conn = db.lock();
    let members = runner::resolve_selector(&conn, &tpl).unwrap();
    assert_eq!(members.len(), 1, "group wins");
    assert_eq!(members[0].device_id, grp_dev);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_on_demand_with_empty_selector_returns_no_reports() {
    let db = open_db();
    let template_id = {
        let conn = db.lock();
        IntentRepo::create(
            &conn,
            IntentTemplate {
                id: String::new(),
                name: "t".into(),
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                kind: IntentKind::Golden,
                body: "".into(),
                vars_yaml: String::new(),
                selector: IntentSelector::default(),
                match_mode: MatchMode::Baseline,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap()
    };
    let executor = Executor::new(
        db.clone(),
        Arc::new(MockWorkerFactory::with_delay(Duration::from_millis(1))),
        Arc::new(NoopSink),
        Arc::new(NoopParse),
    );
    let reports = runner::run_on_demand(db, executor, &template_id)
        .await
        .unwrap();
    assert!(reports.is_empty());
}

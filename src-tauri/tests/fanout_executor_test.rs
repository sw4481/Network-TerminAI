use ccie_terminal_lib::fanout::events::FanoutEvent;
use ccie_terminal_lib::fanout::executor::{EventSink, ExecuteArgs, Executor, MemberRef, NoopParse};
use ccie_terminal_lib::fanout::model::DeviceKind;
use ccie_terminal_lib::fanout::store::FanoutStore;
use ccie_terminal_lib::fanout::worker::{MockWorkerFactory, WorkerError};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;

#[derive(Default, Clone)]
struct VecSink {
    events: Arc<Mutex<Vec<FanoutEvent>>>,
}
impl VecSink {
    fn snapshot(&self) -> Vec<FanoutEvent> {
        self.events.lock().clone()
    }
}
impl EventSink for VecSink {
    fn emit(&self, event: &FanoutEvent) {
        self.events.lock().push(event.clone());
    }
}

fn open_db() -> Arc<Mutex<rusqlite::Connection>> {
    ccie_terminal_lib::rag::vec::register_vec_auto_extension();
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    ccie_terminal_lib::rag::vec::enable_vec_extension(&conn).unwrap();
    ccie_terminal_lib::db::apply_migrations(&mut conn).unwrap();
    Arc::new(Mutex::new(conn))
}

fn seed_ssh(db: &Arc<Mutex<rusqlite::Connection>>, n: usize) -> Vec<MemberRef> {
    let conn = db.lock();
    (0..n)
        .map(|i| {
            let name = format!("d{i}");
            let host = format!("10.0.0.{}", i + 1);
            let id = FanoutStore::seed_test_ssh(&conn, &name, &host).unwrap();
            MemberRef {
                device_id: id,
                device_kind: DeviceKind::Ssh,
                display_name: name,
            }
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn executor_fans_out_50_and_caps_concurrency() {
    let db = open_db();
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(150));
    let sink = VecSink::default();
    let ex = Executor::new(
        db.clone(),
        Arc::new(factory.clone()),
        Arc::new(sink.clone()),
        Arc::new(NoopParse),
    );
    let members = seed_ssh(&db, 50);

    let args = ExecuteArgs {
        command: "show version".into(),
        group_id: None,
        members,
        timeout_ms: 30_000,
        concurrency: 50,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();

    assert_eq!(outcome.succeeded, 50, "expected 50 successes");
    assert_eq!(outcome.failed, 0);
    // The real proof of concurrency is peak_concurrency == 50 below (serial
    // execution would peak at 1 and take ~50*150ms). The wall-clock bound is a
    // nice-to-have that flakes on loaded/shared CI runners (observed 509ms), so
    // only enforce it off-CI.
    if std::env::var_os("CI").is_none() {
        assert!(
            outcome.duration_ms < 350,
            "expected p100 well under 2x single-device 150ms; got {}ms",
            outcome.duration_ms
        );
    }
    assert_eq!(factory.peak_concurrency(), 50);

    // Run summary status reflects all-success rollup
    let summary = FanoutStore::get_run_summary(&db.lock(), &run_id).unwrap();
    assert_eq!(summary.status, "success");
    assert_eq!(summary.total, 50);
    assert_eq!(summary.succeeded, 50);

    // Sink saw a RunStarted and a RunCompleted
    let events = sink.snapshot();
    assert!(events
        .iter()
        .any(|e| matches!(e, FanoutEvent::RunStarted { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, FanoutEvent::RunCompleted { succeeded: 50, .. })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn executor_enforces_per_device_timeout() {
    let db = open_db();
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(5_000));
    let sink = VecSink::default();
    let ex = Executor::new(
        db.clone(),
        Arc::new(factory),
        Arc::new(sink.clone()),
        Arc::new(NoopParse),
    );
    let members = seed_ssh(&db, 5);
    let args = ExecuteArgs {
        command: "show run".into(),
        group_id: None,
        members,
        timeout_ms: 100,
        concurrency: 5,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();
    assert_eq!(outcome.succeeded, 0);
    assert_eq!(outcome.failed, 5);
    use ccie_terminal_lib::fanout::events::FailureKind;
    assert!(outcome
        .failures
        .iter()
        .all(|f| matches!(f.kind, FailureKind::Timeout)));

    let summary = FanoutStore::get_run_summary(&db.lock(), &run_id).unwrap();
    assert_eq!(summary.status, "failed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn executor_run_cancel_propagates() {
    let db = open_db();
    let factory = MockWorkerFactory::with_delay(Duration::from_secs(10));
    let sink = VecSink::default();
    let ex = Executor::new(
        db.clone(),
        Arc::new(factory),
        Arc::new(sink.clone()),
        Arc::new(NoopParse),
    );
    let members = seed_ssh(&db, 10);
    let args = ExecuteArgs {
        command: "show".into(),
        group_id: None,
        members,
        timeout_ms: 30_000,
        concurrency: 10,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    ex.cancel_run(&run_id).unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();
    assert_eq!(outcome.cancelled, 10);
    assert!(
        outcome.duration_ms < 1000,
        "cancel should propagate quickly; took {}ms",
        outcome.duration_ms
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn executor_partial_run_status() {
    let db = open_db();
    let factory_ok = MockWorkerFactory::with_delay(Duration::from_millis(50));
    let sink = VecSink::default();
    let ex = Executor::new(
        db.clone(),
        Arc::new(factory_ok),
        Arc::new(sink),
        Arc::new(NoopParse),
    );
    let members = seed_ssh(&db, 3);
    let args = ExecuteArgs {
        command: "show".into(),
        group_id: None,
        members,
        timeout_ms: 30_000,
        concurrency: 3,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    // Cancel only one device
    {
        let device_id = {
            let conn = db.lock();
            let mut stmt = conn
                .prepare("SELECT device_id FROM fanout_run_results LIMIT 1")
                .unwrap();
            stmt.query_row([], |r| r.get::<_, String>(0)).unwrap()
        };
        ex.cancel_device(&run_id, &device_id, DeviceKind::Ssh)
            .unwrap();
    }
    let outcome = ex.await_run(&run_id).await.unwrap();
    let summary = FanoutStore::get_run_summary(&db.lock(), &run_id).unwrap();
    // Either the cancel raced with success and status ended `success`, or one
    // device cancelled and we got `partial`. Both rolls are valid; assert
    // counters add up.
    assert_eq!(outcome.succeeded + outcome.failed + outcome.cancelled, 3);
    assert!(matches!(summary.status.as_str(), "success" | "partial"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn executor_classifies_auth_failure() {
    let db = open_db();
    let factory = MockWorkerFactory::failing(
        Duration::from_millis(10),
        WorkerError::Auth("bad creds".into()),
    );
    let sink = VecSink::default();
    let ex = Executor::new(
        db.clone(),
        Arc::new(factory),
        Arc::new(sink),
        Arc::new(NoopParse),
    );
    let members = seed_ssh(&db, 4);
    let args = ExecuteArgs {
        command: "show".into(),
        group_id: None,
        members,
        timeout_ms: 30_000,
        concurrency: 4,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();
    assert_eq!(outcome.failed, 4);
    use ccie_terminal_lib::fanout::events::FailureKind;
    assert!(outcome
        .failures
        .iter()
        .all(|f| matches!(f.kind, FailureKind::Auth)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn executor_zero_member_run_completes_immediately() {
    let db = open_db();
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(10));
    let sink = VecSink::default();
    let ex = Executor::new(db, Arc::new(factory), Arc::new(sink), Arc::new(NoopParse));
    let args = ExecuteArgs {
        command: "x".into(),
        group_id: None,
        members: vec![],
        timeout_ms: 1000,
        concurrency: 50,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();
    assert_eq!(outcome.succeeded, 0);
    assert_eq!(outcome.failed, 0);
    assert_eq!(outcome.cancelled, 0);
}

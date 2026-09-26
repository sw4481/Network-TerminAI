use ccie_terminal_lib::drift::intent::{IntentKind, IntentRepo, IntentSelector, IntentTemplate, MatchMode};
use ccie_terminal_lib::drift::schedule::DriftScheduleRepo;
use ccie_terminal_lib::drift::scheduler::{DriftScheduler, ScheduleSink};
use ccie_terminal_lib::fanout::events::FanoutEvent;
use ccie_terminal_lib::fanout::executor::{EventSink, Executor, NoopParse};
use ccie_terminal_lib::fanout::worker::MockWorkerFactory;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

struct CountingSink {
    fired: Arc<AtomicUsize>,
}
impl ScheduleSink for CountingSink {
    fn emit_run_completed(&self, _id: &str, _t: &str, _ok: bool, _s: &str) {
        self.fired.fetch_add(1, Ordering::SeqCst);
    }
}
struct NoopFanSink;
impl EventSink for NoopFanSink {
    fn emit(&self, _: &FanoutEvent) {}
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
async fn schedule_crud_persists_and_lists() {
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
                body: String::new(),
                vars_yaml: String::new(),
                selector: IntentSelector::default(),
                match_mode: MatchMode::Baseline,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap()
    };

    let s = {
        let conn = db.lock();
        DriftScheduleRepo::create(&conn, &template_id, "0 0 * * * *").unwrap()
    };
    assert!(s.enabled);
    let conn = db.lock();
    let listed = DriftScheduleRepo::list_enabled(&conn).unwrap();
    assert_eq!(listed.len(), 1);

    DriftScheduleRepo::set_enabled(&conn, &s.id, false).unwrap();
    assert_eq!(DriftScheduleRepo::list_enabled(&conn).unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scheduler_fires_secondly_cron() {
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
                body: String::new(),
                vars_yaml: String::new(),
                // Empty selector → run_on_demand returns Ok(vec![])
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
        Arc::new(NoopFanSink),
        Arc::new(NoopParse),
    );
    let fired = Arc::new(AtomicUsize::new(0));
    let scheduler = DriftScheduler::new(
        db.clone(),
        executor,
        Arc::new(CountingSink {
            fired: fired.clone(),
        }),
    );
    scheduler.start().await.unwrap();

    // Fire every second.
    let _ = scheduler
        .add_schedule(&template_id, "*/1 * * * * *")
        .await
        .unwrap();

    // Wait long enough for ≥1 firing.
    tokio::time::sleep(Duration::from_millis(2_500)).await;

    let count = fired.load(Ordering::SeqCst);
    assert!(count >= 1, "expected scheduler to have fired at least once, got {count}");

    scheduler.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_disables_and_resume_re_enables() {
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
                body: String::new(),
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
        Arc::new(NoopFanSink),
        Arc::new(NoopParse),
    );
    let scheduler = DriftScheduler::new(
        db.clone(),
        executor,
        Arc::new(CountingSink {
            fired: Arc::new(AtomicUsize::new(0)),
        }),
    );
    scheduler.start().await.unwrap();
    let s = scheduler
        .add_schedule(&template_id, "0 0 * * * *")
        .await
        .unwrap();

    scheduler.pause(&s.id).await.unwrap();
    {
        let conn = db.lock();
        let row = DriftScheduleRepo::get(&conn, &s.id).unwrap().unwrap();
        assert!(!row.enabled);
    }

    scheduler.resume(&s.id).await.unwrap();
    {
        let conn = db.lock();
        let row = DriftScheduleRepo::get(&conn, &s.id).unwrap().unwrap();
        assert!(row.enabled);
    }
    scheduler.shutdown().await.unwrap();
}

use super::*;
use crate::heartbeat::repo::HeartbeatRepo;

fn test_db() -> Arc<Mutex<Connection>> {
    crate::rag::vec::register_vec_auto_extension();
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    crate::rag::vec::enable_vec_extension(&conn).unwrap();
    crate::db::apply_migrations(&mut conn).unwrap();
    Arc::new(Mutex::new(conn))
}

fn heartbeat_due(db: &Arc<Mutex<Connection>>, id: &str) -> Option<i64> {
    let conn = db.lock();
    HeartbeatRepo::get_heartbeat(&conn, id)
        .unwrap()
        .unwrap()
        .next_run_at
}

#[test]
fn exact_non_cron_intervals_are_preserved() {
    assert_eq!(interval_seconds(39).unwrap(), 2_340);
    assert_eq!(interval_seconds(90).unwrap(), 5_400);
    assert_eq!(interval_seconds(1_440).unwrap(), 86_400);
    assert_eq!(interval_seconds(2_880).unwrap(), 172_800);
    assert_eq!(
        first_future_due(10_000, None, interval_seconds(39).unwrap()).unwrap(),
        12_340
    );
    assert_eq!(
        first_future_due(10_000, None, interval_seconds(90).unwrap()).unwrap(),
        15_400
    );
}

#[test]
fn interval_must_be_nonzero() {
    let error = interval_seconds(0).unwrap_err();
    assert!(error.to_string().contains("at least 1 minute"));
}

#[test]
fn restart_preserves_future_phase_and_advances_stale_phase() {
    assert_eq!(first_future_due(1_000, Some(1_001), 300).unwrap(), 1_001);
    assert_eq!(first_future_due(1_000, Some(100), 300).unwrap(), 1_300);
    assert_eq!(first_future_due(1_000, Some(1_000), 300).unwrap(), 1_300);
    assert_eq!(first_future_due(1_000, None, 300).unwrap(), 1_300);
}

#[test]
fn delayed_run_skips_every_missed_tick_in_closed_form() {
    // Phase: 1000, 3340, 5680, 8020, 10360. A run completing at 9000
    // advances directly to 10360 and never replays the three missed ticks.
    assert_eq!(first_future_due(9_000, Some(1_000), 2_340).unwrap(), 10_360);
}

#[test]
fn tick_persists_next_phase_before_queue_and_readvances_after_long_run() {
    let next_at_tick = first_future_due(1_000, Some(1_000), 300).unwrap();
    assert_eq!(next_at_tick, 1_300);

    // Finishing before the next phase leaves the already-persisted due alone.
    assert_eq!(
        first_future_due(1_250, Some(next_at_tick), 300).unwrap(),
        1_300
    );

    // A queue/run crossing 1300, 1600, and 1900 skips directly to 2200.
    assert_eq!(
        first_future_due(1_900, Some(next_at_tick), 300).unwrap(),
        2_200
    );
}

#[test]
fn invalid_concurrency_configuration_defaults_and_large_values_clamp() {
    assert_eq!(parse_max_concurrency(None), 1);
    assert_eq!(parse_max_concurrency(Some("")), 1);
    assert_eq!(parse_max_concurrency(Some("0")), 1);
    assert_eq!(parse_max_concurrency(Some("-1")), 1);
    assert_eq!(parse_max_concurrency(Some("not-a-number")), 1);
    assert_eq!(parse_max_concurrency(Some(" 2 ")), 2);
    assert_eq!(
        parse_max_concurrency(Some("999")),
        MAX_CONFIGURED_CONCURRENCY
    );
}

#[tokio::test]
async fn keyed_gate_prevents_same_heartbeat_overlap() {
    let admission = RunAdmission::new(2);
    let first = admission.acquire("heartbeat-a").await.unwrap();

    assert!(
        tokio::time::timeout(Duration::from_millis(25), admission.acquire("heartbeat-a"))
            .await
            .is_err()
    );

    // A different heartbeat can use the second global slot.
    let other = tokio::time::timeout(Duration::from_millis(100), admission.acquire("heartbeat-b"))
        .await
        .unwrap()
        .unwrap();

    drop(other);
    drop(first);
}

#[tokio::test]
async fn global_gate_honors_limits_one_and_two() {
    let serial = RunAdmission::new(1);
    let serial_first = serial.acquire("heartbeat-a").await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(25), serial.acquire("heartbeat-b"))
            .await
            .is_err()
    );
    drop(serial_first);
    tokio::time::timeout(Duration::from_millis(100), serial.acquire("heartbeat-b"))
        .await
        .unwrap()
        .unwrap();

    let parallel = RunAdmission::new(2);
    let first = parallel.acquire("heartbeat-a").await.unwrap();
    let second = parallel.acquire("heartbeat-b").await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(25), parallel.acquire("heartbeat-c"))
            .await
            .is_err()
    );
    drop(first);
    tokio::time::timeout(Duration::from_millis(100), parallel.acquire("heartbeat-c"))
        .await
        .unwrap()
        .unwrap();
    drop(second);
}

#[tokio::test]
async fn queued_scheduled_acquisition_is_cancellation_aware() {
    let admission = RunAdmission::new(1);
    let blocker = admission.acquire("heartbeat-a").await.unwrap();
    let cancellation = CancellationToken::new();
    let acquisition = admission.acquire_scheduled("heartbeat-b", &cancellation);
    tokio::pin!(acquisition);

    // Let the future acquire its keyed permit and block on the global gate.
    tokio::task::yield_now().await;
    cancellation.cancel();

    let result = tokio::time::timeout(Duration::from_millis(100), acquisition)
        .await
        .unwrap();
    assert!(result.is_none());
    drop(blocker);
}

#[tokio::test]
async fn retiring_gate_rejects_new_runs_drains_retained_run_and_is_removed() {
    let admission = RunAdmission::new(2);
    let retained_run = admission.acquire("heartbeat-a").await.unwrap();
    assert!(admission.has_heartbeat_gate("heartbeat-a"));

    let retiring_gate = admission.begin_retirement("heartbeat-a");
    let rejected =
        tokio::time::timeout(Duration::from_millis(100), admission.acquire("heartbeat-a"))
            .await
            .unwrap();
    assert!(rejected.is_err());

    let drain = retiring_gate.semaphore.clone().acquire_owned();
    tokio::pin!(drain);
    assert!(tokio::time::timeout(Duration::from_millis(25), &mut drain)
        .await
        .is_err());

    drop(retained_run);
    let exclusive = tokio::time::timeout(Duration::from_millis(100), drain)
        .await
        .unwrap()
        .unwrap();
    admission.finish_retirement("heartbeat-a", &retiring_gate, true);
    assert!(!admission.has_heartbeat_gate("heartbeat-a"));
    drop(exclusive);
}

#[tokio::test]
async fn trigger_selected_gate_cannot_be_recreated_after_concurrent_retirement() {
    let admission = RunAdmission::new(1);

    // Model trigger_now's atomic DB-check/gate-selection step, followed by a
    // delete that wins before the trigger polls permit acquisition.
    let selected = admission.select_gate("heartbeat-a").unwrap();
    let retiring_gate = admission.begin_retirement("heartbeat-a");
    let exclusive = retiring_gate
        .semaphore
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    admission.finish_retirement("heartbeat-a", &retiring_gate, true);
    assert!(!admission.has_heartbeat_gate("heartbeat-a"));

    assert!(admission
        .acquire_selected("heartbeat-a", selected)
        .await
        .is_err());
    assert!(!admission.has_heartbeat_gate("heartbeat-a"));
    drop(exclusive);
}

#[tokio::test]
async fn lifecycle_uses_fresh_phases_for_resume_and_update_but_preserves_restart_phase() {
    let db = test_db();
    let heartbeat = {
        let conn = db.lock();
        HeartbeatRepo::create_heartbeat(&conn, "Lifecycle", "test", 39, 30).unwrap()
    };

    let persisted_future = epoch_seconds().unwrap() + 60_000;
    {
        let conn = db.lock();
        HeartbeatRepo::set_next_run(&conn, &heartbeat.id, Some(persisted_future)).unwrap();
    }

    let bridge = AgentBridge::new("/usr/bin/false".to_string(), Vec::new());
    let scheduler = HeartbeatScheduler::new(db.clone(), bridge.clone(), Arc::new(NoopSink));
    scheduler.start().await.unwrap();
    assert_eq!(heartbeat_due(&db, &heartbeat.id), Some(persisted_future));

    scheduler.pause(&heartbeat.id).await.unwrap();
    {
        let conn = db.lock();
        let paused = HeartbeatRepo::get_heartbeat(&conn, &heartbeat.id)
            .unwrap()
            .unwrap();
        assert!(!paused.enabled);
        assert_eq!(paused.next_run_at, None);
    }

    let resume_before = epoch_seconds().unwrap();
    scheduler.resume(&heartbeat.id).await.unwrap();
    let resume_after = epoch_seconds().unwrap();
    let resumed_due = heartbeat_due(&db, &heartbeat.id).unwrap();
    assert!(resumed_due >= resume_before + 2_340);
    assert!(resumed_due <= resume_after + 2_340);

    {
        let conn = db.lock();
        HeartbeatRepo::update_heartbeat(&conn, &heartbeat.id, "Lifecycle updated", "test", 90, 30)
            .unwrap();
    }
    let updated = {
        let conn = db.lock();
        HeartbeatRepo::get_heartbeat(&conn, &heartbeat.id)
            .unwrap()
            .unwrap()
    };
    let update_before = epoch_seconds().unwrap();
    scheduler.add_heartbeat(&updated).await.unwrap();
    let update_after = epoch_seconds().unwrap();
    let updated_due = heartbeat_due(&db, &heartbeat.id).unwrap();
    assert!(updated_due >= update_before + 5_400);
    assert!(updated_due <= update_after + 5_400);

    scheduler.shutdown().await.unwrap();
    assert_eq!(heartbeat_due(&db, &heartbeat.id), Some(updated_due));

    let restarted = HeartbeatScheduler::new(db.clone(), bridge, Arc::new(NoopSink));
    restarted.start().await.unwrap();
    assert_eq!(heartbeat_due(&db, &heartbeat.id), Some(updated_due));
    restarted.shutdown().await.unwrap();
}

#[tokio::test]
async fn stale_enabled_snapshot_cannot_resurrect_a_paused_heartbeat() {
    let db = test_db();
    let stale_enabled_snapshot = {
        let conn = db.lock();
        HeartbeatRepo::create_heartbeat(&conn, "Pause race", "test", 39, 30).unwrap()
    };
    let scheduler = HeartbeatScheduler::new(
        db.clone(),
        AgentBridge::new("/usr/bin/false".to_string(), Vec::new()),
        Arc::new(NoopSink),
    );
    scheduler.start().await.unwrap();
    assert!(scheduler
        .inner
        .tasks
        .lock()
        .contains_key(&stale_enabled_snapshot.id));

    // Reproduce the harmful ordering deterministically: heartbeat_update held
    // this enabled snapshot, then pause won the lifecycle lock first.
    scheduler.pause(&stale_enabled_snapshot.id).await.unwrap();
    scheduler
        .add_heartbeat(&stale_enabled_snapshot)
        .await
        .unwrap();

    let current = {
        let conn = db.lock();
        HeartbeatRepo::get_heartbeat(&conn, &stale_enabled_snapshot.id)
            .unwrap()
            .unwrap()
    };
    assert!(!current.enabled);
    assert_eq!(current.next_run_at, None);
    assert!(!scheduler
        .inner
        .tasks
        .lock()
        .contains_key(&stale_enabled_snapshot.id));
    scheduler.shutdown().await.unwrap();
}

#[tokio::test]
async fn manual_trigger_does_not_shift_periodic_phase() {
    let db = test_db();
    let heartbeat = {
        let conn = db.lock();
        HeartbeatRepo::create_heartbeat(&conn, "Manual", "test", 39, 30).unwrap()
    };
    let scheduler = HeartbeatScheduler::new(
        db.clone(),
        AgentBridge::new("/usr/bin/false".to_string(), Vec::new()),
        Arc::new(NoopSink),
    );
    scheduler.start().await.unwrap();

    let due_before = heartbeat_due(&db, &heartbeat.id);
    scheduler.trigger_now(&heartbeat.id).await.unwrap();
    assert_eq!(heartbeat_due(&db, &heartbeat.id), due_before);

    {
        let conn = db.lock();
        let executions =
            HeartbeatRepo::get_execution_history(&conn, &heartbeat.id, Some(10)).unwrap();
        assert_eq!(executions.len(), 1);
    }
    scheduler.shutdown().await.unwrap();
}

#[tokio::test]
async fn delete_removes_the_heartbeat_gate_after_runs_are_drained() {
    let db = test_db();
    let heartbeat = {
        let conn = db.lock();
        HeartbeatRepo::create_heartbeat(&conn, "Delete", "test", 39, 30).unwrap()
    };
    let scheduler = HeartbeatScheduler::new(
        db.clone(),
        AgentBridge::new("/usr/bin/false".to_string(), Vec::new()),
        Arc::new(NoopSink),
    );
    scheduler.start().await.unwrap();
    scheduler.trigger_now(&heartbeat.id).await.unwrap();
    assert!(scheduler.inner.admission.has_heartbeat_gate(&heartbeat.id));

    scheduler.delete(&heartbeat.id).await.unwrap();
    assert!(!scheduler.inner.admission.has_heartbeat_gate(&heartbeat.id));
    {
        let conn = db.lock();
        assert!(HeartbeatRepo::get_heartbeat(&conn, &heartbeat.id)
            .unwrap()
            .is_none());
    }
    scheduler.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_delete_restores_enabled_heartbeat_task_and_phase() {
    let db = test_db();
    let heartbeat = {
        let conn = db.lock();
        HeartbeatRepo::create_heartbeat(&conn, "Delete rollback", "test", 39, 30).unwrap()
    };
    let scheduler = HeartbeatScheduler::new(
        db.clone(),
        AgentBridge::new("/usr/bin/false".to_string(), Vec::new()),
        Arc::new(NoopSink),
    );
    scheduler.start().await.unwrap();
    let due_before = heartbeat_due(&db, &heartbeat.id).unwrap();
    assert!(scheduler.inner.tasks.lock().contains_key(&heartbeat.id));

    {
        let conn = db.lock();
        conn.execute_batch(
            "CREATE TRIGGER inject_heartbeat_delete_failure
             BEFORE DELETE ON heartbeats
             BEGIN
                 SELECT RAISE(FAIL, 'injected heartbeat delete failure');
             END;",
        )
        .unwrap();
    }

    let error = scheduler.delete(&heartbeat.id).await.unwrap_err();
    assert!(error
        .to_string()
        .contains("injected heartbeat delete failure"));

    let surviving = {
        let conn = db.lock();
        HeartbeatRepo::get_heartbeat(&conn, &heartbeat.id)
            .unwrap()
            .unwrap()
    };
    assert!(surviving.enabled);
    assert_eq!(surviving.next_run_at, Some(due_before));
    assert!(scheduler.inner.tasks.lock().contains_key(&heartbeat.id));
    let gate = scheduler
        .inner
        .admission
        .heartbeat_gates
        .lock()
        .get(&heartbeat.id)
        .cloned()
        .unwrap();
    assert!(!gate.retiring.load(Ordering::Acquire));

    {
        let conn = db.lock();
        conn.execute_batch("DROP TRIGGER inject_heartbeat_delete_failure")
            .unwrap();
    }
    scheduler.delete(&heartbeat.id).await.unwrap();
    scheduler.shutdown().await.unwrap();
}

#[tokio::test]
async fn deleting_missing_heartbeat_does_not_create_a_gate() {
    let db = test_db();
    let scheduler = HeartbeatScheduler::new(
        db,
        AgentBridge::new("/usr/bin/false".to_string(), Vec::new()),
        Arc::new(NoopSink),
    );
    scheduler.start().await.unwrap();

    let missing_id = "missing-heartbeat";
    assert!(scheduler.delete(missing_id).await.is_err());
    assert!(!scheduler.inner.admission.has_heartbeat_gate(missing_id));
    scheduler.shutdown().await.unwrap();
}

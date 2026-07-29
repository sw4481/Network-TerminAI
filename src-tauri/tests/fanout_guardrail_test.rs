//! Final security review — Finding 1.
//!
//! Plan 09's classifier MUST gate the multi-device fan-out executor: a
//! Tier-3 command (`reload`, `write erase`) submitted via the fan-out
//! Run path MUST NOT reach any worker. Before this guardrail wiring, a
//! caller could `fanout_run_start("reload", group_id=…)` and the
//! command would hit every device's SSH session without a confirmation
//! dialog.
//!
//! Strategy:
//!   * Build an `Executor::with_ruleset` against the production builtin
//!     RuleSet.
//!   * Inject a `MockWorkerFactory` that increments a counter on every
//!     `run` call.
//!   * Submit a Tier-3 command across multiple devices.
//!   * Assert: counter is 0, every device row is `blocked_by_guardrail`,
//!     and the run finalizes as `failed`.

use ccie_terminal_lib::fanout::events::{FailureKind, FanoutEvent};
use ccie_terminal_lib::fanout::executor::{
    EventSink, ExecuteArgs, Executor, MemberRef, NoopParse,
};
use ccie_terminal_lib::fanout::model::DeviceKind;
use ccie_terminal_lib::fanout::store::FanoutStore;
use ccie_terminal_lib::fanout::worker::MockWorkerFactory;
use ccie_terminal_lib::guardrails::rules::RuleSet;
use parking_lot::{Mutex, RwLock};
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
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let path = tmp.path().to_path_buf();
    std::mem::forget(tmp); // keep the file alive for the duration of the test
    let conn = ccie_terminal_lib::db::open_and_migrate(&path).unwrap();
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

fn ruleset() -> Arc<RwLock<RuleSet>> {
    Arc::new(RwLock::new(RuleSet::load_builtin().expect("builtin rules load")))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tier3_reload_is_blocked_before_worker_runs() {
    let db = open_db();
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(5));
    let sink = VecSink::default();
    let ex = Executor::with_ruleset(
        db.clone(),
        Arc::new(factory.clone()),
        Arc::new(sink.clone()),
        Arc::new(NoopParse),
        ruleset(),
    );
    let members = seed_ssh(&db, 5);

    let args = ExecuteArgs {
        command: "reload".into(),
        group_id: None,
        members: members.clone(),
        timeout_ms: 30_000,
        concurrency: 5,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    // The guardrail short-circuits synchronously before any worker is
    // spawned, so we don't `await_run` (no driver task was registered).
    // The DB rows are finalized inline by `spawn_run` itself.

    // No worker invocations.
    assert_eq!(
        factory.history().await.len(),
        0,
        "Tier-3 `reload` MUST NOT reach the worker"
    );

    // Every device row was finalized with status `blocked_by_guardrail`.
    let detail = FanoutStore::get_run_detail(&db.lock(), &run_id).unwrap();
    assert_eq!(detail.devices.len(), 5);
    for d in &detail.devices {
        assert_eq!(
            d.status, "blocked_by_guardrail",
            "device {} status was {:?}",
            d.device_id, d.status
        );
        assert!(
            d.error.as_deref().unwrap_or("").contains("Tier-0"),
            "expected guardrail reason, got {:?}",
            d.error,
        );
    }

    // The event stream surfaced the rejection so the frontend can react.
    let events = sink.snapshot();
    let device_failed_count = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                FanoutEvent::DeviceFailed {
                    failure_kind: FailureKind::BlockedByGuardrail,
                    ..
                }
            )
        })
        .count();
    assert_eq!(
        device_failed_count, 5,
        "expected 5 BlockedByGuardrail events, saw {device_failed_count}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tier3_write_erase_is_blocked_before_worker_runs() {
    let db = open_db();
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(5));
    let sink = VecSink::default();
    let ex = Executor::with_ruleset(
        db.clone(),
        Arc::new(factory.clone()),
        Arc::new(sink.clone()),
        Arc::new(NoopParse),
        ruleset(),
    );
    let members = seed_ssh(&db, 3);

    let args = ExecuteArgs {
        command: "write erase".into(),
        group_id: None,
        members,
        timeout_ms: 30_000,
        concurrency: 3,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    // Synchronous short-circuit on the guardrail path; no await needed.

    assert_eq!(
        factory.history().await.len(),
        0,
        "`write erase` MUST NOT reach the worker"
    );
    let detail = FanoutStore::get_run_detail(&db.lock(), &run_id).unwrap();
    for d in &detail.devices {
        assert_eq!(d.status, "blocked_by_guardrail");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_chain_injection_in_command_is_blocked() {
    // A `show version ; reload` command would classify as Tier-0 if we
    // didn't shell-split, because the leading `show version` matches the
    // read-only safety default. The shared `split_for_classification`
    // helper must catch the trailing `reload` chunk and refuse the run.
    let db = open_db();
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(5));
    let sink = VecSink::default();
    let ex = Executor::with_ruleset(
        db.clone(),
        Arc::new(factory.clone()),
        Arc::new(sink.clone()),
        Arc::new(NoopParse),
        ruleset(),
    );
    let members = seed_ssh(&db, 2);

    let args = ExecuteArgs {
        command: "show version ; reload".into(),
        group_id: None,
        members,
        timeout_ms: 30_000,
        concurrency: 2,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    // Synchronous short-circuit on the guardrail path; no await needed.

    assert_eq!(
        factory.history().await.len(),
        0,
        "shell-chained reload MUST NOT reach the worker"
    );
    let detail = FanoutStore::get_run_detail(&db.lock(), &run_id).unwrap();
    for d in &detail.devices {
        assert_eq!(d.status, "blocked_by_guardrail");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tier0_show_command_is_dispatched_normally() {
    // Sanity: when the command is genuinely Tier-0, the gate stays out of
    // the way and the workers actually run.
    let db = open_db();
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(5));
    let sink = VecSink::default();
    let ex = Executor::with_ruleset(
        db.clone(),
        Arc::new(factory.clone()),
        Arc::new(sink.clone()),
        Arc::new(NoopParse),
        ruleset(),
    );
    let members = seed_ssh(&db, 4);

    let args = ExecuteArgs {
        command: "show version".into(),
        group_id: None,
        members,
        timeout_ms: 30_000,
        concurrency: 4,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();

    assert_eq!(outcome.succeeded, 4, "Tier-0 should run normally");
    assert_eq!(factory.history().await.len(), 4);
}

use ccie_terminal_lib::fanout::executor::{
    EventSink, ExecuteArgs, Executor, MemberRef, NoopParse,
};
use ccie_terminal_lib::fanout::events::FanoutEvent;
use ccie_terminal_lib::fanout::model::DeviceKind;
use ccie_terminal_lib::fanout::store::FanoutStore;
use ccie_terminal_lib::fanout::worker::MockWorkerFactory;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;

struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, _event: &FanoutEvent) {}
}

fn open_db() -> Arc<Mutex<rusqlite::Connection>> {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let path = tmp.path().to_path_buf();
    std::mem::forget(tmp);
    let conn = ccie_terminal_lib::db::open_and_migrate(&path).unwrap();
    Arc::new(Mutex::new(conn))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_persists_block_and_tag_per_device() {
    let db = open_db();
    let members: Vec<MemberRef> = {
        let conn = db.lock();
        (0..3)
            .map(|i| {
                let id = FanoutStore::seed_test_ssh(
                    &conn,
                    &format!("d{i}"),
                    &format!("10.0.0.{i}"),
                )
                .unwrap();
                MemberRef {
                    device_id: id,
                    device_kind: DeviceKind::Ssh,
                    display_name: format!("d{i}"),
                }
            })
            .collect()
    };
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(20));
    let ex = Executor::new(
        db.clone(),
        Arc::new(factory),
        Arc::new(NoopSink),
        Arc::new(NoopParse),
    );
    let args = ExecuteArgs {
        command: "show ip int br".into(),
        group_id: None,
        members,
        timeout_ms: 5_000,
        concurrency: 3,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();
    assert_eq!(outcome.succeeded, 3);

    let conn = db.lock();
    // 3 result rows, all success, each with a non-null block_id
    let mut stmt = conn
        .prepare(
            "SELECT block_id, status FROM fanout_run_results WHERE run_id = ?1",
        )
        .unwrap();
    let rows: Vec<(Option<String>, String)> = stmt
        .query_map([&run_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|(b, s)| b.is_some() && s == "success"));

    // Each block_id has a fanout:<run_id> tag
    let tag = format!("fanout:{run_id}");
    let mut stmt = conn
        .prepare(
            "SELECT COUNT(*) FROM block_tags
             WHERE tag = ?1 AND block_id IN (SELECT block_id FROM fanout_run_results WHERE run_id=?2)",
        )
        .unwrap();
    let n: i64 = stmt.query_row([&tag, &run_id], |r| r.get(0)).unwrap();
    assert_eq!(n, 3, "expected 3 fanout:<run_id> tags");

    // Each block has its raw output
    let mut stmt = conn
        .prepare(
            "SELECT cmd, output FROM command_blocks
             WHERE id IN (SELECT block_id FROM fanout_run_results WHERE run_id=?1)",
        )
        .unwrap();
    let blocks: Vec<(String, Vec<u8>)> = stmt
        .query_map([&run_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(blocks.len(), 3);
    assert!(blocks
        .iter()
        .all(|(cmd, raw)| cmd == "show ip int br" && !raw.is_empty()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fanout_run_get_returns_devices_after_run() {
    let db = open_db();
    let members: Vec<MemberRef> = {
        let conn = db.lock();
        (0..2)
            .map(|i| {
                let id = FanoutStore::seed_test_ssh(
                    &conn,
                    &format!("d{i}"),
                    &format!("10.0.0.{i}"),
                )
                .unwrap();
                MemberRef {
                    device_id: id,
                    device_kind: DeviceKind::Ssh,
                    display_name: format!("d{i}"),
                }
            })
            .collect()
    };
    let ex = Executor::new(
        db.clone(),
        Arc::new(MockWorkerFactory::with_delay(Duration::from_millis(15))),
        Arc::new(NoopSink),
        Arc::new(NoopParse),
    );
    let args = ExecuteArgs {
        command: "show".into(),
        group_id: None,
        members,
        timeout_ms: 5_000,
        concurrency: 2,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    let _ = ex.await_run(&run_id).await.unwrap();

    let detail = FanoutStore::get_run_detail(&db.lock(), &run_id).unwrap();
    assert_eq!(detail.summary.status, "success");
    assert_eq!(detail.devices.len(), 2);
    assert!(detail.devices.iter().all(|d| d.status == "success"));
    assert!(detail.devices.iter().all(|d| d.block_id.is_some()));
}

#[test]
fn cleanup_orphan_runs_marks_in_progress_runs_as_failed() {
    let db = open_db();
    let conn = db.lock();
    // Manually seed an in-progress run
    conn.execute(
        "INSERT INTO fanout_runs(id, command, status) VALUES('orphan-1','show','running')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO fanout_run_results(run_id, device_id, device_kind, attempt_number, status)
         VALUES('orphan-1','dev-1','ssh',1,'running')",
        [],
    )
    .unwrap();
    let n = FanoutStore::cleanup_orphan_runs(&conn).unwrap();
    assert_eq!(n, 1);
    let status: String = conn
        .query_row(
            "SELECT status FROM fanout_runs WHERE id='orphan-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "failed");
    let row_status: String = conn
        .query_row(
            "SELECT status FROM fanout_run_results WHERE run_id='orphan-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(row_status, "failed");
}

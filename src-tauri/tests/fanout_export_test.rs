use ccie_terminal_lib::fanout::events::FanoutEvent;
use ccie_terminal_lib::fanout::executor::{
    EventSink, ExecuteArgs, Executor, MemberRef, NoopParse,
};
use ccie_terminal_lib::fanout::export::export_run_zip;
use ccie_terminal_lib::fanout::model::DeviceKind;
use ccie_terminal_lib::fanout::store::FanoutStore;
use ccie_terminal_lib::fanout::worker::MockWorkerFactory;
use parking_lot::Mutex;
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;
use zip::ZipArchive;

struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, _event: &FanoutEvent) {}
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
async fn export_zip_contains_manifest_report_and_per_device_files() {
    let db = open_db();
    let members: Vec<MemberRef> = {
        let conn = db.lock();
        (0..3)
            .map(|i| {
                let id = FanoutStore::seed_test_ssh(
                    &conn,
                    &format!("dev{i}"),
                    &format!("10.0.0.{i}"),
                )
                .unwrap();
                MemberRef {
                    device_id: id,
                    device_kind: DeviceKind::Ssh,
                    display_name: format!("dev{i}"),
                }
            })
            .collect()
    };
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(10));
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
    ex.await_run(&run_id).await.unwrap();

    let dest = tempfile::NamedTempFile::new().unwrap();
    let dest_path = dest.path().to_path_buf();
    drop(dest);
    let manifest = export_run_zip(&db.lock(), &run_id, &dest_path).unwrap();
    assert_eq!(manifest.total, 3);
    assert_eq!(manifest.succeeded, 3);
    assert_eq!(manifest.devices.len(), 3);

    let zip_file = std::fs::File::open(&dest_path).unwrap();
    let mut archive = ZipArchive::new(zip_file).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(names.iter().any(|n| n == "manifest.json"));
    assert!(names.iter().any(|n| n == "report.md"));
    let device_files: Vec<&String> = names
        .iter()
        .filter(|n| n.starts_with("devices/") && n.ends_with(".txt"))
        .collect();
    assert_eq!(device_files.len(), 3);

    // report.md contains the run id + status table
    let mut report_entry = archive.by_name("report.md").unwrap();
    let mut buf = String::new();
    report_entry.read_to_string(&mut buf).unwrap();
    assert!(buf.contains(&run_id));
    assert!(buf.contains("| dev0 |") || buf.contains("dev0"));
    assert!(buf.contains("show ip int br"));

    // manifest.json deserializes
    drop(report_entry);
    let mut manifest_entry = archive.by_name("manifest.json").unwrap();
    let mut mbuf = String::new();
    manifest_entry.read_to_string(&mut mbuf).unwrap();
    let v: serde_json::Value = serde_json::from_str(&mbuf).unwrap();
    assert_eq!(v["run_id"], run_id.as_str());
    assert_eq!(v["command"], "show ip int br");
    let _ = std::fs::remove_file(dest_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn export_zip_handles_partial_run_with_failures() {
    let db = open_db();
    let members: Vec<MemberRef> = {
        let conn = db.lock();
        (0..2)
            .map(|i| {
                let id = FanoutStore::seed_test_ssh(
                    &conn,
                    &format!("dev{i}"),
                    &format!("10.0.0.{i}"),
                )
                .unwrap();
                MemberRef {
                    device_id: id,
                    device_kind: DeviceKind::Ssh,
                    display_name: format!("dev{i}"),
                }
            })
            .collect()
    };
    // Force everyone to time out
    let factory = MockWorkerFactory::with_delay(Duration::from_millis(5_000));
    let ex = Executor::new(
        db.clone(),
        Arc::new(factory),
        Arc::new(NoopSink),
        Arc::new(NoopParse),
    );
    let args = ExecuteArgs {
        command: "show".into(),
        group_id: None,
        members,
        timeout_ms: 50,
        concurrency: 2,
    };
    let run_id = ex.spawn_run(args).await.unwrap();
    ex.await_run(&run_id).await.unwrap();

    let dest = tempfile::NamedTempFile::new().unwrap();
    let dest_path = dest.path().to_path_buf();
    drop(dest);
    let manifest = export_run_zip(&db.lock(), &run_id, &dest_path).unwrap();
    assert_eq!(manifest.failed, 2);
    assert_eq!(manifest.succeeded, 0);
    assert_eq!(manifest.status, "failed");
    let _ = std::fs::remove_file(dest_path);
}

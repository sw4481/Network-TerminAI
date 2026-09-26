use ccie_terminal_lib::db::open_and_migrate;
use ccie_terminal_lib::pty::RawOutput;
use ccie_terminal_lib::recording::supervisor::RecordingSupervisor;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Instant;
use tempfile::TempDir;

#[tokio::test]
async fn start_feed_stop_writes_cast_and_persists_summary() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    let conn = open_and_migrate(&db_path).unwrap();
    let db = Arc::new(Mutex::new(conn));
    let sup = RecordingSupervisor::new(db.clone());
    let recording_dir = tmp.path().join("recordings");
    std::fs::create_dir_all(&recording_dir).unwrap();
    sup.set_base_dir(recording_dir.clone());

    let (dto, tx) = sup.start("tab-1", "local", 120, 40).unwrap();
    assert!(sup.is_active("tab-1"));
    assert!(dto.path.ends_with(".cast"));

    let started = Instant::now();
    for chunk in [&b"hello "[..], &b"world\r\n"[..], &b"more\r\n"[..]] {
        tx.send(RawOutput {
            bytes: chunk.to_vec(),
            recv_at: started + std::time::Duration::from_millis(50),
        })
        .await
        .unwrap();
    }
    // Allow the writer task to drain.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let final_dto = sup.stop("tab-1").await.unwrap();
    assert!(!sup.is_active("tab-1"));
    assert!(final_dto.size_bytes > 0);

    // .cast file should exist on disk.
    assert!(std::path::Path::new(&final_dto.path).exists());

    // session_recordings row updated with size + ended_at.
    let conn = db.lock();
    let (size, ended): (i64, Option<i64>) = conn
        .query_row(
            "SELECT size_bytes, ended_at FROM session_recordings WHERE id = ?1",
            rusqlite::params![final_dto.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(size > 0);
    assert!(ended.is_some());
}

#[tokio::test]
async fn redaction_persisted_on_stop() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    let conn = open_and_migrate(&db_path).unwrap();
    let db = Arc::new(Mutex::new(conn));
    let sup = RecordingSupervisor::new(db.clone());
    sup.set_base_dir(tmp.path().join("recordings"));

    let (_dto, tx) = sup.start("tab-2", "local", 120, 40).unwrap();
    tx.send(RawOutput {
        bytes: b"enable secret 5 $1$abcdef$xyz\r\n".to_vec(),
        recv_at: Instant::now(),
    })
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let final_dto = sup.stop("tab-2").await.unwrap();

    let summary = sup.redaction_summary(&final_dto.id).unwrap();
    assert!(
        summary.iter().any(|(p, _, _)| p == "cisco_enable_secret"),
        "expected cisco_enable_secret hit, got {summary:?}"
    );
}

#[tokio::test]
async fn double_start_for_same_tab_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let db = Arc::new(Mutex::new(open_and_migrate(&tmp.path().join("t.db")).unwrap()));
    let sup = RecordingSupervisor::new(db);
    sup.set_base_dir(tmp.path().join("recordings"));
    sup.start("tab-x", "local", 80, 24).unwrap();
    assert!(sup.start("tab-x", "local", 80, 24).is_err());
}

/// Orphan recordings (ended_at IS NULL) are left behind when the app exits
/// mid-recording. On the next boot they must be reconciled — marked ended with
/// the actual on-disk size — so they don't show "LIVE" forever.
#[test]
fn cleanup_orphan_recordings_marks_unfinished_rows_ended() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("t.db");
    let conn = open_and_migrate(&db_path).unwrap();
    let db = Arc::new(Mutex::new(conn));

    // Seed: one orphan (ended_at NULL) + one already-ended recording.
    {
        let c = db.lock();
        c.execute(
            "INSERT INTO session_recordings (id, tab_id, started_at, ended_at, path, size_bytes, session_kind)
             VALUES ('orphan', 'tab-1', 100, NULL, '/tmp/orphan.cast', 0, 'local')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO session_recordings (id, tab_id, started_at, ended_at, path, size_bytes, session_kind)
             VALUES ('done', 'tab-2', 100, 200, '/tmp/done.cast', 512, 'local')",
            [],
        )
        .unwrap();
    }

    let sup = RecordingSupervisor::new(db.clone());
    let n = sup.cleanup_orphan_recordings().unwrap();
    assert_eq!(n, 1, "exactly one orphan should be reconciled");

    let c = db.lock();
    let orphan_ended: Option<i64> = c
        .query_row(
            "SELECT ended_at FROM session_recordings WHERE id = 'orphan'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(orphan_ended.is_some(), "orphan must no longer be LIVE");

    // The already-ended row is untouched.
    let done_ended: Option<i64> = c
        .query_row(
            "SELECT ended_at FROM session_recordings WHERE id = 'done'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(done_ended, Some(200));
}

/// Regression: `start()` spawns a background writer task. If called outside a
/// Tokio runtime it used to panic ("there is no reactor running") and abort
/// the whole process. It must instead return a clean `Err`. (Plain `#[test]`
/// — deliberately NOT `#[tokio::test]` — so there is no ambient runtime.)
#[test]
fn start_without_tokio_runtime_errors_instead_of_aborting() {
    let tmp = TempDir::new().unwrap();
    let db = Arc::new(Mutex::new(
        open_and_migrate(&tmp.path().join("t.db")).unwrap(),
    ));
    let sup = RecordingSupervisor::new(db);
    sup.set_base_dir(tmp.path().join("recordings"));

    let result = sup.start("tab-no-rt", "local", 80, 24);
    assert!(
        result.is_err(),
        "start() must return Err (not abort) when no Tokio runtime is present"
    );
    // And it must not leave a half-registered active recording behind.
    assert!(!sup.is_active("tab-no-rt"));
}

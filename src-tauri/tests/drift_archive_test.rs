use ccie_terminal_lib::drift::archive::{ConfigSnapshotRepo, RETENTION_PER_DEVICE};
use rusqlite::Connection;

fn mem_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE config_snapshots (
           id TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_kind TEXT NOT NULL,
           vendor TEXT, platform TEXT, normalized_config TEXT NOT NULL,
           label TEXT, source TEXT NOT NULL,
           captured_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));",
    )
    .unwrap();
    conn
}

#[test]
fn dedup_skips_identical_consecutive() {
    let conn = mem_db();
    let a = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", "hostname R1\n", "drift_run").unwrap();
    assert!(a.is_some());
    let b = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", "hostname R1\n", "drift_run").unwrap();
    assert!(b.is_none(), "identical consecutive snapshot should dedup");
    let c = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", "hostname R2\n", "drift_run").unwrap();
    assert!(c.is_some(), "changed config should store");
}

#[test]
fn retention_evicts_oldest_unlabeled() {
    let conn = mem_db();
    for i in 0..(RETENTION_PER_DEVICE + 5) {
        let cfg = format!("hostname R{i}\n");
        // Force distinct captured_at ordering by writing explicit timestamps.
        let id = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", &cfg, "drift_run")
            .unwrap()
            .unwrap()
            .id;
        conn.execute("UPDATE config_snapshots SET captured_at = ?1 WHERE id = ?2",
            rusqlite::params![1000 + i, id]).unwrap();
        // Re-run retention now that captured_at is deterministic.
        ConfigSnapshotRepo::enforce_retention(&conn, "d1", "ssh").unwrap();
    }
    let rows = ConfigSnapshotRepo::list_for_device(&conn, "d1", "ssh", 100).unwrap();
    assert!(rows.len() as i64 <= RETENTION_PER_DEVICE, "kept {} rows", rows.len());
}

#[test]
fn labeled_snapshots_survive_retention() {
    let conn = mem_db();
    let first = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", "hostname KEEP\n", "manual")
        .unwrap().unwrap();
    conn.execute("UPDATE config_snapshots SET captured_at = 1 WHERE id = ?1", [&first.id]).unwrap();
    ConfigSnapshotRepo::set_label(&conn, &first.id, Some("known-good")).unwrap();
    for i in 0..(RETENTION_PER_DEVICE + 5) {
        let cfg = format!("hostname R{i}\n");
        let id = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", &cfg, "drift_run")
            .unwrap().unwrap().id;
        conn.execute("UPDATE config_snapshots SET captured_at = ?1 WHERE id = ?2",
            rusqlite::params![1000 + i, id]).unwrap();
        ConfigSnapshotRepo::enforce_retention(&conn, "d1", "ssh").unwrap();
    }
    let kept = ConfigSnapshotRepo::get(&conn, &first.id).unwrap();
    assert!(kept.is_some(), "labeled snapshot must never be evicted");
    let all = ConfigSnapshotRepo::list_for_device(&conn, "d1", "ssh", 100).unwrap();
    // 15 unlabeled retained + the 1 labeled survivor.
    assert_eq!(all.len() as i64, RETENTION_PER_DEVICE + 1, "expected 15 unlabeled + 1 labeled, got {}", all.len());
}

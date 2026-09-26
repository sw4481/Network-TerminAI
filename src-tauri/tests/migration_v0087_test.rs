use ccie_terminal_lib::db;
use tempfile::TempDir;

#[test]
fn v0087_preserves_remote_rows_and_permits_local_captures() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("pcap-v87.db");
    {
        let conn = db::open_and_migrate_to(&path, 86).unwrap();
        conn.execute(
            "INSERT INTO pcap_captures (
                 id, session_id, device_ref, device_kind, interface, filter,
                 started_at, ended_at, status, local_path, packet_count,
                 size_bytes, error, created_at
             ) VALUES (
                 'remote', 'session-1', 'router-1', 'iosxe', 'GigabitEthernet1',
                 'tcp port 179', 100, 200, 'ready', '/tmp/remote.pcap', 12,
                 4096, NULL, 50
             )",
            [],
        )
        .unwrap();
    }

    let conn = db::open_and_migrate(&path).unwrap();
    let preserved: (String, String, String, String, i64, i64) = conn
        .query_row(
            "SELECT session_id, device_ref, device_kind, status, packet_count, size_bytes
               FROM pcap_captures WHERE id = 'remote'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        preserved,
        (
            "session-1".into(),
            "router-1".into(),
            "iosxe".into(),
            "ready".into(),
            12,
            4096,
        )
    );

    conn.execute(
        "INSERT INTO pcap_captures
           (id, device_ref, device_kind, interface, status)
         VALUES ('local', 'This Computer', 'local', 'en0', 'capturing')",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO pcap_captures
               (id, device_ref, device_kind, interface, status)
             VALUES ('invalid', 'x', 'embedded-libpcap', 'en0', 'capturing')",
            [],
        )
        .is_err());

    for index in [
        "idx_pcap_captures_session",
        "idx_pcap_captures_status",
        "idx_pcap_captures_created",
    ] {
        let present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                [index],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(present, 1, "missing rebuilt index {index}");
    }
}

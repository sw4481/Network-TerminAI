use ccie_terminal_lib::db;
use rusqlite::params;
use tempfile::TempDir;

#[test]
fn v0084_backfills_legacy_connections_into_the_root_folder() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("ssh-v84.db");
    {
        let conn = db::open_and_migrate_to(&path, 83).unwrap();
        conn.execute(
            "INSERT INTO ssh_connections(id, name, host, user, port)
             VALUES ('legacy', 'Legacy', '192.0.2.10', 'admin', 22)",
            [],
        )
        .unwrap();
    }

    let conn = db::open_and_migrate(&path).unwrap();
    let row: (String, String, Option<String>, String, String) = conn
        .query_row(
            "SELECT folder_id, tags_json, accent_color, vendor, platform
               FROM ssh_connections WHERE id = 'legacy'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "root".into(),
            "[]".into(),
            None,
            "generic".into(),
            "generic".into()
        )
    );
    let root_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ssh_folders WHERE id = ?1 AND parent_id IS NULL",
            params!["root"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(root_count, 1);
}

#[test]
fn v0084_rejects_arbitrary_accent_colors_and_vendors() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("ssh-v84-checks.db");
    let conn = db::open_and_migrate(&path).unwrap();
    let invalid_accent = conn.execute(
        "INSERT INTO ssh_connections(id, name, host, accent_color)
         VALUES ('bad-accent', 'Bad Accent', '192.0.2.11', '#ffffff')",
        [],
    );
    assert!(invalid_accent.is_err());
    let invalid_vendor = conn.execute(
        "INSERT INTO ssh_connections(id, name, host, vendor)
         VALUES ('bad-vendor', 'Bad Vendor', '192.0.2.12', 'unknown')",
        [],
    );
    assert!(invalid_vendor.is_err());
}

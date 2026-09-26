use ccie_terminal_lib::db;
use tempfile::TempDir;

#[test]
fn v0085_keeps_migrated_devices_visually_unchanged() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("ssh-v85.db");
    {
        let conn = db::open_and_migrate_to(&path, 84).unwrap();
        conn.execute(
            "INSERT INTO ssh_connections(id, name, host)
             VALUES ('legacy', 'Legacy', '192.0.2.10')",
            [],
        )
        .unwrap();
    }

    let conn = db::open_and_migrate(&path).unwrap();
    let row: (bool, String) = conn
        .query_row(
            "SELECT syntax_highlighting_enabled, syntax_profile
               FROM ssh_connections WHERE id = 'legacy'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, (false, "auto".into()));
}

#[test]
fn v0085_rejects_invalid_profiles_and_non_boolean_flags() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("ssh-v85-checks.db");
    let conn = db::open_and_migrate(&path).unwrap();
    assert!(conn
        .execute(
            "INSERT INTO ssh_connections
               (id, name, host, syntax_profile)
             VALUES ('bad-profile', 'Bad Profile', '192.0.2.11', 'custom')",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO ssh_connections
               (id, name, host, syntax_highlighting_enabled)
             VALUES ('bad-flag', 'Bad Flag', '192.0.2.12', 2)",
            [],
        )
        .is_err());
}

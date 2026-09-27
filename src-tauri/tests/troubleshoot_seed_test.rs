//! Integration test for the troubleshoot builtin seed loader.
//!
//! Lives in `tests/` (not `src/`) so it exercises `ccie_terminal_lib`
//! through its public surface — the same way the running binary does at
//! boot. Migrations are applied via `db::open_and_migrate` against an
//! ephemeral file (in-memory `:memory:` would also work but we want the
//! same code path the app uses).

use ccie_terminal_lib::db;
use ccie_terminal_lib::troubleshoot::seed;
use rusqlite::params;
use tempfile::TempDir;

fn fresh_db() -> (TempDir, rusqlite::Connection) {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("test.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (tmp, conn)
}

#[test]
fn troubleshoot_builtins_seed_six_rows_on_first_run() {
    let (_tmp, conn) = fresh_db();
    seed::ensure_builtins(&conn).unwrap();

    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM troubleshoot_playbooks WHERE builtin = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 6, "expected six builtin playbooks after first seed");
}

#[test]
fn troubleshoot_builtins_are_idempotent() {
    let (_tmp, conn) = fresh_db();

    // Three boots in a row.
    seed::ensure_builtins(&conn).unwrap();
    seed::ensure_builtins(&conn).unwrap();
    seed::ensure_builtins(&conn).unwrap();

    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM troubleshoot_playbooks",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 6, "idempotency: still exactly six rows after re-seeding");

    // Every shipped builtin id must be present.
    for id in [
        "bgp-wont-peer",
        "ospf-neighbor-init",
        "interface-err-disabled",
        "dhcp-no-lease",
        "ipsec-phase1-fail",
        "mac-flap",
    ] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM troubleshoot_playbooks WHERE id = ?1 AND builtin = 1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1, "missing builtin: {id}");
    }
}

#[test]
fn troubleshoot_seed_protects_user_forks() {
    // Plan 15 invariant: re-seeding never trample a user-forked row.
    let (_tmp, conn) = fresh_db();
    seed::ensure_builtins(&conn).unwrap();

    let user_yaml = "id: bgp-wont-peer\nname: My Custom Fork\n";
    conn.execute(
        "UPDATE troubleshoot_playbooks
            SET name = 'My Custom Fork', body_yaml = ?1, builtin = 0
          WHERE id = 'bgp-wont-peer'",
        params![user_yaml],
    )
    .unwrap();

    seed::ensure_builtins(&conn).unwrap();

    let (name, body, builtin): (String, String, i64) = conn
        .query_row(
            "SELECT name, body_yaml, builtin
               FROM troubleshoot_playbooks
              WHERE id = 'bgp-wont-peer'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();

    assert_eq!(name, "My Custom Fork");
    assert_eq!(body, user_yaml);
    assert_eq!(builtin, 0);
}

#[test]
fn troubleshoot_seed_populates_metadata_fields() {
    let (_tmp, conn) = fresh_db();
    seed::ensure_builtins(&conn).unwrap();

    let (name, vendor, platform, keywords): (String, String, String, String) = conn
        .query_row(
            "SELECT name, vendor, platform, symptom_keywords
               FROM troubleshoot_playbooks
              WHERE id = 'bgp-wont-peer'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();

    assert!(!name.is_empty());
    assert_eq!(vendor, "cisco");
    assert_eq!(platform, "iosxe");
    let keywords_vec: Vec<String> = serde_json::from_str(&keywords).unwrap();
    assert!(keywords_vec.contains(&"bgp".to_string()));
}

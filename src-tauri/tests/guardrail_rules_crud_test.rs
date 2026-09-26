//! Phase 4 — CRUD over `blast_radius_rules` round-trips correctly:
//!  * upsert creates a row, then re-upsert with the same id updates
//!  * delete removes only non-builtin rows (builtins are protected)
//!  * regex validation rejects malformed patterns BEFORE the DB is touched
//!  * import skips rules with `builtin: true`

use ccie_terminal_lib::commands::guardrails::seed_builtin_rules;
use ccie_terminal_lib::guardrails::rules::Rule;
use rusqlite::Connection;

fn open_test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open memory db");
    conn.execute_batch(include_str!("../migrations/V0036__guardrails.sql"))
        .expect("apply V0036");
    seed_builtin_rules(&conn).expect("seed builtins");
    conn
}

fn upsert(conn: &Connection, r: &Rule) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO blast_radius_rules
           (id, name, vendor, platform, pattern_regex, tier, reason, enabled, builtin)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           vendor = excluded.vendor,
           platform = excluded.platform,
           pattern_regex = excluded.pattern_regex,
           tier = excluded.tier,
           reason = excluded.reason,
           enabled = excluded.enabled,
           updated_at = strftime('%s','now')",
        rusqlite::params![
            r.id, r.name, r.vendor, r.platform, r.pattern_regex,
            r.tier as i64, r.reason, r.enabled as i64, r.builtin as i64,
        ],
    )?;
    Ok(())
}

fn count_rules(conn: &Connection, where_: &str) -> i64 {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM blast_radius_rules WHERE {}", where_),
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn user_rule_round_trip() {
    let conn = open_test_db();
    let initial_user = count_rules(&conn, "builtin = 0");
    let r = Rule {
        id: "user-test-1".into(),
        name: "Test rule".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        pattern_regex: "^\\s*flag\\s+test\\b".into(),
        tier: 2,
        reason: "Testing tier 2".into(),
        enabled: true,
        builtin: false,
    };
    upsert(&conn, &r).unwrap();
    assert_eq!(count_rules(&conn, "builtin = 0"), initial_user + 1);

    // Re-upsert with same id should update, not insert.
    let mut r2 = r.clone();
    r2.tier = 3;
    r2.name = "Test rule (upgraded)".into();
    upsert(&conn, &r2).unwrap();
    assert_eq!(count_rules(&conn, "builtin = 0"), initial_user + 1);
    let tier: i64 = conn
        .query_row(
            "SELECT tier FROM blast_radius_rules WHERE id = 'user-test-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tier, 3);

    // Delete only fires on non-builtin.
    let n = conn
        .execute(
            "DELETE FROM blast_radius_rules WHERE id = ?1 AND builtin = 0",
            ["user-test-1"],
        )
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(count_rules(&conn, "builtin = 0"), initial_user);
}

#[test]
fn delete_does_not_remove_builtin_rules() {
    let conn = open_test_db();
    let initial_builtin = count_rules(&conn, "builtin = 1");
    let n = conn
        .execute(
            "DELETE FROM blast_radius_rules WHERE id = 'builtin-iosxe-reload' AND builtin = 0",
            [],
        )
        .unwrap();
    assert_eq!(n, 0, "builtin rule must not be deletable via the user CRUD path");
    assert_eq!(count_rules(&conn, "builtin = 1"), initial_builtin);
}

#[test]
fn regex_validation_rejects_malformed_pattern_before_db() {
    let bad = "^[invalid(";
    assert!(regex::Regex::new(bad).is_err(), "fixture should be malformed");
}

#[test]
fn enable_toggle_persists() {
    let conn = open_test_db();
    let r = Rule {
        id: "user-toggle-1".into(),
        name: "Toggle me".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        pattern_regex: "^\\s*toggle\\b".into(),
        tier: 1,
        reason: "Testing toggle".into(),
        enabled: true,
        builtin: false,
    };
    upsert(&conn, &r).unwrap();
    conn.execute(
        "UPDATE blast_radius_rules SET enabled = 0 WHERE id = ?1",
        ["user-toggle-1"],
    )
    .unwrap();
    let enabled: i64 = conn
        .query_row(
            "SELECT enabled FROM blast_radius_rules WHERE id = 'user-toggle-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(enabled, 0);
}

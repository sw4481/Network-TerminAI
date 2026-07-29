//! First-boot seeder for the bundled troubleshooting playbooks.
//!
//! The seed corpus is `include_str!`'d directly from the sidecar package
//! (`sidecar/src/ccie_sidecar/troubleshoot/seeds/`). Co-locating the YAML
//! with the Python validator means the sidecar tests gate the binary's
//! seed contents — if a seed is broken, the sidecar test suite fails
//! before the Rust `cargo test` does.
//!
//! ## Idempotency
//!
//! `ensure_builtins` is called on every app start. The UPSERT uses
//! `ON CONFLICT(id) DO UPDATE ... WHERE builtin=1` so:
//!
//!   * The first run inserts six rows with `builtin=1`.
//!   * Subsequent runs UPDATE those same rows in-place (refreshing
//!     `name`, `symptom_keywords`, `body_yaml`, and `updated_at`) — but
//!     NOT user-forked rows. If a user copies `bgp-wont-peer` to
//!     `bgp-wont-peer` (illegal, same id) the conflict updates the
//!     builtin; if they save it as `bgp-wont-peer-mine` (different id)
//!     it's untouched. If they UPDATE the builtin row to set
//!     `builtin=0` (forking in place), the WHERE clause means we no
//!     longer overwrite their edits.
//!
//! The integration test `tests/troubleshoot_seed_test.rs` asserts the
//! row count is exactly six after running twice.

use anyhow::Context;
use rusqlite::{params, Connection};

use crate::troubleshoot::playbook::Playbook;

/// (id, raw YAML) pairs for every shipped builtin.
///
/// The id MUST match the YAML's `id:` field (the Python loader and
/// `tests/troubleshoot/test_seeds_valid.py` enforce this on the sidecar
/// side; we re-verify in `ensure_builtins` below).
const SEEDS: &[(&str, &str)] = &[
    (
        "bgp-wont-peer",
        include_str!("../../../sidecar/src/ccie_sidecar/troubleshoot/seeds/bgp-wont-peer.yaml"),
    ),
    (
        "ospf-neighbor-init",
        include_str!(
            "../../../sidecar/src/ccie_sidecar/troubleshoot/seeds/ospf-neighbor-init.yaml"
        ),
    ),
    (
        "interface-err-disabled",
        include_str!(
            "../../../sidecar/src/ccie_sidecar/troubleshoot/seeds/interface-err-disabled.yaml"
        ),
    ),
    (
        "dhcp-no-lease",
        include_str!("../../../sidecar/src/ccie_sidecar/troubleshoot/seeds/dhcp-no-lease.yaml"),
    ),
    (
        "ipsec-phase1-fail",
        include_str!(
            "../../../sidecar/src/ccie_sidecar/troubleshoot/seeds/ipsec-phase1-fail.yaml"
        ),
    ),
    (
        "mac-flap",
        include_str!("../../../sidecar/src/ccie_sidecar/troubleshoot/seeds/mac-flap.yaml"),
    ),
];

/// Number of builtin playbooks that should always be present after
/// `ensure_builtins` runs. Exposed for tests.
pub const BUILTIN_COUNT: usize = 6;

/// Idempotently populate `troubleshoot_playbooks` with every shipped
/// builtin. Safe to call on every app start.
///
/// Errors propagate from YAML parse / id-mismatch / SQL.
pub fn ensure_builtins(conn: &Connection) -> anyhow::Result<()> {
    debug_assert_eq!(SEEDS.len(), BUILTIN_COUNT);

    for (expected_id, yaml_text) in SEEDS {
        let pb = Playbook::parse_yaml(yaml_text)
            .with_context(|| format!("parse builtin playbook '{expected_id}'"))?;

        anyhow::ensure!(
            pb.id == *expected_id,
            "builtin playbook file id mismatch: registry='{}' vs yaml='{}'",
            expected_id,
            pb.id,
        );

        let keywords = serde_json::to_string(&pb.symptom_keywords)?;
        conn.execute(
            "INSERT INTO troubleshoot_playbooks
                 (id, name, symptom_keywords, vendor, platform, body_yaml, builtin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
             ON CONFLICT(id) DO UPDATE SET
                 name             = excluded.name,
                 symptom_keywords = excluded.symptom_keywords,
                 vendor           = excluded.vendor,
                 platform         = excluded.platform,
                 body_yaml        = excluded.body_yaml,
                 updated_at       = strftime('%s','now')
             WHERE builtin = 1",
            params![
                pb.id,
                pb.name,
                keywords,
                pb.vendor,
                pb.platform,
                yaml_text,
            ],
        )
        .with_context(|| format!("upsert builtin playbook '{expected_id}'"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    fn fresh_db() -> (TempDir, Connection) {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("seed.db");
        let conn = db::open_and_migrate(&path).unwrap();
        (tmp, conn)
    }

    #[test]
    fn seed_inserts_six_rows() {
        let (_tmp, conn) = fresh_db();
        ensure_builtins(&conn).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM troubleshoot_playbooks WHERE builtin = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 6);
    }

    #[test]
    fn seed_is_idempotent() {
        let (_tmp, conn) = fresh_db();
        ensure_builtins(&conn).unwrap();
        ensure_builtins(&conn).unwrap();
        ensure_builtins(&conn).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM troubleshoot_playbooks",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 6);
    }

    #[test]
    fn seed_does_not_clobber_user_forks() {
        // Simulate a user who forked `bgp-wont-peer` in-place (set
        // builtin=0). The next ensure_builtins MUST NOT overwrite their
        // body_yaml.
        let (_tmp, conn) = fresh_db();
        ensure_builtins(&conn).unwrap();

        let user_yaml = "id: bgp-wont-peer\nname: My Fork\n";
        conn.execute(
            "UPDATE troubleshoot_playbooks
                SET name = 'My Fork', body_yaml = ?1, builtin = 0
              WHERE id = 'bgp-wont-peer'",
            params![user_yaml],
        )
        .unwrap();

        ensure_builtins(&conn).unwrap();

        let (name, body, builtin): (String, String, i64) = conn
            .query_row(
                "SELECT name, body_yaml, builtin FROM troubleshoot_playbooks WHERE id = 'bgp-wont-peer'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();

        assert_eq!(name, "My Fork", "user fork name was clobbered");
        assert_eq!(body, user_yaml, "user fork body was clobbered");
        assert_eq!(builtin, 0, "user fork builtin flag was reset");
    }
}

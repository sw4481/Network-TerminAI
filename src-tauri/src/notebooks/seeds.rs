//! First-run seed loader for canonical MOPs. Bundled markdown lives in
//! `src-tauri/notebooks/seeds/` and is `include_str!`'d here so the binary
//! is self-contained.
//!
//! Idempotency: a row in `app_flags` (`notebooks.runnable.seeded.v1`) is
//! written after a successful seed; subsequent calls are a no-op.

use anyhow::Result;
use rusqlite::Connection;

use crate::commands::notebooks_runnable::import_markdown_impl;

const SEED_FLAG_KEY: &str = "notebooks.runnable.seeded.v1";

/// 10 canonical MOPs bundled with the application. Add new seeds here.
pub const SEED_MARKDOWN: &[(&str, &str)] = &[
    ("bgp_peer_bringup", include_str!("../../notebooks/seeds/bgp_peer_bringup.mop.md")),
    ("ospf_neighbor_add", include_str!("../../notebooks/seeds/ospf_neighbor_add.mop.md")),
    ("isis_neighbor_add", include_str!("../../notebooks/seeds/isis_neighbor_add.mop.md")),
    ("interface_mtu_change_validation", include_str!("../../notebooks/seeds/interface_mtu_change_validation.mop.md")),
    ("vlan_trunk_add", include_str!("../../notebooks/seeds/vlan_trunk_add.mop.md")),
    ("hsrp_failover_test", include_str!("../../notebooks/seeds/hsrp_failover_test.mop.md")),
    ("bfd_single_hop_enable", include_str!("../../notebooks/seeds/bfd_single_hop_enable.mop.md")),
    ("acl_apply_with_rollback", include_str!("../../notebooks/seeds/acl_apply_with_rollback.mop.md")),
    ("ntp_server_change", include_str!("../../notebooks/seeds/ntp_server_change.mop.md")),
    ("snmpv3_user_add", include_str!("../../notebooks/seeds/snmpv3_user_add.mop.md")),
];

pub fn ensure_seed_marker_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"CREATE TABLE IF NOT EXISTS app_flags (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );"#,
    )?;
    Ok(())
}

pub fn already_seeded(conn: &Connection) -> Result<bool> {
    ensure_seed_marker_table(conn)?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_flags WHERE key = ?1",
        rusqlite::params![SEED_FLAG_KEY],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

pub fn mark_seeded(conn: &Connection) -> Result<()> {
    ensure_seed_marker_table(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO app_flags (key, value) VALUES (?1, '1')",
        rusqlite::params![SEED_FLAG_KEY],
    )?;
    Ok(())
}

/// Idempotent: imports each bundled seed once. Returns the number of seeds
/// imported on this call (0 if already seeded).
pub fn seed_builtin_runnable_notebooks(conn: &Connection) -> Result<usize> {
    if already_seeded(conn)? {
        return Ok(0);
    }
    let mut count = 0usize;
    for (slug, md) in SEED_MARKDOWN {
        match import_markdown_impl(conn, md) {
            Ok(_) => count += 1,
            Err(e) => {
                tracing::warn!(seed = %slug, error = %e, "skipping bad seed notebook");
            }
        }
    }
    mark_seeded(conn)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notebooks::parser::parse_markdown;

    #[test]
    fn every_seed_parses_cleanly() {
        for (slug, md) in SEED_MARKDOWN {
            let result = parse_markdown(md);
            assert!(
                result.is_ok(),
                "seed {slug} failed to parse: {}",
                result.unwrap_err()
            );
            let nb = result.unwrap();
            assert!(!nb.frontmatter.title.is_empty(), "{slug} has empty title");
            assert!(!nb.cells.is_empty(), "{slug} produced no cells");
            // Every seed must include at least one approval and one assertion.
            let has_approval = nb
                .cells
                .iter()
                .any(|c| matches!(c, crate::notebooks::model::NotebookCell::Approval { .. }));
            let has_assertion = nb
                .cells
                .iter()
                .any(|c| matches!(c, crate::notebooks::model::NotebookCell::Assertion { .. }));
            assert!(has_approval, "{slug} missing approval cell");
            assert!(has_assertion, "{slug} missing assertion cell");
        }
    }

    #[test]
    fn ten_seeds_bundled() {
        assert_eq!(SEED_MARKDOWN.len(), 10);
    }
}

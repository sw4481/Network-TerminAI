//! First-run seed for canonical change-verification bundles. Idempotent
//! via `app_flags`'s `change_verify.bundles.seeded.v1` marker so subsequent
//! boots are a no-op even if the user has deleted some bundles.

use anyhow::Result;
use rusqlite::Connection;

use super::bundles;
use super::model::NewCheckBundle;

const SEED_FLAG_KEY: &str = "change_verify.bundles.seeded.v1";

fn already_seeded(conn: &Connection) -> Result<bool> {
    conn.execute_batch(
        r#"CREATE TABLE IF NOT EXISTS app_flags (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );"#,
    )?;
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![SEED_FLAG_KEY],
            |r| r.get(0),
        )
        .ok();
    Ok(v.is_some())
}

fn mark_seeded(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, '1')",
        rusqlite::params![SEED_FLAG_KEY],
    )?;
    Ok(())
}

fn seeds() -> Vec<NewCheckBundle> {
    vec![
        NewCheckBundle {
            name: "Cisco IOS-XE routing baseline".into(),
            description: Some("Core L3 verification".into()),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            commands: vec![
                "show ip interface brief".into(),
                "show ip route summary".into(),
                "show ip bgp summary".into(),
                "show ip ospf neighbor".into(),
                "show cdp neighbor".into(),
            ],
        },
        NewCheckBundle {
            name: "Cisco IOS-XE switching baseline".into(),
            description: Some("L2 verification".into()),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            commands: vec![
                "show interfaces status".into(),
                "show vlan brief".into(),
                "show spanning-tree summary".into(),
                "show cdp neighbor".into(),
                "show mac address-table count".into(),
            ],
        },
        NewCheckBundle {
            name: "NX-OS fabric baseline".into(),
            description: Some("VXLAN / BGP-EVPN fabric checks".into()),
            vendor: "cisco".into(),
            platform: "nxos".into(),
            commands: vec![
                "show interface brief".into(),
                "show ip route summary".into(),
                "show bgp l2vpn evpn summary".into(),
                "show nve peers".into(),
                "show vpc".into(),
            ],
        },
        NewCheckBundle {
            name: "Junos routing baseline".into(),
            description: Some("Core L3 verification on Junos".into()),
            vendor: "juniper".into(),
            platform: "junos".into(),
            commands: vec![
                "show interfaces terse".into(),
                "show route summary".into(),
                "show bgp summary".into(),
                "show ospf neighbor".into(),
                "show lldp neighbors".into(),
            ],
        },
    ]
}

pub fn seed_if_first_run(db: &mut Connection) -> Result<usize> {
    if already_seeded(db)? {
        return Ok(0);
    }
    // `bundles::create` opens its own transaction per bundle, so we don't
    // wrap the loop in an outer one. Each bundle is independently atomic;
    // partial failure leaves earlier successes in place, which matches the
    // user-visible "skip on UNIQUE collision" semantics below.
    let mut count = 0;
    for s in seeds() {
        // Skip silently if a bundle with the same (name, vendor, platform)
        // already exists — this can happen if the user manually pre-seeded
        // one. The unique constraint returns an Err we treat as "already
        // there".
        match bundles::create(db, s) {
            Ok(_) => count += 1,
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("UNIQUE constraint failed") {
                    continue;
                }
                return Err(e);
            }
        }
    }
    mark_seeded(db)?;
    Ok(count)
}

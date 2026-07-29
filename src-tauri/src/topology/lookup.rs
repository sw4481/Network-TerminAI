//! Plan 13 Phase 3.2 — saved-device lookup for click-to-SSH.
//!
//! Resolves a topology `device_ref` (mgmt IP or hostname surfaced in the
//! inline topology panel) to a saved SSH connection or NETCONF device.
//! Used by `device_lookup_by_ref` in `commands/topology.rs` to decide
//! whether a neighbor click should open an SSH tab, a NETCONF tab, or
//! prompt the SaveNeighborModal flow.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::SavedDeviceLookup;

/// Look up a saved device by reference (currently the `host` column on
/// both `ssh_connections` and `netconf_devices`). Returns `None` if no
/// match exists in either table.
///
/// SSH is the primary interactive path; when a host is saved in BOTH
/// tables we prefer SSH so click-to-SSH stays predictable. The kind
/// priority is encoded directly in the `UNION ALL` ordering below.
pub fn lookup_device_by_ref(
    conn: &Connection,
    reference: &str,
) -> Result<Option<SavedDeviceLookup>> {
    // Trim whitespace so e.g. "10.0.0.2 " (stray trailing space from a
    // parsed neighbor record) still matches "10.0.0.2" in ssh_connections.
    // Hosts in ssh_connections / netconf_devices are user-typed and
    // already normalized at insert time, so we only normalize the query
    // side here. (Index-friendly: equality on `host` still uses the
    // existing UNIQUE / PRIMARY KEY indexes.)
    let reference = reference.trim();
    let mut stmt = conn.prepare(
        "SELECT kind, device_ref FROM (
             SELECT 'ssh' AS kind, host AS device_ref, 1 AS priority
               FROM ssh_connections WHERE host = ?1
             UNION ALL
             SELECT 'netconf' AS kind, host AS device_ref, 2 AS priority
               FROM netconf_devices WHERE host = ?1
         )
         ORDER BY priority
         LIMIT 1",
    )?;
    let mut rows = stmt.query(params![reference])?;
    if let Some(row) = rows.next()? {
        Ok(Some(SavedDeviceLookup {
            kind: row.get(0)?,
            device_ref: row.get(1)?,
        }))
    } else {
        Ok(None)
    }
}

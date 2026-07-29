//! Blast-radius impact preview — produces a short summary for Tier 2/3
//! confirmation modals. Integrates with Plan 13 topology data when
//! available; otherwise falls back to per-command heuristics derived from
//! command shape alone.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImpactSummary {
    pub affected_neighbors: Vec<String>,
    pub affected_prefixes: Vec<String>,
    pub notes: Vec<String>,
    pub topology_available: bool,
}

/// Returns true if the topology table from Plan 13 is present in the DB.
pub fn topology_available(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'topology_graphs'",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

/// Produce a per-command impact summary.
///
/// Even without topology data, we can still predict from command shape:
///  * `shutdown` on an interface → "Interface <name> goes admin down."
///  * `no router bgp <asn>` → "All BGP sessions in ASN <asn> torn down."
///  * `clear ip bgp * soft` → "All BGP neighbors receive refreshed inbound."
///  * `reload` / `request system reboot` → "Full device reboot — outage until boot completes."
pub fn summarize(conn: &Connection, vendor: &str, platform: &str, command: &str) -> ImpactSummary {
    let topo = topology_available(conn);
    let lower = command.to_lowercase();

    let mut summary = ImpactSummary {
        topology_available: topo,
        ..Default::default()
    };

    if !topo {
        summary.notes.push(
            "Topology data not available — impact preview limited to rule reasoning.".into(),
        );
    }

    // Per-command heuristics that work without topology.
    if lower.contains("reload") || lower.contains("request system reboot") || lower.contains("request system halt") {
        summary
            .notes
            .push("Full device reboot — outage until boot completes.".into());
    } else if let Some(rest) = strip_prefix(&lower, "no router bgp ") {
        let asn = first_token(rest);
        summary.notes.push(format!(
            "All BGP sessions in ASN {asn} will be torn down."
        ));
    } else if lower.contains("clear ip bgp * soft")
        || lower.contains("clear bgp * soft")
        || lower.contains("clear bgp neighbor *")
    {
        summary
            .notes
            .push("All BGP neighbors receive refreshed inbound; forwarding unchanged but churn expected.".into());
    } else if lower.contains("clear ip bgp *") || lower.contains("clear bgp *") {
        summary
            .notes
            .push("All BGP sessions hard-reset; full reconvergence required.".into());
    } else if lower.contains("write erase") || lower.contains("zeroize") || lower.contains("delete startup-config") {
        summary
            .notes
            .push("Startup-config wiped — device will boot empty next reload.".into());
    } else if lower.trim_start().starts_with("shutdown")
        || lower.contains("\nshutdown")
        || lower.contains("set interfaces") && lower.contains("disable")
    {
        summary
            .notes
            .push("Interface goes admin down — any L3 adjacencies on this interface drop.".into());
    } else if let Some(_rest) = strip_prefix(&lower, "no neighbor ") {
        summary
            .notes
            .push("BGP neighbor removed — peering torn down.".into());
    }

    // Vendor-specific elaboration.
    if (vendor == "juniper" || platform == "junos") && lower.trim() == "commit" {
        summary
            .notes
            .push("All staged changes apply immediately to the live config.".into());
    }

    // If no heuristic fired and no topology, leave the topology-fallback note.
    if summary.notes.is_empty() {
        summary
            .notes
            .push("No specific impact pattern matched — rely on rule reasoning.".into());
    }

    summary
}

fn strip_prefix<'a>(s: &'a str, p: &str) -> Option<&'a str> {
    s.strip_prefix(p)
}

fn first_token(s: &str) -> &str {
    s.split_whitespace().next().unwrap_or("")
}

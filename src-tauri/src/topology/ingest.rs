//! End-to-end ingest pipeline: take a list of normalised `NeighborRecord`s
//! observed on a single source device and write them into:
//!   * `neighbor_cache` — one row per `(device_ref, device_kind, source_cmd)`.
//!   * `topology_nodes` / `topology_edges` — into the Global graph.
//!
//! The neighbor's `device_kind` is "promoted" from `discovered` to `ssh`
//! or `netconf` if its mgmt_ip / hostname is already known to the user
//! through the saved-connections tables. `ssh` wins when both match
//! (`UNION ALL ... LIMIT 1`, ssh first).

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use super::{cache, graph, IngestSummary, NeighborRecord, TopologyEdge, TopologyNode};
use super::GLOBAL_GRAPH_ID;

/// Promote a discovered neighbor's device_kind by checking whether the
/// supplied mgmt_ip OR hostname appears in `ssh_connections.host` or
/// `netconf_devices.host`. SSH wins ties.
fn promote_kind(
    conn: &Connection,
    neighbor_mgmt_ip: Option<&str>,
    neighbor_name: &str,
) -> Result<String> {
    // De-dupe non-empty candidates; if mgmt_ip is missing or empty, fall
    // back to just the hostname.
    let ip = neighbor_mgmt_ip.filter(|s| !s.is_empty()).unwrap_or("");
    let kind: Option<String> = conn
        .query_row(
            "SELECT 'ssh' AS kind FROM ssh_connections WHERE host IN (?1, ?2)
             UNION ALL
             SELECT 'netconf' AS kind FROM netconf_devices WHERE host IN (?1, ?2)
             LIMIT 1",
            params![ip, neighbor_name],
            |row| row.get(0),
        )
        .optional()?;
    Ok(kind.unwrap_or_else(|| "discovered".to_string()))
}

/// Persist a batch of neighbors observed from one source device.
///
/// Steps:
/// 1. Cache the raw + parsed_json under `(source_device_ref, source_device_kind, source_cmd)`.
/// 2. Upsert the source node into the Global graph.
/// 3. For each NeighborRecord:
///    a. Pick the canonical `device_ref`: prefer `neighbor_mgmt_ip` if
///       present (more stable than hostname), else `neighbor_name`.
///    b. Promote `device_kind` based on saved-connections lookup.
///    c. Upsert the neighbor node and the canonicalised edge.
///
/// The returned `IngestSummary` counts how many neighbor rows were
/// processed (the source node is not counted), since SQLite UPSERT does
/// not distinguish INSERT vs UPDATE without an extra round trip.
pub fn ingest_neighbors(
    conn: &Connection,
    source_device_ref: &str,
    source_device_kind: &str,
    source_cmd: &str,
    raw_output: &str,
    records: &[NeighborRecord],
) -> Result<IngestSummary> {
    let parsed_json = serde_json::to_string(records)?;

    // 1. Cache the capture (idempotent on the PK triple).
    cache::upsert_neighbor_cache(
        conn,
        source_device_ref,
        source_device_kind,
        source_cmd,
        raw_output,
        &parsed_json,
    )?;

    // 2. Upsert the source node into the Global graph.
    graph::upsert_node(
        conn,
        &TopologyNode {
            graph_id: GLOBAL_GRAPH_ID.to_string(),
            device_ref: source_device_ref.to_string(),
            device_kind: source_device_kind.to_string(),
            label: source_device_ref.to_string(),
            vendor: None,
            platform: None,
            mgmt_ip: None,
        },
    )?;

    let mut nodes_added: u32 = 0;
    let mut edges_added: u32 = 0;

    // 3. For each neighbor, upsert node + edge.
    for rec in records {
        let neighbor_ref: String = rec
            .neighbor_mgmt_ip
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| rec.neighbor_name.clone());

        let device_kind = promote_kind(conn, rec.neighbor_mgmt_ip.as_deref(), &rec.neighbor_name)?;

        graph::upsert_node(
            conn,
            &TopologyNode {
                graph_id: GLOBAL_GRAPH_ID.to_string(),
                device_ref: neighbor_ref.clone(),
                device_kind: device_kind.clone(),
                label: rec.neighbor_name.clone(),
                vendor: rec.neighbor_vendor.clone(),
                platform: rec.neighbor_platform.clone(),
                mgmt_ip: rec.neighbor_mgmt_ip.clone(),
            },
        )?;
        nodes_added += 1;

        // Plan 13 Phase 5 Task 5.2 — Routing-protocol records (BGP / OSPF /
        // IS-IS) often lack a local or neighbor port:
        //   * BGP peers have no L2 attachment — both sides empty.
        //   * OSPF reports the local interface but never the neighbor's.
        //   * IS-IS reports the local interface only.
        // To keep the canonical edge primary key unique across multiple
        // peers we substitute placeholders (`peer:<...>`) before insert.
        // Without these, two BGP peers from the same device would collide
        // on PK (graph_id, "", "", "", protocol).
        let a_port = if rec.local_port.is_empty() {
            format!("peer:{}", neighbor_ref)
        } else {
            rec.local_port.clone()
        };
        let b_port = if rec.neighbor_port.is_empty() {
            format!("peer:{}", source_device_ref)
        } else {
            rec.neighbor_port.clone()
        };

        graph::upsert_edge(
            conn,
            &TopologyEdge {
                graph_id: GLOBAL_GRAPH_ID.to_string(),
                a_device_ref: source_device_ref.to_string(),
                a_port,
                b_device_ref: neighbor_ref,
                b_port,
                protocol: rec.protocol.clone(),
                captured_at: 0, // 0 sentinel → SQLite stamps strftime('%s','now')
            },
        )?;
        edges_added += 1;
    }

    Ok(IngestSummary {
        nodes_added,
        edges_added,
        cache_updated: true,
    })
}

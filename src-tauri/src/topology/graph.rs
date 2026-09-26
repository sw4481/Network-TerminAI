//! SQL helpers for `topology_graphs`, `topology_nodes`, and
//! `topology_edges` (V0040). The interesting bit is `upsert_edge`, which
//! canonicalises the edge direction so that observations from both ends
//! of a link collapse into a single PK row.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::{TopologyEdge, TopologyGraph, TopologyNode};

/// Create a new topology_graphs row. Caller supplies the id (uuidv4 from
/// the command layer) so this function stays trivially testable.
pub fn create_graph(
    conn: &Connection,
    id: &str,
    name: &str,
    description: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO topology_graphs(id, name, description) VALUES (?1, ?2, ?3)",
        params![id, name, description],
    )?;
    Ok(())
}

/// Delete a graph and (via `ON DELETE CASCADE`) its nodes and edges.
pub fn delete_graph(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM topology_graphs WHERE id = ?1", params![id])?;
    Ok(())
}

/// All graphs ordered alphabetically.
pub fn list_graphs(conn: &Connection) -> Result<Vec<TopologyGraph>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, created_at, updated_at
         FROM topology_graphs
         ORDER BY name ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TopologyGraph {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Fetch a single graph by id, if it exists.
pub fn get_graph(conn: &Connection, id: &str) -> Result<Option<TopologyGraph>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, created_at, updated_at
         FROM topology_graphs WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(TopologyGraph {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        }))
    } else {
        Ok(None)
    }
}

/// Insert-or-replace a node by PK `(graph_id, device_ref, device_kind)`.
pub fn upsert_node(conn: &Connection, node: &TopologyNode) -> Result<()> {
    conn.execute(
        "INSERT INTO topology_nodes
            (graph_id, device_ref, device_kind, label, vendor, platform, mgmt_ip)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(graph_id, device_ref, device_kind) DO UPDATE SET
            label    = excluded.label,
            vendor   = excluded.vendor,
            platform = excluded.platform,
            mgmt_ip  = excluded.mgmt_ip",
        params![
            node.graph_id,
            node.device_ref,
            node.device_kind,
            node.label,
            node.vendor,
            node.platform,
            node.mgmt_ip,
        ],
    )?;
    Ok(())
}

/// Insert-or-replace an edge after canonicalising direction.
///
/// CDP/LLDP yields one observation per side of a link, so a physical link
/// between R1:Gi0/1 and R2:Gi0/2 will be reported twice:
///   * From R1's `show cdp neighbors`: `a=R1/Gi0/1`, `b=R2/Gi0/2`.
///   * From R2's `show cdp neighbors`: `a=R2/Gi0/2`, `b=R1/Gi0/1`.
/// To collapse those into one PK row we sort the `(device_ref, port)`
/// tuples lexicographically; the smaller side becomes `a_*`. Both
/// observations therefore canonicalise to `(R1,Gi0/1, R2,Gi0/2)`.
///
/// We compare on the full tuple, not just `device_ref`, so multi-link
/// peerings (R1:Gi0/1↔R2:Gi0/2 and R1:Gi0/3↔R2:Gi0/4) remain distinct.
pub fn upsert_edge(conn: &Connection, edge: &TopologyEdge) -> Result<()> {
    let (a_dev, a_port, b_dev, b_port) = canonicalise(
        &edge.a_device_ref,
        &edge.a_port,
        &edge.b_device_ref,
        &edge.b_port,
    );

    if edge.captured_at == 0 {
        // Let SQLite stamp the current epoch via the column DEFAULT.
        conn.execute(
            "INSERT INTO topology_edges
                (graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(graph_id, a_device_ref, a_port, b_device_ref, b_port) DO UPDATE SET
                protocol    = excluded.protocol,
                captured_at = strftime('%s','now')",
            params![edge.graph_id, a_dev, a_port, b_dev, b_port, edge.protocol],
        )?;
    } else {
        conn.execute(
            "INSERT INTO topology_edges
                (graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol, captured_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(graph_id, a_device_ref, a_port, b_device_ref, b_port) DO UPDATE SET
                protocol    = excluded.protocol,
                captured_at = excluded.captured_at",
            params![
                edge.graph_id,
                a_dev,
                a_port,
                b_dev,
                b_port,
                edge.protocol,
                edge.captured_at
            ],
        )?;
    }
    Ok(())
}

/// All nodes in a graph, ordered by device_ref for deterministic output.
pub fn list_nodes(conn: &Connection, graph_id: &str) -> Result<Vec<TopologyNode>> {
    let mut stmt = conn.prepare(
        "SELECT graph_id, device_ref, device_kind, label, vendor, platform, mgmt_ip
         FROM topology_nodes WHERE graph_id = ?1
         ORDER BY device_ref ASC, device_kind ASC",
    )?;
    let rows = stmt
        .query_map(params![graph_id], |row| {
            Ok(TopologyNode {
                graph_id: row.get(0)?,
                device_ref: row.get(1)?,
                device_kind: row.get(2)?,
                label: row.get(3)?,
                vendor: row.get(4)?,
                platform: row.get(5)?,
                mgmt_ip: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// All edges in a graph.
pub fn list_edges(conn: &Connection, graph_id: &str) -> Result<Vec<TopologyEdge>> {
    let mut stmt = conn.prepare(
        "SELECT graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol, captured_at
         FROM topology_edges WHERE graph_id = ?1
         ORDER BY a_device_ref ASC, a_port ASC, b_device_ref ASC, b_port ASC",
    )?;
    let rows = stmt
        .query_map(params![graph_id], |row| {
            Ok(TopologyEdge {
                graph_id: row.get(0)?,
                a_device_ref: row.get(1)?,
                a_port: row.get(2)?,
                b_device_ref: row.get(3)?,
                b_port: row.get(4)?,
                protocol: row.get(5)?,
                captured_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Wipe every node and edge belonging to a graph; preserve the graph row.
pub fn clear_graph(conn: &Connection, graph_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM topology_edges WHERE graph_id = ?1",
        params![graph_id],
    )?;
    conn.execute(
        "DELETE FROM topology_nodes WHERE graph_id = ?1",
        params![graph_id],
    )?;
    Ok(())
}

/// Sort `(dev, port)` tuples lexicographically; the smaller pair becomes
/// the `a_*` side. Exposed (`pub(crate)`) for tests in the integration
/// suite.
pub(crate) fn canonicalise<'a>(
    a_dev: &'a str,
    a_port: &'a str,
    b_dev: &'a str,
    b_port: &'a str,
) -> (&'a str, &'a str, &'a str, &'a str) {
    if (a_dev, a_port) <= (b_dev, b_port) {
        (a_dev, a_port, b_dev, b_port)
    } else {
        (b_dev, b_port, a_dev, a_port)
    }
}

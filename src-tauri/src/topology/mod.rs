//! Plan 13 Phase 1.3 — topology data model + ingest pipeline.
//!
//! This module exposes:
//! - `cache`: SQL helpers around the `neighbor_cache` table.
//! - `graph`: SQL helpers for graph CRUD + node/edge upserts (with edge
//!   canonicalisation).
//! - `ingest`: end-to-end pipeline that takes a list of `NeighborRecord`s
//!   for a single source device and writes them into the Global graph
//!   (and the neighbor cache).
//!
//! Types are kept here so callers can `use crate::topology::TopologyNode`
//! without importing a submodule. Submodules contain only logic.

pub mod cache;
pub mod graph;
pub mod ingest;
pub mod lookup;

/// Stable id of the seeded "Global" graph. Migration `V0040` inserts a
/// `topology_graphs` row with this id; ingest always writes into it so the
/// frontend has at least one graph to render. Defining the literal here
/// means callers (commands, tests) don't have to hard-code it.
pub const GLOBAL_GRAPH_ID: &str = "00000000-0000-0000-0000-0000000000g1";

/// One normalized neighbor entry as emitted by the sidecar's
/// `topology.neighbors` method (Phase 1.2). The `protocol` is the discovery
/// protocol that produced the record (`"cdp"` or `"lldp"` in Phase 1).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NeighborRecord {
    pub protocol: String,
    pub local_port: String,
    pub neighbor_name: String,
    pub neighbor_port: String,
    pub neighbor_mgmt_ip: Option<String>,
    pub neighbor_platform: Option<String>,
    pub neighbor_vendor: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// One node in a topology graph. PK = `(graph_id, device_ref, device_kind)`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TopologyNode {
    pub graph_id: String,
    pub device_ref: String,
    pub device_kind: String,
    pub label: String,
    pub vendor: Option<String>,
    pub platform: Option<String>,
    pub mgmt_ip: Option<String>,
}

/// One edge in a topology graph. The `(a_*, b_*)` tuple is canonicalised
/// before insert (see `graph::upsert_edge`) so that bidirectional
/// observations from both sides collapse into a single PK row.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TopologyEdge {
    pub graph_id: String,
    pub a_device_ref: String,
    pub a_port: String,
    pub b_device_ref: String,
    pub b_port: String,
    pub protocol: String,
    pub captured_at: i64,
}

/// Metadata for a single topology graph (Global or user-created).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TopologyGraph {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Returned by `ingest::ingest_neighbors`. `nodes_added` / `edges_added`
/// count rows processed (INSERTs and UPDATEs) since SQLite UPSERTs always
/// "touch" the row; getting a precise INSERT-vs-UPDATE delta would require
/// a SELECT-then-INSERT round trip per row which is not worth the cost.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IngestSummary {
    pub nodes_added: u32,
    pub edges_added: u32,
    pub cache_updated: bool,
}

/// One row of `neighbor_cache` — the latest CDP/LLDP output captured for
/// a `(device_ref, device_kind, source_cmd)` triple.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NeighborCacheRow {
    pub device_ref: String,
    pub device_kind: String,
    pub source_cmd: String,
    pub captured_at: i64,
    pub parsed_json: String,
}

/// Bundle returned by `topology_get_graph`: graph metadata plus all
/// nodes and edges in one round trip. Frontend uses this to render
/// without a follow-up call.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GraphSnapshot {
    pub graph: TopologyGraph,
    pub nodes: Vec<TopologyNode>,
    pub edges: Vec<TopologyEdge>,
}

/// Result of `device_lookup_by_ref` (Plan 13 Phase 3.2). Mirrors the
/// TypeScript `SavedDeviceLookup` interface in `src/lib/topology.ts` —
/// `kind` is `"ssh"` or `"netconf"`, and `device_ref` is the host
/// string the caller should pass to the SSH/NETCONF open helpers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SavedDeviceLookup {
    pub kind: String,
    pub device_ref: String,
}

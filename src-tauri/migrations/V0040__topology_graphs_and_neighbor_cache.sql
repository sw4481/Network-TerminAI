-- V0040__topology_graphs_and_neighbor_cache.sql

CREATE TABLE IF NOT EXISTS topology_graphs (
  id          TEXT PRIMARY KEY,                  -- uuidv4
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS topology_nodes (
  graph_id    TEXT NOT NULL REFERENCES topology_graphs(id) ON DELETE CASCADE,
  device_ref  TEXT NOT NULL,                     -- canonical ref (hostname or mgmt_ip)
  device_kind TEXT NOT NULL,                     -- 'ssh' | 'netconf' | 'discovered'
  label       TEXT NOT NULL,
  vendor      TEXT,
  platform    TEXT,
  mgmt_ip     TEXT,
  PRIMARY KEY (graph_id, device_ref, device_kind)
);
CREATE INDEX IF NOT EXISTS idx_topo_nodes_graph ON topology_nodes(graph_id);

CREATE TABLE IF NOT EXISTS topology_edges (
  graph_id     TEXT NOT NULL REFERENCES topology_graphs(id) ON DELETE CASCADE,
  a_device_ref TEXT NOT NULL,
  a_port       TEXT NOT NULL,
  b_device_ref TEXT NOT NULL,
  b_port       TEXT NOT NULL,
  protocol     TEXT NOT NULL CHECK (protocol IN ('cdp','lldp','bgp','ospf','isis')),
  captured_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (graph_id, a_device_ref, a_port, b_device_ref, b_port)
);
CREATE INDEX IF NOT EXISTS idx_topo_edges_graph ON topology_edges(graph_id);
CREATE INDEX IF NOT EXISTS idx_topo_edges_proto ON topology_edges(protocol);

CREATE TABLE IF NOT EXISTS neighbor_cache (
  device_ref  TEXT NOT NULL,
  device_kind TEXT NOT NULL,
  source_cmd  TEXT NOT NULL,                     -- the exact show command issued
  raw_output  TEXT NOT NULL,
  parsed_json TEXT NOT NULL,                     -- canonicalised NeighborRecord[]
  captured_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (device_ref, device_kind, source_cmd)
);
CREATE INDEX IF NOT EXISTS idx_neighbor_cache_captured ON neighbor_cache(captured_at DESC);

-- Seed a default "Global" graph so the topology tab always has something to render.
INSERT OR IGNORE INTO topology_graphs (id, name, description)
  VALUES ('00000000-0000-0000-0000-0000000000g1', 'Global', 'Aggregated view of all discovered neighbors.');

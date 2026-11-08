-- Preserve every surviving legacy observation verbatim. Historic overwritten
-- protocol evidence cannot be reconstructed by this migration.
CREATE TABLE topology_edges_v0098 (
  graph_id     TEXT NOT NULL REFERENCES topology_graphs(id) ON DELETE CASCADE,
  a_device_ref TEXT NOT NULL,
  a_port       TEXT NOT NULL,
  b_device_ref TEXT NOT NULL,
  b_port       TEXT NOT NULL,
  protocol     TEXT NOT NULL CHECK (protocol IN ('cdp','lldp','bgp','ospf','isis','eigrp','unknown')),
  captured_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol)
);
INSERT INTO topology_edges_v0098
  (graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol, captured_at)
SELECT graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol, captured_at
FROM topology_edges;
DROP TABLE topology_edges;
ALTER TABLE topology_edges_v0098 RENAME TO topology_edges;
CREATE INDEX idx_topo_edges_graph ON topology_edges(graph_id);
CREATE INDEX idx_topo_edges_proto ON topology_edges(protocol);

-- An origin receipt only: subsequent native observations may coexist with imports.
-- Only declared, validated inventory/protocol fields enter this bounded JSON.
CREATE TABLE topology_import_provenance (
  graph_id TEXT PRIMARY KEY REFERENCES topology_graphs(id) ON DELETE CASCADE,
  provenance_json TEXT NOT NULL CHECK (length(CAST(provenance_json AS BLOB)) <= 2097152)
);

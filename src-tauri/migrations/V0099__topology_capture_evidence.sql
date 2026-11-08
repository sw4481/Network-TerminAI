-- Collection receipts stay local; native interchange v1 contains graph observations only.
CREATE TABLE topology_capture_evidence (
  graph_id TEXT NOT NULL REFERENCES topology_graphs(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('cdp','lldp','bgp','ospf','isis')),
  attempt_id TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL CHECK (length(CAST(evidence_json AS BLOB)) <= 2097152),
  PRIMARY KEY (graph_id, source_ref, protocol)
);

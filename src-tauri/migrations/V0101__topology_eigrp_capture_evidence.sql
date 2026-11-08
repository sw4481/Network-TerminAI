-- Admit EIGRP without changing existing source-command receipts or attempt authority.
ALTER TABLE topology_capture_evidence RENAME TO topology_capture_evidence_legacy;
CREATE TABLE topology_capture_evidence (
  graph_id TEXT NOT NULL REFERENCES topology_graphs(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('cdp','lldp','bgp','ospf','isis','eigrp')),
  source_command TEXT NOT NULL,
  attempt_id TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL CHECK (length(CAST(evidence_json AS BLOB)) <= 2097152),
  PRIMARY KEY (graph_id, source_ref, protocol, source_command)
);
INSERT INTO topology_capture_evidence(graph_id,source_ref,protocol,source_command,attempt_id,evidence_json)
SELECT graph_id,source_ref,protocol,source_command,attempt_id,evidence_json
FROM topology_capture_evidence_legacy;
DROP TABLE topology_capture_evidence_legacy;

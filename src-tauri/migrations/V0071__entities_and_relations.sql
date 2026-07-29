-- V0071__entities_and_relations.sql
--
-- Context-graph Phase A: a canonical entity overlay + a generic relationship
-- table. ADDITIVE ONLY — no existing table is altered or dropped, so a DB
-- migrated to V0071 still opens cleanly on a pre-feature binary (rollback
-- contract). All reads/writes are gated at runtime by the CCIE_CONTEXT_GRAPH
-- flag; when the feature is off these tables simply sit empty.
--
-- `entities` unifies the ad-hoc (device_ref, device_kind) join key used across
-- topology_nodes, ssh_connections, and netconf_devices into one addressable
-- node. It is an OVERLAY: the source tables remain the source of truth and are
-- untouched; `entities` is (re)built by the sidecar graph helper on demand.

CREATE TABLE IF NOT EXISTS entities (
  entity_id   TEXT PRIMARY KEY,                 -- canonical id: '<kind>:<ref>'
  kind        TEXT NOT NULL,                    -- 'device' | 'interface' | 'service' | 'vrf' | ...
  device_ref  TEXT,                             -- hostname or mgmt_ip (join key to topology/config/drift)
  label       TEXT NOT NULL,
  vendor      TEXT,
  platform    TEXT,
  mgmt_ip     TEXT,
  sources     TEXT NOT NULL DEFAULT '[]',       -- JSON array: which tables contributed
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_device_ref ON entities(device_ref);

-- Generic subject-predicate-object relationship overlay for relations that are
-- NOT physical/protocol topology links (those stay in topology_edges). Populated
-- opportunistically by feature writers (config snapshot save, drift report,
-- change report) and by the graph helper. Kept separate from topology_edges so
-- the existing edge CHECK constraint and PK are never touched.
CREATE TABLE IF NOT EXISTS entity_relations (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  subject     TEXT NOT NULL,                    -- entity_id or device_ref
  predicate   TEXT NOT NULL,                    -- 'configured_by' | 'has_snapshot' | 'drifted_from' | 'documented_in' | 'changed_by'
  object      TEXT NOT NULL,                    -- entity_id / snapshot id / doc id / etc.
  metadata    TEXT,                             -- optional JSON
  captured_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(subject, predicate, object)
);
CREATE INDEX IF NOT EXISTS idx_entity_relations_subject ON entity_relations(subject);
CREATE INDEX IF NOT EXISTS idx_entity_relations_object ON entity_relations(object);
CREATE INDEX IF NOT EXISTS idx_entity_relations_predicate ON entity_relations(predicate);

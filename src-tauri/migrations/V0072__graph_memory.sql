-- V0072__graph_memory.sql
--
-- Context-graph Phase B: temporal memory. Two ADDITIVE tables — no existing
-- table is touched, so a DB migrated to V0072 still opens on a pre-feature
-- binary (rollback contract). All reads/writes are gated at runtime by the
-- CCIE_CONTEXT_GRAPH flag; empty when the feature is off.
--
-- `graph_facts` is a TEMPORAL knowledge store: a new value for an existing
-- (entity, key) supersedes the prior one by stamping its valid_to, rather than
-- deleting — so history is preserved and "what did we know then" is answerable.
-- `graph_decisions` records the WHY behind operational changes (context +
-- rationale + affected entities) for cross-session recall and audit.

CREATE TABLE IF NOT EXISTS graph_facts (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  entity      TEXT NOT NULL,                    -- normalized lowercase entity name
  key         TEXT NOT NULL,                    -- attribute name, e.g. 'bgp_state'
  value       TEXT NOT NULL,
  metadata    TEXT,                             -- optional JSON
  valid_from  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  valid_to    INTEGER,                          -- NULL = currently valid
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(entity, key, valid_from)
);
CREATE INDEX IF NOT EXISTS idx_graph_facts_entity ON graph_facts(entity);
CREATE INDEX IF NOT EXISTS idx_graph_facts_entity_key ON graph_facts(entity, key);
CREATE INDEX IF NOT EXISTS idx_graph_facts_valid ON graph_facts(valid_from, valid_to);

CREATE TABLE IF NOT EXISTS graph_decisions (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  context       TEXT NOT NULL,                  -- what was happening
  decision      TEXT NOT NULL,                  -- what was decided/done
  rationale     TEXT NOT NULL,                  -- why
  entities_json TEXT NOT NULL DEFAULT '[]',     -- JSON array of related entity names
  cr_ref        TEXT,                           -- optional change-request reference
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_decisions_created ON graph_decisions(created_at DESC);

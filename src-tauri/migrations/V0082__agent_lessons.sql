-- V0082__agent_lessons.sql
--
-- Agent lessons: a self-learning "second brain" for the agents. One ADDITIVE
-- table — no existing table is touched, so a DB migrated to V0082 still opens
-- on a pre-feature binary (rollback contract). All reads/writes are gated at
-- runtime by the CCIE_AGENT_LESSONS flag; empty/no-op when the feature is off.
--
-- Each row is one short behavioral gotcha learned from a prior run (e.g. "pass
-- Meraki pagination via query_params={'total_pages':'all'}, not as a kwarg").
-- `scope` is a vendor/tool id ('meraki','pyats',…) or 'global'. Lessons are
-- injected into the agent's system prompt at loop start, filtered to the
-- running agent's scope plus 'global'. `source` distinguishes auto-distilled
-- lessons from ones recorded explicitly. UNIQUE(scope, lesson) dedupes cheaply
-- at the DB layer so re-learning the same lesson is a no-op insert.

CREATE TABLE IF NOT EXISTS agent_lessons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,                       -- vendor/tool id or 'global'
  lesson     TEXT NOT NULL,                       -- one short behavioral gotcha
  source     TEXT NOT NULL DEFAULT 'auto',        -- 'auto' | 'explicit'
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(scope, lesson)
);
CREATE INDEX IF NOT EXISTS idx_agent_lessons_scope ON agent_lessons(scope);

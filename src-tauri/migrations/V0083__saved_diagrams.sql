-- V0083__saved_diagrams.sql
--
-- Persist agent-generated diagrams. Until now a diagram produced by the drawio
-- sandbox helper was emitted as a streaming event, rendered inline, and held
-- only in an in-memory Zustand store — so it vanished on reload/restart and was
-- never queryable. This ADDITIVE table gives every diagram a durable home.
--
-- One row per saved diagram. `format` is 'xml' (native mxGraph, renderable
-- offline), 'mermaid', 'csv', or 'image' (Kroki SVG). `xml` holds native
-- mxGraph for offline preview; `source` holds mermaid/csv text; `url` is the
-- app.diagrams.net #create= link (self-contained, compressed). `agent_id` and
-- `tab_id` are best-effort provenance (nullable) so a diagram can be traced
-- back to the run that made it. No FK on tab_id: diagrams outlive tabs.

CREATE TABLE IF NOT EXISTS saved_diagrams (
  id         TEXT PRIMARY KEY,                    -- uuid / caller-supplied id
  title      TEXT NOT NULL DEFAULT 'diagram',
  format     TEXT NOT NULL DEFAULT 'xml',         -- 'xml' | 'mermaid' | 'csv' | 'image'
  xml        TEXT,                                -- native mxGraph XML (offline render)
  source     TEXT,                                -- mermaid/csv source when not xml
  url        TEXT,                                -- app.diagrams.net #create= link
  image_url  TEXT,                                -- Kroki SVG / data URI for 'image'
  agent_id   TEXT,                                -- provenance (nullable)
  tab_id     TEXT,                                -- provenance (nullable, no FK)
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_saved_diagrams_created ON saved_diagrams(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_diagrams_agent ON saved_diagrams(agent_id);

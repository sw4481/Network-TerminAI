-- V0055: Drop session-chains tables.
--
-- Session chaining (Plan 10 / V0037) was retired in favor of Fan-Out — its
-- live dispatch was never finished (stub openers) and Fan-Out covers the
-- multi-device need. This removes the now-unused tables.
--
-- Order matters: jump_host_links and session_chain_hops reference
-- session_chains, so drop the dependents first.
--
-- The `tabs.chain_id` column (added by V0037) carries a foreign-key reference
-- to session_chains. It MUST be dropped along with the table: with
-- `PRAGMA foreign_keys = ON`, any INSERT into `tabs` would otherwise fail with
-- "no such table: session_chains" once the parent table is gone. Modern SQLite
-- (3.35+) supports ALTER TABLE ... DROP COLUMN directly.

DROP INDEX IF EXISTS idx_jump_host_links_child;
DROP INDEX IF EXISTS idx_tabs_chain;

ALTER TABLE tabs DROP COLUMN chain_id;

DROP TABLE IF EXISTS jump_host_links;
DROP TABLE IF EXISTS session_chain_hops;
DROP TABLE IF EXISTS session_chains;

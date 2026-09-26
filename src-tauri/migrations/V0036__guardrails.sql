-- Plan 09 Phase 1 — AI Guardrails / Blast-Radius Analyzer
--
-- Two tables:
--  * blast_radius_rules — vendor/platform-scoped regex rules that classify
--    a CLI command into a tier (0=read-only, 1=local-write, 2=forwarding,
--    3=service-affecting). Includes seeded `builtin=1` rows compiled in
--    via `src-tauri/src/guardrails/builtin_rules.json`.
--  * guardrail_decisions — append-only audit log of every classification
--    decision and the user's resolution (auto-approved / confirmed /
--    typed-confirmed / admin-override / denied / ambiguous).

CREATE TABLE IF NOT EXISTS blast_radius_rules (
  id TEXT PRIMARY KEY,                       -- uuidv4 or "builtin-..."
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,                      -- 'cisco' | 'juniper' | 'arista' | '*'
  platform TEXT NOT NULL,                    -- 'iosxe' | 'ios' | 'nxos' | 'junos' | 'eos' | '*'
  pattern_regex TEXT NOT NULL,               -- anchored regex (callers should anchor; we validate)
  tier INTEGER NOT NULL CHECK (tier IN (0,1,2,3)),
  reason TEXT NOT NULL,                      -- human-readable reasoning shown in decision log
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_blast_radius_rules_vendor_platform
  ON blast_radius_rules(vendor, platform, enabled);
CREATE INDEX IF NOT EXISTS idx_blast_radius_rules_tier
  ON blast_radius_rules(tier, enabled);

CREATE TABLE IF NOT EXISTS guardrail_decisions (
  id TEXT PRIMARY KEY,                       -- uuidv4
  session_id TEXT NOT NULL,                  -- NETCONF session id or SSH tab id
  command TEXT NOT NULL,                     -- the literal command being classified
  tier INTEGER NOT NULL CHECK (tier IN (0,1,2,3)),
  rule_id TEXT REFERENCES blast_radius_rules(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,                    -- 'auto_approved'|'confirmed'|'typed_confirmed'|'admin_override'|'denied'|'ambiguous'
  user_action TEXT,                          -- 'proceed'|'cancel'|'edit' etc.
  reasoning TEXT NOT NULL,                   -- rule.reason or "no rule matched; LLM second opinion: ..."
  decided_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_guardrail_decisions_session
  ON guardrail_decisions(session_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_guardrail_decisions_tier
  ON guardrail_decisions(tier, decided_at DESC);

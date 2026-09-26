-- V0068: per-intent match mode. 'baseline' = whole-config two-way diff
-- (existing behavior); 'partial' = presence match (only intended lines).
-- Existing rows default to 'baseline' so behavior is unchanged.
ALTER TABLE intent_templates
  ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'baseline'
  CHECK (match_mode IN ('baseline','partial'));

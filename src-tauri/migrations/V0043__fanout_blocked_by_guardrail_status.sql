-- Final security review (Finding 1): the multi-device fan-out executor now
-- gates every command against the Plan 09 guardrail ruleset before
-- dispatch. When a command (or any of its shell-split chunks) classifies
-- above Tier-0, every device's row is finalized with a new status —
-- `blocked_by_guardrail` — so the frontend can surface the rejection
-- distinctly from a worker-side failure.
--
-- The original `fanout_run_results.status` CHECK constraint did not
-- include this value. SQLite can't ALTER a CHECK in place, so we rebuild
-- the table: copy rows out, drop the original, re-create with the wider
-- CHECK, copy back, and rebuild the index. Foreign-key cascades onto
-- `fanout_runs(id)` are preserved.

CREATE TABLE fanout_run_results_new (
  run_id            TEXT    NOT NULL REFERENCES fanout_runs(id) ON DELETE CASCADE,
  device_id         TEXT    NOT NULL,
  device_kind       TEXT    NOT NULL CHECK (device_kind IN ('ssh','netconf')),
  attempt_number    INTEGER NOT NULL DEFAULT 1,
  block_id          TEXT,
  parsed_output_id  TEXT,
  status            TEXT    NOT NULL CHECK (status IN
                      ('pending','running','success','failed','timeout','cancelled','blocked_by_guardrail')),
  error             TEXT,
  started_at        INTEGER,
  ended_at          INTEGER,
  PRIMARY KEY (run_id, device_id, device_kind, attempt_number)
);

INSERT INTO fanout_run_results_new
  (run_id, device_id, device_kind, attempt_number, block_id, parsed_output_id,
   status, error, started_at, ended_at)
SELECT run_id, device_id, device_kind, attempt_number, block_id, parsed_output_id,
       status, error, started_at, ended_at
  FROM fanout_run_results;

DROP TABLE fanout_run_results;
ALTER TABLE fanout_run_results_new RENAME TO fanout_run_results;

CREATE INDEX IF NOT EXISTS idx_fanout_results_status
  ON fanout_run_results(run_id, status);

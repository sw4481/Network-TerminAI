-- V0049__command_block_iac_execution_id.sql
-- Add the iac_execution_id link column to command_blocks.
--
-- IaC Phase 1 wired the detect -> parse -> store -> render pipeline, but the
-- column that links a command block to its parsed iac_executions row was only
-- ever created ad-hoc on the original dev machine. It was never in a migration,
-- so fresh databases (CI, new installs) lacked it. That broke ALL block loading
-- (blocks.rs SELECTs iac_execution_id) and IaC enrichment (iac_process_block
-- UPDATEs it), not just the IaC feature.
--
-- Nullable, no default: blocks without IaC metadata simply have NULL.
ALTER TABLE command_blocks ADD COLUMN iac_execution_id TEXT;

CREATE INDEX IF NOT EXISTS idx_command_blocks_iac_execution
  ON command_blocks(iac_execution_id);

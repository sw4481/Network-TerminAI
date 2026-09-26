-- Add error_analysis column to command_blocks table for Phase 4 Task 5
-- Stores AI-generated error analysis with categorization and fix suggestions
ALTER TABLE command_blocks ADD COLUMN error_analysis TEXT;

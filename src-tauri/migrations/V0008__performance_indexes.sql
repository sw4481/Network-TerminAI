-- Performance indexes for Phase 7 optimization
-- These indexes improve query performance for command history, AI chat, and session data

-- Optimize command block queries by tab and time range
-- Existing index: idx_blocks_tab ON command_blocks(tab_id, started_at)
-- Add covering index for common query patterns
CREATE INDEX IF NOT EXISTS idx_command_blocks_ended_at ON command_blocks(tab_id, ended_at DESC)
  WHERE ended_at IS NOT NULL;

-- Optimize AI message queries by tab and timestamp
-- Existing index: idx_ai_messages_tab ON ai_messages(tab_id, timestamp)
-- Add index for reverse chronological queries (common in chat UI)
CREATE INDEX IF NOT EXISTS idx_ai_messages_recent ON ai_messages(tab_id, timestamp DESC);

-- Optimize session scrollback queries by tab and sequence
CREATE INDEX IF NOT EXISTS idx_session_scrollback_seq ON session_scrollback(session_id, tab_id);

-- Add index for scrollback queries by tab
CREATE INDEX IF NOT EXISTS idx_scrollback_tab_seq ON scrollback(tab_id, seq DESC);

-- Optimize tab lookup by creation time (for "recent tabs" queries)
CREATE INDEX IF NOT EXISTS idx_tabs_created ON tabs(created_at DESC)
  WHERE closed_at IS NULL;

-- Optimize closed tab cleanup queries
CREATE INDEX IF NOT EXISTS idx_tabs_closed ON tabs(closed_at)
  WHERE closed_at IS NOT NULL;

-- Add composite index for command block exit code analysis
CREATE INDEX IF NOT EXISTS idx_command_blocks_exit_code ON command_blocks(tab_id, exit_code, started_at)
  WHERE exit_code IS NOT NULL;

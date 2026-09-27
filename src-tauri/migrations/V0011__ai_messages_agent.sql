-- Per-agent chat histories: tag ai_messages with the agent that was active
-- when the message was produced. NULL => general chat (no persona).
ALTER TABLE ai_messages ADD COLUMN agent_id TEXT;

-- Composite index for "get messages for (tab, agent)" lookups (hot path).
-- NULL agent_id rows are indexed too since SQLite indexes NULL values.
CREATE INDEX IF NOT EXISTS idx_ai_messages_tab_agent_ts
  ON ai_messages(tab_id, agent_id, timestamp);

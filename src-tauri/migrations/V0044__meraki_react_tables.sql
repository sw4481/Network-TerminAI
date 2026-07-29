-- Phase 4: ReACT agent with disambiguation and auto-resolve for Meraki CLI
--
-- Tracks session context (last-used parameter values) and pending resumes
-- (paused loops waiting for user disambiguation/confirmation).

-- Session state: tracks last-used parameter values per agent session
CREATE TABLE IF NOT EXISTS react_session_state (
    session_id      TEXT PRIMARY KEY,
    last_org_id     TEXT,
    last_network_id TEXT,
    last_serial     TEXT,
    updated_at      INTEGER NOT NULL
);

-- Pending resumes: stores paused loops waiting for user input
CREATE TABLE IF NOT EXISTS react_pending_resumes (
    pending_id      TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    question        TEXT NOT NULL,             -- JSON: {param, prompt, options}
    loop_state      BLOB NOT NULL,             -- pickled history + ctx
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL           -- 30 min default
);

-- Index for cleaning up expired resumes
CREATE INDEX IF NOT EXISTS idx_react_pending_expires
    ON react_pending_resumes(expires_at);

-- Phase 5: Audit log for all Meraki tool calls
CREATE TABLE IF NOT EXISTS meraki_tool_calls (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT,
    agent_id         TEXT,
    tool_name        TEXT NOT NULL,
    method           TEXT NOT NULL,
    path             TEXT NOT NULL,
    args_json        TEXT NOT NULL,
    blast_radius     TEXT NOT NULL,
    approval_status  TEXT,                     -- null|approved|denied|auto|approved_session
    response_status  INTEGER,
    response_summary TEXT,
    error_code       TEXT,
    duration_ms      INTEGER NOT NULL,
    created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meraki_tool_calls_conv  ON meraki_tool_calls(conversation_id);
CREATE INDEX IF NOT EXISTS idx_meraki_tool_calls_agent ON meraki_tool_calls(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_meraki_tool_calls_blast ON meraki_tool_calls(blast_radius, created_at);

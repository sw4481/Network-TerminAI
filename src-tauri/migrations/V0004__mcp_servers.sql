-- MCP server definitions
-- Tracks configured MCP servers and their connection details
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport IN ('stdio', 'sse')),
  command_json TEXT,       -- for stdio: {"cmd": "...", "args": [...]}
  url TEXT,                -- for sse: the SSE endpoint URL
  env_json TEXT,           -- environment variables as JSON object
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Approval policies for MCP tools
-- Controls which tools can execute automatically vs requiring user approval
CREATE TABLE IF NOT EXISTS approval_policies (
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(policy IN ('auto_allow', 'confirm', 'confirm_once', 'deny')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'session')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (server_name, tool_name)
);

-- Index for quick policy lookups
CREATE INDEX IF NOT EXISTS idx_approval_policies_server ON approval_policies(server_name);

-- Remembered decisions for ConfirmOnce policies
-- When a user approves a ConfirmOnce tool, we record it here
CREATE TABLE IF NOT EXISTS approval_memory (
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny')),
  remembered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (server_name, tool_name)
);

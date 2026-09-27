# CCIE Terminal API Documentation

Complete reference for Tauri commands, Python sidecar protocol, skills API, and MCP integration.

## Table of Contents

- [Tauri Commands](#tauri-commands)
- [Python Sidecar Protocol](#python-sidecar-protocol)
- [Skills API](#skills-api)
- [MCP Integration](#mcp-integration)
- [Database Schema](#database-schema)

## Tauri Commands

All Tauri commands are invoked from the frontend using `@tauri-apps/api`:

```typescript
import { invoke } from '@tauri-apps/api/core';

const result = await invoke('command_name', { param1: value1 });
```

### PTY Management

#### `pty_spawn`

Spawn a new PTY session.

**Parameters:**
- `shell: string` - Shell executable path
- `args: string[]` - Shell arguments
- `cwd: string` - Working directory
- `cols: number` - Terminal width in columns
- `rows: number` - Terminal height in rows
- `on_event: Channel<PtyEvent>` - Event channel for PTY output

**Returns:** `Promise<string>` - Tab ID

**Example:**
```typescript
import { Channel } from '@tauri-apps/api/core';

const events = new Channel<PtyEvent>();
events.onmessage = (event) => {
  console.log('PTY event:', event);
};

const tabId = await invoke('pty_spawn', {
  shell: '/bin/zsh',
  args: [],
  cwd: '$HOME',
  cols: 80,
  rows: 24,
  onEvent: events,
});
```

#### `pty_write`

Write data to a PTY session.

**Parameters:**
- `tab_id: string` - Tab ID
- `data: number[]` - Bytes to write

**Returns:** `Promise<void>`

**Example:**
```typescript
const data = new TextEncoder().encode('ls -la\n');
await invoke('pty_write', {
  tabId,
  data: Array.from(data),
});
```

#### `pty_resize`

Resize a PTY session.

**Parameters:**
- `tab_id: string` - Tab ID
- `cols: number` - New width
- `rows: number` - New height

**Returns:** `Promise<void>`

**Example:**
```typescript
await invoke('pty_resize', {
  tabId,
  cols: 120,
  rows: 40,
});
```

#### `pty_kill`

Kill a PTY session and close the tab.

**Parameters:**
- `tab_id: string` - Tab ID

**Returns:** `Promise<void>`

**Example:**
```typescript
await invoke('pty_kill', { tabId });
```

### Tab Management

#### `list_tabs`

List all open tabs.

**Returns:** `Promise<Tab[]>`

```typescript
interface Tab {
  id: string;
  title: string;
  shell_cmd: string;
  cwd: string;
  created_at: number;
}

const tabs = await invoke('list_tabs');
```

#### `tab_scrollback`

Get scrollback buffer for a tab.

**Parameters:**
- `tab_id: string` - Tab ID

**Returns:** `Promise<number[]>` - Raw bytes

**Example:**
```typescript
const bytes = await invoke('tab_scrollback', { tabId });
const text = new TextDecoder().decode(new Uint8Array(bytes));
```

#### `block_output`

Get output for a specific command block.

**Parameters:**
- `block_id: string` - Block ID

**Returns:** `Promise<number[]>` - Raw bytes

### AI Agent

#### `agent_chat_stream`

Stream AI chat responses.

**Parameters:**
- `tab_id: string` - Associated tab ID
- `message: string` - User message
- `on_event: Channel<AgentChatEvent>` - Event channel

**Returns:** `Promise<void>`

**Event types:**
```typescript
type AgentChatEvent =
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

**Example:**
```typescript
const events = new Channel<AgentChatEvent>();
let response = '';

events.onmessage = (event) => {
  if (event.type === 'token') {
    response += event.text;
  } else if (event.type === 'done') {
    console.log('Complete response:', response);
  } else if (event.type === 'error') {
    console.error('Error:', event.message);
  }
};

await invoke('agent_chat_stream', {
  tabId,
  message: 'Explain BGP',
  onEvent: events,
});
```

#### `agent_nl_to_command`

Convert natural language to a shell command.

**Parameters:**
- `nl_query: string` - Natural language query
- `shell: string` - Shell type (bash, zsh, etc.)
- `cwd: string` - Current working directory

**Returns:** `Promise<string>` - Generated command

**Example:**
```typescript
const cmd = await invoke('agent_nl_to_command', {
  nlQuery: 'list files modified today',
  shell: 'bash',
  cwd: '/home/user',
});
// cmd: "find . -type f -mtime -1"
```

#### `agent_explain_error`

Get AI explanation for a failed command.

**Parameters:**
- `cmd: string` - Command that failed
- `output: string` - Command output
- `exit_code: number` - Exit code
- `cwd: string` - Working directory

**Returns:** `Promise<ExplainErrorResult>`

```typescript
interface ExplainErrorResult {
  explanation: string;
  suggested_command: string;
}

const result = await invoke('agent_explain_error', {
  cmd: 'git push',
  output: 'fatal: No upstream branch...',
  exitCode: 1,
  cwd: '/project',
});
```

### MCP Servers

#### `mcp_list_servers`

List all configured MCP servers.

**Returns:** `Promise<McpServer[]>`

```typescript
interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command_json: string | null;
  url: string | null;
  env_json: string | null;
  enabled: boolean;
  created_at: number;
}
```

#### `mcp_add_server`

Add a new MCP server.

**Parameters:**
- `name: string` - Server name
- `transport: 'stdio' | 'sse'` - Transport type
- `command_json: string | null` - Command config (stdio)
- `url: string | null` - Server URL (sse)
- `env_json: string | null` - Environment variables

**Returns:** `Promise<string>` - Server ID

**Example:**
```typescript
const serverId = await invoke('mcp_add_server', {
  name: 'filesystem',
  transport: 'stdio',
  commandJson: JSON.stringify({
    cmd: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
  }),
  url: null,
  envJson: null,
});
```

#### `mcp_remove_server`

Remove an MCP server.

**Parameters:**
- `id: string` - Server ID

**Returns:** `Promise<void>`

#### `mcp_update_server_enabled`

Enable or disable an MCP server.

**Parameters:**
- `id: string` - Server ID
- `enabled: boolean` - New state

**Returns:** `Promise<void>`

#### `approve_tool_call`

Respond to an MCP tool approval request.

**Parameters:**
- `request_id: string` - Request ID
- `approved: boolean` - Approval decision
- `remember: boolean` - Remember for future invocations

**Returns:** `Promise<void>`

### Skills

#### `skills_list`

List all available skills.

**Returns:** `Promise<Skill[]>`

```typescript
interface Skill {
  id: string;
  name: string;
  description: string;
  when_to_use: string;
  playbook: string;
  scripts: string[] | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}
```

#### `skills_get`

Get a specific skill by ID.

**Parameters:**
- `id: string` - Skill ID

**Returns:** `Promise<Skill>`

#### `skills_create`

Create a new skill.

**Parameters:**
- `name: string` - Skill name
- `skill_md_content: string` - SKILL.md content
- `scripts: SkillScript[]` - Helper scripts

```typescript
interface SkillScript {
  name: string;
  content: string;
}

await invoke('skills_create', {
  name: 'backup_cisco',
  skillMdContent: '# Name\nbackup_cisco\n...',
  scripts: [
    { name: 'backup.sh', content: '#!/bin/bash\n...' },
  ],
});
```

#### `agent_generate_skill`

Generate a skill using AI.

**Parameters:**
- `description: string` - Skill description
- `examples: string | null` - Example usage
- `profile: string | null` - LLM profile to use

**Returns:** `Promise<GenerateSkillResult>`

```typescript
interface GenerateSkillResult {
  skill_md: string;
  scripts: SkillScript[];
}
```

### Search

#### `search_all`

Search across commands, AI messages, and skills.

**Parameters:**
- `query: string` - Search query
- `limit: number | null` - Max results per category

**Returns:** `Promise<SearchResults>`

```typescript
interface SearchResults {
  commands: CommandBlockResult[];
  ai_messages: AiMessageResult[];
  skills: SkillResult[];
}

interface CommandBlockResult {
  id: string;
  tab_id: string;
  cmd: string;
  output: string;
  exit_code: number | null;
  started_at: number;
  rank: number;
}

interface AiMessageResult {
  id: string;
  tab_id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  rank: number;
}

interface SkillResult {
  id: string;
  name: string;
  description: string;
  rank: number;
}
```

### Session Management

#### `save_current_session`

Save the current session state.

**Parameters:**
- `active_tab_id: string | null` - Currently active tab

**Returns:** `Promise<string>` - Snapshot ID

#### `restore_last_session`

Restore the last saved session.

**Returns:** `Promise<SessionSnapshot | null>`

```typescript
interface SessionSnapshot {
  tabs: Tab[];
  scrollback: Record<string, number[]>;
  ai_history: Record<string, string>;
}
```

#### `session_save_named`

Save a named session.

**Parameters:**
- `name: string` - Session name
- `description: string | null` - Optional description

**Returns:** `Promise<string>` - Session ID

#### `session_list_saved`

List all saved sessions.

**Returns:** `Promise<SavedSessionInfo[]>`

```typescript
interface SavedSessionInfo {
  id: string;
  name: string;
  description: string | null;
  tab_count: number;
  created_at: number;
}
```

## Python Sidecar Protocol

Communication between Rust and Python uses NDJSON (newline-delimited JSON) over stdin/stdout.

### Request Format

```json
{
  "id": "unique-request-id",
  "method": "method_name",
  "params": {
    "param1": "value1"
  }
}
```

### Response Format

**Success:**
```json
{
  "id": "unique-request-id",
  "type": "done",
  "result": {
    "key": "value"
  }
}
```

**Error:**
```json
{
  "id": "unique-request-id",
  "type": "error",
  "message": "Error description"
}
```

**Streaming:**
```json
{"id": "req-id", "type": "token", "data": "chunk1"}
{"id": "req-id", "type": "token", "data": "chunk2"}
{"id": "req-id", "type": "done"}
```

### Available Methods

#### `ping`

Test sidecar connectivity.

**Request:**
```json
{"id": "1", "method": "ping", "params": {}}
```

**Response:**
```json
{"id": "1", "type": "done", "result": "pong"}
```

#### `nl_to_command`

Convert natural language to shell command.

**Request:**
```json
{
  "id": "2",
  "method": "nl_to_command",
  "params": {
    "nl_query": "list large files",
    "shell": "bash",
    "cwd": "/home/user",
    "profile": "fast"
  }
}
```

**Response:**
```json
{
  "id": "2",
  "type": "done",
  "result": {
    "command": "find . -type f -size +100M"
  }
}
```

#### `chat.stream`

Stream AI chat responses.

**Request:**
```json
{
  "id": "3",
  "method": "chat.stream",
  "params": {
    "session_id": "tab-123",
    "messages": [
      {"role": "user", "content": "Explain OSPF"}
    ],
    "profile": "fast"
  }
}
```

**Response (streaming):**
```json
{"id": "3", "type": "token", "data": "OSPF "}
{"id": "3", "type": "token", "data": "is a "}
{"id": "3", "type": "token", "data": "link-state "}
...
{"id": "3", "type": "done"}
```

#### `explain_error`

Explain a failed command.

**Request:**
```json
{
  "id": "4",
  "method": "explain_error",
  "params": {
    "cmd": "git push",
    "output": "fatal: No upstream branch",
    "exit_code": 1,
    "cwd": "/project",
    "profile": "fast"
  }
}
```

**Response:**
```json
{
  "id": "4",
  "type": "done",
  "result": {
    "explanation": "Git doesn't know where to push...",
    "suggested_command": "git push -u origin main"
  }
}
```

#### `generate_skill`

Generate a skill definition.

**Request:**
```json
{
  "id": "5",
  "method": "generate_skill",
  "params": {
    "description": "Backup Cisco device configs",
    "examples": "cisco-backup 192.168.1.1",
    "profile": "smart"
  }
}
```

**Response:**
```json
{
  "id": "5",
  "type": "done",
  "result": {
    "skill_md": "# Name\nbackup_cisco\n...",
    "scripts": [
      {"name": "backup.sh", "content": "#!/bin/bash\n..."}
    ]
  }
}
```

#### `invoke_skill`

Manually invoke a skill.

**Request:**
```json
{
  "id": "6",
  "method": "invoke_skill",
  "params": {
    "skill_name": "backup_cisco",
    "args": "192.168.1.1",
    "context": {
      "cwd": "/configs"
    },
    "profile": "default"
  }
}
```

**Response:**
```json
{
  "id": "6",
  "type": "done",
  "result": {
    "response": "Backing up 192.168.1.1..."
  }
}
```

## Skills API

Skills are defined in `~/.config/ccie-terminal/skills/<skill-name>/`.

### SKILL.md Format

```markdown
# Name
skill_name

# Description
Brief description of what the skill does.

# When to Use
- Trigger pattern 1
- Trigger pattern 2
- Keywords to match

# Playbook
Detailed step-by-step instructions for the AI:

1. Step one
2. Step two
3. If condition X, do Y
4. Return result in format Z

# Scripts
- script1.sh: Description
- script2.py: Description
```

### Skill Directory Structure

```
~/.config/ccie-terminal/skills/
├── backup_cisco/
│   ├── SKILL.md
│   ├── backup.sh
│   └── parse_config.py
├── analyze_logs/
│   ├── SKILL.md
│   └── extract.py
```

### Script Execution

Scripts are executed via the sidecar's `execute_skill_script` method:

**Request:**
```json
{
  "method": "execute_skill_script",
  "params": {
    "skill_name": "backup_cisco",
    "script_name": "backup.sh",
    "args": ["192.168.1.1", "admin"],
    "timeout": 30
  }
}
```

**Response:**
```json
{
  "type": "done",
  "result": {
    "stdout": "Backup successful...",
    "stderr": "",
    "exit_code": 0
  }
}
```

## MCP Integration

CCIE Terminal implements the Model Context Protocol as a client.

### Supported Transports

#### stdio

Launch MCP servers as subprocesses:

```rust
let server = McpServer {
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: vec!["-y", "@modelcontextprotocol/server-filesystem", "/path"],
    env: HashMap::new(),
};
```

#### SSE (Server-Sent Events)

Connect to remote MCP servers over HTTP:

```rust
let server = McpServer {
    name: "remote",
    transport: "sse",
    url: "https://mcp.example.com/sse",
};
```

### Tool Invocation Flow

1. AI requests tool invocation
2. Rust checks approval policy
3. If needed, show approval modal to user
4. Send tool call to MCP server
5. Return result to AI

### Approval Policies

Stored in `approval_policies` table:

```sql
INSERT INTO approval_policies (server_name, tool_name, policy)
VALUES ('filesystem', 'read_file', 'auto_allow');
```

Policy values:
- `auto_allow`: Execute without prompting
- `confirm`: Always ask user
- `confirm_once`: Ask once per session
- `deny`: Never execute

## Database Schema

### Core Tables

**tabs**: Terminal tabs
```sql
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  shell_cmd TEXT NOT NULL,
  cwd TEXT NOT NULL,
  profile_id TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
```

**command_blocks**: Command history
```sql
CREATE TABLE command_blocks (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  cmd TEXT NOT NULL,
  output BLOB NOT NULL,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
```

**ai_messages**: AI chat history
```sql
CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

**skills**: Skill definitions
```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  playbook TEXT NOT NULL,
  scripts TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**mcp_servers**: MCP server configurations
```sql
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command_json TEXT,
  url TEXT,
  env_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
```

### FTS5 Tables

Full-text search tables:
- `command_blocks_fts`
- `ai_messages_fts`
- `skills_fts`

Automatically kept in sync via triggers.

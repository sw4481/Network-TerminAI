# CCIE Terminal Architecture

System architecture, data flow, and technical design.

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Tech Stack](#tech-stack)
- [Data Flow](#data-flow)
- [Component Details](#component-details)
- [Database Schema](#database-schema)
- [Communication Protocols](#communication-protocols)
- [Security Considerations](#security-considerations)

## Overview

CCIE Terminal is built as a three-layer system:

1. **Frontend (React)**: User interface and terminal rendering
2. **Core (Rust/Tauri)**: System integration, PTY management, database
3. **Sidecar (Python)**: AI integration and LLM communication

This architecture provides:
- **Performance**: Native Rust core with efficient PTY handling
- **Safety**: Rust's memory safety and type system
- **Flexibility**: Python sidecar for rapid AI experimentation
- **Portability**: Cross-platform support via Tauri and portable-pty

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (React)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Terminal │  │ AI Chat  │  │  Search  │  │  Skills  │   │
│  │  (xterm) │  │  Panel   │  │   Panel  │  │  Panel   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │               │             │          │
│       └─────────────┴───────────────┴─────────────┘          │
│                          │                                   │
│                   Tauri IPC Bridge                          │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                   Core (Rust/Tauri)                         │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │    PTY     │  │   Database   │  │     MCP      │       │
│  │  Manager   │  │   (SQLite)   │  │    Bridge    │       │
│  └─────┬──────┘  └──────┬───────┘  └──────┬───────┘       │
│        │                │                   │               │
│  ┌─────┴───────┐  ┌────┴────────┐  ┌──────┴──────┐        │
│  │   Session   │  │   Search    │  │   Skills    │        │
│  │   Manager   │  │   (FTS5)    │  │   Loader    │        │
│  └─────┬───────┘  └─────────────┘  └─────────────┘        │
│        │                                                     │
│  ┌─────┴──────────────────┐                                │
│  │   Agent Bridge         │                                │
│  │   (NDJSON Protocol)    │                                │
│  └─────┬──────────────────┘                                │
└────────┼─────────────────────────────────────────────────────┘
         │ stdio
         │ (NDJSON over stdin/stdout)
         │
┌────────┼─────────────────────────────────────────────────────┐
│  ┌─────▼──────────────────┐                                 │
│  │   NDJSON Server        │                                 │
│  └─────┬──────────────────┘                                 │
│        │                                                     │
│  ┌─────┴─────────┐  ┌────────────┐  ┌───────────┐         │
│  │   AI Agent    │  │   Skills   │  │    MCP    │         │
│  │   (Chat/NL)   │  │  Executor  │  │   Tools   │         │
│  └───────┬───────┘  └────────────┘  └───────────┘         │
│          │                                                   │
│  ┌───────▼──────────────────────────────────────┐          │
│  │   LLM Providers                               │          │
│  │  (Anthropic, OpenAI, Google, Ollama, vLLM)   │          │
│  └───────────────────────────────────────────────┘          │
│                  Sidecar (Python)                           │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

### Frontend Layer

**Core Technologies:**
- **React 19**: UI framework with concurrent features
- **TypeScript 5.8**: Type-safe JavaScript
- **Vite 7**: Fast build tool and dev server
- **Zustand 5**: Lightweight state management

**Terminal:**
- **xterm.js 6**: Full-featured terminal emulator
- **@xterm/addon-fit**: Dynamic terminal sizing
- **@xterm/addon-web-links**: Clickable URLs in terminal

**UI Libraries:**
- **react-markdown**: Markdown rendering for AI responses
- Custom CSS for styling (no framework dependency)

**Why these choices:**
- React 19: Concurrent rendering for smooth AI streaming
- xterm.js: Industry-standard terminal emulation
- Zustand: Simpler than Redux, perfect for our use case
- Vite: Fast dev experience and optimized builds

### Core Layer

**Runtime:**
- **Tauri v2**: Desktop application framework
- **Rust stable**: Systems programming language
- **Tokio**: Async runtime for concurrency

**Key Crates:**
- **portable-pty**: Cross-platform PTY implementation
- **rusqlite**: SQLite database bindings
- **serde/serde_json**: Serialization
- **anyhow**: Error handling
- **parking_lot**: High-performance synchronization
- **uuid**: Unique identifiers
- **refinery**: Database migrations

**Why these choices:**
- Tauri: Native performance, small bundle size, secure IPC
- Rust: Memory safety, concurrency, and performance
- SQLite: Embedded database, zero-config, FTS5 support
- portable-pty: Best cross-platform PTY solution

### Sidecar Layer

**Runtime:**
- **Python 3.12**: AI/ML ecosystem compatibility

**Key Packages:**
- **anthropic**: Claude API SDK
- **openai**: OpenAI API SDK (also vLLM compatible)
- **google-generativeai**: Gemini API
- **httpx**: Async HTTP client
- **pytest**: Testing framework
- **ruff**: Linting and formatting

**Why these choices:**
- Python: Best ecosystem for AI/ML integration
- Multiple SDKs: Support various LLM providers
- Async: Non-blocking I/O for streaming responses

## Data Flow

### Terminal Data Flow

```
User Input → xterm.js → Frontend State → Tauri IPC
                                             ↓
                                     pty_write command
                                             ↓
                                      PTY Handle
                                             ↓
                                     Shell Process
                                             ↓
                                    PTY Reader Thread
                                             ↓
                                    Command Parser
                                   (OSC 133 sequences)
                                             ↓
                                      PtyEvent Channel
                                             ↓
                              ┌──────────────┴───────────────┐
                              ↓                              ↓
                         Database                      Frontend Event
                    (scrollback + blocks)                   Channel
                                                             ↓
                                                         xterm.js
                                                          (render)
```

### AI Chat Data Flow

```
User Message → Frontend → Tauri IPC → agent_chat_stream
                                            ↓
                                      Agent Bridge
                                   (NDJSON Protocol)
                                            ↓
                                      Python Sidecar
                                        Server.py
                                            ↓
                                       Agent.py
                                    (load history)
                                            ↓
                              ┌─────────────┴─────────────┐
                              ↓                           ↓
                        Skills Matcher              MCP Tools Loader
                              ↓                           ↓
                              └─────────────┬─────────────┘
                                            ↓
                                    LLM Provider SDK
                                   (stream response)
                                            ↓
                              ┌─────────────┴─────────────┐
                              ↓                           ↓
                    Token Events                     Database
                    (back to frontend)             (save messages)
```

### Natural Language Command Flow

```
User Types ">list files" → Frontend → agent_nl_to_command
                                            ↓
                                      Agent Bridge
                                            ↓
                                    Python: nl_to_command()
                                            ↓
                                      Build Prompt
                            (shell context + cwd + history)
                                            ↓
                                    LLM Provider
                                            ↓
                                  Parse Response
                               (extract command)
                                            ↓
                                  Return to Frontend
                                            ↓
                          Display in terminal (user confirms)
```

### MCP Tool Invocation Flow

```
AI wants tool → MCP Bridge → Check Approval Policy
                                      ↓
                         ┌────────────┴────────────┐
                         ↓                         ↓
                   Auto Allow?                  Confirm?
                         ↓                         ↓
                      Execute               Show Modal
                         ↓                    (user decides)
                         └────────────┬─────────────┘
                                      ↓
                                 MCP Client
                              (JSON-RPC 2.0)
                                      ↓
                           ┌──────────┴──────────┐
                           ↓                     ↓
                      stdio Server         SSE Server
                  (local subprocess)    (remote HTTP)
                           ↓                     ↓
                           └──────────┬──────────┘
                                      ↓
                                Tool Response
                                      ↓
                                 Back to AI
```

### Dual-Mode Terminal Architecture

CCIE Terminal supports two complementary terminal modes with seamless switching:

#### Terminal Mode (Traditional)

```
User Input → xterm.js → PTY → Shell Process → PTY → xterm.js (render)
```

Full terminal emulation with direct PTY access:
- Single xterm.js instance renders all output
- Full cursor control and ANSI escape sequences
- Interactive programs work correctly (SSH, vim, top)
- Traditional scrollback buffer
- OSC 133 sequences still detected for block creation
- **Use case**: Interactive commands, SSH sessions, text editors

#### Blocks Mode (Warp-style)

```
User Input → InputEditor → PTY → Shell → PTY → Hidden xterm.js → Block Extraction
                                                                        ↓
                                                            BlocksStore + SQLite
                                                                        ↓
                                                           CommandBlock Components
```

Discrete command blocks with organized history:
- InputEditor component at bottom for command entry
- Hidden xterm.js captures PTY output
- CommandBlock components render completed commands as React
- Each block is collapsible with metadata
- OSC 133 sequences trigger block creation
- **Use case**: Simple commands, organized history, command reuse

#### Mode Toggle Implementation

```typescript
// Terminal.tsx
const [blocksMode, setBlocksMode] = useState(false);

return (
  <div className="terminal-wrapper">
    {/* Toggle buttons */}
    <div className="terminal-mode-toggle">
      <button onClick={() => setBlocksMode(false)}>Terminal</button>
      <button onClick={() => setBlocksMode(true)}>Blocks</button>
    </div>

    {blocksMode ? (
      /* Blocks Mode UI */
      <>
        <div className="blocks-history">
          {blocks.map(block => <CommandBlock key={block.id} block={block} />)}
        </div>
        <div ref={xtermContainer} style={{ display: 'none' }} />
        <InputEditor onExecute={handleExecuteCommand} />
      </>
    ) : (
      /* Terminal Mode UI */
      <div ref={xtermContainer} className="xterm-container" />
    )}
  </div>
);
```

#### Command Blocks Data Flow

**Block Creation Flow**:
```
OSC 133 sequence → PTY Parser → Tauri Event → Frontend
  → BlocksStore → Add/Complete Block → Sync to SQLite
```

The flow begins when the shell emits OSC 133 sequences (via integration scripts):
1. `OSC 133;E;<cmd>` - Shell sends command text before execution
2. PTY parser in Rust detects sequence and extracts command
3. Tauri emits event to frontend with command metadata
4. BlocksStore creates new block in state
5. Block is persisted to SQLite for cross-session storage
6. Command executes and output streams to xterm buffer
7. `OSC 133;D;<exit_code>` - Shell sends completion signal
8. Output is extracted, block marked complete, and stored

**Completed Block Structure**:
```typescript
interface Block {
  id: string;
  tabId: string;
  cmd: string;
  cwd: string;
  output: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  isBookmarked: boolean;
  collapsed: boolean;
}
```

**Design Benefits**:
- **Mode flexibility**: Switch between traditional and modern UI without losing state
- **Collapse/expand**: Works without losing terminal state (output stored separately)
- **Clean copy/paste**: Text extraction removes ANSI escape sequences automatically
- **Persistence**: Blocks survive app restarts via SQLite storage
- **Performance**: Completed blocks render as lightweight React instead of heavy xterm instances
- **Interactive support**: Terminal mode provides full PTY for SSH/vim/etc
- **Foundation**: Enables future features like AI analysis, sharing, workflows, and notebooks

**Visual Layout Comparison**:

Terminal Mode:
```
┌────────────────────────────────────────┐
│  [Terminal] Blocks                     │
├────────────────────────────────────────┤
│                                        │
│  user@host:~$ ls -la                  │
│  total 48                             │
│  drwxr-xr-x  12 user  staff   384 ... │
│  -rw-r--r--   1 user  staff  1024 ... │
│  user@host:~$ █                       │
│                                        │
│  (continuous scrollback)              │
│                                        │
└────────────────────────────────────────┘
```

Blocks Mode:
```
┌────────────────────────────────────────┐
│  Terminal [Blocks]                     │
├────────────────────────────────────────┤
│  Block 1: ls -la                      │
│  Exit: 0  Duration: 45ms  ~/ ▼       │
│  total 48                             │
│  drwxr-xr-x  12 user  staff  384 ...  │
│  [★ Bookmark] [↻ Rerun] [📋 Copy]     │
├────────────────────────────────────────┤
│  Block 2: git status                  │
│  Exit: 0  Duration: 120ms  ~/proj ▼  │
│  (output collapsed - 15 lines)        │
├────────────────────────────────────────┤
│  $ █ Type a command...                │
└────────────────────────────────────────┘
```

### Split Panes Architecture

Pane layouts use a recursive tree structure where each node is either a leaf (terminal) or a split (container).

#### Tree Structure

Each node in the layout tree is one of two types:
- **Leaf**: Contains a Terminal component with its own PTY session
- **Split**: Contains 2+ children arranged horizontally or vertically

**Data Structure:**
```typescript
type PaneNode = {
  type: 'leaf' | 'split';
  id: string;
  size: number; // Percentage (0-100)
  children?: PaneNode[]; // Only for split type
  direction?: 'horizontal' | 'vertical'; // Only for split type
  terminalId?: string; // Only for leaf type
}
```

**Example: 2x2 Grid Layout**
```
Split (vertical, 50/50)
├─ Split (horizontal, 50/50)
│  ├─ Leaf (terminal-1, size: 50)
│  └─ Leaf (terminal-2, size: 50)
└─ Split (horizontal, 50/50)
   ├─ Leaf (terminal-3, size: 50)
   └─ Leaf (terminal-4, size: 50)
```

#### State Management Flow

**State Flow:**
```
User Action (split/close/resize)
  ↓
panesStore.ts (Zustand)
  ↓
Tree Mutation (immutable update)
  ↓
PaneContainer Re-render (recursive)
  ↓
Tauri Command (persist to SQLite)
```

**Store Actions:**
- `initializeLayout(tabId)`: Create single-pane layout
- `splitPane(paneId, direction)`: Convert leaf to split with 2 children
- `closePane(paneId)`: Remove pane and rebalance siblings
- `resizePane(splitId, sizes)`: Update child size percentages
- `setFocusedPane(paneId)`: Track currently focused pane
- `navigateFocus(direction)`: Move focus between panes

#### Component Hierarchy

```
App.tsx
  └─ PaneContainer (recursive)
       ├─ Pane (leaf) → Terminal → PTY Session
       ├─ PaneHandle (resize divider)
       └─ PaneContainer (split node)
            ├─ Pane (leaf) → Terminal → PTY Session
            ├─ PaneHandle
            └─ Pane (leaf) → Terminal → PTY Session
```

**Component Responsibilities:**
- **PaneContainer**: Recursively renders tree - either Pane or nested splits
- **Pane**: Wrapper with focus indicator, contains Terminal component
- **PaneHandle**: Draggable divider between panes for resizing
- **Terminal**: xterm.js instance with PTY connection (one per pane)

Each pane gets its own Terminal component which spawns an independent PTY process. This allows simultaneous interactive sessions without interference.

#### Persistence

Layouts are stored in SQLite as JSON:

```sql
CREATE TABLE pane_layouts (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  layout_json TEXT NOT NULL, -- Serialized PaneNode tree
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_pane_layouts_unique_tab ON pane_layouts(tab_id);
```

**When layouts are saved:**
- On split (new pane added to tree)
- On close (pane removed from tree)
- On resize (size percentages updated)

**When layouts are loaded:**
- Tab creation (load from DB or initialize default)
- App startup (restore all tab layouts)

Layouts are automatically saved on every mutation and restored when tabs are reopened or the app restarts.

## Component Details

### Frontend Components

#### Terminal Component
```typescript
// src/components/Terminal.tsx
- Manages xterm.js instance
- Handles PTY events from Tauri
- Sends user input to PTY
- Renders command blocks overlay
- Manages terminal lifecycle
```

**Key responsibilities:**
- Initialize xterm.js with addons
- Subscribe to PTY events via Tauri channels
- Handle terminal resize
- Render command blocks above terminal output
- Coordinate with tab state

#### AgentPanel Component
```typescript
// src/components/AgentPanel.tsx
- AI chat interface
- Message history display
- Streaming response rendering
- Profile selection
```

**Key features:**
- Markdown rendering for AI responses
- Auto-scroll during streaming
- Per-tab chat history
- Token-by-token streaming display

#### CommandPalette Component
```typescript
// src/components/CommandPalette.tsx
- Universal command launcher (Cmd+K)
- Fuzzy search with Fuse.js
- Recent commands + bookmarks + actions
- Keyboard-driven navigation
```

**Key features:**
- Opens with Cmd+K (Ctrl+K on Windows/Linux)
- Loads recent commands from current tab (last 20)
- Displays bookmarked commands across all tabs
- Built-in actions (new tab, search, toggle panels)
- Fuzzy search matches partial text in command + cwd
- Arrow key navigation (↑/↓), Enter to execute, Escape to close

**Data sources:**
- Recent commands: `blocks_get_recent(tabId, limit=20)`
- Bookmarked commands: `blocks_get_bookmarked()`
- Actions: Hardcoded list of built-in actions

**Integration:**
```typescript
// App.tsx
const [paletteOpen, setPaletteOpen] = useState(false);

useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setPaletteOpen(true);
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, []);
```

#### InputEditor Component
```typescript
// src/components/InputEditor.tsx
- Text area for command entry in Blocks Mode
- Command history navigation (↑/↓)
- Keyboard shortcuts (Enter, Ctrl+C, Ctrl+D)
- Auto-focus on mount
```

**Key features:**
- Enter to execute, Shift+Enter for newline
- Up/Down arrows for command history
- Session-specific history (not persisted)
- Ctrl+C to clear, Ctrl+D for EOF
- Disabled state when PTY not ready

#### CommandBlock Component
```typescript
// src/components/CommandBlock.tsx
- Renders completed command blocks
- BlockHeader + BlockOutput
- Actions: bookmark, rerun, copy
```

**Key features:**
- Click header to collapse/expand
- Exit code indicator (green/red)
- Duration and timestamp display
- Block actions toolbar
- Collapsible output with line count hint

#### SearchBar Component
```typescript
// src/components/SearchBar.tsx
- Full-text search interface
- Category tabs (Commands/AI/Skills)
- Result display and navigation
```

### Frontend State Management

#### BlocksStore (Zustand)
```typescript
// src/state/blocksStore.ts
- Central state for command blocks
- Map of blocksByTab (tabId -> Block[])
- Actions for block lifecycle
```

**State structure:**
```typescript
interface BlocksStore {
  // State
  blocksByTab: Map<string, Block[]>;
  activeBlockId: string | null;
  
  // Actions
  loadBlocksForTab(tabId: string): Promise<void>;
  startBlock(tabId: string, cmd: string, cwd: string): void;
  appendOutput(blockId: string, data: string): void;
  completeBlock(blockId: string, exitCode: number): void;
  toggleCollapse(blockId: string): void;
  toggleBookmark(blockId: string): void;
  rerunBlock(blockId: string): void;
  copyOutput(blockId: string): void;
}
```

**Block lifecycle:**
1. `loadBlocksForTab()` - Load existing blocks from SQLite on tab creation
2. `startBlock()` - Create new block when OSC 133;E detected
3. `appendOutput()` - Accumulate output as PTY emits data
4. `completeBlock()` - Mark block done when OSC 133;D detected
5. Block persisted to SQLite via Tauri commands

**Integration with Terminal:**
```typescript
// Terminal.tsx
const blocks = useBlocksStore((s) => {
  if (!handle?.tabId) return EMPTY_BLOCKS;
  return s.blocksByTab.get(handle.tabId) ?? EMPTY_BLOCKS;
});

// Load blocks on mount
useEffect(() => {
  if (handle && loadedTabIdRef.current !== handle.tabId) {
    loadedTabIdRef.current = handle.tabId;
    loadBlocks(handle.tabId);
  }
}, [handle, loadBlocks]);
```

### Core Components

#### PTY Manager
```rust
// src-tauri/src/pty.rs
- Spawns PTY sessions using portable-pty
- Manages reader/writer threads
- Parses OSC 133 sequences
- Emits PtyEvent via channels
```

**Design:**
- One `PtyHandle` per terminal tab
- Blocking I/O in dedicated threads
- Channel-based communication with async runtime
- Command parser tracks shell state

#### Agent Bridge
```rust
// src-tauri/src/agent_bridge.rs
- NDJSON protocol implementation
- Request/response matching
- Streaming support
- Process lifecycle management
```

**Features:**
- Spawn Python sidecar on startup
- Reuse single process for all requests
- Handle streaming and non-streaming methods
- Automatic request ID generation

#### Session Manager
```rust
// src-tauri/src/session.rs
- Tab lifecycle management
- Scrollback ring buffer
- Command block storage
- Session snapshot/restore
```

**Key functions:**
- `create_tab()`: Initialize new tab in DB
- `append_scrollback()`: Add output to ring buffer
- `start_command_block()`: Begin command tracking
- `save_session_snapshot()`: Serialize entire state

#### Skills Loader
```rust
// src-tauri/src/skills/loader.rs
- File system watching
- SKILL.md parsing
- Skills caching
- Hot-reload on changes
```

**Implementation:**
- Watch `~/.config/ccie-terminal/skills/`
- Parse SKILL.md on changes
- Store parsed skills in memory
- Update database for FTS5 search

#### MCP Bridge
```rust
// src-tauri/src/mcp/bridge.rs
- MCP server lifecycle
- Tool approval flow
- Request routing
- Policy enforcement
```

### Sidecar Components

#### NDJSON Server
```python
# sidecar/src/ccie_sidecar/server.py
- Read requests from stdin
- Route to handlers
- Write responses to stdout
- Handle streaming protocols
```

**Protocol:**
- One JSON object per line
- Request: `{"id": "1", "method": "ping", "params": {}}`
- Response: `{"id": "1", "type": "done", "result": "pong"}`

#### AI Agent
```python
# sidecar/src/ccie_sidecar/agent.py
- LLM provider abstraction
- Prompt engineering
- Context management
- Response streaming
```

**Providers:**
- Anthropic: Native SDK with streaming
- OpenAI: Chat completions API
- Google: Gemini API
- Ollama: Local inference via HTTP
- vLLM: OpenAI-compatible API

## Database Schema

### Design Principles

1. **Normalized**: Reduce redundancy, use foreign keys
2. **Indexed**: Fast queries with appropriate indexes
3. **FTS5**: Full-text search via virtual tables
4. **Migrations**: Versioned with refinery

### Key Tables

#### tabs
Primary table for terminal tabs:
```sql
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,           -- UUID
  title TEXT NOT NULL,           -- Display name
  shell_cmd TEXT NOT NULL,       -- Shell executable
  cwd TEXT NOT NULL,            -- Working directory
  profile_id TEXT,              -- LLM profile (optional)
  created_at INTEGER NOT NULL,  -- Unix timestamp
  closed_at INTEGER             -- NULL if open
);
```

#### command_blocks
Command history with output:
```sql
CREATE TABLE command_blocks (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  cmd TEXT NOT NULL,            -- Command text
  output BLOB NOT NULL,         -- Raw output bytes
  exit_code INTEGER,            -- NULL if still running
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX idx_blocks_tab ON command_blocks(tab_id, started_at);
```

#### scrollback
Ring buffer for terminal output:
```sql
CREATE TABLE scrollback (
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,         -- Sequence number
  chunk BLOB NOT NULL,         -- Output chunk
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tab_id, seq)
);
```

**Ring buffer logic:**
- Calculate total size per tab
- When exceeds limit, delete oldest chunks
- Sequential numbering allows ordered retrieval

#### ai_messages
Chat history:
```sql
CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,  -- App-provided for ordering
  created_at INTEGER NOT NULL  -- DB timestamp
);

CREATE INDEX idx_ai_messages_tab ON ai_messages(tab_id, timestamp);
```

#### skills
Skill definitions from filesystem:
```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  playbook TEXT NOT NULL,
  scripts TEXT,                -- JSON array
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_skills_name ON skills(name);
```

#### mcp_servers
MCP server configurations:
```sql
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,     -- 'stdio' or 'sse'
  command_json TEXT,          -- For stdio
  url TEXT,                   -- For sse
  env_json TEXT,             -- Environment variables
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
```

### FTS5 Virtual Tables

Full-text search tables automatically synced via triggers:

```sql
CREATE VIRTUAL TABLE command_blocks_fts USING fts5(
  cmd, output, content='command_blocks', content_rowid='rowid'
);

CREATE VIRTUAL TABLE ai_messages_fts USING fts5(
  content, content='ai_messages', content_rowid='rowid'
);

CREATE VIRTUAL TABLE skills_fts USING fts5(
  name, description, when_to_use, playbook,
  content='skills', content_rowid='rowid'
);
```

**Triggers maintain sync:**
```sql
CREATE TRIGGER command_blocks_ai AFTER INSERT ON command_blocks BEGIN
  INSERT INTO command_blocks_fts(rowid, cmd, output)
  VALUES (new.rowid, new.cmd, new.output);
END;
```

## Communication Protocols

### Tauri IPC

Frontend ↔ Rust communication via JSON-RPC-like protocol:

**From Frontend:**
```typescript
import { invoke } from '@tauri-apps/api/core';

const result = await invoke('command_name', {
  param1: value1,
  param2: value2,
});
```

**In Rust:**
```rust
#[tauri::command]
pub fn command_name(param1: String, param2: i32) -> Result<String, String> {
    // Implementation
    Ok(result)
}
```

**Streaming via Channels:**
```typescript
import { Channel } from '@tauri-apps/api/core';

const channel = new Channel<EventType>();
channel.onmessage = (event) => {
  // Handle event
};

await invoke('streaming_command', { onEvent: channel });
```

### NDJSON Protocol

Rust ↔ Python communication over stdio:

**Request format:**
```json
{
  "id": "unique-request-id",
  "method": "method_name",
  "params": {
    "key": "value"
  }
}
```

**Response format (success):**
```json
{
  "id": "unique-request-id",
  "type": "done",
  "result": {
    "key": "value"
  }
}
```

**Response format (error):**
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

### MCP Protocol

MCP client implementation follows JSON-RPC 2.0:

**Tool listing request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

**Tool invocation:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "read_file",
    "arguments": {
      "path": "/path/to/file"
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": "file contents..."
  }
}
```

## Security Considerations

### API Key Storage

- Stored in `~/.config/ccie-terminal/.env`
- File permissions set to 0600 (user read/write only)
- Never logged or included in error messages
- Not exposed to frontend (Tauri side only)

### PTY Isolation

- Each tab runs in isolated PTY session
- No cross-tab command injection
- Exit signals properly handled
- Zombie processes prevented with killer handles

### MCP Tool Approval

- Default policy: Confirm (user approval required)
- Policy stored per server+tool combination
- Session-scoped "confirm once" option
- Denied tools never execute

### Database Security

- SQLite in user config directory
- No remote access enabled
- Prepared statements prevent SQL injection
- Foreign keys enforce referential integrity

### Process Isolation

- Python sidecar runs as subprocess
- Communication only via stdin/stdout
- No network access from sidecar by default
- MCP servers run as separate processes

## Performance Considerations

### Terminal Performance

- xterm.js efficiently renders large outputs
- Scrollback ring buffer prevents unbounded growth
- Command blocks stored separately from scrollback
- Lazy loading of historical command output

### Database Performance

- Indexes on frequently queried columns
- FTS5 for fast full-text search
- VACUUM runs periodically to reclaim space
- Connection pooling (single connection per app instance)

### Memory Management

- Rust's ownership system prevents leaks
- Python subprocess isolated memory space
- Frontend state pruned (closed tabs removed)
- Scrollback limited per tab (configurable)

### Async Concurrency

- Tokio async runtime for non-blocking I/O
- PTY reading in dedicated threads (blocking)
- Channel-based communication between sync/async
- Parallel MCP server connections

## Future Architecture Considerations

### Scalability

- Multi-window support (multiple Tauri windows)
- Remote PTY sessions (SSH integration)
- Distributed MCP servers (load balancing)
- Collaborative sessions (shared terminals)

### Extensibility

- Plugin system for custom commands
- Custom LLM providers via Python plugins
- User-defined UI themes
- Scriptable automation (Lua/Python)

### Reliability

- Crash recovery with session auto-save
- PTY reconnection on subprocess failures
- MCP server health checks and auto-restart
- Database backup and restore utilities

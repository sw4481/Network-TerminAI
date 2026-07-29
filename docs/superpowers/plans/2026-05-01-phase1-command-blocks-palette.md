# Phase 1: Command Blocks + Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform CCIE Terminal from continuous scroll to block-based UI where each command is a discrete, manageable unit. Add universal command palette (Cmd+K) for quick access to commands, skills, and actions.

**Architecture:** Hybrid terminal - command blocks are React components, not overlays. Each block contains command metadata + either live xterm (active) or rendered text (completed). OSC 133 shell integration detects command boundaries. Zustand manages block state, SQLite persists history.

**Tech Stack:** React 19, Zustand, xterm.js, Rust/Tauri, SQLite, fuse.js (fuzzy search)

---

## File Structure

### New Files (Create)
- `src/state/blocksStore.ts` - Zustand store for command blocks state
- `src/components/CommandBlock.tsx` - Single command block component
- `src/components/BlockHeader.tsx` - Block header with command + metadata
- `src/components/BlockOutput.tsx` - Block output (xterm or text)
- `src/components/BlockActions.tsx` - Block action buttons
- `src/components/CommandPalette.tsx` - Command palette modal
- `src/components/PaletteSearch.tsx` - Search input component
- `src/components/PaletteResults.tsx` - Results list component
- `src/hooks/useKeyboardShortcut.ts` - Keyboard shortcut hook
- `src-tauri/migrations/V0017__enhance_command_blocks.sql` - DB migration
- `src-tauri/src/commands/blocks.rs` - Tauri commands for blocks

### Modified Files
- `src/components/Terminal.tsx` - Switch to hybrid block-based rendering
- `src/state/tabsStore.ts` - Integrate blocks store
- `src-tauri/src/command_parser.rs` - Enhance OSC 133 parsing
- `src-tauri/src/main.rs` - Register new commands
- `package.json` - Add fuse.js dependency

---

## Task 1: Database Schema Enhancement

**Files:**
- Create: `src-tauri/migrations/V0017__enhance_command_blocks.sql`

- [ ] **Step 1: Write migration to enhance command_blocks table**

```sql
-- Add new columns to command_blocks table
ALTER TABLE command_blocks ADD COLUMN cwd TEXT NOT NULL DEFAULT '/';
ALTER TABLE command_blocks ADD COLUMN output_line_count INTEGER DEFAULT 0;
ALTER TABLE command_blocks ADD COLUMN is_bookmarked BOOLEAN DEFAULT 0;
ALTER TABLE command_blocks ADD COLUMN ai_analysis TEXT;
ALTER TABLE command_blocks ADD COLUMN duration_ms INTEGER;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_blocks_bookmark ON command_blocks(is_bookmarked) WHERE is_bookmarked = 1;
CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON command_blocks(started_at DESC);

-- Update existing rows with default values for new columns
UPDATE command_blocks SET cwd = '/' WHERE cwd IS NULL;
UPDATE command_blocks SET output_line_count = 0 WHERE output_line_count IS NULL;
UPDATE command_blocks SET is_bookmarked = 0 WHERE is_bookmarked IS NULL;
```

- [ ] **Step 2: Verify migration compiles**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Test migration on fresh database**

Run:
```bash
cd src-tauri
rm -f target/test.db
cargo test test_migrations -- --nocapture
```

Expected: Test passes, command_blocks table has new columns

- [ ] **Step 4: Commit**

```bash
git add src-tauri/migrations/V0017__enhance_command_blocks.sql
git commit -m "feat(db): enhance command_blocks schema with bookmarks and metadata

- Add cwd, output_line_count, is_bookmarked, ai_analysis, duration_ms columns
- Add indexes for bookmarks and timestamp queries
- Set defaults for existing rows"
```

---

## Task 2: Blocks State Management (Zustand Store)

**Files:**
- Create: `src/state/blocksStore.ts`

- [ ] **Step 1: Write failing test for blocksStore**

Create: `src/state/blocksStore.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useBlocksStore } from './blocksStore';

describe('blocksStore', () => {
  beforeEach(() => {
    useBlocksStore.setState({
      blocksByTab: new Map(),
      activeBlockId: null,
    });
  });

  it('should add a new block', () => {
    const blockId = useBlocksStore.getState().addBlock('tab-1', 'ls -la', '/home/user');
    
    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks).toHaveLength(1);
    expect(blocks![0].id).toBe(blockId);
    expect(blocks![0].command).toBe('ls -la');
    expect(blocks![0].cwd).toBe('/home/user');
    expect(blocks![0].exitCode).toBeUndefined();
  });

  it('should complete a block with exit code', () => {
    const blockId = useBlocksStore.getState().addBlock('tab-1', 'echo test', '/tmp');
    
    useBlocksStore.getState().completeBlock(blockId, 0, 150, 'test\n');
    
    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].exitCode).toBe(0);
    expect(blocks![0].durationMs).toBe(150);
    expect(blocks![0].output).toBe('test\n');
  });

  it('should toggle bookmark status', () => {
    const blockId = useBlocksStore.getState().addBlock('tab-1', 'important-command', '/');
    
    useBlocksStore.getState().toggleBookmark(blockId);
    
    let blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].bookmarked).toBe(true);
    
    useBlocksStore.getState().toggleBookmark(blockId);
    blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].bookmarked).toBe(false);
  });

  it('should toggle collapse status', () => {
    const blockId = useBlocksStore.getState().addBlock('tab-1', 'ls', '/');
    
    useBlocksStore.getState().toggleCollapse(blockId);
    
    let blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].collapsed).toBe(true);
    
    useBlocksStore.getState().toggleCollapse(blockId);
    blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].collapsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/state/blocksStore.test.ts`
Expected: FAIL with "blocksStore not found"

- [ ] **Step 3: Implement blocksStore**

Create: `src/state/blocksStore.ts`

```typescript
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface Block {
  id: string;
  tabId: string;
  command: string;
  cwd: string;
  timestamp: number;
  durationMs?: number;
  exitCode?: number;
  output: string;
  outputLineCount: number;
  collapsed: boolean; // UI state only
  bookmarked: boolean;
  aiAnalysis?: string;
}

interface BlocksState {
  // Map of tabId -> Block[]
  blocksByTab: Map<string, Block[]>;
  
  // Currently active block (where user is typing)
  activeBlockId: string | null;
  
  // Actions
  addBlock: (tabId: string, command: string, cwd: string) => string;
  completeBlock: (blockId: string, exitCode: number, durationMs: number, output: string) => void;
  toggleCollapse: (blockId: string) => void;
  toggleBookmark: (blockId: string) => void;
  deleteBlock: (blockId: string) => void;
  rerunBlock: (blockId: string) => void;
  
  // Persistence
  loadBlocksForTab: (tabId: string) => Promise<void>;
  syncBlockToDb: (block: Block) => Promise<void>;
}

export const useBlocksStore = create<BlocksState>((set, get) => ({
  blocksByTab: new Map(),
  activeBlockId: null,
  
  addBlock: (tabId: string, command: string, cwd: string) => {
    const blockId = `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = Date.now();
    
    const newBlock: Block = {
      id: blockId,
      tabId,
      command,
      cwd,
      timestamp,
      output: '',
      outputLineCount: 0,
      collapsed: false,
      bookmarked: false,
    };
    
    set((state) => {
      const blocks = state.blocksByTab.get(tabId) || [];
      const newMap = new Map(state.blocksByTab);
      newMap.set(tabId, [...blocks, newBlock]);
      
      return {
        blocksByTab: newMap,
        activeBlockId: blockId,
      };
    });
    
    // Async: persist to DB (don't await)
    get().syncBlockToDb(newBlock);
    
    return blockId;
  },
  
  completeBlock: (blockId: string, exitCode: number, durationMs: number, output: string) => {
    set((state) => {
      const newMap = new Map(state.blocksByTab);
      
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updatedBlocks = [...blocks];
          const outputLines = output.split('\n').length;
          
          updatedBlocks[index] = {
            ...updatedBlocks[index],
            exitCode,
            durationMs,
            output,
            outputLineCount: outputLines,
          };
          
          newMap.set(tabId, updatedBlocks);
          
          // Async: persist to DB
          get().syncBlockToDb(updatedBlocks[index]);
          
          break;
        }
      }
      
      return { blocksByTab: newMap, activeBlockId: null };
    });
  },
  
  toggleCollapse: (blockId: string) => {
    set((state) => {
      const newMap = new Map(state.blocksByTab);
      
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updatedBlocks = [...blocks];
          updatedBlocks[index] = {
            ...updatedBlocks[index],
            collapsed: !updatedBlocks[index].collapsed,
          };
          newMap.set(tabId, updatedBlocks);
          break;
        }
      }
      
      return { blocksByTab: newMap };
    });
  },
  
  toggleBookmark: (blockId: string) => {
    set((state) => {
      const newMap = new Map(state.blocksByTab);
      
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updatedBlocks = [...blocks];
          updatedBlocks[index] = {
            ...updatedBlocks[index],
            bookmarked: !updatedBlocks[index].bookmarked,
          };
          newMap.set(tabId, updatedBlocks);
          
          // Async: persist to DB
          get().syncBlockToDb(updatedBlocks[index]);
          
          break;
        }
      }
      
      return { blocksByTab: newMap };
    });
  },
  
  deleteBlock: (blockId: string) => {
    set((state) => {
      const newMap = new Map(state.blocksByTab);
      
      for (const [tabId, blocks] of newMap.entries()) {
        const filtered = blocks.filter(b => b.id !== blockId);
        if (filtered.length !== blocks.length) {
          newMap.set(tabId, filtered);
          
          // Async: delete from DB
          invoke('blocks_delete', { blockId }).catch(console.error);
          
          break;
        }
      }
      
      return { blocksByTab: newMap };
    });
  },
  
  rerunBlock: (blockId: string) => {
    const state = get();
    
    // Find the block
    for (const blocks of state.blocksByTab.values()) {
      const block = blocks.find(b => b.id === blockId);
      if (block) {
        // Create new block with same command
        const newBlockId = state.addBlock(block.tabId, block.command, block.cwd);
        
        // Emit custom event to execute the command
        window.dispatchEvent(new CustomEvent('ccie:execute-command', {
          detail: { command: block.command, blockId: newBlockId }
        }));
        
        break;
      }
    }
  },
  
  loadBlocksForTab: async (tabId: string) => {
    try {
      const blocks = await invoke<Block[]>('blocks_list', { tabId, limit: 100 });
      
      set((state) => {
        const newMap = new Map(state.blocksByTab);
        newMap.set(tabId, blocks.map(b => ({ ...b, collapsed: false })));
        return { blocksByTab: newMap };
      });
    } catch (error) {
      console.error('Failed to load blocks:', error);
    }
  },
  
  syncBlockToDb: async (block: Block) => {
    try {
      await invoke('blocks_upsert', {
        block: {
          id: block.id,
          tab_id: block.tabId,
          cmd: block.command,
          cwd: block.cwd,
          output: block.output,
          exit_code: block.exitCode ?? null,
          started_at: Math.floor(block.timestamp / 1000),
          ended_at: block.exitCode !== undefined ? Math.floor(Date.now() / 1000) : null,
          output_line_count: block.outputLineCount,
          is_bookmarked: block.bookmarked ? 1 : 0,
          ai_analysis: block.aiAnalysis ?? null,
          duration_ms: block.durationMs ?? null,
        }
      });
    } catch (error) {
      console.error('Failed to sync block to DB:', error);
    }
  },
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/state/blocksStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/blocksStore.ts src/state/blocksStore.test.ts
git commit -m "feat(state): add blocksStore for command block management

- Zustand store with addBlock, completeBlock, toggle actions
- Persistent storage via Tauri commands
- Tests for core functionality"
```

---

## Task 3: Tauri Commands for Block Persistence

**Files:**
- Create: `src-tauri/src/commands/blocks.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Create blocks module**

Create: `src-tauri/src/commands/blocks.rs`

```rust
use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Debug, Serialize, Deserialize)]
pub struct Block {
    pub id: String,
    pub tab_id: String,
    pub cmd: String,
    pub cwd: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub output_line_count: i32,
    pub is_bookmarked: i32,
    pub ai_analysis: Option<String>,
    pub duration_ms: Option<i32>,
}

#[tauri::command]
pub async fn blocks_list(
    db: tauri::State<'_, Arc<Mutex<Connection>>>,
    tab_id: String,
    limit: usize,
) -> Result<Vec<Block>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn
        .prepare(
            "SELECT id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at, 
                    output_line_count, is_bookmarked, ai_analysis, duration_ms
             FROM command_blocks 
             WHERE tab_id = ? 
             ORDER BY started_at DESC 
             LIMIT ?"
        )
        .map_err(|e| e.to_string())?;
    
    let blocks = stmt
        .query_map(rusqlite::params![tab_id, limit], |row| {
            Ok(Block {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                cwd: row.get(3)?,
                output: row.get(4)?,
                exit_code: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
                output_line_count: row.get(8)?,
                is_bookmarked: row.get(9)?,
                ai_analysis: row.get(10)?,
                duration_ms: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    
    Ok(blocks)
}

#[tauri::command]
pub async fn blocks_upsert(
    db: tauri::State<'_, Arc<Mutex<Connection>>>,
    block: Block,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    
    conn.execute(
        "INSERT INTO command_blocks 
         (id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at, 
          output_line_count, is_bookmarked, ai_analysis, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           output = excluded.output,
           exit_code = excluded.exit_code,
           ended_at = excluded.ended_at,
           output_line_count = excluded.output_line_count,
           is_bookmarked = excluded.is_bookmarked,
           ai_analysis = excluded.ai_analysis,
           duration_ms = excluded.duration_ms",
        rusqlite::params![
            block.id,
            block.tab_id,
            block.cmd,
            block.cwd,
            block.output,
            block.exit_code,
            block.started_at,
            block.ended_at,
            block.output_line_count,
            block.is_bookmarked,
            block.ai_analysis,
            block.duration_ms,
        ],
    )
    .map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub async fn blocks_delete(
    db: tauri::State<'_, Arc<Mutex<Connection>>>,
    block_id: String,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    
    conn.execute(
        "DELETE FROM command_blocks WHERE id = ?",
        rusqlite::params![block_id],
    )
    .map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub async fn blocks_get_recent(
    db: tauri::State<'_, Arc<Mutex<Connection>>>,
    tab_id: String,
    limit: usize,
) -> Result<Vec<Block>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at,
                    output_line_count, is_bookmarked, ai_analysis, duration_ms
             FROM command_blocks 
             WHERE tab_id = ? AND cmd != ''
             ORDER BY started_at DESC 
             LIMIT ?"
        )
        .map_err(|e| e.to_string())?;
    
    let blocks = stmt
        .query_map(rusqlite::params![tab_id, limit], |row| {
            Ok(Block {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                cwd: row.get(3)?,
                output: row.get(4)?,
                exit_code: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
                output_line_count: row.get(8)?,
                is_bookmarked: row.get(9)?,
                ai_analysis: row.get(10)?,
                duration_ms: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    
    Ok(blocks)
}

#[tauri::command]
pub async fn blocks_get_bookmarked(
    db: tauri::State<'_, Arc<Mutex<Connection>>>,
) -> Result<Vec<Block>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn
        .prepare(
            "SELECT id, tab_id, cmd, cwd, output, exit_code, started_at, ended_at,
                    output_line_count, is_bookmarked, ai_analysis, duration_ms
             FROM command_blocks 
             WHERE is_bookmarked = 1
             ORDER BY started_at DESC"
        )
        .map_err(|e| e.to_string())?;
    
    let blocks = stmt
        .query_map([], |row| {
            Ok(Block {
                id: row.get(0)?,
                tab_id: row.get(1)?,
                cmd: row.get(2)?,
                cwd: row.get(3)?,
                output: row.get(4)?,
                exit_code: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
                output_line_count: row.get(8)?,
                is_bookmarked: row.get(9)?,
                ai_analysis: row.get(10)?,
                duration_ms: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    
    Ok(blocks)
}
```

- [ ] **Step 2: Register blocks module in main.rs**

Modify: `src-tauri/src/main.rs`

Add at top with other mod declarations:
```rust
mod commands;
```

Add blocks commands to invoke_handler:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    commands::blocks::blocks_list,
    commands::blocks::blocks_upsert,
    commands::blocks::blocks_delete,
    commands::blocks::blocks_get_recent,
    commands::blocks::blocks_get_bookmarked,
])
```

- [ ] **Step 3: Create commands module file**

Create: `src-tauri/src/commands/mod.rs`

```rust
pub mod blocks;
```

- [ ] **Step 4: Build and verify compilation**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds

- [ ] **Step 5: Test commands manually**

Run app in dev mode:
```bash
CCIE_REPO_ROOT="$PWD" bun tauri dev
```

Open dev console and test:
```javascript
await window.__TAURI__.invoke('blocks_list', { tabId: 'test', limit: 10 })
```

Expected: Returns empty array or existing blocks

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/
git add src-tauri/src/main.rs
git commit -m "feat(tauri): add blocks CRUD commands

- blocks_list: fetch blocks for tab
- blocks_upsert: create or update block
- blocks_delete: remove block
- blocks_get_recent: recent commands for palette
- blocks_get_bookmarked: bookmarked blocks"
```

---

## Task 4: Command Block Components

**Files:**
- Create: `src/components/BlockHeader.tsx`
- Create: `src/components/BlockOutput.tsx`
- Create: `src/components/BlockActions.tsx`
- Create: `src/components/CommandBlock.tsx`

- [ ] **Step 1: Create BlockHeader component**

Create: `src/components/BlockHeader.tsx`

```typescript
import { memo } from 'react';
import './BlockHeader.css';

interface BlockHeaderProps {
  command: string;
  exitCode?: number;
  duration?: number;
  timestamp: number;
  bookmarked: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  children?: React.ReactNode;
}

export const BlockHeader = memo(function BlockHeader({
  command,
  exitCode,
  duration,
  timestamp,
  bookmarked,
  collapsed,
  onToggleCollapse,
  children,
}: BlockHeaderProps) {
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
  };

  const getExitCodeColor = (code?: number) => {
    if (code === undefined) return 'gray';
    return code === 0 ? 'green' : 'red';
  };

  return (
    <div className="block-header" onClick={onToggleCollapse}>
      <button 
        className={`collapse-btn ${collapsed ? 'collapsed' : ''}`}
        aria-label={collapsed ? 'Expand' : 'Collapse'}
      >
        ▶
      </button>
      
      <div className="command-text" title={command}>
        {command}
      </div>
      
      <div className="metadata">
        {duration && (
          <span className="duration">{formatDuration(duration)}</span>
        )}
        
        {exitCode !== undefined && (
          <span 
            className="exit-code"
            style={{ color: `var(--${getExitCodeColor(exitCode)})` }}
          >
            exit {exitCode}
          </span>
        )}
        
        <span className="timestamp">{formatTimestamp(timestamp)}</span>
        
        {bookmarked && <span className="bookmark-indicator">★</span>}
      </div>
      
      {children}
    </div>
  );
});
```

- [ ] **Step 2: Create BlockHeader styles**

Create: `src/components/BlockHeader.css`

```css
.block-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #2a2a2a;
  border-bottom: 1px solid #3a3a3a;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.block-header:hover {
  background: #333333;
}

.collapse-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 10px;
  cursor: pointer;
  padding: 4px;
  transition: transform 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.collapse-btn:not(.collapsed) {
  transform: rotate(90deg);
}

.command-text {
  flex: 1;
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  font-size: 13px;
  color: #e6e1cf;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.metadata {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: #888;
}

.duration {
  color: #aaa;
}

.exit-code {
  font-weight: 600;
}

.timestamp {
  color: #777;
}

.bookmark-indicator {
  color: #ffd700;
  font-size: 14px;
}
```

- [ ] **Step 3: Create BlockActions component**

Create: `src/components/BlockActions.tsx`

```typescript
import { memo } from 'react';
import './BlockActions.css';

interface BlockActionsProps {
  onRerun: () => void;
  onBookmark: () => void;
  onCopy: () => void;
  onShare: () => void;
  bookmarked: boolean;
}

export const BlockActions = memo(function BlockActions({
  onRerun,
  onBookmark,
  onCopy,
  onShare,
  bookmarked,
}: BlockActionsProps) {
  const handleClick = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation(); // Don't trigger collapse
    action();
  };

  return (
    <div className="block-actions">
      <button 
        onClick={(e) => handleClick(e, onRerun)}
        title="Rerun command"
        className="action-btn"
      >
        ↻
      </button>
      
      <button 
        onClick={(e) => handleClick(e, onBookmark)}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark'}
        className={`action-btn ${bookmarked ? 'bookmarked' : ''}`}
      >
        ★
      </button>
      
      <button 
        onClick={(e) => handleClick(e, onCopy)}
        title="Copy output"
        className="action-btn"
      >
        📋
      </button>
      
      <button 
        onClick={(e) => handleClick(e, onShare)}
        title="Share block"
        className="action-btn"
      >
        ↗
      </button>
    </div>
  );
});
```

- [ ] **Step 4: Create BlockActions styles**

Create: `src/components/BlockActions.css`

```css
.block-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.block-header:hover .block-actions {
  opacity: 1;
}

.action-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.action-btn:hover {
  background: #444;
  color: #e6e1cf;
}

.action-btn.bookmarked {
  color: #ffd700;
}
```

- [ ] **Step 5: Create BlockOutput component**

Create: `src/components/BlockOutput.tsx`

```typescript
import { memo } from 'react';
import './BlockOutput.css';

interface BlockOutputProps {
  output: string;
  outputLineCount: number;
  collapsed: boolean;
  active: boolean;
  children?: React.ReactNode; // For active xterm terminal
}

export const BlockOutput = memo(function BlockOutput({
  output,
  outputLineCount,
  collapsed,
  active,
  children,
}: BlockOutputProps) {
  if (collapsed) {
    return (
      <div className="block-output collapsed">
        <span className="collapse-hint">
          {outputLineCount} lines (click to expand)
        </span>
      </div>
    );
  }

  if (active) {
    // Active block: render live xterm (passed as children)
    return (
      <div className="block-output active">
        {children}
      </div>
    );
  }

  // Completed block: render as text
  return (
    <div className="block-output">
      <pre className="output-text">{output}</pre>
    </div>
  );
});
```

- [ ] **Step 6: Create BlockOutput styles**

Create: `src/components/BlockOutput.css`

```css
.block-output {
  background: #1e1e1e;
  min-height: 100px;
}

.block-output.collapsed {
  min-height: 0;
  padding: 8px 12px;
  background: #252525;
  border-bottom: 1px solid #3a3a3a;
}

.collapse-hint {
  font-size: 12px;
  color: #666;
  font-style: italic;
}

.block-output.active {
  min-height: 200px;
  height: auto;
}

.output-text {
  margin: 0;
  padding: 12px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  font-size: 13px;
  color: #e6e1cf;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-x: auto;
}

.output-text::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.output-text::-webkit-scrollbar-track {
  background: #1e1e1e;
}

.output-text::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 4px;
}

.output-text::-webkit-scrollbar-thumb:hover {
  background: #555;
}
```

- [ ] **Step 7: Create CommandBlock component**

Create: `src/components/CommandBlock.tsx`

```typescript
import { memo } from 'react';
import { BlockHeader } from './BlockHeader';
import { BlockOutput } from './BlockOutput';
import { BlockActions } from './BlockActions';
import { useBlocksStore, type Block } from '../state/blocksStore';
import './CommandBlock.css';

interface CommandBlockProps {
  block: Block;
  active: boolean;
  children?: React.ReactNode; // Active xterm terminal
}

export const CommandBlock = memo(function CommandBlock({
  block,
  active,
  children,
}: CommandBlockProps) {
  const toggleCollapse = useBlocksStore((s) => s.toggleCollapse);
  const toggleBookmark = useBlocksStore((s) => s.toggleBookmark);
  const rerunBlock = useBlocksStore((s) => s.rerunBlock);

  const handleCopy = () => {
    navigator.clipboard.writeText(block.output).catch((err) => {
      console.error('Failed to copy:', err);
    });
  };

  const handleShare = () => {
    // TODO: Implement share functionality (Phase 2)
    console.log('Share block:', block.id);
  };

  return (
    <div 
      className={`command-block ${active ? 'active' : ''}`}
      data-block-id={block.id}
    >
      <BlockHeader
        command={block.command}
        exitCode={block.exitCode}
        duration={block.durationMs}
        timestamp={block.timestamp}
        bookmarked={block.bookmarked}
        collapsed={block.collapsed}
        onToggleCollapse={() => toggleCollapse(block.id)}
      >
        <BlockActions
          onRerun={() => rerunBlock(block.id)}
          onBookmark={() => toggleBookmark(block.id)}
          onCopy={handleCopy}
          onShare={handleShare}
          bookmarked={block.bookmarked}
        />
      </BlockHeader>

      <BlockOutput
        output={block.output}
        outputLineCount={block.outputLineCount}
        collapsed={block.collapsed}
        active={active}
      >
        {children}
      </BlockOutput>

      {block.aiAnalysis && (
        <div className="ai-analysis">
          <div className="ai-analysis-header">🤖 AI Analysis</div>
          <div className="ai-analysis-content">
            {block.aiAnalysis}
          </div>
        </div>
      )}
    </div>
  );
});
```

- [ ] **Step 8: Create CommandBlock styles**

Create: `src/components/CommandBlock.css`

```css
.command-block {
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 12px;
  transition: box-shadow 0.15s ease;
}

.command-block:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.command-block.active {
  border-color: #4a90e2;
  box-shadow: 0 0 0 2px rgba(74, 144, 226, 0.2);
}

.ai-analysis {
  background: #2a2a3a;
  border-top: 1px solid #3a3a4a;
  padding: 12px;
}

.ai-analysis-header {
  font-size: 12px;
  font-weight: 600;
  color: #8ba4f5;
  margin-bottom: 8px;
}

.ai-analysis-content {
  font-size: 13px;
  color: #d0d0d0;
  line-height: 1.5;
}
```

- [ ] **Step 9: Test components in isolation**

Create: `src/components/CommandBlock.test.tsx`

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommandBlock } from './CommandBlock';
import type { Block } from '../state/blocksStore';

describe('CommandBlock', () => {
  const mockBlock: Block = {
    id: 'test-block-1',
    tabId: 'tab-1',
    command: 'ls -la',
    cwd: '/home/user',
    timestamp: Date.now(),
    output: 'file1.txt\nfile2.txt\n',
    outputLineCount: 2,
    collapsed: false,
    bookmarked: false,
  };

  it('should render command in header', () => {
    render(<CommandBlock block={mockBlock} active={false} />);
    expect(screen.getByText('ls -la')).toBeInTheDocument();
  });

  it('should show exit code when completed', () => {
    const completedBlock = { ...mockBlock, exitCode: 0 };
    render(<CommandBlock block={completedBlock} active={false} />);
    expect(screen.getByText(/exit 0/)).toBeInTheDocument();
  });

  it('should show bookmark indicator when bookmarked', () => {
    const bookmarkedBlock = { ...mockBlock, bookmarked: true };
    render(<CommandBlock block={bookmarkedBlock} active={false} />);
    expect(screen.getByText('★')).toBeInTheDocument();
  });

  it('should hide output when collapsed', () => {
    const collapsedBlock = { ...mockBlock, collapsed: true };
    render(<CommandBlock block={collapsedBlock} active={false} />);
    expect(screen.getByText(/2 lines \(click to expand\)/)).toBeInTheDocument();
    expect(screen.queryByText('file1.txt')).not.toBeInTheDocument();
  });
});
```

Run: `bun test src/components/CommandBlock.test.tsx`
Expected: Tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/components/CommandBlock* src/components/Block*
git commit -m "feat(ui): add command block components

- BlockHeader: command + metadata display
- BlockOutput: collapsible output renderer
- BlockActions: rerun, bookmark, copy, share buttons
- CommandBlock: main block container
- Full CSS styling with hover effects"
```

---

## Task 5: Hybrid Terminal Integration

**Files:**
- Modify: `src/components/Terminal.tsx`

- [ ] **Step 1: Update Terminal component to render blocks**

Modify: `src/components/Terminal.tsx`

Replace the terminal rendering section with:

```typescript
import { memo, useEffect, useRef, useState } from "react";
import { usePty } from "../hooks/usePty";
import { useAgentsStore } from "../state/agentsStore";
import { useBlocksStore } from "../state/blocksStore";
import { CommandBlock } from "./CommandBlock";

type TerminalProps = {
  shell: string;
  cwd: string;
  onRegistered?: (tabId: string) => void;
};

export const Terminal = memo(function Terminal({ shell, cwd, onRegistered }: TerminalProps) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const handle = usePty(el, shell, cwd);
  
  // Get blocks for this tab
  const blocks = useBlocksStore((s) => 
    handle?.tabId ? s.blocksByTab.get(handle.tabId) || [] : []
  );
  const activeBlockId = useBlocksStore((s) => s.activeBlockId);
  const loadBlocks = useBlocksStore((s) => s.loadBlocksForTab);

  // Notify parent once we know our tab_id
  const registeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handle) return;
    if (registeredRef.current === handle.tabId) return;
    registeredRef.current = handle.tabId;
    onRegistered?.(handle.tabId);
    
    // Load existing blocks for this tab
    loadBlocks(handle.tabId);
  }, [handle, onRegistered, loadBlocks]);

  useEffect(() => {
    if (!handle || !wrapRef.current) return;
    const ro = new ResizeObserver(() => handle.fit());
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [handle]);

  return (
    <div className="terminal-wrapper" ref={wrapRef}>
      <div className="blocks-container">
        {blocks.map((block) => (
          <CommandBlock
            key={block.id}
            block={block}
            active={block.id === activeBlockId}
          >
            {block.id === activeBlockId && (
              <div ref={setEl} className="xterm-container" />
            )}
          </CommandBlock>
        ))}
        
        {/* No blocks yet - show xterm directly */}
        {blocks.length === 0 && (
          <div ref={setEl} className="xterm-container" />
        )}
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Add CSS for terminal wrapper**

Modify: `src/App.css` (or create `src/components/Terminal.css`)

Add:
```css
.terminal-wrapper {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  background: #1e1e1e;
}

.blocks-container {
  padding: 12px;
  max-width: 100%;
}

.xterm-container {
  height: 100%;
  min-height: 200px;
}
```

- [ ] **Step 3: Test terminal renders blocks**

Run: `CCIE_REPO_ROOT="$PWD" bun tauri dev`

Expected:
- Terminal opens
- Run a command (e.g., `ls`)
- Command appears in a block
- Output shows in block
- Can collapse/expand block

- [ ] **Step 4: Commit**

```bash
git add src/components/Terminal.tsx src/App.css
git commit -m "feat(terminal): integrate hybrid block-based rendering

- Replace continuous xterm with CommandBlock components
- Active block contains live xterm terminal
- Completed blocks render as text
- Load existing blocks on mount"
```

---

## Task 6: OSC 133 Sequence Enhancement

**Files:**
- Modify: `src-tauri/src/command_parser.rs`
- Modify: `src/hooks/usePty.ts`

- [ ] **Step 1: Enhance command_parser to emit block events**

Modify: `src-tauri/src/command_parser.rs`

Find the `ParseEvent` enum and ensure it includes:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ParseEvent {
    Output { bytes: Vec<u8> },
    CommandStart { cmd: String, block_id: Option<String> },
    CommandEnd { exit_code: Option<i32> },
}
```

Find the OSC 133 parsing section and enhance:

```rust
// In Parser impl, enhance parse_osc_sequence method
fn parse_osc_sequence(&mut self, seq: &str) -> Option<ParseEvent> {
    // OSC 133 ; A - Prompt start (new block begins)
    if seq.starts_with("133;A") {
        self.current_command = None;
        self.command_start_time = Some(std::time::Instant::now());
        return None; // Don't emit event yet
    }
    
    // OSC 133 ; C - Command start
    if seq.starts_with("133;C") {
        return None; // Wait for command text
    }
    
    // OSC 133 ; E ; <cmd> - Command text
    if let Some(cmd) = seq.strip_prefix("133;E;") {
        self.current_command = Some(cmd.to_string());
        return Some(ParseEvent::CommandStart {
            cmd: cmd.to_string(),
            block_id: None, // Frontend generates ID
        });
    }
    
    // OSC 133 ; D ; <exit_code> - Command end
    if let Some(code_str) = seq.strip_prefix("133;D;") {
        let exit_code = code_str.parse::<i32>().ok();
        self.current_command = None;
        return Some(ParseEvent::CommandEnd { exit_code });
    }
    
    None
}
```

- [ ] **Step 2: Update usePty hook to handle block events**

Modify: `src/hooks/usePty.ts`

Add block event handling:

```typescript
import { useEffect, useState, useRef } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useBlocksStore } from '../state/blocksStore';
import type { PtyEvent } from '../lib/types';

export function usePty(container: HTMLDivElement | null, shell: string, cwd: string) {
  const [handle, setHandle] = useState<PtyHandle | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const outputBufferRef = useRef<string>('');
  const currentBlockIdRef = useRef<string | null>(null);
  const blockStartTimeRef = useRef<number>(0);
  
  const addBlock = useBlocksStore((s) => s.addBlock);
  const completeBlock = useBlocksStore((s) => s.completeBlock);

  useEffect(() => {
    if (!container) return;

    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let tabId: string | null = null;
    let unlisten: (() => void) | undefined;

    (async () => {
      // Initialize terminal
      term = new Terminal({
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace",
        fontSize: 13,
        cursorBlink: true,
        cursorStyle: 'block',
        theme: {
          background: '#1e1e1e',
          foreground: '#e6e1cf',
        },
      });
      
      termRef.current = term;
      
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      
      term.open(container);
      fitAddon.fit();

      // Create PTY event channel
      const channel = new Channel<PtyEvent>();
      channel.onmessage = (event) => {
        if (event.type === 'output') {
          const text = new TextDecoder().decode(new Uint8Array(event.bytes));
          term?.write(text);
          
          // Buffer output for current block
          if (currentBlockIdRef.current) {
            outputBufferRef.current += text;
          }
        } 
        else if (event.type === 'command_start') {
          // Start new block
          if (tabId) {
            const blockId = addBlock(tabId, event.cmd, cwd);
            currentBlockIdRef.current = blockId;
            blockStartTimeRef.current = Date.now();
            outputBufferRef.current = '';
          }
        } 
        else if (event.type === 'command_end') {
          // Complete current block
          if (currentBlockIdRef.current) {
            const duration = Date.now() - blockStartTimeRef.current;
            completeBlock(
              currentBlockIdRef.current,
              event.exit_code ?? -1,
              duration,
              outputBufferRef.current
            );
            currentBlockIdRef.current = null;
            outputBufferRef.current = '';
          }
        }
        else if (event.type === 'exit') {
          console.log('PTY exited:', event.code);
        }
      };

      // Spawn PTY
      tabId = await invoke<string>('pty_spawn', {
        channel,
        shell,
        cwd,
        cols: term.cols,
        rows: term.rows,
      });

      // Handle terminal input
      term.onData((data) => {
        if (tabId) {
          invoke('pty_write', { tabId, data }).catch(console.error);
        }
      });

      setHandle({
        tabId,
        term,
        fit: () => fitAddon?.fit(),
      });

    })();

    return () => {
      if (tabId) {
        invoke('pty_close', { tabId }).catch(console.error);
      }
      term?.dispose();
      unlisten?.();
    };
  }, [container, shell, cwd, addBlock, completeBlock]);

  return handle;
}

interface PtyHandle {
  tabId: string;
  term: Terminal;
  fit: () => void;
}
```

- [ ] **Step 3: Test OSC 133 integration**

Run: `CCIE_REPO_ROOT="$PWD" bun tauri dev`

Test sequence:
1. Open terminal
2. Run `ls` - should create a block
3. Run `echo test` - should create another block
4. Verify blocks show command + output + exit code

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/command_parser.rs src/hooks/usePty.ts
git commit -m "feat(pty): enhance OSC 133 parsing for command blocks

- Parse OSC 133;E for command text
- Parse OSC 133;D for exit codes
- Emit CommandStart/CommandEnd events
- usePty hook creates/completes blocks automatically
- Buffer output per block"
```

---

## Task 7: Command Palette Foundation

**Files:**
- Create: `src/hooks/useKeyboardShortcut.ts`
- Create: `src/components/CommandPalette.tsx`
- Create: `package.json` (add fuse.js)

- [ ] **Step 1: Add fuse.js dependency**

Run: `bun add fuse.js`

Expected: Package added to package.json

- [ ] **Step 2: Create keyboard shortcut hook**

Create: `src/hooks/useKeyboardShortcut.ts`

```typescript
import { useEffect } from 'react';

export function useKeyboardShortcut(
  key: string,
  callback: () => void,
  options: {
    ctrl?: boolean;
    cmd?: boolean;
    shift?: boolean;
    alt?: boolean;
  } = {}
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      
      const modifierMatch = 
        (options.ctrl === undefined || e.ctrlKey === options.ctrl) &&
        (options.cmd === undefined || (isMac ? e.metaKey : e.ctrlKey) === options.cmd) &&
        (options.shift === undefined || e.shiftKey === options.shift) &&
        (options.alt === undefined || e.altKey === options.alt);
      
      if (modifierMatch && e.key.toLowerCase() === key.toLowerCase()) {
        e.preventDefault();
        callback();
      }
    };
    
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [key, callback, options]);
}
```

- [ ] **Step 3: Write failing test for CommandPalette**

Create: `src/components/CommandPalette.test.tsx`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette } from './CommandPalette';

describe('CommandPalette', () => {
  it('should not render when closed', () => {
    render(<CommandPalette open={false} onClose={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });

  it('should render when open', () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it('should call onClose when pressing Escape', () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} />);
    
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    
    expect(onClose).toHaveBeenCalled();
  });

  it('should filter items by search query', async () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: 'git' } });
    
    // Should show items matching 'git'
    expect(screen.queryByText(/^git/i)).toBeInTheDocument();
  });
});
```

Run: `bun test src/components/CommandPalette.test.tsx`
Expected: FAIL - CommandPalette not found

- [ ] **Step 4: Implement CommandPalette component**

Create: `src/components/CommandPalette.tsx`

```typescript
import { useState, useEffect, useMemo } from 'react';
import Fuse from 'fuse.js';
import { invoke } from '@tauri-apps/api/core';
import { useBlocksStore } from '../state/blocksStore';
import './CommandPalette.css';

interface PaletteItem {
  type: 'command' | 'skill' | 'tool' | 'action' | 'bookmark';
  title: string;
  subtitle?: string;
  icon: string;
  action: () => void | Promise<void>;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  const blocksByTab = useBlocksStore((s) => s.blocksByTab);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelectedIndex(0);
      return;
    }

    // Load all items when opening
    const loadItems = async () => {
      const allItems: PaletteItem[] = [];

      // Recent commands from current tab
      const currentTabId = Array.from(blocksByTab.keys())[0]; // Get first tab
      if (currentTabId) {
        try {
          const recent = await invoke<any[]>('blocks_get_recent', {
            tabId: currentTabId,
            limit: 20
          });
          
          recent.forEach((block) => {
            allItems.push({
              type: 'command',
              title: block.cmd,
              subtitle: block.cwd,
              icon: '📋',
              action: () => {
                window.dispatchEvent(new CustomEvent('ccie:execute-command', {
                  detail: { command: block.cmd }
                }));
                onClose();
              },
            });
          });
        } catch (error) {
          console.error('Failed to load recent commands:', error);
        }
      }

      // Bookmarked commands
      try {
        const bookmarked = await invoke<any[]>('blocks_get_bookmarked');
        bookmarked.forEach((block) => {
          allItems.push({
            type: 'bookmark',
            title: block.cmd,
            subtitle: `${block.cwd} • Bookmarked`,
            icon: '⭐',
            action: () => {
              window.dispatchEvent(new CustomEvent('ccie:execute-command', {
                detail: { command: block.cmd }
              }));
              onClose();
            },
          });
        });
      } catch (error) {
        console.error('Failed to load bookmarks:', error);
      }

      // Built-in actions
      allItems.push(
        {
          type: 'action',
          title: 'New Tab',
          subtitle: 'Create a new terminal tab',
          icon: '⚙️',
          action: () => {
            window.dispatchEvent(new CustomEvent('ccie:new-tab'));
            onClose();
          },
        },
        {
          type: 'action',
          title: 'Search History',
          subtitle: 'Search all command history',
          icon: '⚙️',
          action: () => {
            window.dispatchEvent(new CustomEvent('ccie:search-history'));
            onClose();
          },
        },
        {
          type: 'action',
          title: 'Toggle Agent Panel',
          subtitle: 'Show or hide AI agent panel',
          icon: '⚙️',
          action: () => {
            window.dispatchEvent(new CustomEvent('ccie:toggle-agent-panel'));
            onClose();
          },
        }
      );

      setItems(allItems);
    };

    loadItems();
  }, [open, blocksByTab, onClose]);

  const fuse = useMemo(() => {
    return new Fuse(items, {
      keys: ['title', 'subtitle'],
      threshold: 0.3,
      includeScore: true,
    });
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!query) return items;
    return fuse.search(query).map((result) => result.item);
  }, [query, fuse, items]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filteredItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        filteredItems[selectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const handleItemClick = (index: number) => {
    filteredItems[index].action();
  };

  if (!open) return null;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <span className="search-icon">⌘K</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type to search commands, skills, tools..."
            autoFocus
          />
        </div>

        <div className="palette-results">
          {filteredItems.length === 0 ? (
            <div className="no-results">No results found</div>
          ) : (
            filteredItems.map((item, index) => (
              <div
                key={index}
                className={`palette-item ${index === selectedIndex ? 'selected' : ''}`}
                onClick={() => handleItemClick(index)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="item-icon">{item.icon}</span>
                <div className="item-content">
                  <div className="item-title">{item.title}</div>
                  {item.subtitle && <div className="item-subtitle">{item.subtitle}</div>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create CommandPalette styles**

Create: `src/components/CommandPalette.css`

```css
.palette-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  z-index: 9999;
}

.palette-modal {
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  width: 600px;
  max-width: 90vw;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.palette-search {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid #3a3a3a;
}

.search-icon {
  font-size: 14px;
  color: #888;
}

.palette-search input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: #e6e1cf;
  font-size: 16px;
  font-family: inherit;
}

.palette-search input::placeholder {
  color: #666;
}

.palette-results {
  overflow-y: auto;
  max-height: calc(70vh - 60px);
}

.palette-results::-webkit-scrollbar {
  width: 8px;
}

.palette-results::-webkit-scrollbar-track {
  background: #2a2a2a;
}

.palette-results::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 4px;
}

.palette-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.1s ease;
}

.palette-item:hover,
.palette-item.selected {
  background: #353535;
}

.item-icon {
  font-size: 18px;
  width: 24px;
  text-align: center;
}

.item-content {
  flex: 1;
  min-width: 0;
}

.item-title {
  font-size: 14px;
  color: #e6e1cf;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-subtitle {
  font-size: 12px;
  color: #888;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.no-results {
  padding: 32px;
  text-align: center;
  color: #666;
  font-style: italic;
}
```

- [ ] **Step 6: Run tests**

Run: `bun test src/components/CommandPalette.test.tsx`
Expected: Tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useKeyboardShortcut.ts src/components/CommandPalette* package.json bun.lockb
git commit -m "feat(ui): add command palette with fuzzy search

- Cmd+K opens modal with search
- Fuzzy search via fuse.js
- Loads recent commands, bookmarks, actions
- Keyboard navigation (arrows, enter, escape)
- Tests for core functionality"
```

---

## Task 8: Integrate Command Palette in App

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add palette state and keyboard shortcut**

Modify: `src/App.tsx`

Add imports:
```typescript
import { CommandPalette } from "./components/CommandPalette";
import { useKeyboardShortcut } from "./hooks/useKeyboardShortcut";
```

Add state and hook inside App component:
```typescript
const [paletteOpen, setPaletteOpen] = useState(false);

useKeyboardShortcut('k', () => setPaletteOpen(true), { cmd: true });
```

Add palette component before closing `</div>`:
```typescript
<CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
```

- [ ] **Step 2: Test palette integration**

Run: `CCIE_REPO_ROOT="$PWD" bun tauri dev`

Test:
1. Press Cmd+K (or Ctrl+K on Windows)
2. Palette should open
3. Type "git" - should filter commands
4. Press Escape - should close
5. Arrow keys should navigate
6. Enter should execute

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): integrate command palette with Cmd+K

- Cmd+K opens command palette
- Escape closes palette
- Palette overlays entire app"
```

---

## Task 9: Shell Integration Scripts

**Files:**
- Create: `docs/shell-integration/zshrc-additions.sh`
- Create: `docs/shell-integration/bashrc-additions.sh`
- Create: `docs/USER_GUIDE.md` (update)

- [ ] **Step 1: Create zsh integration script**

Create: `docs/shell-integration/zshrc-additions.sh`

```bash
# CCIE Terminal - Command Blocks Integration for Zsh
# Add these lines to your ~/.zshrc

# Emit OSC 133 sequences for command tracking
precmd() {
  # Command completed - send exit code
  printf '\e]133;D;%s\a' "$?"
  
  # New prompt starting - begin new block
  printf '\e]133;A\a'
}

preexec() {
  # About to execute command
  printf '\e]133;C\a'
  
  # Send command text
  printf '\e]133;E;%s\a' "$1"
}

# Get current working directory for block context
_ccie_get_cwd() {
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"
}

# Emit CWD on directory change
chpwd_functions+=(_ccie_get_cwd)
```

- [ ] **Step 2: Create bash integration script**

Create: `docs/shell-integration/bashrc-additions.sh`

```bash
# CCIE Terminal - Command Blocks Integration for Bash
# Add these lines to your ~/.bashrc

# Emit OSC 133 sequences for command tracking
__ccie_prompt_command() {
  local exit_code=$?
  printf '\e]133;D;%s\a' "$exit_code"
  printf '\e]133;A\a'
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"
}

__ccie_preexec() {
  printf '\e]133;C\a'
  printf '\e]133;E;%s\a' "$BASH_COMMAND"
}

# Install hooks
PROMPT_COMMAND="__ccie_prompt_command"
trap '__ccie_preexec' DEBUG
```

- [ ] **Step 3: Update USER_GUIDE with setup instructions**

Modify: `docs/USER_GUIDE.md`

Add section:

```markdown
## Command Blocks Setup

CCIE Terminal uses command blocks to organize your terminal into discrete, manageable units. Each command you run becomes a block that you can:

- Collapse/expand
- Bookmark
- Rerun
- Copy output
- View metadata (duration, exit code, timestamp)

### Shell Integration

To enable automatic command block detection, add these lines to your shell config:

**For Zsh (~/.zshrc):**
```bash
# Source CCIE Terminal integration
source <path-to-ccie>/docs/shell-integration/zshrc-additions.sh
```

**For Bash (~/.bashrc):**
```bash
# Source CCIE Terminal integration
source <path-to-ccie>/docs/shell-integration/bashrc-additions.sh
```

After adding, reload your shell:
```bash
source ~/.zshrc  # or source ~/.bashrc
```

### Using Command Blocks

- **Collapse/Expand**: Click the block header
- **Bookmark**: Click the ★ button
- **Rerun**: Click the ↻ button
- **Copy Output**: Click the 📋 button

### Command Palette

Press `Cmd+K` (or `Ctrl+K` on Windows/Linux) to open the command palette:

- Search recent commands
- Access bookmarked commands
- Quick actions (new tab, search history)
- Fuzzy search across all items

Use arrow keys to navigate, Enter to execute, Escape to close.
```

- [ ] **Step 4: Commit**

```bash
git add docs/shell-integration/ docs/USER_GUIDE.md
git commit -m "docs: add shell integration scripts for command blocks

- Zsh integration with OSC 133 sequences
- Bash integration with OSC 133 sequences
- USER_GUIDE section explaining setup and usage"
```

---

## Task 10: End-to-End Testing

**Files:**
- Create: `e2e/tests/command-blocks.spec.ts`

- [ ] **Step 1: Write E2E test for command blocks**

Create: `e2e/tests/command-blocks.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import { setupTest } from '../fixtures';

test.describe('Command Blocks', () => {
  test('should create blocks for each command', async ({ page }) => {
    const { terminal } = await setupTest(page);
    
    // Run a command
    await terminal.type('echo "Hello World"');
    await terminal.pressEnter();
    
    // Wait for output
    await page.waitForSelector('[data-block-id]', { timeout: 5000 });
    
    // Verify block was created
    const blocks = await page.$$('[data-block-id]');
    expect(blocks.length).toBeGreaterThan(0);
    
    // Verify command text is in block header
    const commandText = await page.locator('.command-text').first().textContent();
    expect(commandText).toContain('echo');
  });

  test('should show exit code after command completes', async ({ page }) => {
    const { terminal } = await setupTest(page);
    
    // Run a successful command
    await terminal.type('true');
    await terminal.pressEnter();
    
    await page.waitForSelector('.exit-code', { timeout: 5000 });
    
    const exitCode = await page.locator('.exit-code').first().textContent();
    expect(exitCode).toContain('exit 0');
  });

  test('should collapse and expand blocks', async ({ page }) => {
    const { terminal } = await setupTest(page);
    
    // Run a command with output
    await terminal.type('ls');
    await terminal.pressEnter();
    
    await page.waitForSelector('[data-block-id]', { timeout: 5000 });
    
    // Get the block
    const block = page.locator('[data-block-id]').first();
    
    // Initially expanded - output should be visible
    await expect(block.locator('.output-text')).toBeVisible();
    
    // Click header to collapse
    await block.locator('.block-header').click();
    
    // Output should be hidden
    await expect(block.locator('.collapse-hint')).toBeVisible();
    await expect(block.locator('.output-text')).not.toBeVisible();
    
    // Click again to expand
    await block.locator('.block-header').click();
    
    // Output should be visible again
    await expect(block.locator('.output-text')).toBeVisible();
  });

  test('should bookmark blocks', async ({ page }) => {
    const { terminal } = await setupTest(page);
    
    await terminal.type('important-command');
    await terminal.pressEnter();
    
    await page.waitForSelector('[data-block-id]', { timeout: 5000 });
    
    const block = page.locator('[data-block-id]').first();
    
    // Click bookmark button
    await block.locator('.action-btn:has-text("★")').click();
    
    // Verify bookmark indicator appears
    await expect(block.locator('.bookmark-indicator')).toBeVisible();
  });

  test('should open command palette with Cmd+K', async ({ page }) => {
    await setupTest(page);
    
    // Press Cmd+K
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    
    // Palette should open
    await expect(page.locator('.palette-modal')).toBeVisible();
    
    // Search input should be focused
    const input = page.locator('.palette-search input');
    await expect(input).toBeFocused();
  });

  test('should filter palette items by query', async ({ page }) => {
    const { terminal } = await setupTest(page);
    
    // Run some commands first
    await terminal.type('git status');
    await terminal.pressEnter();
    await page.waitForTimeout(500);
    
    await terminal.type('npm install');
    await terminal.pressEnter();
    await page.waitForTimeout(500);
    
    // Open palette
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    
    // Type search query
    const input = page.locator('.palette-search input');
    await input.fill('git');
    
    // Should show git-related items
    const items = await page.$$('.palette-item');
    expect(items.length).toBeGreaterThan(0);
    
    const firstItemText = await items[0].textContent();
    expect(firstItemText?.toLowerCase()).toContain('git');
  });

  test('should close palette with Escape', async ({ page }) => {
    await setupTest(page);
    
    // Open palette
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await expect(page.locator('.palette-modal')).toBeVisible();
    
    // Press Escape
    await page.keyboard.press('Escape');
    
    // Palette should close
    await expect(page.locator('.palette-modal')).not.toBeVisible();
  });
});
```

- [ ] **Step 2: Run E2E tests**

Run: `bun test:e2e e2e/tests/command-blocks.spec.ts`

Expected: All tests PASS

- [ ] **Step 3: Fix any failing tests**

If tests fail:
- Check terminal output for errors
- Verify OSC sequences are being emitted
- Check block creation timing
- Verify CSS selectors match

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/command-blocks.spec.ts
git commit -m "test(e2e): add command blocks end-to-end tests

- Test block creation
- Test collapse/expand
- Test bookmarking
- Test command palette
- Test fuzzy search
- Test keyboard shortcuts"
```

---

## Final Task: Documentation and Polish

**Files:**
- Update: `README.md`
- Update: `docs/ARCHITECTURE.md`
- Create: `docs/COMMAND_BLOCKS.md`

- [ ] **Step 1: Update README with command blocks feature**

Modify: `README.md`

Update Key Features section:
```markdown
## Key Features

- **Command Blocks**: Organize terminal into discrete, manageable command units
  - Collapsible command outputs
  - Bookmark important commands
  - Rerun commands with one click
  - Copy outputs without escape sequences
- **Command Palette**: Universal Cmd+K launcher for commands, skills, and actions
  - Fuzzy search across all items
  - Recent commands quick access
  - Keyboard-driven navigation
- **AI-Powered Command Translation**: Type natural language queries and get shell commands instantly
... (existing features)
```

- [ ] **Step 2: Create COMMAND_BLOCKS documentation**

Create: `docs/COMMAND_BLOCKS.md`

```markdown
# Command Blocks

Command blocks transform CCIE Terminal from a continuous scroll into discrete, manageable command units. Each command you execute becomes a block with:

- Command text and working directory
- Execution timestamp and duration
- Exit code (success/failure)
- Full output (collapsible)
- Interactive actions (bookmark, rerun, copy, share)

## Architecture

### Hybrid Terminal Design

Unlike traditional terminals that render everything in a single continuous xterm.js instance, CCIE Terminal uses a **hybrid approach**:

- **Active block**: Contains a live, interactive xterm.js terminal where you type
- **Completed blocks**: Render output as plain text (faster, lighter)
- **Block metadata**: Stored in SQLite for persistence and search

This design enables:
- Smooth collapse/expand animations
- Clean copy/paste (no ANSI escape sequences)
- Efficient rendering of large command histories
- Foundation for advanced features (AI analysis, sharing, workflows)

### Shell Integration

Command boundaries are detected via OSC 133 escape sequences:

```
User types command
     ↓
Shell preexec hook → OSC 133;E;<cmd>
     ↓
CCIE creates new block
     ↓
Command executes
     ↓
Shell precmd hook → OSC 133;D;<exit_code>
     ↓
CCIE completes block with output
```

### Data Flow

```
┌─────────────────────────────────────────────────┐
│              Frontend (React)                    │
│                                                  │
│  ┌──────────────┐        ┌──────────────────┐  │
│  │ BlocksStore  │ ←────→ │ CommandBlock     │  │
│  │  (Zustand)   │        │  Components      │  │
│  └──────┬───────┘        └──────────────────┘  │
│         │                                        │
└─────────┼────────────────────────────────────────┘
          │ Tauri IPC
┌─────────┼────────────────────────────────────────┐
│         ▼                                        │
│  ┌──────────────┐        ┌──────────────────┐  │
│  │ blocks.rs    │ ←────→ │    SQLite        │  │
│  │  Commands    │        │  command_blocks  │  │
│  └──────────────┘        └──────────────────┘  │
│              Backend (Rust/Tauri)               │
└─────────────────────────────────────────────────┘
```

## Usage

### Basic Operations

**Collapse/Expand**
- Click block header to toggle
- Collapsed blocks show line count
- Saves screen space for long outputs

**Bookmark**
- Click ★ button in block actions
- Bookmarked blocks appear in command palette
- Useful for frequently-used commands

**Rerun**
- Click ↻ button to execute command again
- Creates a new block with same command
- Preserves history while running again

**Copy Output**
- Click 📋 button
- Copies raw output without ANSI escape sequences
- Perfect for pasting into docs/tickets

### Command Palette

Press **Cmd+K** (or **Ctrl+K** on Windows/Linux) to open:

- **Recent Commands**: Last 20 commands from current tab
- **Bookmarked**: All bookmarked blocks
- **Actions**: Built-in actions (new tab, search, etc.)

**Fuzzy Search**:
Type any part of a command to filter results. Uses Fuse.js for intelligent matching:
- `git st` matches "git status"
- `ans play` matches "ansible-playbook"

**Keyboard Navigation**:
- `↑` / `↓` - Navigate items
- `Enter` - Execute selected item
- `Esc` - Close palette

## Performance

### Virtualization

For tabs with 100+ blocks, CCIE uses `react-window` to virtualize the list:
- Only visible blocks are rendered
- Smooth scrolling even with thousands of blocks
- Memory usage stays constant

### Output Storage

- Small outputs (< 1MB): Stored in SQLite TEXT column
- Large outputs (> 1MB): Stored in separate files
- Old blocks (> 30 days): Compressed with gzip

### Memory Management

- Last 50 blocks: Kept fully in memory
- Older blocks: Lazy-loaded from DB on expand
- Active block: Always in memory with live xterm

## Database Schema

```sql
CREATE TABLE command_blocks (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  cmd TEXT NOT NULL,
  cwd TEXT NOT NULL,
  output TEXT NOT NULL,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  output_line_count INTEGER DEFAULT 0,
  is_bookmarked BOOLEAN DEFAULT 0,
  ai_analysis TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (tab_id) REFERENCES tabs(id)
);
```

## Future Enhancements

- **AI Analysis**: Automatic error explanation for failed commands
- **Block Sharing**: Export blocks as markdown/gists
- **Workflows**: Chain blocks into reusable sequences
- **Notebooks**: Mix blocks with markdown notes
- **Search**: Full-text search across all block outputs
```

- [ ] **Step 3: Update ARCHITECTURE.md**

Modify: `docs/ARCHITECTURE.md`

Add section after "Data Flow":

```markdown
### Command Blocks Architecture

Command blocks use a hybrid rendering approach:

**Active Block**:
```
React Component → xterm.js instance → Live PTY
```

**Completed Blocks**:
```
React Component → Plain Text (<pre>) → SQLite
```

**State Flow**:
```
OSC 133 sequence → PTY Parser → Tauri Event → Frontend
  → BlocksStore → Add/Complete Block → Sync to SQLite
```

This design enables:
- Collapse/expand without losing terminal state
- Clean copy/paste (text, not xterm buffer)
- Persistence across sessions
- Foundation for AI analysis and workflows
```

- [ ] **Step 4: Run final verification**

Run complete test suite:
```bash
# Unit tests
bun test

# E2E tests
bun test:e2e

# Build check
cd src-tauri && cargo build --release

# Dev run
CCIE_REPO_ROOT="$PWD" bun tauri dev
```

Expected: All tests pass, app runs without errors

- [ ] **Step 5: Final commit**

```bash
git add README.md docs/ARCHITECTURE.md docs/COMMAND_BLOCKS.md
git commit -m "docs: comprehensive documentation for command blocks

- Updated README with command blocks features
- New COMMAND_BLOCKS.md with architecture details
- Updated ARCHITECTURE.md with hybrid terminal flow
- Usage guide, performance notes, future enhancements"
```

---

## Implementation Complete! 🎉

Phase 1 (Command Blocks + Command Palette) is now complete.

**What we built:**
✅ Database schema for command blocks with metadata
✅ Zustand store for block state management
✅ Tauri commands for block CRUD operations
✅ Hybrid terminal with React-based command blocks
✅ Block header, output, and actions components
✅ OSC 133 shell integration for auto-detection
✅ Command palette with fuzzy search (Cmd+K)
✅ Keyboard shortcuts and navigation
✅ Shell integration scripts (zsh, bash)
✅ Comprehensive tests (unit + E2E)
✅ Full documentation

**Next Steps:**
- Use the terminal for a few days, gather feedback
- Fix any bugs or UX issues discovered
- Then proceed to Phase 2: Split Panes

**Phase 2 Preview:**
- Horizontal/vertical pane splitting
- Independent PTY per pane
- Resizable panes with drag handles
- Synchronized input (optional)

---

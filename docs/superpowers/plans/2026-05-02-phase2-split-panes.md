# Phase 2: Split Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add horizontal and vertical pane splitting to allow users to view multiple terminals side-by-side, each with its own independent PTY session, while supporting pane resizing, focus management, and keyboard navigation.

**Architecture:** React component tree manages pane layout as a recursive split structure (horizontal/vertical containers). Each pane gets its own Terminal component with dedicated PTY. Layout state persists in Zustand store. Drag handles between panes allow resizing. Keyboard shortcuts handle pane navigation and splitting.

**Tech Stack:** React 19, Zustand, xterm.js, Tauri, react-split (for resize handles), TypeScript

---

## Scope

**In Phase 2:**
- Split current pane horizontally (Cmd+Shift+D) or vertically (Cmd+D)
- Each pane has independent PTY session
- Drag handles to resize panes (proportional sizing)
- Focus management (click pane to focus, visual indicator)
- Keyboard navigation (Cmd+Alt+Arrow keys to move focus)
- Close pane (Cmd+W closes focused pane)
- Layout persists across app restarts
- Minimum pane size enforcement (200px)
- Works with both Terminal and Blocks modes

**Deferred:**
- Synchronized input across panes → Phase 3
- Pane zoom/maximize → Phase 3
- Drag-and-drop pane reordering → Phase 3
- Named pane layouts (save/load arrangements) → Phase 4

---

## File Structure

### New Files (Create)
- `src/state/panesStore.ts` - Zustand store for pane layout and focus
- `src/components/PaneContainer.tsx` - Recursive split container component
- `src/components/PaneHandle.tsx` - Drag handle for resizing
- `src/components/Pane.tsx` - Single pane wrapper with focus indicator
- `src/hooks/usePaneSplit.ts` - Hook for split/close/navigate operations
- `src/hooks/usePaneResize.ts` - Hook for drag-resize logic
- `src-tauri/migrations/V0018__pane_layouts.sql` - DB schema for layouts
- `src-tauri/src/commands/panes.rs` - Tauri commands for layout persistence

### Modified Files
- `src/App.tsx` - Replace single Terminal with PaneContainer
- `src/components/TabBar.tsx` - Add split pane buttons
- `src/state/tabsStore.ts` - Track pane layouts per tab
- `src-tauri/src/commands/mod.rs` - Register pane commands
- `src-tauri/src/lib.rs` - Register pane commands in invoke_handler
- `package.json` - Add react-split or custom resize library

---

## Task 1: Database Schema for Pane Layouts

**Files:**
- Create: `src-tauri/migrations/V0019__pane_layouts.sql`

- [ ] **Step 1: Write migration for pane_layouts table**

```sql
-- Store pane layout configurations per tab
CREATE TABLE IF NOT EXISTS pane_layouts (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  layout_json TEXT NOT NULL, -- JSON serialized layout tree
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pane_layouts_tab ON pane_layouts(tab_id);

-- Each tab has exactly one active layout
CREATE UNIQUE INDEX IF NOT EXISTS idx_pane_layouts_unique_tab ON pane_layouts(tab_id);
```

- [ ] **Step 2: Verify migration compiles**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds

- [ ] **Step 3: Test migration applies cleanly**

Run:
```bash
cd src-tauri
rm -f target/test.db
cargo test --lib test_migrations -- --nocapture
```

Expected: Migration V0019 applies successfully

- [ ] **Step 4: Commit**

```bash
git add src-tauri/migrations/V0019__pane_layouts.sql
git commit -m "feat(db): add pane_layouts table for split pane persistence

- Store JSON serialized layout trees per tab
- One layout per tab (unique index)
- Cascading delete when tab is removed"
```

---

## Task 2: Pane Layout State Management (Zustand Store)

**Files:**
- Create: `src/state/panesStore.ts`
- Create: `src/state/panesStore.test.ts`

- [ ] **Step 1: Write failing test for panesStore**

Create: `src/state/panesStore.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { usePanesStore } from './panesStore';

describe('panesStore', () => {
  beforeEach(() => {
    usePanesStore.setState({
      layoutsByTab: new Map(),
      focusedPaneId: null,
    });
  });

  it('should initialize with single pane layout', () => {
    const layout = usePanesStore.getState().initializeLayout('tab-1');
    
    expect(layout.type).toBe('leaf');
    expect(layout.id).toBeDefined();
    expect(layout.terminalId).toBe('tab-1');
  });

  it('should split pane horizontally', () => {
    const store = usePanesStore.getState();
    const layout = store.initializeLayout('tab-1');
    
    const newLayout = store.splitPane(layout.id, 'horizontal');
    
    expect(newLayout.type).toBe('split');
    expect(newLayout.direction).toBe('horizontal');
    expect(newLayout.children).toHaveLength(2);
    expect(newLayout.children[0].size).toBe(50);
    expect(newLayout.children[1].size).toBe(50);
  });

  it('should split pane vertically', () => {
    const store = usePanesStore.getState();
    const layout = store.initializeLayout('tab-1');
    
    const newLayout = store.splitPane(layout.id, 'vertical');
    
    expect(newLayout.type).toBe('split');
    expect(newLayout.direction).toBe('vertical');
    expect(newLayout.children).toHaveLength(2);
  });

  it('should close pane and rebalance siblings', () => {
    const store = usePanesStore.getState();
    let layout = store.initializeLayout('tab-1');
    layout = store.splitPane(layout.id, 'horizontal');
    
    const paneToClose = layout.children[0].id;
    const newLayout = store.closePane(paneToClose);
    
    expect(newLayout.type).toBe('leaf');
    expect(newLayout.id).not.toBe(paneToClose);
  });

  it('should update pane sizes on resize', () => {
    const store = usePanesStore.getState();
    let layout = store.initializeLayout('tab-1');
    layout = store.splitPane(layout.id, 'horizontal');
    
    const newLayout = store.resizePane(layout.id, [30, 70]);
    
    expect(newLayout.children[0].size).toBe(30);
    expect(newLayout.children[1].size).toBe(70);
  });

  it('should track focused pane', () => {
    const store = usePanesStore.getState();
    const layout = store.initializeLayout('tab-1');
    
    store.setFocusedPane(layout.id);
    
    expect(store.focusedPaneId).toBe(layout.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/state/panesStore.test.ts`
Expected: FAIL with "panesStore not found"

- [ ] **Step 3: Implement panesStore**

Create: `src/state/panesStore.ts`

```typescript
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type PaneDirection = 'horizontal' | 'vertical';

export type PaneLeaf = {
  type: 'leaf';
  id: string;
  terminalId: string; // Maps to a tab_id with its own PTY
  size: number; // Percentage (0-100)
};

export type PaneSplit = {
  type: 'split';
  id: string;
  direction: PaneDirection;
  children: PaneNode[];
};

export type PaneNode = PaneLeaf | PaneSplit;

interface PanesState {
  // Map of tabId -> PaneNode (layout tree)
  layoutsByTab: Map<string, PaneNode>;
  
  // Currently focused pane ID
  focusedPaneId: string | null;
  
  // Actions
  initializeLayout: (tabId: string) => PaneNode;
  splitPane: (paneId: string, direction: PaneDirection) => PaneNode;
  closePane: (paneId: string) => PaneNode | null;
  resizePane: (splitId: string, sizes: number[]) => PaneNode;
  setFocusedPane: (paneId: string) => void;
  navigateFocus: (direction: 'up' | 'down' | 'left' | 'right') => void;
  
  // Persistence
  loadLayoutForTab: (tabId: string) => Promise<void>;
  saveLayout: (tabId: string, layout: PaneNode) => Promise<void>;
}

// Helper: Generate unique pane ID
function generatePaneId(): string {
  return `pane-${crypto.randomUUID()}`;
}

// Helper: Find pane node by ID in tree
function findPaneById(node: PaneNode, paneId: string): PaneNode | null {
  if (node.id === paneId) return node;
  
  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findPaneById(child, paneId);
      if (found) return found;
    }
  }
  
  return null;
}

// Helper: Replace pane node in tree
function replacePaneInTree(
  node: PaneNode,
  targetId: string,
  replacement: PaneNode
): PaneNode {
  if (node.id === targetId) return replacement;
  
  if (node.type === 'split') {
    return {
      ...node,
      children: node.children.map(child =>
        replacePaneInTree(child, targetId, replacement)
      ),
    };
  }
  
  return node;
}

// Helper: Remove pane from tree and rebalance
function removePaneFromTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? null : node;
  }
  
  // It's a split - check if target is one of the children
  const newChildren = node.children
    .map(child => removePaneFromTree(child, paneId))
    .filter((child): child is PaneNode => child !== null);
  
  // If only one child remains, collapse the split
  if (newChildren.length === 1) {
    return newChildren[0];
  }
  
  // If no children remain, this split disappears
  if (newChildren.length === 0) {
    return null;
  }
  
  // Rebalance sizes to sum to 100
  const totalSize = newChildren.reduce((sum, child) => sum + child.size, 0);
  const balanced = newChildren.map(child => ({
    ...child,
    size: (child.size / totalSize) * 100,
  }));
  
  return {
    ...node,
    children: balanced,
  };
}

// Helper: Get all leaf panes in layout order
function getAllLeafPanes(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node];
  return node.children.flatMap(getAllLeafPanes);
}

export const usePanesStore = create<PanesState>((set, get) => ({
  layoutsByTab: new Map(),
  focusedPaneId: null,
  
  initializeLayout: (tabId: string) => {
    const rootPane: PaneLeaf = {
      type: 'leaf',
      id: generatePaneId(),
      terminalId: tabId,
      size: 100,
    };
    
    set(state => {
      const newMap = new Map(state.layoutsByTab);
      newMap.set(tabId, rootPane);
      return {
        layoutsByTab: newMap,
        focusedPaneId: rootPane.id,
      };
    });
    
    return rootPane;
  },
  
  splitPane: (paneId: string, direction: PaneDirection) => {
    const state = get();
    let newLayout: PaneNode | null = null;
    
    // Find which tab contains this pane
    for (const [tabId, layout] of state.layoutsByTab.entries()) {
      const targetPane = findPaneById(layout, paneId);
      
      if (targetPane && targetPane.type === 'leaf') {
        // Create two new panes
        const pane1: PaneLeaf = {
          type: 'leaf',
          id: generatePaneId(),
          terminalId: targetPane.terminalId,
          size: 50,
        };
        
        const pane2: PaneLeaf = {
          type: 'leaf',
          id: generatePaneId(),
          terminalId: `term-${crypto.randomUUID()}`, // New terminal
          size: 50,
        };
        
        const split: PaneSplit = {
          type: 'split',
          id: generatePaneId(),
          direction,
          children: [pane1, pane2],
        };
        
        newLayout = replacePaneInTree(layout, paneId, split);
        
        set(state => {
          const newMap = new Map(state.layoutsByTab);
          newMap.set(tabId, newLayout!);
          return {
            layoutsByTab: newMap,
            focusedPaneId: pane2.id, // Focus new pane
          };
        });
        
        // Persist to DB
        get().saveLayout(tabId, newLayout);
        
        break;
      }
    }
    
    return newLayout!;
  },
  
  closePane: (paneId: string) => {
    const state = get();
    let newLayout: PaneNode | null = null;
    
    for (const [tabId, layout] of state.layoutsByTab.entries()) {
      const targetPane = findPaneById(layout, paneId);
      
      if (targetPane) {
        newLayout = removePaneFromTree(layout, paneId);
        
        if (newLayout) {
          set(state => {
            const newMap = new Map(state.layoutsByTab);
            newMap.set(tabId, newLayout!);
            
            // If closed pane was focused, focus first remaining pane
            let newFocusedId = state.focusedPaneId;
            if (newFocusedId === paneId) {
              const leaves = getAllLeafPanes(newLayout!);
              newFocusedId = leaves[0]?.id || null;
            }
            
            return {
              layoutsByTab: newMap,
              focusedPaneId: newFocusedId,
            };
          });
          
          // Persist to DB
          get().saveLayout(tabId, newLayout);
        } else {
          // Last pane closed - remove layout
          set(state => {
            const newMap = new Map(state.layoutsByTab);
            newMap.delete(tabId);
            return {
              layoutsByTab: newMap,
              focusedPaneId: null,
            };
          });
          
          // Delete from DB
          invoke('panes_delete_layout', { tabId }).catch(console.error);
        }
        
        break;
      }
    }
    
    return newLayout;
  },
  
  resizePane: (splitId: string, sizes: number[]) => {
    const state = get();
    let newLayout: PaneNode | null = null;
    
    for (const [tabId, layout] of state.layoutsByTab.entries()) {
      const targetSplit = findPaneById(layout, splitId);
      
      if (targetSplit && targetSplit.type === 'split') {
        const updatedSplit: PaneSplit = {
          ...targetSplit,
          children: targetSplit.children.map((child, index) => ({
            ...child,
            size: sizes[index] || child.size,
          })),
        };
        
        newLayout = replacePaneInTree(layout, splitId, updatedSplit);
        
        set(state => {
          const newMap = new Map(state.layoutsByTab);
          newMap.set(tabId, newLayout!);
          return { layoutsByTab: newMap };
        });
        
        // Persist to DB
        get().saveLayout(tabId, newLayout);
        
        break;
      }
    }
    
    return newLayout!;
  },
  
  setFocusedPane: (paneId: string) => {
    set({ focusedPaneId: paneId });
  },
  
  navigateFocus: (direction: 'up' | 'down' | 'left' | 'right') => {
    const state = get();
    if (!state.focusedPaneId) return;
    
    // Find current focused pane and navigate in direction
    // This is a simplified version - full implementation would need
    // spatial awareness of pane positions
    for (const layout of state.layoutsByTab.values()) {
      const leaves = getAllLeafPanes(layout);
      const currentIndex = leaves.findIndex(p => p.id === state.focusedPaneId);
      
      if (currentIndex !== -1) {
        let newIndex = currentIndex;
        
        if (direction === 'right' || direction === 'down') {
          newIndex = (currentIndex + 1) % leaves.length;
        } else if (direction === 'left' || direction === 'up') {
          newIndex = (currentIndex - 1 + leaves.length) % leaves.length;
        }
        
        set({ focusedPaneId: leaves[newIndex].id });
        break;
      }
    }
  },
  
  loadLayoutForTab: async (tabId: string) => {
    try {
      const layoutJson = await invoke<string>('panes_get_layout', { tabId });
      const layout: PaneNode = JSON.parse(layoutJson);
      
      set(state => {
        const newMap = new Map(state.layoutsByTab);
        newMap.set(tabId, layout);
        
        // Focus first pane
        const leaves = getAllLeafPanes(layout);
        
        return {
          layoutsByTab: newMap,
          focusedPaneId: leaves[0]?.id || null,
        };
      });
    } catch (error) {
      // No saved layout - initialize default
      console.log('No saved layout, initializing default');
      get().initializeLayout(tabId);
    }
  },
  
  saveLayout: async (tabId: string, layout: PaneNode) => {
    try {
      const layoutJson = JSON.stringify(layout);
      await invoke('panes_save_layout', { tabId, layoutJson });
    } catch (error) {
      console.error('Failed to save pane layout:', error);
    }
  },
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/state/panesStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/panesStore.ts src/state/panesStore.test.ts
git commit -m "feat(state): add panesStore for split pane layout management

- Recursive PaneNode tree structure (leaf | split)
- Split horizontal/vertical with 50/50 sizing
- Close pane with automatic rebalancing
- Resize with proportional size updates
- Focus tracking and keyboard navigation
- Persistence via Tauri commands
- Comprehensive unit tests"
```

---

## Task 3: Tauri Commands for Pane Layout Persistence

**Files:**
- Create: `src-tauri/src/commands/panes.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create panes commands module**

Create: `src-tauri/src/commands/panes.rs`

```rust
use anyhow::Result;
use tauri::State;

use super::AppState;

#[tauri::command]
pub async fn panes_get_layout(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<String, String> {
    let conn = state.db.lock();
    
    let layout_json: String = conn
        .query_row(
            "SELECT layout_json FROM pane_layouts WHERE tab_id = ?",
            rusqlite::params![tab_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    
    Ok(layout_json)
}

#[tauri::command]
pub async fn panes_save_layout(
    state: State<'_, AppState>,
    tab_id: String,
    layout_json: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    let now = chrono::Utc::now().timestamp();
    
    conn.execute(
        "INSERT INTO pane_layouts (id, tab_id, layout_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(tab_id) DO UPDATE SET
           layout_json = excluded.layout_json,
           updated_at = excluded.updated_at",
        rusqlite::params![
            format!("layout-{}", uuid::Uuid::new_v4()),
            tab_id,
            layout_json,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub async fn panes_delete_layout(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    
    conn.execute(
        "DELETE FROM pane_layouts WHERE tab_id = ?",
        rusqlite::params![tab_id],
    )
    .map_err(|e| e.to_string())?;
    
    Ok(())
}
```

- [ ] **Step 2: Register panes module**

Modify: `src-tauri/src/commands/mod.rs`

Add at bottom:
```rust
pub mod panes;
```

- [ ] **Step 3: Register commands in lib.rs**

Modify: `src-tauri/src/lib.rs`

Find the `invoke_handler` section and add:
```rust
commands::panes::panes_get_layout,
commands::panes::panes_save_layout,
commands::panes::panes_delete_layout,
```

- [ ] **Step 4: Build and verify**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/panes.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): add panes commands for layout persistence

- panes_get_layout: fetch saved layout JSON
- panes_save_layout: upsert layout with timestamps
- panes_delete_layout: remove layout when last pane closed"
```

---

## Task 4: Pane Components (Pane, PaneHandle)

**Files:**
- Create: `src/components/Pane.tsx`
- Create: `src/components/Pane.css`
- Create: `src/components/PaneHandle.tsx`
- Create: `src/components/PaneHandle.css`

- [ ] **Step 1: Create Pane component**

Create: `src/components/Pane.tsx`

```typescript
import { memo, useRef, useEffect } from 'react';
import { Terminal } from './Terminal';
import { usePanesStore } from '../state/panesStore';
import './Pane.css';

interface PaneProps {
  paneId: string;
  terminalId: string;
  shell: string;
  cwd: string;
}

export const Pane = memo(function Pane({ paneId, terminalId, shell, cwd }: PaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const focusedPaneId = usePanesStore(s => s.focusedPaneId);
  const setFocusedPane = usePanesStore(s => s.setFocusedPane);
  const isFocused = focusedPaneId === paneId;
  
  const handleClick = () => {
    setFocusedPane(paneId);
  };
  
  // Auto-focus on mount if this is the only pane
  useEffect(() => {
    if (!focusedPaneId) {
      setFocusedPane(paneId);
    }
  }, [focusedPaneId, paneId, setFocusedPane]);
  
  return (
    <div
      ref={ref}
      className={`pane ${isFocused ? 'focused' : ''}`}
      onClick={handleClick}
      data-pane-id={paneId}
    >
      <Terminal
        shell={shell}
        cwd={cwd}
        onRegistered={() => {
          // Terminal is ready
        }}
      />
    </div>
  );
});
```

- [ ] **Step 2: Create Pane styles**

Create: `src/components/Pane.css`

```css
.pane {
  position: relative;
  width: 100%;
  height: 100%;
  border: 2px solid transparent;
  transition: border-color 0.15s ease;
  background: #0f1114;
}

.pane.focused {
  border-color: #4a90e2;
  z-index: 1;
}

.pane:not(.focused) {
  border-color: #2a2a2a;
}

/* Prevent terminal from shrinking below minimum size */
.pane .terminal-wrapper {
  min-width: 200px;
  min-height: 200px;
}
```

- [ ] **Step 3: Create PaneHandle component**

Create: `src/components/PaneHandle.tsx`

```typescript
import { memo, useRef, useState, useEffect } from 'react';
import './PaneHandle.css';

interface PaneHandleProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
}

export const PaneHandle = memo(function PaneHandle({ direction, onResize }: PaneHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef<number>(0);
  
  useEffect(() => {
    if (!isDragging) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      const delta = direction === 'horizontal'
        ? e.clientX - startPosRef.current
        : e.clientY - startPosRef.current;
      
      onResize(delta);
      startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;
    };
    
    const handleMouseUp = () => {
      setIsDragging(false);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, direction, onResize]);
  
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;
  };
  
  return (
    <div
      ref={handleRef}
      className={`pane-handle ${direction} ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
    />
  );
});
```

- [ ] **Step 4: Create PaneHandle styles**

Create: `src/components/PaneHandle.css`

```css
.pane-handle {
  background: #2a2a2a;
  transition: background 0.15s ease;
  z-index: 10;
  flex-shrink: 0;
}

.pane-handle:hover {
  background: #4a90e2;
}

.pane-handle.dragging {
  background: #5ca0f2;
}

.pane-handle.horizontal {
  width: 4px;
  height: 100%;
  cursor: ew-resize;
}

.pane-handle.vertical {
  width: 100%;
  height: 4px;
  cursor: ns-resize;
}

/* Visual indicator on hover */
.pane-handle::before {
  content: '';
  position: absolute;
  background: #4a90e2;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.pane-handle.horizontal::before {
  width: 2px;
  height: 100%;
  left: 1px;
}

.pane-handle.vertical::before {
  width: 100%;
  height: 2px;
  top: 1px;
}

.pane-handle:hover::before,
.pane-handle.dragging::before {
  opacity: 1;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/Pane.* src/components/PaneHandle.*
git commit -m "feat(ui): add Pane and PaneHandle components

- Pane: wrapper with focus indicator and Terminal
- PaneHandle: drag-to-resize handle with visual feedback
- Focus management: click to focus, border highlight
- Resize: horizontal/vertical drag with cursor change"
```

---

## Task 5: Recursive PaneContainer Component

**Files:**
- Create: `src/components/PaneContainer.tsx`
- Create: `src/components/PaneContainer.css`

- [ ] **Step 1: Create PaneContainer component**

Create: `src/components/PaneContainer.tsx`

```typescript
import { memo, useRef, useEffect } from 'react';
import { Pane } from './Pane';
import { PaneHandle } from './PaneHandle';
import { usePanesStore, PaneNode } from '../state/panesStore';
import './PaneContainer.css';

interface PaneContainerProps {
  node: PaneNode;
  shell: string;
  cwd: string;
}

export const PaneContainer = memo(function PaneContainer({ node, shell, cwd }: PaneContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizePane = usePanesStore(s => s.resizePane);
  
  if (node.type === 'leaf') {
    return (
      <Pane
        paneId={node.id}
        terminalId={node.terminalId}
        shell={shell}
        cwd={cwd}
      />
    );
  }
  
  // It's a split container
  const handleResize = (index: number, delta: number) => {
    if (!containerRef.current) return;
    
    const containerSize = node.direction === 'horizontal'
      ? containerRef.current.clientWidth
      : containerRef.current.clientHeight;
    
    const deltaPercent = (delta / containerSize) * 100;
    
    // Calculate new sizes
    const sizes = node.children.map(c => c.size);
    sizes[index] = Math.max(20, Math.min(80, sizes[index] + deltaPercent));
    sizes[index + 1] = Math.max(20, Math.min(80, sizes[index + 1] - deltaPercent));
    
    // Normalize to sum to 100
    const total = sizes.reduce((sum, s) => sum + s, 0);
    const normalized = sizes.map(s => (s / total) * 100);
    
    resizePane(node.id, normalized);
  };
  
  return (
    <div
      ref={containerRef}
      className={`pane-container ${node.direction}`}
    >
      {node.children.map((child, index) => (
        <div key={child.id} style={{ flex: `${child.size} 1 0%` }}>
          <PaneContainer node={child} shell={shell} cwd={cwd} />
          {index < node.children.length - 1 && (
            <PaneHandle
              direction={node.direction}
              onResize={(delta) => handleResize(index, delta)}
            />
          )}
        </div>
      ))}
    </div>
  );
});
```

- [ ] **Step 2: Create PaneContainer styles**

Create: `src/components/PaneContainer.css`

```css
.pane-container {
  width: 100%;
  height: 100%;
  display: flex;
}

.pane-container.horizontal {
  flex-direction: row;
}

.pane-container.vertical {
  flex-direction: column;
}

/* Ensure proper sizing for nested containers */
.pane-container > div {
  position: relative;
  min-width: 0;
  min-height: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/PaneContainer.*
git commit -m "feat(ui): add recursive PaneContainer component

- Renders leaf panes or split containers
- Handles horizontal/vertical layouts
- Manages resize with proportional sizing
- Enforces minimum pane sizes (20%)
- Prevents shrinking below 200px via CSS"
```

---

## Task 6: Keyboard Shortcuts and Navigation

**Files:**
- Create: `src/hooks/usePaneSplit.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create pane split hook**

Create: `src/hooks/usePaneSplit.ts`

```typescript
import { useCallback } from 'react';
import { usePanesStore } from '../state/panesStore';
import { useKeyboardShortcut } from './useKeyboardShortcut';

export function usePaneSplit() {
  const focusedPaneId = usePanesStore(s => s.focusedPaneId);
  const splitPane = usePanesStore(s => s.splitPane);
  const closePane = usePanesStore(s => s.closePane);
  const navigateFocus = usePanesStore(s => s.navigateFocus);
  
  // Cmd+D: Split vertically
  const handleSplitVertical = useCallback(() => {
    if (focusedPaneId) {
      splitPane(focusedPaneId, 'vertical');
    }
  }, [focusedPaneId, splitPane]);
  
  // Cmd+Shift+D: Split horizontally
  const handleSplitHorizontal = useCallback(() => {
    if (focusedPaneId) {
      splitPane(focusedPaneId, 'horizontal');
    }
  }, [focusedPaneId, splitPane]);
  
  // Cmd+W: Close focused pane
  const handleClosePane = useCallback(() => {
    if (focusedPaneId) {
      closePane(focusedPaneId);
    }
  }, [focusedPaneId, closePane]);
  
  // Cmd+Alt+Arrow: Navigate between panes
  const handleNavigateUp = useCallback(() => {
    navigateFocus('up');
  }, [navigateFocus]);
  
  const handleNavigateDown = useCallback(() => {
    navigateFocus('down');
  }, [navigateFocus]);
  
  const handleNavigateLeft = useCallback(() => {
    navigateFocus('left');
  }, [navigateFocus]);
  
  const handleNavigateRight = useCallback(() => {
    navigateFocus('right');
  }, [navigateFocus]);
  
  // Register keyboard shortcuts
  useKeyboardShortcut('d', handleSplitVertical, { cmd: true });
  useKeyboardShortcut('d', handleSplitHorizontal, { cmd: true, shift: true });
  useKeyboardShortcut('w', handleClosePane, { cmd: true });
  useKeyboardShortcut('ArrowUp', handleNavigateUp, { cmd: true, alt: true });
  useKeyboardShortcut('ArrowDown', handleNavigateDown, { cmd: true, alt: true });
  useKeyboardShortcut('ArrowLeft', handleNavigateLeft, { cmd: true, alt: true });
  useKeyboardShortcut('ArrowRight', handleNavigateRight, { cmd: true, alt: true });
  
  return {
    splitVertical: handleSplitVertical,
    splitHorizontal: handleSplitHorizontal,
    closePane: handleClosePane,
    navigateFocus,
  };
}
```

- [ ] **Step 2: Integrate pane split hook in App**

Modify: `src/App.tsx`

Add import:
```typescript
import { usePaneSplit } from './hooks/usePaneSplit';
```

Add inside App component:
```typescript
// Register pane split shortcuts
usePaneSplit();
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePaneSplit.ts src/App.tsx
git commit -m "feat(hooks): add usePaneSplit for keyboard shortcuts

- Cmd+D: split vertically
- Cmd+Shift+D: split horizontally
- Cmd+W: close focused pane
- Cmd+Alt+Arrow: navigate between panes
- Integrated in App.tsx"
```

---

## Task 7: Integrate PaneContainer into App

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/state/tabsStore.ts`

- [ ] **Step 1: Replace Terminal with PaneContainer in App**

Modify: `src/App.tsx`

Find the section that renders Terminal and replace with:

```typescript
import { PaneContainer } from './components/PaneContainer';
import { usePanesStore } from './state/panesStore';

// Inside the tab content rendering section:
const activeTab = tabs[activeTabIndex];
const layout = usePanesStore(s => 
  activeTab ? s.layoutsByTab.get(activeTab.id) : null
);
const loadLayoutForTab = usePanesStore(s => s.loadLayoutForTab);
const initializeLayout = usePanesStore(s => s.initializeLayout);

// Load layout when tab changes
useEffect(() => {
  if (activeTab && !layout) {
    loadLayoutForTab(activeTab.id);
  }
}, [activeTab, layout, loadLayoutForTab]);

// Render pane container
{activeTab && layout && (
  <PaneContainer
    node={layout}
    shell={activeTab.shell_cmd}
    cwd={activeTab.cwd}
  />
)}
```

- [ ] **Step 2: Update tabsStore to support pane layouts**

Modify: `src/state/tabsStore.ts`

Add field to Tab interface:
```typescript
export interface Tab {
  id: string;
  title: string;
  shell_cmd: string;
  cwd: string;
  created_at: number;
  hasPanes?: boolean; // Flag for split panes
}
```

- [ ] **Step 3: Test the integration**

Run: `npm run tauri dev`

Test:
1. Open app
2. Press Cmd+D to split vertically
3. Press Cmd+Shift+D to split horizontally
4. Click panes to focus (border should highlight)
5. Drag handles to resize
6. Press Cmd+W to close pane
7. Press Cmd+Alt+Arrow to navigate

Expected: All pane operations work smoothly

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/state/tabsStore.ts
git commit -m "feat(app): integrate PaneContainer for split pane support

- Replace single Terminal with PaneContainer
- Load pane layout when tab activates
- Initialize default single-pane layout
- Support pane flag in Tab interface"
```

---

## Task 8: TabBar Split Buttons

**Files:**
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/TabBar.css`

- [ ] **Step 1: Add split buttons to TabBar**

Modify: `src/components/TabBar.tsx`

Add import:
```typescript
import { usePanesStore } from '../state/panesStore';
```

Add split buttons after tab list:
```typescript
const focusedPaneId = usePanesStore(s => s.focusedPaneId);
const splitPane = usePanesStore(s => s.splitPane);

// Add button group
<div className="tab-actions">
  <button
    className="tab-action-btn"
    onClick={() => focusedPaneId && splitPane(focusedPaneId, 'vertical')}
    title="Split Vertically (Cmd+D)"
    disabled={!focusedPaneId}
  >
    ⬌
  </button>
  <button
    className="tab-action-btn"
    onClick={() => focusedPaneId && splitPane(focusedPaneId, 'horizontal')}
    title="Split Horizontally (Cmd+Shift+D)"
    disabled={!focusedPaneId}
  >
    ⬍
  </button>
</div>
```

- [ ] **Step 2: Add styles for split buttons**

Modify: `src/components/TabBar.css`

```css
.tab-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
  padding-right: 8px;
}

.tab-action-btn {
  background: transparent;
  border: 1px solid #3a3a3a;
  color: #888;
  font-size: 16px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-action-btn:hover:not(:disabled) {
  background: #2a2a2a;
  border-color: #4a90e2;
  color: #4a90e2;
}

.tab-action-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/TabBar.tsx src/components/TabBar.css
git commit -m "feat(ui): add split pane buttons to TabBar

- Vertical split button (⬌)
- Horizontal split button (⬍)
- Disabled when no focused pane
- Tooltips show keyboard shortcuts"
```

---

## Task 9: Documentation and Testing

**Files:**
- Create: `docs/SPLIT_PANES.md`
- Update: `docs/USER_GUIDE.md`
- Update: `docs/ARCHITECTURE.md`
- Update: `README.md`

- [ ] **Step 1: Create split panes documentation**

Create: `docs/SPLIT_PANES.md`

```markdown
# Split Panes

Split panes allow you to view multiple terminals side-by-side within a single tab, each with its own independent PTY session.

## Features

- **Horizontal and Vertical Splits**: Organize terminals in any layout
- **Independent PTYs**: Each pane has its own shell process
- **Drag to Resize**: Resize panes by dragging the handles between them
- **Focus Management**: Click to focus, visual border indicator
- **Keyboard Navigation**: Move focus between panes without mouse
- **Layout Persistence**: Pane arrangements saved across app restarts
- **Works with Both Modes**: Terminal and Blocks modes both supported

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+D` | Split current pane vertically |
| `Cmd+Shift+D` | Split current pane horizontally |
| `Cmd+W` | Close focused pane |
| `Cmd+Alt+↑` | Focus pane above |
| `Cmd+Alt+↓` | Focus pane below |
| `Cmd+Alt+←` | Focus pane to the left |
| `Cmd+Alt+→` | Focus pane to the right |

## Usage

### Creating Splits

1. **Click a pane** to focus it (blue border appears)
2. **Press Cmd+D** for vertical split, or **Cmd+Shift+D** for horizontal split
3. New pane appears with a fresh terminal session
4. Repeat to create complex layouts

### Resizing Panes

1. **Hover over the divider** between two panes
2. Divider highlights blue
3. **Click and drag** to resize
4. Both panes adjust proportionally
5. Minimum size: 200px to prevent unusable panes

### Closing Panes

1. **Click the pane** you want to close
2. **Press Cmd+W**
3. Remaining panes automatically rebalance
4. Last pane cannot be closed (becomes single-pane layout)

### Navigation

Use **Cmd+Alt+Arrow** keys to move focus between panes without touching the mouse. This is especially useful when working across multiple sessions.

## Use Cases

### Side-by-Side Comparison
```
┌────────────┬────────────┐
│            │            │
│  Local     │   SSH      │
│  Dev       │   Prod     │
│            │            │
└────────────┴────────────┘
```
Split vertically to compare local and remote environments.

### Monitoring Multiple Servers
```
┌────────────┬────────────┐
│  Server 1  │  Server 2  │
├────────────┼────────────┤
│  Server 3  │  Server 4  │
└────────────┴────────────┘
```
Create a grid to monitor logs from multiple servers simultaneously.

### Development + Documentation
```
┌──────────────────────────┐
│                          │
│  Code Editor (vim)       │
│                          │
├──────────────────────────┤
│  Test Runner / Logs      │
└──────────────────────────┘
```
Horizontal split for code on top, output below.

## Architecture

### Layout Tree Structure

Pane layouts are represented as a recursive tree:

```typescript
type PaneNode = PaneLeaf | PaneSplit;

type PaneLeaf = {
  type: 'leaf';
  id: string;
  terminalId: string;
  size: number; // Percentage
};

type PaneSplit = {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: PaneNode[];
};
```

Each split can contain more splits, allowing arbitrarily complex layouts.

### Persistence

Layouts are saved to SQLite as JSON:

```sql
CREATE TABLE pane_layouts (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
```

When you switch tabs or restart the app, layouts are restored exactly as you left them.

## Performance

- **Memory**: Each pane has its own PTY (~2MB per pane)
- **Recommended Maximum**: 4-6 panes per tab for smooth performance
- **Resize**: Debounced to prevent excessive re-renders

## Limitations

- No synchronized input (Phase 3)
- No pane zoom/maximize (Phase 3)
- No drag-and-drop reordering (Phase 3)
- No saved layout templates (Phase 4)

## Troubleshooting

**Pane won't split**: Make sure a pane is focused (blue border). Click it first, then press split shortcut.

**Can't resize pane**: Minimum size is 200px. If a pane is already at minimum, it can't shrink further.

**Focus indicator missing**: Check that you've clicked the pane. Focus management requires explicit click or keyboard navigation.

**Layout not restored**: Layout persistence requires tab ID to match. If you close and recreate a tab, it gets a new ID and starts with default single-pane layout.
```

- [ ] **Step 2: Update USER_GUIDE.md**

Modify: `docs/USER_GUIDE.md`

Add section after "Command Palette":

```markdown
## Split Panes

Create multiple terminal views within a single tab for side-by-side work:

### Quick Start
- **Cmd+D**: Split vertically (new pane on right)
- **Cmd+Shift+D**: Split horizontally (new pane below)
- **Cmd+W**: Close focused pane
- **Click pane**: Focus it (blue border)
- **Drag divider**: Resize panes

### Navigation
- **Cmd+Alt+Arrow keys**: Move focus between panes
- **Click**: Direct focus

See [SPLIT_PANES.md](SPLIT_PANES.md) for detailed usage and examples.
```

- [ ] **Step 3: Update ARCHITECTURE.md**

Modify: `docs/ARCHITECTURE.md`

Add section after "Command Blocks Architecture":

```markdown
### Split Panes Architecture

Pane layouts use a recursive tree structure where each node is either:
- **Leaf**: Contains a Terminal component with its own PTY
- **Split**: Contains 2+ children arranged horizontally or vertically

**Data Structure:**
```typescript
type PaneNode = {
  type: 'leaf' | 'split';
  id: string;
  size: number; // Percentage
  children?: PaneNode[]; // Only for split type
  direction?: 'horizontal' | 'vertical'; // Only for split type
  terminalId?: string; // Only for leaf type
}
```

**State Flow:**
```
User Action (split/close/resize)
  ↓
panesStore.ts (Zustand)
  ↓
Layout Tree Mutation
  ↓
PaneContainer Re-render (recursive)
  ↓
Tauri Command (persist to SQLite)
```

**Component Hierarchy:**
```
App.tsx
  └─ PaneContainer (recursive)
       ├─ Pane (leaf) → Terminal
       │    └─ PTY Session
       ├─ PaneHandle (resize)
       └─ PaneContainer (split)
            └─ [recurse...]
```

Each pane gets its own Terminal component which spawns an independent PTY process. This allows simultaneous interactive sessions without interference.
```

- [ ] **Step 4: Update README.md**

Modify: `README.md`

Update "Key Features" section to add:

```markdown
- **Split Panes**: View multiple terminals side-by-side
  - Horizontal and vertical splits with drag-to-resize
  - Independent PTY per pane
  - Keyboard navigation (Cmd+Alt+Arrows)
  - Layout persistence across restarts
  - Works with both Terminal and Blocks modes
```

- [ ] **Step 5: Commit**

```bash
git add docs/SPLIT_PANES.md docs/USER_GUIDE.md docs/ARCHITECTURE.md README.md
git commit -m "docs: add comprehensive split panes documentation

- New SPLIT_PANES.md with usage guide and examples
- Updated USER_GUIDE.md with quick reference
- Updated ARCHITECTURE.md with tree structure explanation
- Updated README.md with feature highlight"
```

---

## Task 10: Manual Testing and Polish

**Files:**
- Create: `docs/manual-tests/split-panes-test-checklist.md`

- [ ] **Step 1: Create manual test checklist**

Create: `docs/manual-tests/split-panes-test-checklist.md`

```markdown
# Split Panes Manual Test Checklist

## Basic Operations

- [ ] **Single pane starts correctly**
  - Open app → single pane with terminal
  - Blue focus border visible
  - Terminal accepts input

- [ ] **Vertical split (Cmd+D)**
  - Press Cmd+D → new pane appears on right
  - Both panes 50/50 width
  - Right pane is focused (blue border)
  - Can type in both panes independently

- [ ] **Horizontal split (Cmd+Shift+D)**
  - Press Cmd+Shift+D → new pane appears below
  - Both panes 50/50 height
  - Bottom pane is focused
  - Can type in both panes independently

## Resizing

- [ ] **Drag vertical divider**
  - Hover over divider → cursor changes to ew-resize
  - Drag left/right → panes resize proportionally
  - Release → sizes persist
  - Minimum size enforced (200px)

- [ ] **Drag horizontal divider**
  - Hover over divider → cursor changes to ns-resize
  - Drag up/down → panes resize proportionally
  - Release → sizes persist

## Focus Management

- [ ] **Click to focus**
  - Click pane → blue border appears
  - Other panes lose focus (gray border)
  - Keyboard input goes to focused pane

- [ ] **Keyboard navigation**
  - Cmd+Alt+→ → focus moves right
  - Cmd+Alt+← → focus moves left
  - Cmd+Alt+↓ → focus moves down
  - Cmd+Alt+↑ → focus moves up

## Closing Panes

- [ ] **Close pane (Cmd+W)**
  - Focus a pane, press Cmd+W → pane closes
  - Remaining panes rebalance to fill space
  - Focus moves to remaining pane

- [ ] **Close all but one**
  - Keep closing panes until one remains
  - Single pane fills entire space
  - Cannot close last pane

## Complex Layouts

- [ ] **Nested splits**
  - Create 2x2 grid:
    1. Start with 1 pane
    2. Cmd+D → 2 panes (left, right)
    3. Focus left, Cmd+Shift+D → split left vertically
    4. Focus right, Cmd+Shift+D → split right vertically
    5. Result: 4 panes in 2x2 grid

- [ ] **Asymmetric layout**
  - Create: one large left pane, two small right panes
  - Verify resize handles work at each level

## Persistence

- [ ] **Layout persists on tab switch**
  - Create split layout
  - Switch to another tab
  - Switch back → layout restored

- [ ] **Layout persists on app restart**
  - Create split layout
  - Quit app
  - Reopen app → layout restored with correct sizes

## Integration with Existing Features

- [ ] **Terminal mode in panes**
  - Create split → both use Terminal mode
  - SSH works in both panes
  - Interactive commands (vim, top) work

- [ ] **Blocks mode in panes**
  - Toggle to Blocks mode → works in focused pane
  - Each pane can independently use Terminal or Blocks mode

- [ ] **Command palette (Cmd+K)**
  - Open palette → works regardless of split state
  - Execute command → goes to focused pane

## Edge Cases

- [ ] **Rapid splits**
  - Press Cmd+D multiple times quickly
  - App doesn't crash
  - All panes render correctly

- [ ] **Resize to minimum**
  - Drag divider to squeeze pane to 200px
  - Cannot resize smaller
  - Terminal remains functional

- [ ] **Close pane with active process**
  - Start long-running command in pane
  - Close pane → process terminates gracefully
  - No zombie processes

## Performance

- [ ] **4 panes**
  - Create 4 panes
  - All panes responsive
  - No lag when typing

- [ ] **6 panes** (stress test)
  - Create 6 panes
  - May be slower but still functional
  - No crashes

## Visual Polish

- [ ] **Focus border distinct**
  - Focused pane has bright blue border
  - Unfocused panes have dim gray border
  - Easy to see which pane is active

- [ ] **Handle hover feedback**
  - Hover over handle → changes color
  - Visual feedback before drag
  - Cursor changes appropriately

- [ ] **Smooth resize**
  - Drag handle → panes resize smoothly
  - No flickering or jumps
  - Terminal re-renders cleanly
```

- [ ] **Step 2: Execute manual tests**

Run through entire checklist and document any issues found.

- [ ] **Step 3: Fix any critical issues**

If tests reveal bugs:
- Create fix commits
- Re-test
- Update checklist with results

- [ ] **Step 4: Commit test results**

```bash
git add docs/manual-tests/split-panes-test-checklist.md
git commit -m "test: add split panes manual test checklist

- 40+ test scenarios covering all features
- Basic operations, resizing, focus, closing
- Complex layouts and edge cases
- Performance and visual polish checks"
```

---

## Implementation Complete! 🎉

Phase 2 (Split Panes) is now complete.

**What we built:**
✅ Database schema for pane layout persistence
✅ Zustand store with recursive tree structure
✅ Tauri commands for layout CRUD operations
✅ Pane and PaneHandle components with focus and resize
✅ Recursive PaneContainer for arbitrarily complex layouts
✅ Keyboard shortcuts for split, close, navigate
✅ TabBar split buttons with visual feedback
✅ Integration with existing Terminal and Blocks modes
✅ Layout persistence across tab switches and app restarts
✅ Comprehensive documentation and manual tests

**Next Steps:**
- Complete manual testing checklist
- Fix any issues discovered during testing
- Gather user feedback on split pane workflows
- Then proceed to Phase 3: Advanced Pane Features
  - Synchronized input across panes
  - Pane zoom/maximize
  - Drag-and-drop reordering

**Phase 3 Preview:**
- Broadcast input to multiple panes simultaneously
- Maximize pane to full tab (and restore)
- Drag panes to reorder within layout
- Copy layout to new tab

---

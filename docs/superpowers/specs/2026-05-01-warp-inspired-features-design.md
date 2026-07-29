# Warp-Inspired Features Design

**Date:** 2026-05-01  
**Status:** Design Review  
**Implementation Approach:** Progressive Enhancement (4 phases)

## Executive Summary

This design adds four major feature sets to CCIE Terminal, inspired by Warp's modern terminal experience:

1. **Command Blocks + Command Palette** (3-4 weeks) - Transform terminal from continuous scroll to discrete, manageable command units with universal search/action launcher
2. **Split Panes** (1-2 weeks) - Multiple terminal panes within a single tab
3. **Code Editor Integration** (5-7 weeks) - Full Monaco-based IDE with LSP support for Python, JSON, YAML, Terraform, and Ansible
4. **Scheduled Agents** (2-3 weeks) - Time-based, event-driven, and conditional automation using existing agent infrastructure

**Total estimated time:** 11-14 weeks

**Key architectural decision:** Hybrid terminal approach - command blocks are React components with embedded xterm.js instances, not overlays. This enables richer interactions, better AI integration, and smoother path to IDE features.

---

## Phase 1: Command Blocks + Command Palette

### Problem Statement

Current terminal is continuous xterm.js scrollback. Users can't:
- Easily find/rerun previous commands
- Collapse long outputs
- Share specific command results
- Navigate between distinct operations
- Quick-access common actions

### Solution Overview

Transform terminal into block-based UI where each command execution is a discrete, manageable unit. Add universal command palette (Cmd+K) for fuzzy-search access to commands, skills, MCP tools, and actions.

### Command Blocks Architecture

#### Data Model

```sql
CREATE TABLE command_blocks (
    id TEXT PRIMARY KEY,
    tab_id TEXT NOT NULL,
    pane_id TEXT, -- NULL initially, added in Phase 2
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    duration_ms INTEGER,
    exit_code INTEGER,
    output TEXT NOT NULL, -- Raw terminal output
    output_line_count INTEGER,
    is_bookmarked BOOLEAN DEFAULT 0,
    ai_analysis TEXT, -- Optional AI error analysis
    FOREIGN KEY (tab_id) REFERENCES tabs(id),
    FOREIGN KEY (pane_id) REFERENCES panes(id)
);

CREATE INDEX idx_blocks_tab ON command_blocks(tab_id);
CREATE INDEX idx_blocks_bookmark ON command_blocks(is_bookmarked) WHERE is_bookmarked = 1;
CREATE INDEX idx_blocks_timestamp ON command_blocks(timestamp DESC);
```

#### State Management (Zustand)

```typescript
interface Block {
  id: string;
  tabId: string;
  paneId?: string; // Added in Phase 2
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
  addBlock(tabId: string, command: string, cwd: string): string;
  completeBlock(blockId: string, exitCode: number, durationMs: number, output: string): void;
  toggleCollapse(blockId: string): void;
  toggleBookmark(blockId: string): void;
  deleteBlock(blockId: string): void;
  rerunBlock(blockId: string): void; // Creates new block with same command
  
  // Persistence
  loadBlocksForTab(tabId: string): Promise<void>;
  syncBlockToDb(block: Block): Promise<void>;
}
```

#### Component Structure

**Hybrid Terminal Design:**

Instead of overlaying headers on continuous xterm.js, we break terminal into React components:

```tsx
<TerminalView tabId={currentTab}>
  {blocks.map(block => (
    <CommandBlock 
      key={block.id}
      block={block}
      active={block.id === activeBlockId}
      onToggleCollapse={() => toggleCollapse(block.id)}
      onRerun={() => rerunBlock(block.id)}
      onBookmark={() => toggleBookmark(block.id)}
    />
  ))}
</TerminalView>

// CommandBlock component
function CommandBlock({ block, active, onToggleCollapse, onRerun, onBookmark }) {
  return (
    <div className="command-block" data-block-id={block.id}>
      <BlockHeader
        command={block.command}
        exitCode={block.exitCode}
        duration={block.durationMs}
        timestamp={block.timestamp}
        bookmarked={block.bookmarked}
        collapsed={block.collapsed}
        onToggleCollapse={onToggleCollapse}
      >
        <BlockActions>
          <button onClick={onRerun} title="Rerun command">↻</button>
          <button onClick={onBookmark} title="Bookmark">★</button>
          <button onClick={() => copyToClipboard(block.output)}>📋</button>
          <button onClick={() => shareBlock(block.id)}>↗</button>
        </BlockActions>
      </BlockHeader>
      
      <BlockOutput collapsed={block.collapsed}>
        {active ? (
          // Active block: interactive xterm
          <XtermTerminal 
            ptyId={block.paneId || block.tabId}
            onData={(data) => writeToPty(data)}
            interactive
          />
        ) : block.collapsed ? (
          // Collapsed: show nothing or summary line
          <div className="output-collapsed">
            {block.outputLineCount} lines (click to expand)
          </div>
        ) : (
          // Completed block: render as text or readonly xterm
          <pre className="output-text">{block.output}</pre>
          // Alternative for large outputs:
          // <XtermTerminal buffer={block.output} readonly />
        )}
      </BlockOutput>
      
      {block.aiAnalysis && (
        <AIAnalysisBanner>
          <MarkdownRenderer content={block.aiAnalysis} />
        </AIAnalysisBanner>
      )}
    </div>
  );
}
```

**Why hybrid over overlay:**
- ✅ Smooth collapse/expand animations
- ✅ Easy to add rich UI elements (badges, buttons, AI analysis)
- ✅ Clean copy/paste without escape sequences
- ✅ Virtualization for performance (render only visible blocks)
- ✅ Search result highlighting within blocks
- ✅ Foundation for split panes (each pane has its own block list)
- ❌ More refactoring than overlay approach
- ❌ Slightly more complex state management

#### Shell Integration

Enhance existing OSC 133 sequences to emit block boundaries:

**zsh configuration:**

```bash
# ~/.zshrc additions for CCIE Terminal

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
```

**bash configuration:**

```bash
# ~/.bashrc additions for CCIE Terminal

__ccie_prompt_command() {
  local exit_code=$?
  printf '\e]133;D;%s\a' "$exit_code"
  printf '\e]133;A\a'
}

__ccie_preexec() {
  printf '\e]133;C\a'
  printf '\e]133;E;%s\a' "$BASH_COMMAND"
}

PROMPT_COMMAND="__ccie_prompt_command"
trap '__ccie_preexec' DEBUG
```

**PTY Parser (Rust):**

Update `src-tauri/src/pty/parser.rs` to detect sequences:

```rust
pub enum ShellEvent {
    PromptStart,
    CommandStart,
    CommandText(String),
    CommandEnd(i32), // exit code
}

impl PtyParser {
    pub fn parse_osc_sequence(&mut self, sequence: &str) -> Option<ShellEvent> {
        if sequence.starts_with("133;A") {
            return Some(ShellEvent::PromptStart);
        }
        if sequence.starts_with("133;C") {
            return Some(ShellEvent::CommandStart);
        }
        if let Some(cmd) = sequence.strip_prefix("133;E;") {
            return Some(ShellEvent::CommandText(cmd.to_string()));
        }
        if let Some(code) = sequence.strip_prefix("133;D;") {
            if let Ok(exit_code) = code.parse::<i32>() {
                return Some(ShellEvent::CommandEnd(exit_code));
            }
        }
        None
    }
}
```

**Event Flow:**

1. User types command → enters
2. Shell's `preexec` fires → sends OSC 133;C + 133;E
3. PTY parser detects → emits Tauri event `shell-command-start`
4. Frontend receives event → calls `addBlock(tabId, command, cwd)`
5. Command executes, output streams to active block's xterm
6. Shell's `precmd` fires → sends OSC 133;D with exit code
7. PTY parser detects → emits `shell-command-end` event
8. Frontend calls `completeBlock(blockId, exitCode, durationMs, output)`
9. Block becomes inactive, xterm instance switches to text rendering

#### Performance Considerations

**Virtualization:**

For tabs with 100+ blocks:

```tsx
import { FixedSizeList } from 'react-window';

function VirtualizedBlockList({ blocks, activeBlockId }) {
  const blockHeight = 120; // Collapsed block height
  
  return (
    <FixedSizeList
      height={windowHeight}
      itemCount={blocks.length}
      itemSize={(index) => {
        const block = blocks[index];
        if (block.collapsed) return blockHeight;
        if (block.id === activeBlockId) return 400; // Active terminal
        return block.outputLineCount * 20 + blockHeight; // Estimate
      }}
    >
      {({ index, style }) => (
        <div style={style}>
          <CommandBlock block={blocks[index]} />
        </div>
      )}
    </FixedSizeList>
  );
}
```

**Output Storage Strategy:**

- Outputs < 1MB: Store in SQLite TEXT column
- Outputs > 1MB: Store in separate file `~/.config/ccie-terminal/blocks/{block_id}.txt`, reference path in DB
- Very old blocks (>30 days): Compress with gzip

**Memory Management:**

- Keep last 50 blocks fully in memory
- Older blocks: lazy-load output from DB on expand
- Active block: always in memory with live xterm

---

### Command Palette

#### UI Design

**Trigger:** `Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux)

**Modal overlay:**

```
┌──────────────────────────────────────────────────┐
│ ⌘K  Type to search commands, skills, tools...   │
├──────────────────────────────────────────────────┤
│                                                   │
│ 📋 Recent Commands                               │
│ → ssh router1.lab.local                          │
│ → ansible-playbook site.yml -i inventory        │
│ → terraform apply                                │
│                                                   │
│ ⭐ Bookmarked                                    │
│ → show ip interface brief | grep down           │
│                                                   │
│ 🤖 Skills                                        │
│ → Device Health Check                            │
│ → Config Backup                                  │
│ → Parse Show Commands                            │
│                                                   │
│ 🔧 MCP Tools                                     │
│ → fetch_url (web-search)                         │
│ → read_file (filesystem)                         │
│                                                   │
│ ⚙️  Actions                                      │
│ → Split Pane Horizontally                        │
│ → New Tab                                        │
│ → Search History                                 │
│ → Open Settings                                  │
│                                                   │
└──────────────────────────────────────────────────┘
```

**Keyboard navigation:**
- ↑/↓ to move selection
- Enter to execute
- Tab to cycle categories
- Esc to close

#### Data Sources

1. **Recent Commands** - Query `command_blocks` table:
   ```sql
   SELECT DISTINCT command, MAX(timestamp) as last_used
   FROM command_blocks
   WHERE tab_id = ?
   ORDER BY last_used DESC
   LIMIT 20
   ```

2. **Bookmarked Blocks** - Filter bookmarked:
   ```sql
   SELECT command, timestamp
   FROM command_blocks
   WHERE is_bookmarked = 1
   ORDER BY timestamp DESC
   ```

3. **Skills** - Load from existing skills system

4. **MCP Tools** - Query connected MCP servers

5. **Actions** - Hardcoded list:
   - Split Pane Horizontally (Cmd+D)
   - Split Pane Vertically (Cmd+Shift+D)
   - Close Pane (Cmd+W)
   - New Tab (Cmd+T)
   - Search History (Cmd+F)
   - Open Settings (Cmd+,)
   - Toggle Agent Panel
   - Toggle Editor Panel

#### Fuzzy Search

Use `fuse.js` for fuzzy matching:

```typescript
import Fuse from 'fuse.js';

interface PaletteItem {
  type: 'command' | 'skill' | 'tool' | 'action' | 'bookmark';
  title: string;
  subtitle?: string;
  icon: string;
  action: () => void | Promise<void>;
}

const fuseOptions = {
  keys: ['title', 'subtitle'],
  threshold: 0.3, // 0 = exact match, 1 = match anything
  includeScore: true,
};

function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  useEffect(() => {
    // Load all items
    const allItems = [
      ...loadRecentCommands(),
      ...loadBookmarkedBlocks(),
      ...loadSkills(),
      ...loadMcpTools(),
      ...loadActions(),
    ];
    setItems(allItems);
  }, []);
  
  const fuse = useMemo(() => new Fuse(items, fuseOptions), [items]);
  
  const filteredItems = useMemo(() => {
    if (!query) return items;
    return fuse.search(query).map(result => result.item);
  }, [query, fuse, items]);
  
  const handleExecute = () => {
    const item = filteredItems[selectedIndex];
    item.action();
    onClose();
  };
  
  return (
    <Modal open={open} onClose={onClose}>
      <PaletteSearch
        value={query}
        onChange={setQuery}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setSelectedIndex(i => Math.min(i + 1, filteredItems.length - 1));
          if (e.key === 'ArrowUp') setSelectedIndex(i => Math.max(i - 1, 0));
          if (e.key === 'Enter') handleExecute();
        }}
      />
      <PaletteResults>
        {filteredItems.map((item, index) => (
          <PaletteItem
            key={index}
            selected={index === selectedIndex}
            onClick={() => { setSelectedIndex(index); handleExecute(); }}
          >
            <Icon>{item.icon}</Icon>
            <ItemContent>
              <Title>{item.title}</Title>
              {item.subtitle && <Subtitle>{item.subtitle}</Subtitle>}
            </ItemContent>
          </PaletteItem>
        ))}
      </PaletteResults>
    </Modal>
  );
}
```

#### Command Palette Actions

**Command execution:**
- Inserts command into active block
- Can optionally auto-execute (with user preference)

**Skill/MCP tool invocation:**
- Opens agent panel
- Pre-fills with skill/tool invocation

**Navigation actions:**
- Execute directly (create pane, new tab, etc.)

---

## Phase 2: Split Panes

### Problem Statement

Users often need multiple terminals visible simultaneously:
- Monitor logs while running commands
- Compare outputs side-by-side
- Work in different directories concurrently

### Solution Overview

Enable splitting a single tab into multiple panes (horizontal or vertical), each with independent PTY and command blocks.

### Layout Model

Tree-based layout (like tmux/VS Code):

```typescript
type PaneLayout = 
  | { type: 'leaf'; pane: Pane }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; left: PaneLayout; right: PaneLayout };

interface Pane {
  id: string;
  ptyId: string; // Each pane has own PTY
  blocks: Block[];
  cwd: string;
  env: Record<string, string>;
}

interface Tab {
  id: string;
  title: string;
  layout: PaneLayout;
  activePaneId: string;
}
```

**Example layouts:**

```
Single:              Two vertical:        Three mixed:
┌────────────┐      ┌──────┬──────┐      ┌──────┬──────┐
│            │      │      │      │      │      │  B   │
│     A      │      │   A  │   B  │      │   A  ├──────┤
│            │      │      │      │      │      │  C   │
└────────────┘      └──────┴──────┘      └──────┴──────┘

Layout tree:         Layout tree:         Layout tree:
{ type: 'leaf',      { type: 'split',     { type: 'split',
  pane: A }            direction: 'v',      direction: 'h',
                       ratio: 0.5,          ratio: 0.5,
                       left: A,             left: A,
                       right: B }           right: {
                                              type: 'split',
                                              direction: 'v',
                                              ratio: 0.5,
                                              left: B,
                                              right: C
                                            }
                                          }
```

### Actions

**Split operations:**

```typescript
function splitPane(
  layout: PaneLayout,
  paneId: string,
  direction: 'horizontal' | 'vertical'
): PaneLayout {
  if (layout.type === 'leaf' && layout.pane.id === paneId) {
    // Split this pane
    const newPane = createPane({ shell: layout.pane.shell, cwd: layout.pane.cwd });
    return {
      type: 'split',
      direction,
      ratio: 0.5,
      left: layout,
      right: { type: 'leaf', pane: newPane }
    };
  }
  
  if (layout.type === 'split') {
    // Recurse into children
    return {
      ...layout,
      left: splitPane(layout.left, paneId, direction),
      right: splitPane(layout.right, paneId, direction),
    };
  }
  
  return layout;
}

function closePane(layout: PaneLayout, paneId: string): PaneLayout | null {
  if (layout.type === 'leaf') {
    return layout.pane.id === paneId ? null : layout;
  }
  
  const left = closePane(layout.left, paneId);
  const right = closePane(layout.right, paneId);
  
  // If one child was closed, promote the other
  if (!left) return right;
  if (!right) return left;
  
  return { ...layout, left, right };
}
```

**Keyboard shortcuts:**
- `Cmd+D` - Split horizontally (left/right)
- `Cmd+Shift+D` - Split vertically (top/bottom)
- `Cmd+W` - Close current pane
- `Cmd+[` / `Cmd+]` - Navigate between panes
- `Cmd+Shift+F` - Maximize current pane (toggle)

**Synchronized input (optional feature):**

Checkbox in UI: "Sync input across panes"

When enabled, typing in one pane broadcasts to all panes in current tab:

```typescript
function handlePaneInput(paneId: string, data: string) {
  const tab = getCurrentTab();
  
  if (tab.syncInput) {
    // Send to all panes
    for (const pane of getAllPanes(tab.layout)) {
      writeToPty(pane.ptyId, data);
    }
  } else {
    // Send only to active pane
    writeToPty(paneId, data);
  }
}
```

### Tauri PTY Management Updates

**New commands:**

```rust
#[tauri::command]
async fn pane_new(
    state: State<'_, AppState>,
    shell: String,
    cwd: String,
    env: HashMap<String, String>,
) -> Result<String, String> {
    let pty_manager = state.pty_manager.lock().unwrap();
    let pane_id = uuid::Uuid::new_v4().to_string();
    
    let pty = pty_manager.spawn_pty(&shell, &cwd, env)?;
    
    Ok(pane_id)
}

#[tauri::command]
async fn pane_close(
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<(), String> {
    let pty_manager = state.pty_manager.lock().unwrap();
    pty_manager.close_pty(&pane_id)?;
    Ok(())
}

// Existing commands now need pane_id parameter
#[tauri::command]
async fn pty_write(
    state: State<'_, AppState>,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    // ... existing logic but use pane_id
}

#[tauri::command]
async fn pty_resize(
    state: State<'_, AppState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // ... existing logic but use pane_id
}
```

### React Component Structure

**Recursive pane renderer:**

```tsx
function PaneLayoutView({ 
  layout, 
  activePaneId, 
  onSplit, 
  onClose, 
  onActivate 
}: PaneLayoutProps) {
  if (layout.type === 'leaf') {
    return (
      <PaneView
        pane={layout.pane}
        active={activePaneId === layout.pane.id}
        onActivate={() => onActivate(layout.pane.id)}
        onSplit={(direction) => onSplit(layout.pane.id, direction)}
        onClose={() => onClose(layout.pane.id)}
      />
    );
  }
  
  const [ratio, setRatio] = useState(layout.ratio);
  const containerRef = useRef<HTMLDivElement>(null);
  
  return (
    <SplitContainer
      ref={containerRef}
      direction={layout.direction}
      ratio={ratio}
    >
      <PaneLayoutView
        layout={layout.left}
        activePaneId={activePaneId}
        onSplit={onSplit}
        onClose={onClose}
        onActivate={onActivate}
      />
      
      <ResizeHandle
        direction={layout.direction}
        onDrag={(delta) => {
          const container = containerRef.current;
          if (!container) return;
          
          const size = layout.direction === 'horizontal' 
            ? container.offsetWidth 
            : container.offsetHeight;
          
          const newRatio = Math.max(0.2, Math.min(0.8, ratio + delta / size));
          setRatio(newRatio);
        }}
      />
      
      <PaneLayoutView
        layout={layout.right}
        activePaneId={activePaneId}
        onSplit={onSplit}
        onClose={onClose}
        onActivate={onActivate}
      />
    </SplitContainer>
  );
}

function PaneView({ pane, active, onActivate, onSplit, onClose }: PaneViewProps) {
  return (
    <div 
      className={`pane ${active ? 'active' : ''}`}
      onClick={onActivate}
    >
      <PaneToolbar>
        <PanePath>{pane.cwd}</PanePath>
        <PaneActions>
          <button onClick={() => onSplit('horizontal')}>⫽</button>
          <button onClick={() => onSplit('vertical')}>⫼</button>
          <button onClick={onClose}>✕</button>
        </PaneActions>
      </PaneToolbar>
      
      <TerminalView 
        paneId={pane.id}
        blocks={pane.blocks}
        active={active}
      />
    </div>
  );
}
```

### Data Persistence

**Store layout in sessions DB:**

```sql
ALTER TABLE tabs ADD COLUMN layout TEXT; -- JSON serialized PaneLayout

UPDATE tabs 
SET layout = json_object('type', 'leaf', 'pane', json_object('id', pty_id))
WHERE layout IS NULL;
```

When restoring session:
1. Deserialize `layout` JSON
2. Recursively create PTYs for each pane
3. Restore blocks for each pane from `command_blocks` table

---

## Phase 3: Code Editor Integration

### Problem Statement

Network engineers frequently edit:
- Python scripts (automation, parsing)
- Ansible playbooks (YAML)
- Terraform configs (.tf files)
- JSON configs (device configs, API responses)
- Jinja2 templates

Switching to external editor breaks flow. Need integrated editor with:
- Syntax highlighting
- Autocomplete
- Error checking
- File tree navigation
- Git awareness

### Solution Overview

Integrate Monaco Editor (VS Code's editor) with LSP support for Python, YAML, JSON. Add file tree panel, basic Git integration. Editor is peer view to terminal (users switch between them).

### Architecture

**New panel mode:**

```
Current:  [Terminal] [Agent] [Search] [Skills]
Updated:  [Terminal] [Editor] [Agent] [Search] [Skills]
```

**Editor panel layout:**

```
┌──────────┬────────────────────────┬───────────┐
│          │                        │           │
│  File    │   Monaco Editor        │  Outline  │
│  Tree    │   (active file)        │  (LSP)    │
│          │                        │           │
│  📁 proj │   1 import sys         │  Classes  │
│  ├─📁 src│   2 import re          │  Methods  │
│  │ └─🐍 a│   3                    │  Vars     │
│  └─📄 .md│   4 def main():        │           │
│          │   5     ...            │           │
│          │                        │           │
└──────────┴────────────────────────┴───────────┘
```

**Resizable panels:**
- File tree: 150-400px
- Editor: flexible (takes remaining space)
- Outline: 150-300px (collapsible)

### Monaco Editor Integration

**Installation:**

```bash
bun add monaco-editor @monaco-editor/react
```

**Component:**

```tsx
import Editor, { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

function CodeEditor({ file, onChange, onSave }: CodeEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  
  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    
    // Keyboard shortcuts
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSave(file.id, editor.getValue());
    });
    
    // Configure LSP
    setupLspProviders(monaco, file.language);
  };
  
  return (
    <Editor
      height="100%"
      language={file.language}
      path={file.path} // Monaco uses path for model identity
      value={file.content}
      onChange={onChange}
      onMount={handleEditorDidMount}
      theme="vs-dark"
      options={{
        fontSize: 14,
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        formatOnPaste: true,
        formatOnType: true,
        suggestOnTriggerCharacters: true,
        quickSuggestions: true,
        parameterHints: { enabled: true },
        folding: true,
        lineNumbers: 'on',
        renderWhitespace: 'selection',
      }}
    />
  );
}
```

**Language detection:**

```typescript
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  const languageMap: Record<string, string> = {
    'py': 'python',
    'js': 'javascript',
    'ts': 'typescript',
    'jsx': 'javascript',
    'tsx': 'typescript',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'tf': 'hcl', // Terraform
    'md': 'markdown',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'toml': 'toml',
    'xml': 'xml',
    'html': 'html',
    'css': 'css',
    'j2': 'jinja', // Jinja2 templates
  };
  
  return languageMap[ext || ''] || 'plaintext';
}
```

### File Tree (Project Explorer)

**Data model:**

```typescript
interface FileNode {
  path: string; // Absolute path
  name: string; // Basename
  type: 'file' | 'directory';
  children?: FileNode[];
  isExpanded?: boolean;
  gitStatus?: 'modified' | 'untracked' | 'staged' | 'ignored';
}

interface EditorState {
  rootPath: string | null; // Project root
  fileTree: FileNode[];
  openFiles: OpenFile[];
  activeFileId: string | null;
  dirtyFiles: Set<string>; // File IDs with unsaved changes
}

interface OpenFile {
  id: string; // Unique ID for this editor instance
  path: string; // Absolute path
  content: string;
  originalContent: string; // For dirty detection
  language: string;
}
```

**Tauri commands:**

```rust
#[tauri::command]
async fn editor_open_folder(path: String) -> Result<FileNode, String> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    
    let root = build_file_tree(&path, 0)?;
    Ok(root)
}

fn build_file_tree(path: &Path, depth: usize) -> Result<FileNode, String> {
    const MAX_DEPTH: usize = 10;
    if depth > MAX_DEPTH {
        return Err("Max depth exceeded".to_string());
    }
    
    let name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    
    if path.is_file() {
        return Ok(FileNode {
            path: path.to_string_lossy().to_string(),
            name,
            type_: "file".to_string(),
            children: None,
        });
    }
    
    let mut children = Vec::new();
    let entries = std::fs::read_dir(path)
        .map_err(|e| e.to_string())?;
    
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        
        // Skip hidden files and common ignore patterns
        let file_name = entry_path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        
        if file_name.starts_with('.') 
            || file_name == "node_modules"
            || file_name == "__pycache__"
            || file_name == "target"
            || file_name == ".venv" {
            continue;
        }
        
        children.push(build_file_tree(&entry_path, depth + 1)?);
    }
    
    // Sort: directories first, then files, alphabetically
    children.sort_by(|a, b| {
        match (a.type_.as_str(), b.type_.as_str()) {
            ("directory", "file") => std::cmp::Ordering::Less,
            ("file", "directory") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    
    Ok(FileNode {
        path: path.to_string_lossy().to_string(),
        name,
        type_: "directory".to_string(),
        children: Some(children),
    })
}

#[tauri::command]
async fn editor_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
async fn editor_write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
async fn editor_create_file(path: String) -> Result<(), String> {
    // Create parent directories if needed
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    
    std::fs::write(&path, "")
        .map_err(|e| format!("Failed to create file: {}", e))
}

#[tauri::command]
async fn editor_delete_file(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if path.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    }
    .map_err(|e| format!("Failed to delete: {}", e))
}

#[tauri::command]
async fn editor_rename_file(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename: {}", e))
}
```

**File watcher:**

Watch for external changes and reload files:

```rust
use notify::{Watcher, RecursiveMode, Event};

#[tauri::command]
async fn editor_watch_folder(
    window: Window,
    path: String,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    
    let mut watcher = notify::recommended_watcher(tx)
        .map_err(|e| e.to_string())?;
    
    watcher.watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    
    tokio::spawn(async move {
        for event in rx {
            if let Ok(event) = event {
                // Emit to frontend
                window.emit("file-changed", event).ok();
            }
        }
    });
    
    Ok(())
}
```

**React file tree component:**

```tsx
function FileTree({ rootPath, onFileOpen }: FileTreeProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  
  useEffect(() => {
    if (!rootPath) return;
    
    setLoading(true);
    invoke<FileNode>('editor_open_folder', { path: rootPath })
      .then(root => setTree([root]))
      .finally(() => setLoading(false));
    
    // Setup file watcher
    invoke('editor_watch_folder', { path: rootPath });
    
    const unlisten = listen('file-changed', (event) => {
      // Refresh tree or update specific node
      console.log('File changed:', event.payload);
    });
    
    return () => { unlisten.then(fn => fn()); };
  }, [rootPath]);
  
  if (!rootPath) {
    return (
      <EmptyState>
        <button onClick={openFolder}>Open Folder</button>
      </EmptyState>
    );
  }
  
  if (loading) return <Spinner />;
  
  return (
    <TreeView>
      {tree.map(node => (
        <FileTreeNode
          key={node.path}
          node={node}
          onFileOpen={onFileOpen}
          level={0}
        />
      ))}
    </TreeView>
  );
}

function FileTreeNode({ node, onFileOpen, level }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(node.isExpanded ?? false);
  
  const handleClick = () => {
    if (node.type === 'file') {
      onFileOpen(node.path);
    } else {
      setExpanded(!expanded);
    }
  };
  
  const icon = node.type === 'directory' 
    ? (expanded ? '📂' : '📁')
    : getFileIcon(node.name);
  
  return (
    <>
      <TreeItem
        level={level}
        onClick={handleClick}
        className={node.gitStatus}
      >
        {node.type === 'directory' && (
          <ExpandArrow expanded={expanded}>▶</ExpandArrow>
        )}
        <FileIcon>{icon}</FileIcon>
        <FileName>{node.name}</FileName>
        {node.gitStatus && <GitBadge status={node.gitStatus} />}
      </TreeItem>
      
      {node.type === 'directory' && expanded && node.children && (
        node.children.map(child => (
          <FileTreeNode
            key={child.path}
            node={child}
            onFileOpen={onFileOpen}
            level={level + 1}
          />
        ))
      )}
    </>
  );
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  const iconMap: Record<string, string> = {
    'py': '🐍',
    'js': '📜',
    'ts': '📘',
    'json': '📋',
    'yaml': '⚙️',
    'yml': '⚙️',
    'md': '📝',
    'tf': '🏗️',
    'sh': '🔧',
    'toml': '⚙️',
    'lock': '🔒',
  };
  
  return iconMap[ext || ''] || '📄';
}
```

### LSP Integration

**Language Server Protocol** provides IDE features:
- Autocomplete
- Go to definition
- Hover documentation
- Error/warning diagnostics
- Symbol search
- Refactoring

**Supported languages (Phase 1):**

1. **Python** - `pylsp` (Python Language Server)
2. **YAML** - `yaml-language-server`
3. **JSON** - Built into Monaco
4. **Terraform** - `terraform-ls` (Phase 2)

**Architecture:**

```
Monaco Editor (Frontend)
    │
    ├─ LSP Client (Monaco API)
    │
    ▼ (Tauri IPC)
    │
Rust LSP Manager
    │
    ├─ Python LSP Server Process
    ├─ YAML LSP Server Process
    └─ Terraform LSP Server Process
    │
    ▼ (JSON-RPC over stdio)
    │
Language Server
```

**LSP Manager (Rust):**

```rust
// src-tauri/src/lsp/manager.rs

use serde_json::Value;
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;

pub struct LspManager {
    servers: HashMap<String, LspServer>,
    workspace_root: Option<String>,
}

struct LspServer {
    process: Child,
    stdin: ChildStdin,
    next_id: i32,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            servers: HashMap::new(),
            workspace_root: None,
        }
    }
    
    pub fn set_workspace(&mut self, root: String) {
        self.workspace_root = Some(root);
    }
    
    pub async fn start_server(&mut self, language: &str) -> Result<(), String> {
        if self.servers.contains_key(language) {
            return Ok(()); // Already running
        }
        
        let command_line = match language {
            "python" => vec!["pylsp"],
            "yaml" => vec!["yaml-language-server", "--stdio"],
            "terraform" => vec!["terraform-ls", "serve"],
            _ => return Err(format!("Unsupported language: {}", language)),
        };
        
        let mut child = Command::new(command_line[0])
            .args(&command_line[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn LSP: {}", e))?;
        
        let stdin = child.stdin.take()
            .ok_or("Failed to get stdin")?;
        
        let mut server = LspServer {
            process: child,
            stdin,
            next_id: 1,
        };
        
        // Send initialize request
        let init_params = serde_json::json!({
            "processId": std::process::id(),
            "rootUri": self.workspace_root.as_ref().map(|r| format!("file://{}", r)),
            "capabilities": {
                "textDocument": {
                    "completion": { "completionItem": { "snippetSupport": true } },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "linkSupport": true },
                    "publishDiagnostics": {}
                }
            }
        });
        
        server.send_request("initialize", init_params).await?;
        server.send_notification("initialized", serde_json::json!({})).await?;
        
        self.servers.insert(language.to_string(), server);
        Ok(())
    }
    
    pub async fn completion(
        &mut self,
        language: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Result<Value, String> {
        let server = self.get_or_start_server(language).await?;
        
        let params = serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        });
        
        server.send_request("textDocument/completion", params).await
    }
    
    pub async fn hover(
        &mut self,
        language: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Result<Value, String> {
        let server = self.get_or_start_server(language).await?;
        
        let params = serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        });
        
        server.send_request("textDocument/hover", params).await
    }
    
    pub async fn definition(
        &mut self,
        language: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Result<Value, String> {
        let server = self.get_or_start_server(language).await?;
        
        let params = serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        });
        
        server.send_request("textDocument/definition", params).await
    }
    
    pub async fn did_open(
        &mut self,
        language: &str,
        uri: &str,
        language_id: &str,
        version: i32,
        text: &str,
    ) -> Result<(), String> {
        let server = self.get_or_start_server(language).await?;
        
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": version,
                "text": text
            }
        });
        
        server.send_notification("textDocument/didOpen", params).await
    }
    
    pub async fn did_change(
        &mut self,
        language: &str,
        uri: &str,
        version: i32,
        text: &str,
    ) -> Result<(), String> {
        let server = self.get_or_start_server(language).await?;
        
        let params = serde_json::json!({
            "textDocument": { "uri": uri, "version": version },
            "contentChanges": [{ "text": text }]
        });
        
        server.send_notification("textDocument/didChange", params).await
    }
    
    async fn get_or_start_server(&mut self, language: &str) -> Result<&mut LspServer, String> {
        if !self.servers.contains_key(language) {
            self.start_server(language).await?;
        }
        
        self.servers.get_mut(language)
            .ok_or_else(|| format!("Server not found: {}", language))
    }
}

impl LspServer {
    async fn send_request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        
        self.write_message(&request).await?;
        
        // In real implementation, need to read response asynchronously
        // and match by id. Simplified here.
        Ok(serde_json::json!({}))
    }
    
    async fn send_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        
        self.write_message(&notification).await
    }
    
    async fn write_message(&mut self, msg: &Value) -> Result<(), String> {
        let content = serde_json::to_string(msg)
            .map_err(|e| e.to_string())?;
        
        let header = format!("Content-Length: {}\r\n\r\n", content.len());
        
        self.stdin.write_all(header.as_bytes()).await
            .map_err(|e| e.to_string())?;
        self.stdin.write_all(content.as_bytes()).await
            .map_err(|e| e.to_string())?;
        self.stdin.flush().await
            .map_err(|e| e.to_string())?;
        
        Ok(())
    }
}
```

**Tauri commands:**

```rust
#[tauri::command]
async fn lsp_start(
    state: State<'_, AppState>,
    language: String,
) -> Result<(), String> {
    let mut lsp = state.lsp_manager.lock().unwrap();
    lsp.start_server(&language).await
}

#[tauri::command]
async fn lsp_completion(
    state: State<'_, AppState>,
    language: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    let mut lsp = state.lsp_manager.lock().unwrap();
    lsp.completion(&language, &uri, line, character).await
}

#[tauri::command]
async fn lsp_hover(
    state: State<'_, AppState>,
    language: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    let mut lsp = state.lsp_manager.lock().unwrap();
    lsp.hover(&language, &uri, line, character).await
}

#[tauri::command]
async fn lsp_definition(
    state: State<'_, AppState>,
    language: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    let mut lsp = state.lsp_manager.lock().unwrap();
    lsp.definition(&language, &uri, line, character).await
}

#[tauri::command]
async fn lsp_did_open(
    state: State<'_, AppState>,
    language: String,
    uri: String,
    language_id: String,
    version: i32,
    text: String,
) -> Result<(), String> {
    let mut lsp = state.lsp_manager.lock().unwrap();
    lsp.did_open(&language, &uri, &language_id, version, &text).await
}

#[tauri::command]
async fn lsp_did_change(
    state: State<'_, AppState>,
    language: String,
    uri: String,
    version: i32,
    text: String,
) -> Result<(), String> {
    let mut lsp = state.lsp_manager.lock().unwrap();
    lsp.did_change(&language, &uri, version, &text).await
}
```

**Monaco LSP bridge (Frontend):**

```typescript
import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';

export function setupLspProviders(monacoInstance: typeof monaco, language: string) {
  // Start LSP server
  invoke('lsp_start', { language });
  
  // Completion provider
  monacoInstance.languages.registerCompletionItemProvider(language, {
    async provideCompletionItems(model, position) {
      const uri = model.uri.toString();
      const result = await invoke('lsp_completion', {
        language,
        uri,
        line: position.lineNumber - 1,
        character: position.column - 1,
      });
      
      // Transform LSP result to Monaco format
      return {
        suggestions: transformCompletions(result)
      };
    }
  });
  
  // Hover provider
  monacoInstance.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const uri = model.uri.toString();
      const result = await invoke('lsp_hover', {
        language,
        uri,
        line: position.lineNumber - 1,
        character: position.column - 1,
      });
      
      return transformHover(result);
    }
  });
  
  // Definition provider
  monacoInstance.languages.registerDefinitionProvider(language, {
    async provideDefinition(model, position) {
      const uri = model.uri.toString();
      const result = await invoke('lsp_definition', {
        language,
        uri,
        line: position.lineNumber - 1,
        character: position.column - 1,
      });
      
      return transformDefinition(result);
    }
  });
}

// Notify LSP of file open/change events
export function notifyLspFileOpen(language: string, uri: string, content: string) {
  invoke('lsp_did_open', {
    language,
    uri,
    languageId: language,
    version: 1,
    text: content,
  });
}

export function notifyLspFileChange(language: string, uri: string, version: number, content: string) {
  invoke('lsp_did_change', {
    language,
    uri,
    version,
    text: content,
  });
}
```

### Git Integration

**Basic features (Phase 3):**

1. **File status in tree** - Show modified/untracked/staged badges
2. **Diff viewer** - Compare current vs HEAD
3. **Stage/unstage files**
4. **Commit** - Simple commit dialog
5. **Branch indicator** - Show current branch in status bar

**Advanced features (later):**
- Branch switching
- Merge conflict resolution
- Pull/push
- History view
- Blame

**Implementation (using `git2-rs`):**

```rust
use git2::Repository;

#[tauri::command]
async fn git_status(repo_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = Repository::open(&repo_path)
        .map_err(|e| format!("Not a git repo: {}", e))?;
    
    let statuses = repo.statuses(None)
        .map_err(|e| e.to_string())?;
    
    let mut result = Vec::new();
    for entry in statuses.iter() {
        if let Some(path) = entry.path() {
            result.push(GitFileStatus {
                path: path.to_string(),
                status: git_status_to_string(entry.status()),
            });
        }
    }
    
    Ok(result)
}

fn git_status_to_string(status: git2::Status) -> String {
    if status.is_index_new() || status.is_wt_new() {
        "untracked".to_string()
    } else if status.is_index_modified() || status.is_wt_modified() {
        "modified".to_string()
    } else if status.is_index_deleted() || status.is_wt_deleted() {
        "deleted".to_string()
    } else if status.is_ignored() {
        "ignored".to_string()
    } else {
        "clean".to_string()
    }
}

#[tauri::command]
async fn git_diff(repo_path: String, file_path: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path)
        .map_err(|e| e.to_string())?;
    
    let head = repo.head()
        .map_err(|e| e.to_string())?;
    let head_tree = head.peel_to_tree()
        .map_err(|e| e.to_string())?;
    
    let mut diff_options = git2::DiffOptions::new();
    diff_options.pathspec(&file_path);
    
    let diff = repo.diff_tree_to_workdir(Some(&head_tree), Some(&mut diff_options))
        .map_err(|e| e.to_string())?;
    
    let mut diff_text = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        diff_text.push_str(&format!("{}\n", String::from_utf8_lossy(line.content())));
        true
    }).map_err(|e| e.to_string())?;
    
    Ok(diff_text)
}

#[tauri::command]
async fn git_current_branch(repo_path: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path)
        .map_err(|e| e.to_string())?;
    
    let head = repo.head()
        .map_err(|e| e.to_string())?;
    
    head.shorthand()
        .map(|s| s.to_string())
        .ok_or_else(|| "Failed to get branch name".to_string())
}

#[tauri::command]
async fn git_stage_file(repo_path: String, file_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path)
        .map_err(|e| e.to_string())?;
    
    let mut index = repo.index()
        .map_err(|e| e.to_string())?;
    
    index.add_path(Path::new(&file_path))
        .map_err(|e| e.to_string())?;
    
    index.write()
        .map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
async fn git_commit(
    repo_path: String,
    message: String,
    author_name: String,
    author_email: String,
) -> Result<String, String> {
    let repo = Repository::open(&repo_path)
        .map_err(|e| e.to_string())?;
    
    let signature = git2::Signature::now(&author_name, &author_email)
        .map_err(|e| e.to_string())?;
    
    let mut index = repo.index()
        .map_err(|e| e.to_string())?;
    let tree_id = index.write_tree()
        .map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id)
        .map_err(|e| e.to_string())?;
    
    let parent_commit = repo.head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());
    
    let parents = if let Some(p) = &parent_commit {
        vec![p]
    } else {
        vec![]
    };
    
    let commit_id = repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        &message,
        &tree,
        &parents,
    ).map_err(|e| e.to_string())?;
    
    Ok(commit_id.to_string())
}
```

**Diff viewer component:**

```tsx
import { DiffEditor } from '@monaco-editor/react';

function GitDiffView({ filePath }: { filePath: string }) {
  const [diff, setDiff] = useState<{ original: string; modified: string } | null>(null);
  
  useEffect(() => {
    Promise.all([
      invoke('git_show_file_at_head', { filePath }), // Original
      invoke('editor_read_file', { path: filePath }), // Modified
    ]).then(([original, modified]) => {
      setDiff({ original, modified });
    });
  }, [filePath]);
  
  if (!diff) return <Spinner />;
  
  return (
    <DiffEditor
      height="100%"
      language={detectLanguage(filePath)}
      original={diff.original}
      modified={diff.modified}
      theme="vs-dark"
      options={{
        readOnly: true,
        renderSideBySide: true,
      }}
    />
  );
}
```

---

## Phase 4: Scheduled Agents

### Problem Statement

Network engineers need automation for:
- **Scheduled tasks**: Daily config backups, hourly health checks
- **Event-driven actions**: Auto-debug failed commands, monitor for errors
- **Conditional monitoring**: Alert when specific log patterns appear

Currently requires external cron/scripts. Better UX: schedule agents from within terminal.

### Solution Overview

Add scheduling engine that triggers agent executions based on:
1. **Cron schedules** - Time-based (hourly, daily, custom)
2. **Events** - command_failed, pattern_matched, file_changed
3. **Conditions** - Poll for specific state, trigger when true

Uses existing Python sidecar agent infrastructure. Results stored in DB, visible in dedicated Scheduler panel.

### Data Model

```sql
CREATE TABLE scheduled_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    enabled BOOLEAN DEFAULT 1,
    
    -- Trigger configuration
    type TEXT NOT NULL, -- 'cron', 'event', 'conditional'
    schedule TEXT, -- Cron expression (for cron type)
    event_trigger TEXT, -- Event name (for event type)
    condition TEXT, -- JSON condition (for conditional type)
    
    -- Agent execution
    agent_prompt TEXT NOT NULL,
    skill_id TEXT, -- Optional: invoke specific skill
    
    -- Scheduling metadata
    last_run_at INTEGER,
    next_run_at INTEGER,
    run_count INTEGER DEFAULT 0,
    
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE job_executions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL, -- 'running', 'success', 'failed', 'timeout'
    output TEXT, -- Agent's response
    error TEXT,
    
    FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id)
);

CREATE INDEX idx_jobs_enabled ON scheduled_jobs(enabled) WHERE enabled = 1;
CREATE INDEX idx_jobs_next_run ON scheduled_jobs(next_run_at) WHERE enabled = 1;
CREATE INDEX idx_executions_job ON job_executions(job_id);
CREATE INDEX idx_executions_time ON job_executions(started_at DESC);
```

### Job Types

#### 1. Cron Jobs (Time-based)

```typescript
interface CronJob {
  type: 'cron';
  schedule: string; // Standard cron expression
  agentPrompt: string;
  skillId?: string;
}

// Examples:
{
  name: "Hourly Router Health Check",
  type: "cron",
  schedule: "0 */1 * * *", // Every hour
  agentPrompt: `
    Run health checks on all routers in ~/inventory.json:
    1. Connect via SSH
    2. Run: show version, show ip interface brief, show processes cpu
    3. Alert if CPU > 80% or any interfaces down
    4. Log results to ~/health-checks.log
  `
}

{
  name: "Daily Config Backup",
  type: "cron",
  schedule: "0 2 * * *", // 2 AM daily
  agentPrompt: `
    Backup configs for all devices:
    1. Pull running-config from each device
    2. Save to ~/backups/YYYY-MM-DD/
    3. Commit to git with message "Daily backup YYYY-MM-DD"
  `
}
```

**Cron expression format:** `minute hour day month weekday`

**Common patterns:**
- `*/5 * * * *` - Every 5 minutes
- `0 */2 * * *` - Every 2 hours
- `0 9 * * 1-5` - 9 AM weekdays
- `0 0 * * 0` - Midnight Sundays

#### 2. Event-Triggered Jobs

```typescript
interface EventJob {
  type: 'event';
  eventTrigger: EventType;
  condition?: EventCondition;
  agentPrompt: string;
}

type EventType = 
  | 'command_failed' 
  | 'pattern_matched'
  | 'file_changed';

interface EventCondition {
  // For command_failed
  exitCode?: number | number[];
  commandPattern?: string; // Regex
  
  // For pattern_matched
  pattern?: string; // Regex
  source?: 'terminal_output' | 'file';
  filePath?: string;
  
  // For file_changed
  watchPath?: string;
  changeType?: 'created' | 'modified' | 'deleted';
}

// Examples:
{
  name: "Auto-Debug Failed Commands",
  type: "event",
  eventTrigger: "command_failed",
  condition: { exitCode: [1, 127] }, // Non-zero exit
  agentPrompt: `
    The last command failed with exit code {exit_code}.
    
    Analyze the error output and provide:
    1. What went wrong
    2. How to fix it
    3. Alternative commands to try
  `
}

{
  name: "Alert on SSH Failures",
  type: "event",
  eventTrigger: "pattern_matched",
  condition: {
    pattern: "Connection refused|Permission denied|Timeout",
    source: "terminal_output"
  },
  agentPrompt: `
    SSH connection issue detected: {matched_pattern}
    
    Diagnose the problem and suggest fixes.
  `
}

{
  name: "Config Change Notifier",
  type: "event",
  eventTrigger: "file_changed",
  condition: {
    watchPath: "~/configs/**/*.conf",
    changeType: "modified"
  },
  agentPrompt: `
    Config file changed: {file_path}
    
    Review the changes and check for:
    1. Syntax errors
    2. Security issues
    3. Best practice violations
  `
}
```

#### 3. Conditional Jobs (Polling-based)

```typescript
interface ConditionalJob {
  type: 'conditional';
  checkInterval: number; // Seconds between checks
  condition: Condition;
  agentPrompt: string;
}

interface Condition {
  type: 'log_pattern' | 'file_exists' | 'command_output' | 'port_open';
  params: Record<string, any>;
}

// Examples:
{
  name: "Syslog Error Monitor",
  type: "conditional",
  checkInterval: 300, // Check every 5 minutes
  condition: {
    type: "log_pattern",
    params: {
      logFile: "/var/log/syslog",
      pattern: "ERROR|CRITICAL|FATAL",
      sinceLastCheck: true // Only new lines
    }
  },
  agentPrompt: `
    Found {match_count} errors in syslog:
    
    {matched_lines}
    
    Analyze these errors and determine if action is needed.
  `
}

{
  name: "Device Reachability Monitor",
  type: "conditional",
  checkInterval: 60, // Check every minute
  condition: {
    type: "command_output",
    params: {
      command: "ping -c 1 router1.lab.local",
      expectedExitCode: 0
    }
  },
  agentPrompt: `
    Device router1.lab.local is unreachable.
    
    Last successful ping: {last_success_time}
    
    1. Check network connectivity
    2. Verify device is powered on
    3. Review recent changes
  `
}
```

### Scheduler Engine (Rust)

```rust
// src-tauri/src/scheduler/mod.rs

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::time::{interval, Duration};
use cron::Schedule;
use std::str::FromStr;

pub struct Scheduler {
    jobs: Arc<Mutex<HashMap<String, ScheduledJob>>>,
    executor: Arc<JobExecutor>,
    running: Arc<AtomicBool>,
}

struct ScheduledJob {
    id: String,
    name: String,
    enabled: bool,
    job_type: JobType,
    agent_prompt: String,
    skill_id: Option<String>,
    last_run: Option<i64>,
    next_run: Option<i64>,
}

enum JobType {
    Cron { schedule: Schedule },
    Event { trigger: EventTrigger, condition: Option<EventCondition> },
    Conditional { interval_secs: u64, condition: Condition },
}

impl Scheduler {
    pub fn new(db: Arc<Database>, sidecar: Arc<SidecarBridge>) -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
            executor: Arc::new(JobExecutor::new(db, sidecar)),
            running: Arc::new(AtomicBool::new(false)),
        }
    }
    
    pub async fn start(&self) {
        self.running.store(true, Ordering::SeqCst);
        
        // Load jobs from database
        self.load_jobs().await;
        
        // Start scheduler loop
        let jobs = self.jobs.clone();
        let executor = self.executor.clone();
        let running = self.running.clone();
        
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_secs(10)); // Check every 10s
            
            while running.load(Ordering::SeqCst) {
                tick.tick().await;
                
                let now = chrono::Utc::now().timestamp();
                let jobs_snapshot = jobs.lock().unwrap().clone();
                
                for (id, job) in jobs_snapshot {
                    if !job.enabled {
                        continue;
                    }
                    
                    match &job.job_type {
                        JobType::Cron { schedule } => {
                            if let Some(next_run) = job.next_run {
                                if now >= next_run {
                                    executor.execute(job.clone()).await;
                                    
                                    // Calculate next run time
                                    let next = schedule.upcoming(chrono::Utc).next();
                                    if let Some(next_time) = next {
                                        let mut jobs = jobs.lock().unwrap();
                                        if let Some(j) = jobs.get_mut(&id) {
                                            j.next_run = Some(next_time.timestamp());
                                        }
                                    }
                                }
                            }
                        }
                        
                        JobType::Conditional { interval_secs, condition } => {
                            let should_check = job.last_run
                                .map(|last| now - last >= *interval_secs as i64)
                                .unwrap_or(true);
                            
                            if should_check {
                                if Self::check_condition(condition).await {
                                    executor.execute(job.clone()).await;
                                }
                                
                                let mut jobs = jobs.lock().unwrap();
                                if let Some(j) = jobs.get_mut(&id) {
                                    j.last_run = Some(now);
                                }
                            }
                        }
                        
                        JobType::Event { .. } => {
                            // Event jobs are triggered externally via on_event()
                        }
                    }
                }
            }
        });
    }
    
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
    
    pub async fn on_event(&self, event: JobEvent) {
        let jobs = self.jobs.lock().unwrap().clone();
        
        for job in jobs.values() {
            if !job.enabled {
                continue;
            }
            
            if let JobType::Event { trigger, condition } = &job.job_type {
                if Self::event_matches(trigger, condition, &event) {
                    self.executor.execute(job.clone()).await;
                }
            }
        }
    }
    
    async fn check_condition(condition: &Condition) -> bool {
        match condition {
            Condition::LogPattern { file, pattern, since_last_check } => {
                // Check if pattern appears in log file
                Self::check_log_pattern(file, pattern, *since_last_check).await
            }
            Condition::FileExists { path } => {
                std::path::Path::new(path).exists()
            }
            Condition::CommandOutput { command, expected_exit_code } => {
                Self::run_command_check(command, *expected_exit_code).await
            }
            // ... other condition types
        }
    }
    
    async fn check_log_pattern(file: &str, pattern: &str, since_last: bool) -> bool {
        // Implementation: tail log file, check for regex match
        // If since_last, only check lines written since last check
        todo!()
    }
    
    fn event_matches(
        trigger: &EventTrigger,
        condition: &Option<EventCondition>,
        event: &JobEvent,
    ) -> bool {
        // Check if event matches trigger and optional condition
        todo!()
    }
    
    async fn load_jobs(&self) {
        // Load from database, deserialize, populate self.jobs
        todo!()
    }
}

struct JobExecutor {
    db: Arc<Database>,
    sidecar: Arc<SidecarBridge>,
}

impl JobExecutor {
    async fn execute(&self, job: ScheduledJob) {
        let execution_id = uuid::Uuid::new_v4().to_string();
        let started_at = chrono::Utc::now().timestamp();
        
        // Create execution record
        self.db.insert_job_execution(&execution_id, &job.id, started_at, "running").await;
        
        // Build agent context with job parameters
        let context = self.build_context(&job).await;
        
        // Send to Python sidecar
        let request = SidecarRequest::RunScheduledJob {
            execution_id: execution_id.clone(),
            prompt: job.agent_prompt,
            skill_id: job.skill_id,
            context,
        };
        
        match self.sidecar.send(request).await {
            Ok(response) => {
                let completed_at = chrono::Utc::now().timestamp();
                self.db.update_job_execution(
                    &execution_id,
                    Some(completed_at),
                    "success",
                    Some(response.output),
                    None,
                ).await;
            }
            Err(e) => {
                let completed_at = chrono::Utc::now().timestamp();
                self.db.update_job_execution(
                    &execution_id,
                    Some(completed_at),
                    "failed",
                    None,
                    Some(e.to_string()),
                ).await;
            }
        }
    }
    
    async fn build_context(&self, job: &ScheduledJob) -> HashMap<String, String> {
        // Include relevant context variables for template substitution
        let mut ctx = HashMap::new();
        ctx.insert("job_name".to_string(), job.name.clone());
        ctx.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());
        // ... add more context based on job type
        ctx
    }
}

pub enum JobEvent {
    CommandFailed { exit_code: i32, command: String, output: String },
    PatternMatched { pattern: String, source: String, line: String },
    FileChanged { path: String, change_type: String },
}
```

**Tauri commands:**

```rust
#[tauri::command]
async fn scheduler_create_job(
    state: State<'_, AppState>,
    job: ScheduledJobConfig,
) -> Result<String, String> {
    let scheduler = state.scheduler.lock().unwrap();
    scheduler.create_job(job).await
}

#[tauri::command]
async fn scheduler_list_jobs(
    state: State<'_, AppState>,
) -> Result<Vec<ScheduledJob>, String> {
    let scheduler = state.scheduler.lock().unwrap();
    scheduler.list_jobs().await
}

#[tauri::command]
async fn scheduler_update_job(
    state: State<'_, AppState>,
    job_id: String,
    updates: JobUpdates,
) -> Result<(), String> {
    let scheduler = state.scheduler.lock().unwrap();
    scheduler.update_job(&job_id, updates).await
}

#[tauri::command]
async fn scheduler_delete_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let scheduler = state.scheduler.lock().unwrap();
    scheduler.delete_job(&job_id).await
}

#[tauri::command]
async fn scheduler_run_now(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<String, String> {
    let scheduler = state.scheduler.lock().unwrap();
    scheduler.execute_immediately(&job_id).await
}

#[tauri::command]
async fn scheduler_list_executions(
    state: State<'_, AppState>,
    job_id: Option<String>,
    limit: usize,
) -> Result<Vec<JobExecution>, String> {
    let scheduler = state.scheduler.lock().unwrap();
    scheduler.list_executions(job_id.as_deref(), limit).await
}
```

### UI - Scheduler Panel

**Location:** New panel tab (alongside Terminal, Editor, Agent, Search, Skills)

```tsx
function SchedulerPanel() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [executions, setExecutions] = useState<JobExecution[]>([]);
  
  useEffect(() => {
    loadJobs();
    loadExecutions();
    
    // Refresh periodically
    const interval = setInterval(() => {
      loadJobs();
      loadExecutions();
    }, 10000);
    
    return () => clearInterval(interval);
  }, []);
  
  const loadJobs = async () => {
    const result = await invoke<ScheduledJob[]>('scheduler_list_jobs');
    setJobs(result);
  };
  
  const loadExecutions = async () => {
    const result = await invoke<JobExecution[]>('scheduler_list_executions', {
      jobId: selectedJob,
      limit: 20
    });
    setExecutions(result);
  };
  
  return (
    <PanelContainer>
      <PanelHeader>
        <h2>Scheduled Jobs</h2>
        <Button onClick={openCreateWizard}>+ New Job</Button>
      </PanelHeader>
      
      <JobsList>
        {jobs.map(job => (
          <JobCard
            key={job.id}
            job={job}
            selected={selectedJob === job.id}
            onClick={() => setSelectedJob(job.id)}
            onToggle={() => toggleJob(job.id)}
            onEdit={() => openEditWizard(job)}
            onDelete={() => deleteJob(job.id)}
            onRunNow={() => runJobNow(job.id)}
          />
        ))}
      </JobsList>
      
      <Divider />
      
      <ExecutionsHeader>
        <h3>Recent Executions</h3>
        {selectedJob && (
          <FilterBadge onClick={() => setSelectedJob(null)}>
            Filtered to 1 job ✕
          </FilterBadge>
        )}
      </ExecutionsHeader>
      
      <ExecutionsList>
        {executions.map(exec => (
          <ExecutionCard
            key={exec.id}
            execution={exec}
            onClick={() => showExecutionDetails(exec)}
          />
        ))}
      </ExecutionsList>
    </PanelContainer>
  );
}

function JobCard({ job, selected, onClick, onToggle, onEdit, onDelete, onRunNow }) {
  const icon = job.type === 'cron' ? '⏰' : job.type === 'event' ? '🔔' : '📊';
  const statusColor = job.enabled ? 'green' : 'gray';
  
  return (
    <Card selected={selected} onClick={onClick}>
      <JobHeader>
        <JobIcon>{icon}</JobIcon>
        <JobTitle>{job.name}</JobTitle>
        <JobStatus color={statusColor}>
          {job.enabled ? 'Enabled' : 'Disabled'}
        </JobStatus>
      </JobHeader>
      
      <JobDetails>
        {job.type === 'cron' && (
          <JobSchedule>
            {humanizeCron(job.schedule)} • Next: {formatNextRun(job.next_run_at)}
          </JobSchedule>
        )}
        {job.type === 'event' && (
          <JobTrigger>
            On {job.event_trigger} {job.condition && `(${formatCondition(job.condition)})`}
          </JobTrigger>
        )}
        {job.type === 'conditional' && (
          <JobInterval>
            Every {job.check_interval}s • {formatCondition(job.condition)}
          </JobInterval>
        )}
        
        <JobStats>
          Last run: {job.last_run_at ? formatRelative(job.last_run_at) : 'Never'} • 
          Runs: {job.run_count}
        </JobStats>
      </JobDetails>
      
      <JobActions>
        <IconButton onClick={onRunNow} title="Run now">▶</IconButton>
        <IconButton onClick={onEdit} title="Edit">✎</IconButton>
        <IconButton onClick={onToggle} title={job.enabled ? 'Disable' : 'Enable'}>
          {job.enabled ? '⏸' : '▶'}
        </IconButton>
        <IconButton onClick={onDelete} title="Delete">🗑</IconButton>
      </JobActions>
    </Card>
  );
}

function ExecutionCard({ execution, onClick }) {
  const statusIcon = {
    running: '⏳',
    success: '✓',
    failed: '✗',
    timeout: '⏱',
  }[execution.status];
  
  const statusColor = {
    running: 'blue',
    success: 'green',
    failed: 'red',
    timeout: 'orange',
  }[execution.status];
  
  return (
    <ExecCard onClick={onClick}>
      <ExecStatus color={statusColor}>{statusIcon}</ExecStatus>
      <ExecContent>
        <ExecTime>{formatTimestamp(execution.started_at)}</ExecTime>
        <ExecJob>{execution.job_name}</ExecJob>
        {execution.status === 'running' && (
          <ExecDuration>Running for {formatDuration(Date.now() - execution.started_at)}</ExecDuration>
        )}
        {execution.completed_at && (
          <ExecDuration>Completed in {formatDuration(execution.completed_at - execution.started_at)}</ExecDuration>
        )}
      </ExecContent>
    </ExecCard>
  );
}
```

### Job Creation Wizard

Similar to Skills wizard - step-by-step configuration:

```tsx
function CreateJobWizard({ onClose, onSave }) {
  const [step, setStep] = useState(1);
  const [jobConfig, setJobConfig] = useState<Partial<ScheduledJobConfig>>({});
  
  return (
    <WizardModal onClose={onClose}>
      <WizardHeader>
        <h2>Create Scheduled Job</h2>
        <StepIndicator current={step} total={4} />
      </WizardHeader>
      
      {step === 1 && (
        <StepOne onNext={(type) => {
          setJobConfig({ ...jobConfig, type });
          setStep(2);
        }} />
      )}
      
      {step === 2 && (
        <StepTwo
          type={jobConfig.type!}
          onNext={(trigger) => {
            setJobConfig({ ...jobConfig, ...trigger });
            setStep(3);
          }}
          onBack={() => setStep(1)}
        />
      )}
      
      {step === 3 && (
        <StepThree
          onNext={(prompt) => {
            setJobConfig({ ...jobConfig, agentPrompt: prompt });
            setStep(4);
          }}
          onBack={() => setStep(2)}
        />
      )}
      
      {step === 4 && (
        <StepFour
          config={jobConfig}
          onSave={async () => {
            await invoke('scheduler_create_job', { job: jobConfig });
            onSave();
            onClose();
          }}
          onBack={() => setStep(3)}
        />
      )}
    </WizardModal>
  );
}

function StepOne({ onNext }) {
  return (
    <StepContainer>
      <StepTitle>Choose Trigger Type</StepTitle>
      
      <TriggerOptions>
        <TriggerOption onClick={() => onNext('cron')}>
          <OptionIcon>⏰</OptionIcon>
          <OptionTitle>Time-based (Cron)</OptionTitle>
          <OptionDescription>
            Run on a schedule (hourly, daily, custom)
          </OptionDescription>
          <OptionExamples>
            Examples: Daily backups, hourly health checks
          </OptionExamples>
        </TriggerOption>
        
        <TriggerOption onClick={() => onNext('event')}>
          <OptionIcon>🔔</OptionIcon>
          <OptionTitle>Event-triggered</OptionTitle>
          <OptionDescription>
            Run when specific events occur
          </OptionDescription>
          <OptionExamples>
            Examples: Command fails, pattern detected
          </OptionExamples>
        </TriggerOption>
        
        <TriggerOption onClick={() => onNext('conditional')}>
          <OptionIcon>📊</OptionIcon>
          <OptionTitle>Conditional (Monitor)</OptionTitle>
          <OptionDescription>
            Poll for specific conditions and trigger when met
          </OptionDescription>
          <OptionExamples>
            Examples: Monitor logs, check device reachability
          </OptionExamples>
        </TriggerOption>
      </TriggerOptions>
    </StepContainer>
  );
}

function StepTwo({ type, onNext, onBack }) {
  if (type === 'cron') {
    return <CronConfigStep onNext={onNext} onBack={onBack} />;
  }
  if (type === 'event') {
    return <EventConfigStep onNext={onNext} onBack={onBack} />;
  }
  return <ConditionalConfigStep onNext={onNext} onBack={onBack} />;
}

function CronConfigStep({ onNext, onBack }) {
  const [schedule, setSchedule] = useState('');
  const [preset, setPreset] = useState<string | null>(null);
  
  const presets = [
    { label: 'Every 5 minutes', value: '*/5 * * * *' },
    { label: 'Every hour', value: '0 */1 * * *' },
    { label: 'Every 6 hours', value: '0 */6 * * *' },
    { label: 'Daily at 2 AM', value: '0 2 * * *' },
    { label: 'Weekdays at 9 AM', value: '0 9 * * 1-5' },
    { label: 'Custom', value: null },
  ];
  
  return (
    <StepContainer>
      <StepTitle>Configure Schedule</StepTitle>
      
      <PresetSelector>
        {presets.map(p => (
          <PresetButton
            key={p.label}
            selected={preset === p.label}
            onClick={() => {
              setPreset(p.label);
              if (p.value) setSchedule(p.value);
            }}
          >
            {p.label}
          </PresetButton>
        ))}
      </PresetSelector>
      
      {preset === 'Custom' && (
        <CustomSchedule>
          <Label>Cron Expression</Label>
          <Input
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="0 */1 * * *"
          />
          <HelpText>
            Format: minute hour day month weekday
            <br />
            <a href="https://crontab.guru" target="_blank">crontab.guru</a> for help
          </HelpText>
        </CustomSchedule>
      )}
      
      {schedule && <NextRunPreview schedule={schedule} />}
      
      <WizardActions>
        <Button onClick={onBack} variant="secondary">Back</Button>
        <Button
          onClick={() => onNext({ schedule })}
          disabled={!schedule}
        >
          Next
        </Button>
      </WizardActions>
    </StepContainer>
  );
}

function StepThree({ onNext, onBack }) {
  const [prompt, setPrompt] = useState('');
  
  return (
    <StepContainer>
      <StepTitle>Define Agent Task</StepTitle>
      <StepDescription>
        What should the agent do when this job triggers?
      </StepDescription>
      
      <PromptEditor>
        <Label>Agent Instructions</Label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={12}
          placeholder="Describe what the agent should do...

Example:
Connect to all routers in ~/inventory.json and run:
- show version
- show ip interface brief
- show memory

Alert me if any device has:
- Interfaces in 'down' state
- Memory usage > 80%
"
        />
      </PromptEditor>
      
      <TemplateVariables>
        <h4>Available Variables</h4>
        <VariablesList>
          <Variable><code>{'{timestamp}'}</code> - Current time</Variable>
          <Variable><code>{'{job_name}'}</code> - Job name</Variable>
          <Variable><code>{'{exit_code}'}</code> - Command exit code (event jobs)</Variable>
          <Variable><code>{'{matched_pattern}'}</code> - Matched regex (pattern jobs)</Variable>
        </VariablesList>
      </TemplateVariables>
      
      <WizardActions>
        <Button onClick={onBack} variant="secondary">Back</Button>
        <Button onClick={() => onNext(prompt)} disabled={!prompt}>
          Next
        </Button>
      </WizardActions>
    </StepContainer>
  );
}

function StepFour({ config, onSave, onBack }) {
  const [name, setName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  
  const testJob = async () => {
    setTesting(true);
    try {
      // Create temp job, run immediately, show results
      const result = await invoke('scheduler_test_job', { config: { ...config, name } });
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };
  
  return (
    <StepContainer>
      <StepTitle>Review & Test</StepTitle>
      
      <FormField>
        <Label>Job Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Hourly Health Check"
        />
      </FormField>
      
      <ConfigSummary>
        <SummarySection>
          <SummaryLabel>Trigger</SummaryLabel>
          <SummaryValue>{formatTrigger(config)}</SummaryValue>
        </SummarySection>
        
        <SummarySection>
          <SummaryLabel>Agent Task</SummaryLabel>
          <SummaryValue>
            <pre>{config.agentPrompt}</pre>
          </SummaryValue>
        </SummarySection>
      </ConfigSummary>
      
      <TestSection>
        <Button onClick={testJob} disabled={testing || !name}>
          {testing ? 'Testing...' : 'Test Job Now'}
        </Button>
        
        {testResult && (
          <TestResult success={testResult.status === 'success'}>
            <ResultHeader>
              {testResult.status === 'success' ? '✓ Test Passed' : '✗ Test Failed'}
            </ResultHeader>
            <ResultOutput>{testResult.output}</ResultOutput>
          </TestResult>
        )}
      </TestSection>
      
      <WizardActions>
        <Button onClick={onBack} variant="secondary">Back</Button>
        <Button
          onClick={() => onSave({ ...config, name })}
          disabled={!name}
          variant="primary"
        >
          Create Job
        </Button>
      </WizardActions>
    </StepContainer>
  );
}
```

### Built-in Job Templates

**Network engineering templates:**

```typescript
const JOB_TEMPLATES = [
  {
    name: "Daily Config Backup",
    type: "cron",
    schedule: "0 2 * * *",
    agentPrompt: `
Connect to all devices in ~/inventory.json and:
1. Pull running-config
2. Save to ~/backups/{{date}}/{{hostname}}.conf
3. Commit to git with message "Backup {{date}}"
4. Report any failures
    `.trim()
  },
  
  {
    name: "Hourly Health Check",
    type: "cron",
    schedule: "0 */1 * * *",
    agentPrompt: `
Run health checks on all production devices:
- CPU usage (alert if >80%)
- Memory usage (alert if >80%)
- Interface status (alert if any critical interfaces down)
- BGP neighbor status (alert if any neighbors down)

Summarize findings and alert if any issues.
    `.trim()
  },
  
  {
    name: "Interface Status Monitor",
    type: "conditional",
    checkInterval: 300,
    condition: {
      type: "command_output",
      params: {
        command: "ssh router1 'show ip interface brief' | grep down",
        expectedExitCode: 1 // Expect no matches (no down interfaces)
      }
    },
    agentPrompt: `
Interface(s) detected as down on router1.

Current status:
{{command_output}}

1. Identify which interfaces are down
2. Check recent changes
3. Suggest remediation steps
    `.trim()
  },
  
  {
    name: "Syslog Error Monitor",
    type: "conditional",
    checkInterval: 60,
    condition: {
      type: "log_pattern",
      params: {
        logFile: "/var/log/syslog",
        pattern: "%ERROR|%CRIT",
        sinceLastCheck: true
      }
    },
    agentPrompt: `
Found {{match_count}} errors in syslog:

{{matched_lines}}

Analyze severity and determine if immediate action required.
    `.trim()
  },
  
  {
    name: "Failed Command Debugger",
    type: "event",
    eventTrigger: "command_failed",
    condition: { exitCode: [1, 2, 127] },
    agentPrompt: `
Command failed with exit code {{exit_code}}:

Command: {{command}}
Output: {{output}}

Diagnose the issue and suggest:
1. What went wrong
2. How to fix it
3. Alternative commands
    `.trim()
  },
  
  {
    name: "Configuration Compliance Audit",
    type: "cron",
    schedule: "0 0 * * 0", // Weekly on Sunday
    agentPrompt: `
Audit all device configs against baseline in ~/compliance/baseline.yaml:

For each device:
1. Pull running-config
2. Compare against baseline requirements
3. Report deviations
4. Suggest remediation

Generate compliance report in ~/compliance/reports/{{date}}.md
    `.trim()
  },
];
```

---

## Implementation Order & Estimates

### Phase 1: Command Blocks + Command Palette (3-4 weeks)

**Week 1: Data model & shell integration**
- SQLite schema for blocks
- Update PTY parser for OSC 133 sequences
- Zustand store for block state
- Shell config updates (zsh, bash)

**Week 2: Block rendering**
- CommandBlock React component
- Hybrid terminal layout
- Collapse/expand functionality
- Block actions (copy, rerun, bookmark)

**Week 3: Command palette**
- Modal UI with fuzzy search
- Data source integrations (history, skills, MCP, actions)
- Keyboard shortcuts
- Action handlers

**Week 4: Polish & testing**
- Performance optimization (virtualization)
- Output storage strategy
- Edge cases (very long outputs, binary data)
- User testing

---

### Phase 2: Split Panes (1-2 weeks)

**Week 1: Layout model & PTY management**
- PaneLayout tree structure
- Rust PTY commands (pane_new, pane_close)
- Split/close algorithms
- State persistence

**Week 2: UI & interactions**
- Recursive PaneLayoutView component
- Resize handles
- Keyboard navigation
- Synchronized input (optional)

---

### Phase 3: Code Editor (5-7 weeks)

**Week 1: Monaco integration**
- Install dependencies
- Basic Editor component
- Language detection
- Theme/settings

**Week 2: File tree**
- Tauri file system commands
- FileTreeNode recursive component
- File open/close/save
- File watcher

**Week 3: LSP manager (Rust)**
- LSP process spawning
- JSON-RPC protocol handling
- Python LSP (pylsp)
- YAML LSP (yaml-language-server)

**Week 4: LSP client (Monaco)**
- Completion provider
- Hover provider
- Definition provider
- Diagnostics integration

**Week 5: Git integration**
- git2-rs bindings
- Status detection
- Diff viewer
- Basic commit UI

**Week 6-7: Polish & additional features**
- Terraform support
- Jinja2 syntax
- Outline view
- Find/replace
- Multi-file editing
- Unsaved changes handling

---

### Phase 4: Scheduled Agents (2-3 weeks)

**Week 1: Scheduler engine**
- SQLite schema
- Rust Scheduler implementation
- Cron parsing
- Event system

**Week 2: Job executor & UI**
- JobExecutor with sidecar integration
- Scheduler panel
- Job list/execution list
- Job creation wizard

**Week 3: Templates & polish**
- Built-in templates
- Conditional job types
- Testing/debugging tools
- Notifications

---

## Success Criteria

### Command Blocks
- ✓ Every command automatically becomes a block
- ✓ Can collapse/expand any block
- ✓ Bookmarked blocks persist across sessions
- ✓ Copy output without escape sequences
- ✓ Rerun command creates new block
- ✓ Performance: 500+ blocks in tab without lag

### Command Palette
- ✓ Opens with Cmd+K in <100ms
- ✓ Fuzzy search returns results in <50ms
- ✓ Keyboard-only navigation works perfectly
- ✓ Executes commands, skills, MCP tools, actions
- ✓ Shows recent commands from history

### Split Panes
- ✓ Can split horizontally and vertically
- ✓ Each pane has independent PTY
- ✓ Resize handles work smoothly
- ✓ Keyboard navigation between panes
- ✓ Layout persists in sessions
- ✓ Can have 4+ panes without performance issues

### Code Editor
- ✓ Monaco editor loads in <500ms
- ✓ Syntax highlighting for Python, YAML, JSON, Terraform
- ✓ Autocomplete works for Python (via pylsp)
- ✓ File tree shows project structure
- ✓ Can create/edit/delete/rename files
- ✓ Git status shows in file tree
- ✓ Diff viewer compares working vs HEAD
- ✓ Can commit directly from editor

### Scheduled Agents
- ✓ Can create cron, event, and conditional jobs
- ✓ Scheduler runs jobs on schedule
- ✓ Event jobs trigger on command_failed
- ✓ Job executions stored in DB
- ✓ Execution history shows in UI
- ✓ Can manually trigger any job
- ✓ Can enable/disable jobs
- ✓ Built-in network engineering templates

---

## Risk Mitigation

### Performance Risks

**Risk:** Command blocks with large outputs (1MB+) slow down rendering

**Mitigation:**
- Store large outputs in files, not SQLite TEXT
- Lazy-load collapsed blocks
- Virtualize block list for tabs with 100+ blocks
- Compress old blocks

**Risk:** Monaco editor increases bundle size significantly

**Mitigation:**
- Lazy-load Monaco (only when editor tab opened)
- Use Monaco's web worker architecture
- Code-split editor features

### Complexity Risks

**Risk:** LSP integration is complex and error-prone

**Mitigation:**
- Start with Python only (well-tested LSP)
- Graceful degradation if LSP unavailable (syntax-only)
- Detailed logging for debugging
- User can disable LSP if problematic

**Risk:** Split panes introduce layout bugs

**Mitigation:**
- Extensive testing of split/close operations
- Save/restore layout state carefully
- Fallback to single pane if layout invalid

### User Experience Risks

**Risk:** Hybrid terminal breaks muscle memory

**Mitigation:**
- Phased rollout: make blocks optional initially
- User preference: "Classic mode" vs "Blocks mode"
- Keyboard shortcuts match Warp where possible
- Clear migration guide

**Risk:** Scheduled agents create notification fatigue

**Mitigation:**
- Jobs disabled by default after creation (user must enable)
- Configurable notification preferences
- "Quiet hours" setting
- Easy to disable/delete jobs

---

## Future Enhancements (Not in Scope)

These features are valuable but deferred to keep scope manageable:

1. **Cloud sync** (Warp Drive equivalent) - sync blocks, settings, jobs across devices
2. **Team sharing** - share blocks, configs, jobs with teammates
3. **Workflows** - YAML-based parameterized command sequences
4. **Notebook mode** - Mix markdown, code, and terminal blocks
5. **Advanced Git features** - branch management, merge conflicts, history
6. **Remote editing** - Edit files on remote servers over SSH
7. **Debugging integration** - Python debugger in editor
8. **AI code review** - Inline suggestions in editor
9. **Collaboration** - Pair programming, shared terminals
10. **Plugin system** - Custom blocks, commands, integrations

---

## Open Questions

1. **Command blocks: Should we support manual block creation?** (User creates block boundary without running command)

2. **Command palette: Should it search file contents too?** (Could be slow on large projects)

3. **Editor: Should we support multiple editors in split?** (Terminal in one pane, editor in another)

4. **Scheduled agents: Should we support remote execution?** (Run jobs on remote hosts, not just local)

5. **Authentication: How to handle credentials for scheduled jobs?** (Device passwords, API keys - need secure storage)

---

## Conclusion

This design adds Warp's most impactful features to CCIE Terminal:

- **Command blocks** modernize the terminal experience, making it easier to navigate, review, and reuse commands
- **Command palette** provides universal access to all functionality via keyboard
- **Split panes** enable multi-tasking without tab switching
- **Code editor** keeps engineers in flow, editing scripts/configs without leaving terminal
- **Scheduled agents** automate repetitive network tasks with AI assistance

Progressive implementation (4 phases over 11-14 weeks) allows iterative feedback and risk mitigation. Each phase delivers independent value.

The hybrid terminal architecture is more complex than an overlay approach, but provides superior UX and makes future enhancements (workflows, notebooks, collaboration) much easier to build.

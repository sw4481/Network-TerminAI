# Phase 3 Ready - File Tree Explorer

**Date:** 2026-05-11  
**Current Status:** Phase 2 Complete, Phase 3 Ready to Start  
**Progress:** 12/35 checkpoints complete (34%)

---

## Phase 2 Recap

### What Works Now
✅ **Editor Tab Creation** - Click "+ Editor" creates new editor tab with ED badge  
✅ **Monaco Integration** - Dark theme, syntax highlighting, line numbers  
✅ **Toolbar** - File info, dirty indicator (●), save button  
✅ **Status Bar** - Line/column position, language display  
✅ **Keyboard Shortcuts** - Cmd+S to save  
✅ **State Persistence** - Tab state survives app restart (database-backed)  
✅ **Zustand Store** - Per-tab state management (content, cursor, dirty flag)  

### What's Missing
❌ **No file picker** - Can't open files from filesystem  
❌ **No directory browsing** - No way to navigate project folders  
❌ **No recent files** - Can't see or reopen previously edited files  
❌ **No file operations** - Can't create, delete, or rename files via UI  

---

## Phase 3: File Tree Explorer

**Goal:** Enable users to browse directories and open files via a collapsible sidebar

### What Phase 3 Delivers

**Core Functionality:**
1. **File Tree Sidebar** - Collapsible explorer panel (250px width)
2. **Directory Navigation** - Click folders to expand/collapse
3. **File Opening** - Click file → loads content into editor
4. **Home Directory Default** - Auto-load user's home directory on mount
5. **Root Path Selection** - Change root directory via future "Open Folder..." button

**Visual Design:**
- Left sidebar with dark theme matching editor
- Folder icons: 📁 (closed) → 📂 (open)
- File icons: Language-specific emojis (🐍 Python, 🔷 TypeScript, etc.)
- Indentation: 16px per nesting level
- Scrollable content area

**State Management:**
- `root_path` - Current directory being browsed
- `file_tree` - Array of FileNode objects
- `explorer_open` - Visibility toggle (default: true)
- `expanded_dirs` - Set of expanded directory paths

---

## Phase 3 Implementation Checklist

### Sub-Phase 3.1: File Tree Tauri Commands ⏸️
**File:** `src-tauri/src/commands/editor.rs`

**Tasks:**
- [ ] Add `FileNode` struct (path, name, node_type, children)
- [ ] Implement `editor_list_directory(path: String)` command
- [ ] Implement `editor_get_home_directory()` command
- [ ] Add ignore patterns: `.git`, `node_modules`, `__pycache__`, `target`, `.venv`
- [ ] Sort results: directories first, then files (alphabetically)
- [ ] Register commands in `src-tauri/src/lib.rs`

**Verification:**
```bash
cargo build  # Must succeed
# Manually test via Tauri devtools:
invoke('editor_list_directory', { path: '/Users/...' })
```

**Estimated Time:** 1 day

---

### Sub-Phase 3.2: File Tree State Management ⏸️
**File:** `src/state/editorStore.ts`

**Tasks:**
- [ ] Add `FileNode` type to store
- [ ] Extend `EditorTabState` with:
  - `explorer_open: boolean`
  - `root_path: string | null`
  - `file_tree: FileNode[]`
- [ ] Add `setFileTree(tabId, tree, rootPath)` method
- [ ] Add `toggleExplorer(tabId)` method
- [ ] Update `emptyTabState()` with new defaults

**Verification:**
```bash
bunx tsc --noEmit  # Must succeed
# Test in browser console:
useEditorStore.getState().toggleExplorer('tab-id')
```

**Estimated Time:** 0.5 days

---

### Sub-Phase 3.3: FileExplorer Component ⏸️
**File:** `src/components/editor/FileExplorer.tsx`  
**File:** `src/components/editor/FileExplorer.css`

**Tasks:**
- [ ] Create FileExplorer component with props:
  - `rootPath: string | null`
  - `onSelectFile: (path: string) => void`
  - `onChangeRoot: (path: string) => void`
- [ ] Implement recursive tree rendering (`renderNode()`)
- [ ] Add expand/collapse directory logic
- [ ] Lazy-load directory children on expand
- [ ] Add file icon helper (`getFileIcon()`)
- [ ] Style with dark theme matching editor

**Verification:**
```bash
bunx tsc --noEmit  # Must succeed
# Visual test: FileExplorer renders in isolation
```

**Estimated Time:** 2 days

---

### Sub-Phase 3.4: Integrate FileExplorer into EditorTab ⏸️
**File:** `src/components/editor/EditorTab.tsx`  
**File:** `src/components/editor/EditorTab.css`

**Tasks:**
- [ ] Import FileExplorer component
- [ ] Add "Toggle Explorer" button to toolbar
- [ ] Wrap editor in flex layout (`.editor-main`)
- [ ] Conditionally render FileExplorer based on `explorer_open`
- [ ] Implement `onOpenFile` handler (calls `editorOpenFile`)
- [ ] Update CSS for horizontal split (explorer | editor)

**Verification:**
```bash
bunx tsc --noEmit  # Must succeed
bun tauri dev       # Test: click "Toggle Explorer", click file → loads
```

**Estimated Time:** 1 day

---

### Sub-Phase 3.5: GUI Test - File Tree ⏸️
**File:** `e2e/tests/editor.spec.ts`

**Tasks:**
- [ ] Test: FileExplorer displays on editor tab load
- [ ] Test: Toggle button hides/shows explorer
- [ ] Test: Directory list loads home directory by default
- [ ] Test: Click directory → expands with children
- [ ] Test: Click file → loads content into editor
- [ ] Test: File nodes have correct icons

**Verification:**
```bash
bun run e2e  # 4 new tests must pass
```

**Estimated Time:** 1 day

---

## Total Phase 3 Estimate: 1 week (5 sub-phases)

---

## Prerequisites Checklist

Before starting Phase 3, verify:

- [x] Phase 1 complete (database, backend commands, IPC wrappers)
- [x] Phase 2 complete (Monaco, EditorTab, TabBar integration)
- [x] Rust build succeeds: `cargo build --manifest-path src-tauri/Cargo.toml`
- [x] TypeScript build succeeds: `bunx tsc --noEmit`
- [x] Dev mode works: `bun tauri dev`
- [ ] Manual GUI test passed (see PHASE-2-COMPLETE.md verification checklist)

---

## Post-Phase 3 Capabilities

After Phase 3, users will be able to:

1. **Browse Filesystem** - Navigate home directory and subdirectories
2. **Open Files** - Click file in tree → loads into editor
3. **Edit & Save** - Full workflow: browse → open → edit → save
4. **Toggle Sidebar** - Hide file tree for more editor space
5. **Visual Feedback** - Icons for file types, expanded/collapsed folders

**Still Missing (Future Phases):**
- File operations (create, delete, rename) - Phase 4
- LSP features (autocomplete, hover) - Phases 5-6
- Git integration (status badges, diff) - Phase 7
- Settings & polish (themes, shortcuts) - Phase 8

---

## Next Steps

**Option 1: Start Phase 3 Immediately**
```bash
# Begin with Sub-Phase 3.1
# Estimated completion: 1 week from now
```

**Option 2: Manual GUI Test First**
```bash
bun tauri dev
# Verify Phase 2 features work before adding complexity
# Follow checklist in PHASE-2-COMPLETE.md
```

**Option 3: Write Phase 2 GUI Tests**
```bash
# Create e2e/tests/editor-phase2.spec.ts
# Test: tab creation, editor rendering, save functionality
# Backfill test coverage before proceeding
```

---

## Context for Implementation

**Key Design Patterns:**
- **Lazy Loading** - Only load directory contents when user expands folder
- **Recursive Rendering** - `renderNode()` calls itself for nested folders
- **State Separation** - File tree state lives in editor store, not component
- **Icon Mapping** - File extension → emoji mapping (extensible)

**Important Files:**
- Backend: `src-tauri/src/commands/editor.rs` (add commands)
- State: `src/state/editorStore.ts` (add file tree state)
- Component: `src/components/editor/FileExplorer.tsx` (NEW)
- Integration: `src/components/editor/EditorTab.tsx` (modify)
- Tests: `e2e/tests/editor.spec.ts` (add file tree tests)

**Reference Patterns:**
- API tab panel structure (left panel + main content)
- NETCONF device picker (list with click handlers)
- Monaco editor wrapper (clean component separation)

---

## Success Criteria

Phase 3 is complete when:

1. ✅ File tree displays home directory on editor tab creation
2. ✅ Click folder → expands/collapses with visual feedback
3. ✅ Click file → loads content into Monaco editor
4. ✅ Toggle button hides/shows file explorer
5. ✅ File/folder icons render correctly
6. ✅ All TypeScript/Rust builds succeed
7. ✅ 4 new E2E tests pass
8. ✅ No console errors in dev mode

---

**Ready to implement Phase 3! 🚀**

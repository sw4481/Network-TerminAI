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

**Alternative method:**
- Click the split buttons in the TabBar
- Vertical split button (⬌) for side-by-side
- Horizontal split button (⬍) for top-bottom

### Resizing Panes

1. **Hover over the divider** between two panes
2. Divider highlights blue
3. **Click and drag** to resize
4. Both panes adjust proportionally
5. Minimum size: 200px to prevent unusable panes

**Tips:**
- Resize is smooth and responsive
- Terminal content automatically reflows
- Size percentages are saved to database

### Closing Panes

1. **Click the pane** you want to close
2. **Press Cmd+W**
3. Remaining panes automatically rebalance
4. Last pane cannot be closed (becomes single-pane layout)

**Behavior:**
- Focus automatically moves to remaining pane
- Layout tree collapses and rebalances
- Closed pane's PTY process terminates gracefully

### Navigation

Use **Cmd+Alt+Arrow** keys to move focus between panes without touching the mouse. This is especially useful when working across multiple sessions.

**Navigation Logic:**
- Arrow keys cycle through panes in layout order
- Focus indicator (blue border) follows keyboard navigation
- Works seamlessly with click-to-focus

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

**Example workflow:**
1. Open tab with your project directory
2. Split vertically (Cmd+D)
3. SSH into production server in right pane
4. Compare configurations, logs, or file contents

### Monitoring Multiple Servers
```
┌────────────┬────────────┐
│  Server 1  │  Server 2  │
├────────────┼────────────┤
│  Server 3  │  Server 4  │
└────────────┴────────────┘
```
Create a grid to monitor logs from multiple servers simultaneously.

**Example workflow:**
1. Start with single pane
2. Split vertically (Cmd+D) → 2 panes
3. Focus left pane, split horizontally (Cmd+Shift+D) → 3 panes
4. Focus right pane, split horizontally (Cmd+Shift+D) → 4 panes
5. SSH into different servers in each pane
6. Run `tail -f /var/log/syslog` in each

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

**Example workflow:**
1. Open project directory
2. Split horizontally (Cmd+Shift+D)
3. Top pane: `vim src/main.rs`
4. Bottom pane: `cargo watch -x test`
5. See test results immediately as you code

### Network Troubleshooting
```
┌─────────┬──────────┬─────────┐
│  Ping   │  Tracert │  Wireshark
│         │          │         │
└─────────┴──────────┴─────────┘
```
Three-way split for parallel diagnostic tools.

**Example workflow:**
1. Split vertically twice
2. Left pane: `ping 8.8.8.8`
3. Middle pane: `traceroute example.com`
4. Right pane: `tcpdump -i eth0`
5. Observe network behavior in real-time

## Architecture

### Layout Tree Structure

Pane layouts are represented as a recursive tree:

```typescript
type PaneNode = PaneLeaf | PaneSplit;

type PaneLeaf = {
  type: 'leaf';
  id: string;
  terminalId: string;
  size: number; // Percentage (0-100)
};

type PaneSplit = {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: PaneNode[];
};
```

**Example tree for 2x2 grid:**
```
Split (vertical)
├─ Split (horizontal)
│  ├─ Leaf (terminal-1)
│  └─ Leaf (terminal-2)
└─ Split (horizontal)
   ├─ Leaf (terminal-3)
   └─ Leaf (terminal-4)
```

Each split can contain more splits, allowing arbitrarily complex layouts.

### State Management

**panesStore.ts (Zustand):**
- Maintains `Map<tabId, PaneNode>` for all layouts
- Tracks `focusedPaneId` for focus management
- Provides actions: `splitPane`, `closePane`, `resizePane`, `navigateFocus`

**Data Flow:**
```
User Action (keyboard/click/drag)
  ↓
panesStore Action
  ↓
Tree Mutation (immutable)
  ↓
React Re-render (PaneContainer recursion)
  ↓
Tauri Command (persist to SQLite)
```

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

**When layouts are saved:**
- On split (new pane added)
- On close (pane removed)
- On resize (sizes updated)

**When layouts are loaded:**
- Tab creation (if saved layout exists)
- Tab switch (lazy load on first view)
- App startup (restore all tabs)

When you switch tabs or restart the app, layouts are restored exactly as you left them.

### Component Hierarchy

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

**Key Components:**
- **PaneContainer**: Recursive component that renders either a Pane or nested splits
- **Pane**: Wrapper with focus indicator, contains Terminal component
- **PaneHandle**: Draggable divider between panes for resizing
- **Terminal**: xterm.js instance with PTY connection (one per pane)

## Performance

### Resource Usage

- **Memory**: Each pane has its own PTY (~2MB per pane)
- **CPU**: Minimal overhead when idle, scales with active processes
- **Recommended Maximum**: 4-6 panes per tab for smooth performance

### Optimization Techniques

- **Lazy Rendering**: Only render visible panes
- **Debounced Resize**: Resize events throttled to prevent lag
- **Efficient Tree Updates**: Immutable state updates prevent unnecessary re-renders
- **PTY Isolation**: Each pane's PTY runs independently

### Performance Tips

1. **Limit Pane Count**: Keep to 4-6 panes for best experience
2. **Close Unused Panes**: Free up resources by closing panes you're not using
3. **Resize Smoothly**: Avoid rapid dragging - resize in deliberate movements
4. **Use Blocks Mode**: Blocks mode is lighter weight than Terminal mode for simple commands

## Limitations

Current phase (Phase 2) intentionally defers some features:

- **No synchronized input**: Cannot broadcast input to multiple panes simultaneously (planned for Phase 3)
- **No pane zoom/maximize**: Cannot temporarily expand one pane to full tab (planned for Phase 3)
- **No drag-and-drop reordering**: Cannot rearrange panes by dragging (planned for Phase 3)
- **No saved layout templates**: Cannot save/load named layout presets (planned for Phase 4)

## Troubleshooting

### Pane won't split

**Symptom**: Pressing Cmd+D or Cmd+Shift+D does nothing.

**Solution**: Make sure a pane is focused (blue border). Click it first, then press split shortcut.

**Root Cause**: Split commands target the focused pane. Without focus, there's no pane to split.

### Can't resize pane

**Symptom**: Dragging divider doesn't move or stops prematurely.

**Solution**: Minimum size is 200px. If a pane is already at minimum, it can't shrink further.

**Workaround**: Close the pane if you don't need it, or resize from a different divider.

### Focus indicator missing

**Symptom**: No blue border visible on any pane.

**Solution**: Check that you've clicked the pane. Focus management requires explicit click or keyboard navigation.

**Debugging**: Open browser DevTools (in dev mode) and check `usePanesStore.focusedPaneId` state.

### Layout not restored

**Symptom**: Pane layout resets to single pane after app restart or tab switch.

**Solution**: Layout persistence requires tab ID to match. If you close and recreate a tab, it gets a new ID and starts with default single-pane layout.

**Workaround**: Keep tabs open to preserve layouts. Use session management to save/restore tab state.

### Pane content not visible

**Symptom**: Pane appears but no terminal content visible.

**Solution**: Terminal may not have initialized. Try clicking the pane to focus it, then typing a command.

**Debugging**: Check browser console for PTY errors. Verify shell process spawned correctly.

### Keyboard shortcuts not working

**Symptom**: Cmd+D, Cmd+W, or navigation shortcuts don't work.

**Solution**: 
1. Ensure CCIE Terminal window is focused (not just the terminal pane)
2. Check for conflicting system keyboard shortcuts
3. On Linux/Windows, use Ctrl instead of Cmd

**Verification**: Test with split buttons in TabBar - if those work, it's a keyboard shortcut issue.

### Performance degradation with many panes

**Symptom**: Terminal becomes sluggish with 6+ panes.

**Solution**:
1. Close unused panes (Cmd+W)
2. Limit to 4-6 panes per tab
3. Use multiple tabs instead of many panes

**Why**: Each pane runs an independent PTY process. Too many concurrent processes can impact performance.

## Best Practices

### Layout Organization

1. **Group Related Tasks**: Put related terminals in the same tab with splits
2. **Logical Arrangement**: Place frequently-compared panes side-by-side
3. **Consistent Sizes**: Use similar sizes for panes with similar content
4. **Leave Space**: Don't make panes too small - text wrapping reduces readability

### Workflow Efficiency

1. **Learn Keyboard Shortcuts**: Faster than clicking buttons or dragging
2. **Use Navigation Keys**: Cmd+Alt+Arrow is faster than clicking to focus
3. **Bookmark Commands**: Combine splits with Command Palette for repeatable workflows
4. **Save Sessions**: Use session management to preserve complex layouts

### Resource Management

1. **Close When Done**: Don't leave unused panes open
2. **Monitor Performance**: If sluggish, reduce pane count
3. **Use Terminal Mode for SSH**: Blocks mode adds overhead for interactive sessions
4. **Restart PTY if Frozen**: Close pane and create new one if terminal stops responding

## Integration with Other Features

### Command Blocks

Split panes work seamlessly with command blocks:
- Each pane maintains its own command history
- Blocks persist per pane when switching modes
- Bookmarks and recent commands are pane-specific

### AI Chat Panel

AI chat is tab-scoped, not pane-scoped:
- AI context includes all panes in current tab
- Commands generated by AI go to focused pane
- Chat history shared across all panes in tab

### Search

Search operates across all panes:
- Command search finds commands from any pane
- Results show which pane executed the command
- Click result to view in originating pane

### Session Management

Pane layouts are included in saved sessions:
- Save session preserves all pane arrangements
- Load session restores splits exactly
- Export/import includes full layout tree

## Advanced Usage

### Creating Custom Layouts

**Example: Development Dashboard**
```
┌──────────────┬─────────┐
│              │ Logs    │
│  Code Editor │         │
│              ├─────────┤
│              │ Tests   │
├──────────────┴─────────┤
│  Git / CLI             │
└────────────────────────┘
```

Steps:
1. Start with single pane
2. Cmd+Shift+D (horizontal split) → top/bottom
3. Focus top, Cmd+D (vertical split) → left/right on top
4. Focus top-right, Cmd+Shift+D (horizontal split) → split right side
5. Resize dividers to preferred sizes

**Example: Multi-Server Monitoring**
```
┌─────┬─────┬─────┐
│  1  │  2  │  3  │
├─────┼─────┼─────┤
│  4  │  5  │  6  │
└─────┴─────┴─────┘
```

Steps:
1. Cmd+D, Cmd+D (3 columns)
2. Focus left, Cmd+Shift+D
3. Focus middle, Cmd+Shift+D
4. Focus right, Cmd+Shift+D

### Scripting Workflows

While synchronized input isn't available yet, you can:
1. Prepare command in one pane (with AI assistance)
2. Copy command with Cmd+C
3. Navigate to other panes (Cmd+Alt+Arrow)
4. Paste and execute

**Tip**: Use Command Palette (Cmd+K) to insert bookmarked commands across panes.

## Future Roadmap

### Phase 3 (Planned)
- **Synchronized Input**: Broadcast commands to multiple panes
- **Pane Zoom**: Maximize pane to full tab temporarily
- **Drag-and-Drop**: Reorder panes by dragging

### Phase 4 (Planned)
- **Layout Templates**: Save and load named layout presets
- **Per-Pane Profiles**: Different AI profiles for each pane
- **Pane Linking**: Link panes for coordinated scrolling

### Community Requests
- Submit feature requests on GitHub
- Vote on upcoming features
- Contribute to implementation

## Related Documentation

- [User Guide](USER_GUIDE.md) - General CCIE Terminal usage
- [Architecture](ARCHITECTURE.md) - Technical implementation details
- [Keyboard Shortcuts](USER_GUIDE.md#keyboard-shortcuts) - Complete shortcut reference
- [Command Blocks](COMMAND_BLOCKS.md) - Command history and blocks system

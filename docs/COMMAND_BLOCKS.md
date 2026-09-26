# Command Blocks

Command blocks transform CCIE Terminal from a continuous scroll into discrete, manageable command units. Each command you execute becomes a block with:

- Command text and working directory
- Execution timestamp and duration
- Exit code (success/failure)
- Full output (collapsible)
- Interactive actions (bookmark, rerun, copy, share)

## Dual-Mode Architecture

CCIE Terminal supports two complementary terminal modes that you can switch between at any time:

### Terminal Mode (Default)

Traditional xterm.js terminal with full PTY access:
- **Best for**: Interactive programs (SSH, vim, top, less), full shell features
- **Features**: Full terminal emulation, cursor control, ANSI colors, interactive input
- **Interface**: Single continuous xterm.js instance with scrollback
- **Use cases**: SSH sessions, text editors, interactive tools, complex shell programs

### Blocks Mode

Warp-inspired interface with discrete command history:
- **Best for**: Simple commands, organized history, command reuse workflows
- **Features**: Automatic block creation, collapsible outputs, clean history view
- **Interface**: Separate blocks for each command + bottom input editor
- **Use cases**: Command history browsing, command bookmarking, simple shell commands
- **Limitation**: Interactive commands (SSH, vim, etc.) don't work in blocks mode

### Mode Toggle

Switch between modes instantly with the toggle buttons at the top of each terminal tab:
- **Terminal button**: Switch to traditional terminal mode
- **Blocks button**: Switch to blocks mode with command history
- Mode preference is per-tab (different tabs can use different modes)
- All command history is preserved regardless of which mode you're in

### Hybrid Implementation

CCIE Terminal uses a **hybrid rendering approach** to support both modes efficiently:

- **Terminal Mode**: Single xterm.js instance renders PTY output directly
- **Blocks Mode**: Hidden xterm.js captures PTY output, visible blocks render as React components
- **Block metadata**: Stored in SQLite for persistence and search across both modes

This design enables:
- Seamless mode switching without losing terminal state
- Smooth collapse/expand animations in blocks mode
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

### Choosing the Right Mode

**Use Terminal Mode for:**
- SSH sessions to remote servers
- Text editors (vim, nano, emacs)
- Interactive tools (top, htop, less, more)
- Full-screen applications
- Complex shell scripts with interactive prompts
- Any command that needs raw terminal control

**Use Blocks Mode for:**
- Simple command execution (ls, grep, find)
- Building command history for workflows
- Browsing and reusing previous commands
- Bookmarking frequently-used commands
- Clean presentation of command outputs
- Organizing work into discrete command units

### Switching Modes

At the top of each terminal tab, you'll see two toggle buttons:

**Terminal** | **Blocks**

- Click **Terminal** to switch to traditional terminal mode
- Click **Blocks** to switch to blocks mode with history view
- Current mode is highlighted with an active state
- Switching modes preserves all command history

### Block Operations (Blocks Mode)

**Collapse/Expand**
- Click block header to toggle
- Collapsed blocks show line count hint
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

### Pinning, Tagging, Sharing

These actions are persisted to SQLite (migration `V0028`) and survive app restart.

**Pin to top** — `block_pins`
- Toggle the 📌 button in the block header, or use **⌘K P** with a focused block.
- Pinned blocks appear in a sticky **PinnedRow** above the virtualized list, in the order they were pinned.
- Drag-and-drop within the pinned row to reorder; new positions are written to `block_pins.position` sequentially (no parallel writes — fast double-drops are gated to avoid interleaving).
- Toggling again unpins.

**Tag a block** — `block_tags`
- Each block can carry one or more free-form tags (e.g. `site-atl`, `golden`, `pre-change`).
- Add tags via the inline tag chip strip on the block header (hover to reveal the **+** affordance), or use **⌘K T** to open the tag input on the focused block.
- Tags are listed alphabetically. Click the **×** on a chip to remove a single tag.
- A **TagFilterBar** at the top of the block list filters with **AND** semantics — selecting `site-atl` and `golden` shows only blocks carrying both.
- Tag-based scoping is also consumed by downstream features (Plans 06 Pre/Post Verification and 07 Multi-Device Fan-Out).

**Share a block** — `block_shares` + deep links
- Open the **share popover** from the block header or use **⌘K S**.
- The first share creates a `block_shares` row (uuidv4 share id) with a frozen JSON snapshot of the block — the share survives even if the original block is deleted (`ON DELETE SET NULL`).
- The popover offers four actions:
  - **Copy link** — copies `ccie-terminal://block/<share_id>` to the clipboard. Opening that URL in another CCIE Terminal instance jumps to the block if local, or imports the snapshot if foreign.
  - **Copy as Markdown** — fenced code block with the command, output, exit code, and any AI explanation.
  - **Copy as JSON** — full block payload, suitable for pasting into tickets or scripts.
  - **Save to file…** — Tauri save-dialog writing markdown or JSON to disk.
- **Revoke** removes the row from `block_shares`; subsequent fetches via the deep link return "not found" and the popover transitions back to the create state.

### Block Navigation Focus

Use **⌘↑** and **⌘↓** to walk the focus cursor between blocks without leaving the keyboard. The focused block is the implicit target of the **⌘K** chord shortcuts (B / P / T / S below).

### Keyboard Shortcuts

All shortcuts are wired by `useBlockShortcuts` and only fire while the active tab is in **Blocks Mode**. Shortcuts that target a single block (`⌘K B/P/T/S`) act on the focused block.

| Shortcut | Action |
|----------|--------|
| `⌘↑` / `Ctrl+↑` | Focus previous block |
| `⌘↓` / `Ctrl+↓` | Focus next block |
| `⌘K` then `B` | Toggle collapse on focused block |
| `⌘K` then `P` | Toggle pin on focused block |
| `⌘K` then `T` | Add a tag to focused block (opens inline input) |
| `⌘K` then `S` | Create / copy share link for focused block |
| `Esc` | Cancel a pending `⌘K` chord |

The `⌘K` chord has a 1.5 s timeout — pressing nothing within the window cancels and frees `⌘K` for the global command palette. Pressing `⌘K` inside an `<input>`/`<textarea>` is ignored so typing is never hijacked.

### Input Editor (Blocks Mode)

When in blocks mode, the input editor appears at the bottom:

- **Type commands**: Simple text input, no terminal emulation
- **Execute**: Press Enter to run command
- **Command history**: Use Up/Down arrows to navigate previous commands
- **Multi-line**: Press Shift+Enter for newline (for complex commands)
- **Clear**: Ctrl+C to clear current input
- **EOF**: Ctrl+D to send EOF signal

### Command Palette

Press **Cmd+K** (or **Ctrl+K** on Windows/Linux) to open the universal command launcher:

**Available items:**
- **Recent Commands**: Last 20 commands from current tab (📋 icon)
- **Bookmarked Commands**: All bookmarked blocks (⭐ icon)
- **Actions**: Built-in actions like "New Tab", "Search History", "Toggle Agent Panel" (⚙️ icon)

**Fuzzy Search**:
Type any part of a command to filter results. Uses Fuse.js for intelligent matching:
- `git st` matches "git status"
- `ans play` matches "ansible-playbook"
- `ssh prod` matches "ssh user@prod-server-01"
- Searches both command text and working directory

**Keyboard Navigation**:
- `↑` / `↓` - Navigate items
- `Enter` - Execute selected item (command) or perform action
- `Esc` - Close palette

**Usage Tips**:
- Works in both Terminal and Blocks modes
- Commands execute in the context of the current tab
- Bookmarked commands persist across sessions
- Recent commands are tab-specific
- Use the palette to quickly switch between common workflows

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
  collapsed INTEGER NOT NULL DEFAULT 0,   -- V0028: persistent collapse state
  FOREIGN KEY (tab_id) REFERENCES tabs(id)
);

-- V0028 — Plan 01 Phase 1
CREATE TABLE block_tags (
  block_id TEXT NOT NULL REFERENCES command_blocks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (block_id, tag)
);
CREATE INDEX idx_block_tags_tag ON block_tags(tag);

CREATE TABLE block_pins (
  block_id TEXT PRIMARY KEY REFERENCES command_blocks(id) ON DELETE CASCADE,
  pinned_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE block_shares (
  share_id TEXT PRIMARY KEY,                 -- uuidv4
  block_id TEXT REFERENCES command_blocks(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL,                -- frozen snapshot, survives block deletion
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

## OSC 133 Sequences

CCIE Terminal uses OSC (Operating System Command) 133 sequences for shell integration:

### Sequence Types

| Sequence | Description | Example |
|----------|-------------|---------|
| `OSC 133;A` | Prompt start | Sent before showing prompt |
| `OSC 133;B` | Prompt end | Sent after prompt, before user input |
| `OSC 133;C` | Command start | Sent when user presses Enter |
| `OSC 133;D;<exit>` | Command end | Sent after command completes |
| `OSC 133;E;<cmd>` | Command line | Contains the actual command text |

### Shell Configuration

Add to your shell's RC file (e.g., `~/.zshrc` or `~/.bashrc`):

```bash
# CCIE Terminal integration
if [ -n "$CCIE_TERMINAL" ]; then
  source ~/.config/ccie-terminal/shell-integration/ccie-terminal.zsh
fi
```

This enables:
- Automatic command block creation
- Exit code tracking
- Command text capture
- Duration calculation

## Future Enhancements

- **AI Analysis**: Automatic error explanation for failed commands
- **Workflows**: Chain blocks into reusable sequences (Plan 02)
- **Notebooks**: Mix blocks with markdown notes (Plan 03)
- **Search**: Full-text search across all block outputs
- **Diff View**: Compare outputs between block reruns
- **Block Groups**: Organize related blocks together
- **Smart Suggestions**: AI-powered command suggestions based on context
- **Team Sharing (Warp Drive-style)**: Cross-machine share index — deferred until backend/auth design is locked.

## Troubleshooting

### Blocks Not Appearing

1. Make sure you're in **Blocks Mode** (click the "Blocks" toggle button)
2. Verify shell integration is loaded:
   ```bash
   echo $CCIE_TERMINAL
   ```
   Should output "1" if integration is active.

3. Check that OSC sequences are enabled in your shell RC file

4. Restart the terminal tab to reload shell configuration

### Interactive Commands Not Working in Blocks Mode

If commands like SSH, vim, or top aren't working:

1. **Switch to Terminal Mode** using the toggle button at the top
2. Terminal Mode provides full PTY access for interactive programs
3. Blocks Mode is designed for simple, non-interactive commands only

### Exit Codes Not Showing

- Ensure `OSC 133;D` sequence includes exit code parameter
- Check shell hooks are properly configured in `precmd`/`PROMPT_COMMAND`
- Shell integration must be sourced in your shell RC file

### Collapse/Expand Not Working

- Verify block has output (empty blocks auto-collapse)
- Check browser console for JavaScript errors
- Try refreshing the application
- Ensure you're viewing blocks in Blocks Mode

### Command Palette Not Opening

- Check that you're pressing Cmd+K (macOS) or Ctrl+K (Windows/Linux)
- Ensure no other application is capturing the shortcut
- Try clicking directly on a recent command in blocks mode

### Mode Toggle Not Visible

- Verify you're on the latest version of CCIE Terminal
- Check that the Terminal component is properly loaded
- Try creating a new tab to reset the interface

### Performance Issues

- Enable block virtualization for tabs with 100+ blocks
- Reduce scrollback buffer size in settings
- Clear old blocks: Settings → Advanced → Clear History
- Use Terminal Mode for long-running or output-heavy commands

## Technical Details

### Block State Machine

```
┌─────────┐  OSC 133;E   ┌─────────┐  Output   ┌───────────┐
│  Idle   │─────────────→│ Running │──────────→│ Streaming │
└─────────┘              └─────────┘           └─────┬─────┘
                                                      │
                                                      │ OSC 133;D
                                                      ↓
                                              ┌──────────────┐
                                              │  Completed   │
                                              └──────────────┘
```

### React Component Hierarchy

```
<Terminal>
  <BlocksColumn>
    <VirtualList>  <!-- Only if 100+ blocks -->
      <CommandBlock>
        <BlockHeader>
          <CommandText />
          <ExitCode />
          <ActionButtons />
        </BlockHeader>
        <BlockOutput collapsed={state}>
          <OutputText />  <!-- Plain text for completed -->
          <XtermTerminal />  <!-- Live xterm for active -->
        </BlockOutput>
      </CommandBlock>
    </VirtualList>
  </BlocksColumn>
  <ActiveTerminal />
</Terminal>
```

### Zustand Store Structure

```typescript
interface BlocksStore {
  blocks: Map<string, CommandBlock>;  // blockId -> block
  activeBlockId: string | null;
  
  // Actions
  startBlock(cmd: string, cwd: string): string;
  appendOutput(blockId: string, data: string): void;
  completeBlock(blockId: string, exitCode: number): void;
  toggleCollapse(blockId: string): void;
  toggleBookmark(blockId: string): void;
  rerunBlock(blockId: string): void;
  copyOutput(blockId: string): void;
}
```

## Best Practices

### Command Organization

1. **Use Bookmarks**: Mark frequently-used commands for quick access
2. **Collapse Long Outputs**: Keep terminal view clean by collapsing large outputs
3. **Review Exit Codes**: Red exit codes indicate failures worth investigating
4. **Use Command Palette**: Faster than scrolling through history

### Performance Tips

1. **Clear Old Blocks**: Periodically clear blocks you no longer need
2. **Avoid Huge Outputs**: Redirect large outputs to files when possible
3. **Use Filters**: Filter command history in palette instead of browsing all blocks

### Workflow Optimization

1. **Bookmark Workflows**: Bookmark each step of common workflows
2. **Rerun Commands**: Use rerun button instead of retyping
3. **Copy Clean Output**: Use copy button to get output without escape codes
4. **Search Outputs**: Use Cmd+F to search within block outputs

## Comparison with Other Terminals

### vs. Traditional Terminals (iTerm2, Terminal.app)

| Feature | CCIE Terminal | Traditional |
|---------|---------------|-------------|
| Block boundaries | Automatic | Manual (marks) |
| Collapse/expand | Yes | No |
| Per-command actions | Yes | No |
| Search in output | Yes | Limited |
| Persistence | SQLite | Session-based |

### vs. Warp

| Feature | CCIE Terminal | Warp |
|---------|---------------|------|
| Command blocks | Yes | Yes |
| AI integration | Deep (Claude) | Yes (proprietary) |
| Open source | Yes | No |
| Shell support | All POSIX | All POSIX |
| Customization | Full control | Limited |

### vs. Fig

| Feature | CCIE Terminal | Fig |
|---------|---------------|-----|
| Block paradigm | Full blocks | Autocomplete focused |
| AI assistant | Built-in | Plugin |
| Terminal emulation | xterm.js | Native |
| Platform | Cross-platform | macOS only |

## References

- [OSC 133 Specification](https://gitlab.freedesktop.org/Per_Bothner/specifications/-/blob/master/proposals/semantic-prompts.md)
- [xterm.js Documentation](https://xtermjs.org/)
- [React Window](https://react-window.vercel.app/)
- [Zustand State Management](https://zustand-demo.pmnd.rs/)

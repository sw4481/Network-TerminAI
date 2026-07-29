# Command Blocks Redesign - Warp-Style Architecture

## Problem Statement

Current implementation has fundamental issues:
- Trying to use xterm for both input and output
- Local echo is buggy (can backspace over prompt)
- Container refs causing remounts
- Blocks tried to wrap xterm, causing lifecycle issues

## Solution: Separate Input/Output

Follow Warp's proven architecture:
1. **Separate Input Editor** - Full text editor for command input
2. **Read-only Output** - Blocks show command results
3. **Hidden PTY Bridge** - xterm captures output, not visible for input

## Architecture

```
┌─────────────────────────────────────────┐
│         Command History (Blocks)        │
│  ┌─────────────────────────────────┐   │
│  │ $ ls -la                         │   │
│  │ Output: [files...]               │   │
│  │ Exit: 0 | 125ms | 11:23 AM      │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │ $ pwd                            │   │
│  │ Output: /Users/...               │   │
│  │ Exit: 0 | 45ms | 11:24 AM       │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
┌─────────────────────────────────────────┐
│         Input Editor (Monaco/Custom)    │
│  $ █                                    │
│                                         │
└─────────────────────────────────────────┘
┌─────────────────────────────────────────┐
│  Hidden xterm (captures PTY output)     │
│  Not rendered, just for data capture    │
└─────────────────────────────────────────┘
```

## Components

### 1. InputEditor Component
- Monaco Editor (lightweight mode) OR custom textarea
- Full editing: cursor movement, selection, copy/paste, undo
- Enter key sends command
- Keyboard shortcuts (Ctrl+C, Ctrl+D)
- Command history (Up/Down arrows)
- PS1 prompt display (read from PTY)

### 2. CommandBlock Component (existing, enhance)
- Display command text
- Display output (plain text, not xterm)
- Metadata: exit code, duration, timestamp
- Actions: copy, rerun, bookmark
- Collapsible output

### 3. PTY Bridge (hidden xterm)
- xterm.js instance not rendered to DOM
- Captures PTY output for current command
- No user input handling
- Just a data pipe

### 4. BlocksStore (existing, enhance)
- Add "pending" block state
- Track current command being executed
- Buffer output until command completes

## Implementation Plan

### Phase 1: Input Editor (2-3 hours)
1. Create InputEditor component with textarea
2. Add prompt display (static "$ " for now)
3. Wire up Enter key → send to PTY
4. Style to match terminal aesthetic
5. Add command history (Up/Down)

### Phase 2: Output Capture (1-2 hours)
1. Make xterm hidden (render off-screen)
2. Modify usePty to not attach onData for user input
3. Keep output capture working
4. Test commands still execute

### Phase 3: Blocks Integration (2-3 hours)
1. Enable blocks rendering (remove TODO comment)
2. Show pending block while command runs
3. Update block with output on completion
4. Clear input after command sent

### Phase 4: Polish (1-2 hours)
1. Add Monaco editor (optional upgrade)
2. Syntax highlighting for commands
3. Autocomplete (future)
4. Error handling

## Benefits

✓ No local echo issues - editor handles all input
✓ No backspace over prompt - editor knows boundaries
✓ Full text editing capabilities
✓ No ref/mounting issues - components are stable
✓ Clean separation of concerns
✓ Foundation for AI features (command suggestions, inline completions)

## Implementation Notes

- Start simple (textarea) before Monaco
- Keep PTY working throughout
- Test each phase independently
- Can fall back to old terminal if needed

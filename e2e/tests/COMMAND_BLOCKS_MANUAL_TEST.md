# Command Blocks - Manual Testing Guide

## Overview

The E2E tests in `command-blocks.spec.ts` are currently **skipped** because they require proper WebDriver setup via `tauri-driver`. This document provides a manual testing checklist to verify all command blocks functionality.

## Why Tests Are Skipped

The current E2E infrastructure has the following limitations:

1. **Mock Page Object**: `tauri-driver.ts` uses a mock page that logs actions but cannot interact with the actual UI
2. **No WebDriver**: Tauri apps use native webviews (not Chromium) which require WebDriver protocol
3. **No tauri-driver**: The proper WebDriver implementation for Tauri is not installed or configured

### To Enable Automated Tests (Future Work)

1. Install tauri-driver:
   ```bash
   cargo install tauri-driver
   ```

2. Update `e2e/tauri-driver.ts` to connect via WebDriver instead of mock

3. Configure Playwright to use WebDriver protocol

4. Update test selectors to match actual DOM structure

5. Remove `test.describe.skip` from `command-blocks.spec.ts`

## Manual Testing Checklist

Until automated tests are enabled, use this checklist to verify functionality.

---

### Test 1: Block Creation (Terminal Mode)

**Scenario**: Blocks are created when commands complete in Terminal mode

**Steps**:
1. Launch the app
2. Ensure you're in **Terminal mode** (not Blocks mode)
3. Run a simple command: `echo "Hello World"`
4. Wait for command to complete
5. Look for block creation in the history

**Expected**:
- Block should be created via OSC 133 sequences
- Block should show command text "echo Hello World"
- Block should display output "Hello World"

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 2: Block Creation (Blocks Mode)

**Scenario**: Blocks are created when commands execute in Blocks mode

**Steps**:
1. Launch the app
2. Click the **Blocks** mode button
3. Type in InputEditor: `echo "Test"`
4. Press Enter
5. Observe block creation

**Expected**:
- Block appears immediately with command text
- Output appears after command completes
- InputEditor stays at bottom for next command

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 3: Exit Code Display

**Scenario**: Exit codes are shown after command completes

**Steps**:
1. In Blocks mode, run: `true` (exit code 0)
2. Wait for completion
3. Check block header for exit code
4. Run: `false` (exit code 1)
5. Wait for completion
6. Check exit code color

**Expected**:
- `true` command shows "exit 0" in green
- `false` command shows "exit 1" in red
- Exit codes appear in block header metadata

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 4: Collapse/Expand Blocks

**Scenario**: Blocks can be collapsed and expanded

**Steps**:
1. Run command with output: `ls -la`
2. Wait for completion
3. Click block header to collapse
4. Verify output is hidden
5. Click header again to expand
6. Verify output reappears

**Expected**:
- First click: output disappears, shows "N lines (click to expand)"
- Collapse button rotates (▶ icon)
- Second click: output reappears
- Smooth animation transition

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 5: Bookmark Blocks

**Scenario**: Blocks can be bookmarked for quick access

**Steps**:
1. Run command: `echo "important"`
2. Wait for completion
3. Find bookmark button (★) in block actions
4. Click bookmark button
5. Verify bookmark indicator appears
6. Click again to unbookmark

**Expected**:
- First click: bookmark indicator (★) appears in header
- Button changes visual state (highlighted)
- Second click: bookmark removed
- Bookmarked blocks persist across sessions

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 6: Command Palette (Cmd+K)

**Scenario**: Command palette opens with keyboard shortcut

**Steps**:
1. Press `Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux)
2. Observe palette modal
3. Check for search input
4. Press `Escape` to close

**Expected**:
- Palette modal appears centered on screen
- Search input is focused automatically
- Background overlay is semi-transparent
- Escape key closes the palette

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 7: Palette Search Filtering

**Scenario**: Palette filters items by search query

**Steps**:
1. Run diverse commands:
   - `git status`
   - `npm install`
   - `ls -la`
2. Open palette with `Cmd+K`
3. Type "git" in search
4. Observe filtered results
5. Clear search
6. Type "npm"
7. Observe new results

**Expected**:
- "git" search shows only git-related items
- "npm" search shows only npm-related items
- Fuzzy matching works (e.g., "gs" matches "git status")
- Results update as you type

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 8: Palette Keyboard Navigation

**Scenario**: Palette items can be navigated with arrow keys

**Steps**:
1. Run 3+ commands
2. Open palette with `Cmd+K`
3. Press `ArrowDown` twice
4. Verify selection moves down
5. Press `ArrowUp` once
6. Verify selection moves up
7. Press `Enter` to execute selected item

**Expected**:
- ArrowDown: selection moves to next item
- ArrowUp: selection moves to previous item
- Selected item has visual highlight
- Enter executes the selected command
- Palette closes after execution

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 9: Palette with Bookmarks

**Scenario**: Bookmarked commands appear in palette

**Steps**:
1. Bookmark 2-3 commands (different from recent)
2. Open palette
3. Look for bookmark section/icon
4. Verify bookmarked commands are listed

**Expected**:
- Bookmarked commands have ⭐ icon
- Bookmarks may be in separate section or mixed with recents
- Selecting bookmark executes the command

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

### Test 10: Mode Toggle

**Scenario**: Switching between Terminal and Blocks mode

**Steps**:
1. Start in Terminal mode
2. Run: `echo "terminal"`
3. Switch to Blocks mode
4. Type: `echo "blocks"`
5. Press Enter
6. Switch back to Terminal mode
7. Verify both commands are visible

**Expected**:
- Terminal mode: xterm visible, traditional prompt
- Blocks mode: InputEditor at bottom, blocks history above
- Commands from both modes appear in history
- Switching modes doesn't lose data

**Actual**: ___________

**Status**: [ ] PASS [ ] FAIL

**Notes**: _____________________________

---

## Architecture Notes

### Terminal Mode (Default)
- Full PTY access via xterm.js
- Supports interactive commands (ssh, vim, top)
- Blocks created via OSC 133 sequences emitted by shell
- Commands typed directly in xterm

### Blocks Mode
- Warp-style interface
- InputEditor component for command entry
- Non-interactive commands only
- Blocks created immediately when command submitted
- Better for simple command history and review

### OSC 133 Integration
The shell (bash/zsh) is configured to emit OSC 133 sequences:
- `OSC 133;A` - Before prompt
- `OSC 133;B` - Before command
- `OSC 133;C` - Before output
- `OSC 133;D;exitCode` - After command completes

These sequences are captured by `usePty.ts` and used to create blocks automatically.

## Test Results Summary

| Test | Status | Notes |
|------|--------|-------|
| 1. Block Creation (Terminal) | | |
| 2. Block Creation (Blocks) | | |
| 3. Exit Code Display | | |
| 4. Collapse/Expand | | |
| 5. Bookmark Blocks | | |
| 6. Command Palette (Cmd+K) | | |
| 7. Palette Search | | |
| 8. Palette Navigation | | |
| 9. Palette Bookmarks | | |
| 10. Mode Toggle | | |

**Overall Status**: ___________

**Tested By**: ___________

**Date**: ___________

**Environment**:
- OS: ___________
- App Version: ___________
- Shell: ___________

## Known Issues

Document any issues found during testing:

1. ___________________________________________
2. ___________________________________________
3. ___________________________________________

## Follow-Up Tasks

- [ ] Set up tauri-driver for automated E2E tests
- [ ] Add data-testid attributes to components for easier selection
- [ ] Create integration tests for Tauri commands
- [ ] Add visual regression tests for block UI
- [ ] Test on Windows and Linux (currently macOS only)

# Split Panes Manual Test Checklist

> **Phase 2 Implementation Verification**  
> Execute these tests to verify split panes functionality before Phase 3.

## Test Environment

- **App Version:** Phase 2 Complete
- **Platform:** macOS
- **Test Date:** 2026-05-02
- **Tester:** 

---

## Basic Operations

### 1. Single Pane Initialization

- [ ] **App starts with single pane**
  - Open app
  - Single pane with terminal visible
  - Blue focus border present
  - Terminal accepts input (type `echo "hello"`)
  - Expected: Single functional pane

### 2. Vertical Split (Cmd+D)

- [ ] **Create vertical split**
  - Start with single pane
  - Press Cmd+D
  - New pane appears on right
  - Both panes approximately 50/50 width
  - Right pane is focused (blue border)
  - Left pane has gray border
  - Expected: Two side-by-side panes

- [ ] **Independent terminal sessions**
  - Type `pwd` in left pane
  - Type `pwd` in right pane
  - Both should have their own output
  - Expected: Separate PTY sessions

### 3. Horizontal Split (Cmd+Shift+D)

- [ ] **Create horizontal split**
  - Start with single pane
  - Press Cmd+Shift+D
  - New pane appears below
  - Both panes approximately 50/50 height
  - Bottom pane is focused
  - Expected: Two stacked panes

- [ ] **Independent terminal sessions**
  - Type different commands in each pane
  - Both should maintain separate history
  - Expected: Separate PTY sessions

---

## Resizing

### 4. Vertical Divider Drag

- [ ] **Drag vertical divider**
  - Create vertical split (Cmd+D)
  - Hover over divider between panes
  - Cursor changes to ew-resize (⟷)
  - Divider highlights blue on hover
  - Drag left → left pane shrinks, right grows
  - Drag right → left pane grows, right shrinks
  - Release → sizes persist
  - Expected: Smooth proportional resize

### 5. Horizontal Divider Drag

- [ ] **Drag horizontal divider**
  - Create horizontal split (Cmd+Shift+D)
  - Hover over divider between panes
  - Cursor changes to ns-resize (⟱)
  - Divider highlights blue on hover
  - Drag up → top pane shrinks, bottom grows
  - Drag down → top pane grows, bottom shrinks
  - Release → sizes persist
  - Expected: Smooth proportional resize

### 6. Minimum Size Enforcement

- [ ] **Cannot resize below minimum**
  - Create vertical split
  - Drag divider all the way left
  - Pane stops at ~200px minimum
  - Terminal remains functional at minimum size
  - Expected: Minimum size enforced (200px)

---

## Focus Management

### 7. Click to Focus

- [ ] **Click focus behavior**
  - Create 2+ panes
  - Click left pane → blue border appears
  - Click right pane → focus moves, blue border
  - Previously focused pane has gray border
  - Keyboard input goes to focused pane only
  - Expected: Clear focus indicator

### 8. Keyboard Navigation (Cmd+Alt+Arrows)

- [ ] **Navigate right (Cmd+Alt+→)**
  - Create 3 panes in a row
  - Focus leftmost pane
  - Press Cmd+Alt+→
  - Focus moves to next pane right
  - Expected: Focus shifts right

- [ ] **Navigate left (Cmd+Alt+←)**
  - Focus rightmost pane
  - Press Cmd+Alt+←
  - Focus moves to next pane left
  - Expected: Focus shifts left

- [ ] **Navigate down (Cmd+Alt+↓)**
  - Create vertical split, then split top pane horizontally
  - Focus top pane
  - Press Cmd+Alt+↓
  - Focus moves down
  - Expected: Focus shifts down

- [ ] **Navigate up (Cmd+Alt+↑)**
  - Focus bottom pane
  - Press Cmd+Alt+↑
  - Focus moves up
  - Expected: Focus shifts up

### 9. Focus Wraps Around

- [ ] **Navigation wraps at edges**
  - Focus rightmost pane
  - Press Cmd+Alt+→
  - Focus wraps to leftmost pane
  - Expected: Circular navigation

---

## Closing Panes

### 10. Close Pane (Cmd+W)

- [ ] **Close focused pane**
  - Create 2 panes
  - Focus left pane
  - Press Cmd+W
  - Left pane closes
  - Right pane expands to fill space
  - Focus moves to remaining pane
  - Expected: Pane closes, space rebalances

### 11. Close Until One Remains

- [ ] **Close all but one pane**
  - Create 4 panes
  - Keep pressing Cmd+W
  - Panes close one by one
  - Space rebalances after each close
  - Final pane fills entire space
  - Cannot close last pane
  - Expected: Single pane remains

### 12. Focus Moves After Close

- [ ] **Focus management after close**
  - Create 3 panes
  - Focus middle pane
  - Press Cmd+W
  - Focus moves to adjacent pane (left or right)
  - Expected: Focus never lost

---

## Complex Layouts

### 13. Nested Splits (2x2 Grid)

- [ ] **Create 2x2 grid layout**
  1. Start with single pane
  2. Cmd+D → split vertically (2 panes)
  3. Focus left pane
  4. Cmd+Shift+D → split left horizontally
  5. Focus right pane
  6. Cmd+Shift+D → split right horizontally
  - Result: 4 panes in 2x2 grid
  - All panes functional
  - Can resize each divider independently
  - Expected: Complex nested layout works

### 14. Asymmetric Layout

- [ ] **Create asymmetric layout**
  - Create 3 panes: 1 large left, 2 small right
  - Drag dividers to make left pane 70% width
  - Split right pane horizontally (50/50)
  - Verify all resize handles work
  - Expected: Non-uniform layouts supported

### 15. Deep Nesting (3+ levels)

- [ ] **Deeply nested splits**
  - Create a split
  - Split one child again
  - Split that child again (3+ levels deep)
  - Verify all panes render correctly
  - Verify all dividers resize correctly
  - Expected: Deep nesting works

---

## Persistence

### 16. Layout Persists on Tab Switch

- [ ] **Tab switch preserves layout**
  - Create 2+ panes with custom sizes (e.g., 30/70)
  - Note the layout
  - Create new tab (Cmd+T)
  - Switch back to original tab
  - Layout restored with exact sizes
  - Terminal content preserved
  - Expected: Layout persists across tab switches

### 17. Layout Persists on App Restart

- [ ] **App restart preserves layout**
  - Create complex layout (4+ panes)
  - Resize panes to custom sizes
  - Note terminal content in each pane
  - Quit app (Cmd+Q)
  - Reopen app
  - Layout restored with exact sizes
  - Terminal sessions restored
  - Expected: Layout persists across restarts

---

## Integration with Existing Features

### 18. Terminal Mode in Panes

- [ ] **Standard terminal commands work**
  - Create 2 panes
  - Run `ls -la` in left pane
  - Run `top` in right pane
  - Both commands work independently
  - Expected: Full terminal functionality per pane

- [ ] **Interactive commands work**
  - Create 2 panes
  - Run `vim` in left pane
  - Run `htop` in right pane
  - Both interactive tools work
  - Can switch focus between them
  - Expected: Interactive tools work per pane

### 19. Blocks Mode in Panes

- [ ] **Blocks mode per pane**
  - Create 2 panes
  - Run a command that creates blocks in left pane
  - Verify blocks appear in left pane only
  - Right pane remains in terminal mode
  - Expected: Blocks mode is pane-specific

### 20. Command Palette (Cmd+K)

- [ ] **Command palette with splits**
  - Create 2+ panes
  - Focus left pane
  - Press Cmd+K
  - Palette opens
  - Execute command → goes to focused pane
  - Press Cmd+K again in right pane
  - Command goes to right pane
  - Expected: Palette respects focused pane

### 21. TabBar Split Buttons

- [ ] **UI split buttons work**
  - Look for split buttons in TabBar (⬌ ⬍)
  - Click vertical split button (⬌)
  - Pane splits vertically
  - Click horizontal split button (⬍)
  - Pane splits horizontally
  - Buttons disabled when no focused pane
  - Tooltips show keyboard shortcuts
  - Expected: UI buttons match keyboard shortcuts

---

## Edge Cases

### 22. Rapid Splits

- [ ] **Rapid keyboard splits**
  - Press Cmd+D 5 times rapidly
  - App doesn't crash
  - All panes render correctly
  - Can navigate between all panes
  - Expected: Handles rapid input gracefully

### 23. Rapid Closes

- [ ] **Rapid keyboard closes**
  - Create 6 panes
  - Hold Cmd+W and press repeatedly
  - Panes close rapidly
  - App doesn't crash
  - Stops at last pane
  - Expected: Handles rapid closes gracefully

### 24. Resize During Active Process

- [ ] **Resize with running command**
  - Start long-running command (e.g., `ping google.com`)
  - Drag divider to resize pane
  - Command continues running
  - Output adjusts to new terminal size
  - Expected: Resize doesn't break running processes

### 25. Close Pane with Active Process

- [ ] **Close pane with running process**
  - Start long-running command in pane
  - Close pane (Cmd+W)
  - Process terminates gracefully
  - No zombie processes (check with `ps aux | grep [command]`)
  - Expected: Process cleanup on close

### 26. Focus Lost Scenario

- [ ] **Focus recovery**
  - Create 2 panes
  - Focus left pane
  - Click outside app (another app)
  - Click back into app
  - Focus restored to last focused pane
  - Expected: Focus state preserved

---

## Performance

### 27. 4 Panes Performance

- [ ] **4 simultaneous panes**
  - Create 4 panes (2x2 grid)
  - Run commands in all 4 simultaneously
  - Type in each pane
  - All panes responsive (<100ms latency)
  - No visible lag
  - Smooth scrolling in all panes
  - Expected: Smooth performance with 4 panes

### 28. 6 Panes Stress Test

- [ ] **6 simultaneous panes**
  - Create 6 panes
  - Run commands in all 6
  - May be slower but still functional
  - No crashes
  - All panes eventually respond
  - Expected: Stable with 6 panes (acceptable degradation)

### 29. Resize Performance

- [ ] **Smooth resize animation**
  - Create 2 panes
  - Drag divider back and forth
  - No flickering
  - No jumps or stutters
  - Terminal re-renders cleanly
  - Expected: Smooth 60fps resize

---

## Visual Polish

### 30. Focus Border Clarity

- [ ] **Focus border distinct**
  - Create 3+ panes
  - Focused pane has bright blue border (#4a90e2)
  - Unfocused panes have dim gray border (#2a2a2a)
  - Easy to identify which pane is active at a glance
  - Expected: Clear visual focus indicator

### 31. Handle Hover Feedback

- [ ] **Handle visual feedback**
  - Hover over resize handle
  - Handle changes color (gray → blue)
  - Visual indicator before drag
  - Cursor changes appropriately (ew-resize or ns-resize)
  - Expected: Clear hover state

### 32. Handle Drag Feedback

- [ ] **Handle drag state**
  - Start dragging handle
  - Handle color changes during drag (#5ca0f2)
  - Clear visual feedback during drag
  - Returns to normal on release
  - Expected: Clear drag state

### 33. Pane Border Consistency

- [ ] **Border rendering consistent**
  - Create multiple panes
  - All borders render at same width (2px)
  - No gaps or overlaps
  - Corners align properly
  - Expected: Clean border rendering

---

## Accessibility

### 34. Keyboard-Only Operation

- [ ] **Full keyboard control**
  - Never touch mouse
  - Create splits with Cmd+D / Cmd+Shift+D
  - Navigate with Cmd+Alt+Arrows
  - Close with Cmd+W
  - All functionality accessible via keyboard
  - Expected: Complete keyboard accessibility

### 35. Screen Reader Compatibility

- [ ] **Screen reader announces focus**
  - Enable VoiceOver (Cmd+F5)
  - Navigate between panes
  - VoiceOver announces pane focus changes
  - Expected: Basic screen reader support

---

## Error Handling

### 36. PTY Spawn Failure

- [ ] **Handle PTY spawn failure**
  - Simulate PTY failure (if possible)
  - Error message displayed in pane
  - App doesn't crash
  - Can close failed pane
  - Expected: Graceful degradation

### 37. Database Persistence Failure

- [ ] **Handle DB write failure**
  - Simulate DB failure (make DB read-only)
  - Create splits
  - App continues working
  - Layout not persisted but app functional
  - Expected: Graceful degradation without crash

---

## Cross-Platform (macOS Focus)

### 38. macOS Native Feel

- [ ] **macOS shortcuts work**
  - Cmd+D (not Ctrl+D) splits vertically
  - Cmd+W (not Ctrl+W) closes pane
  - Cmd+Alt+Arrow navigation
  - Expected: Standard macOS keybindings

### 39. Window Resize

- [ ] **Window resize affects panes**
  - Create 2 panes (50/50 split)
  - Resize app window smaller
  - Panes maintain proportions
  - Minimum size still enforced
  - Resize window larger
  - Panes expand proportionally
  - Expected: Panes adapt to window size

---

## Regression Tests

### 40. Tab Management Still Works

- [ ] **Tab features unaffected by splits**
  - Create split layout
  - Create new tab (Cmd+T)
  - Close tab (Cmd+W on tab bar)
  - Switch between tabs (Cmd+1, Cmd+2)
  - All tab features work normally
  - Expected: Splits don't break tab functionality

### 41. Terminal Features Still Work

- [ ] **Terminal features unaffected**
  - Create split
  - Test copy/paste in each pane
  - Test scrolling in each pane
  - Test terminal themes/colors
  - All work independently per pane
  - Expected: Terminal features work per pane

### 42. App Quit with Splits

- [ ] **Clean app shutdown**
  - Create multiple splits
  - Start processes in each
  - Quit app (Cmd+Q)
  - All processes terminate
  - No zombie processes
  - Expected: Clean shutdown

---

## Summary

**Total Test Scenarios:** 42

**Pass Criteria:**
- ✅ 40+ scenarios pass
- ⚠️ 35-39 scenarios pass (minor issues)
- ❌ <35 scenarios pass (major issues)

**Test Results:**
- Passed: ___/42
- Failed: ___/42
- Blocked: ___/42
- Not Tested: ___/42

**Critical Issues Found:**
1. 
2. 
3. 

**Minor Issues Found:**
1. 
2. 
3. 

**Notes:**

---

## Recommendations

**For User Testing:**
1. Test common workflows (e.g., monitoring multiple servers)
2. Gather feedback on keyboard shortcuts (too complex?)
3. Check if minimum pane size (200px) is appropriate
4. Verify resize handle discoverability (do users find them?)
5. Test with real workloads (SSH sessions, long outputs, etc.)

**For Future Phases:**
- Phase 3: Synchronized input, zoom/maximize, drag-and-drop
- Phase 4: Named layouts, layout templates, layout sharing

**Performance Monitoring:**
- Monitor memory usage with 4+ panes
- Check CPU usage during resize operations
- Profile terminal render times with multiple panes
- Test with different terminal content (heavy colors, rapid output)

---

**Tester Signature:** _______________  
**Date Completed:** _______________

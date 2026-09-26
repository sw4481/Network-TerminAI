# CCIE Terminal - App Verification Checklist

**Date:** 2026-05-12  
**Status:** App is running - Verify UI is visible  
**Processes:** All 4 processes running successfully

---

## Current Status

✅ **Backend:** Rust app running (PID 8992)  
✅ **Frontend:** Vite dev server on http://localhost:1420/ (PID 8958)  
✅ **Build:** ESBuild service active (PID 8959)  
✅ **Database:** Clean state (0 open tabs)

---

## Quick Visual Check

**Look at your app window and verify:**

1. **Window is open** (Should say "Tauri + React + Typescript" in title bar)
2. **Background color** is dark gray (#0f1114), NOT pure black
3. **Tab bar visible** at the top
4. **Buttons visible:**
   - "New Tab" button (left side)
   - "+ API" button
   - "+ NETCONF" button  
   - "+ Editor" button (THIS IS THE FILE EXPLORER)
   - Settings gear icon (right side)

---

## If You See Black Screen

The app is running but React might not be rendering. Check browser console:

1. **Open DevTools:** Right-click in app → "Inspect Element" or press `Cmd+Option+I`
2. **Check Console tab** for errors (red text)
3. **Look for:**
   - ✅ `xterm loaded from CDN successfully`
   - ✅ `[vite] connected.`
   - ❌ Any red errors

**Common Issues:**
- If you see "readonly property" error → Fixed (removed duplicate export)
- If you see "Multiple exports" error → Fixed (removed duplicate export)
- If you see React errors → Report them

---

## Test Each Feature

### Test 1: Create Terminal Tab

1. Click "New Tab" button
2. A new terminal tab should appear
3. Tab bar should show "zsh" or "bash"
4. Terminal prompt should be visible
5. Type `echo "hello"` and press Enter
6. Should see "hello" output

**Expected:** ✅ Terminal works, tab appears  
**If fails:** Report error from console

---

### Test 2: Create Editor Tab (Phase 3 - File Explorer)

1. Click "+ Editor" button (blue button with ED badge)
2. New editor tab should open
3. **Left sidebar visible** with "Explorer" header
4. **File tree showing** your home directory files/folders
5. **Folder icons:** 📁 for directories
6. **File icons:** Various emojis (🐍 for Python, 🔷 for TypeScript, etc.)

**Expected:** ✅ File explorer visible, home directory loaded  
**If fails:** 
- Check console for errors
- Verify backend is running: `ps aux | grep ccie-terminal`
- Check Rust logs: `tail -20 /tmp/tauri-clean-start.log`

---

### Test 3: File Explorer Navigation (Phase 3)

1. **Find a folder** in the file tree (has 📁 icon)
2. **Click the folder name**
3. Folder should expand showing children
4. Children should be indented (+16px)
5. **Click folder again** to collapse

**Expected:** ✅ Folders expand/collapse smoothly  
**If fails:** Report error from console

---

### Test 4: Open File (Phase 3)

1. Find a text file in the file tree (📄 icon)
2. Click the file name
3. **Monaco editor** should load with file content
4. **Toolbar** should show file name and path
5. **Status bar** should show `Ln 1, Col 1`
6. **Language** should be detected (not "plaintext" for known types)

**Expected:** ✅ File opens and displays in Monaco editor  
**If fails:** Check console for file read errors

---

### Test 5: Toggle File Explorer (Phase 3)

1. Look for **◀ button** in editor toolbar (top-right area)
2. Click it
3. File explorer should disappear
4. Editor should expand to full width
5. Button icon changes to **▶**
6. Click again to show explorer

**Expected:** ✅ Explorer toggles on/off  
**If fails:** Button might be missing - check EditorTab.tsx loaded

---

### Test 6: Right-Click Context Menu (Phase 4)

1. In file explorer, **right-click any file**
2. Context menu should appear at cursor
3. Menu should show:
   - ✏️ Rename
   - 🗑️ Delete (red text)
4. **Right-click a folder**
5. Menu should show:
   - 📄 New File
   - 📁 New Folder
   - ✏️ Rename
   - 🗑️ Delete

**Expected:** ✅ Context menu appears with correct options  
**If fails:** 
- Check FileContextMenu.tsx is loaded
- Check for JavaScript errors in console

---

### Test 7: Create File (Phase 4)

1. Right-click a folder
2. Click "📄 New File"
3. Enter filename in prompt: `test-phase4.txt`
4. Click OK
5. File should appear in the tree
6. Click the new file to open it
7. Monaco editor should open (empty content)

**Expected:** ✅ File created and appears in tree  
**If fails:** 
- Check console for Tauri command errors
- Check Rust logs for "Creating file" message

---

### Test 8: Rename File (Phase 4)

1. Right-click the file you just created
2. Click "✏️ Rename"
3. Inline input should appear
4. Change name to `renamed-file.txt`
5. Press Enter or click ✓
6. File name should update in tree

**Expected:** ✅ File renamed successfully  
**If fails:** Check console for rename command errors

---

### Test 9: Delete File (Phase 4)

1. Right-click `renamed-file.txt`
2. Click "🗑️ Delete"
3. Confirmation dialog should appear
4. Click "OK"
5. File should disappear from tree

**Expected:** ✅ File deleted after confirmation  
**If fails:** Check console for delete command errors

---

### Test 10: Edit and Save File (Phase 2 + 3)

1. Create or open an existing file
2. Type some text in Monaco editor
3. **Dirty marker (●)** should appear next to filename
4. Press **Cmd+S** or click "Save" button
5. Dirty marker should disappear
6. File should be saved to disk

**Expected:** ✅ File saves successfully  
**If fails:** 
- Check console for save errors
- Verify file on disk: `cat ~/path/to/file.txt`

---

## Verification Summary

After running all 10 tests, you should have:

- ✅ Terminal tab working
- ✅ Editor tab with file explorer visible
- ✅ File navigation (expand/collapse folders)
- ✅ File opening in Monaco editor
- ✅ Toggle explorer on/off
- ✅ Right-click context menu
- ✅ Create files via context menu
- ✅ Rename files
- ✅ Delete files
- ✅ Edit and save files

**All features working = Phase 4 Complete! 🎉**

---

## If Any Tests Fail

1. **Check Console Errors:**
   ```
   Cmd+Option+I → Console tab → Look for red errors
   ```

2. **Check Rust Backend Logs:**
   ```bash
   tail -50 /tmp/tauri-clean-start.log
   ```

3. **Check Database:**
   ```bash
   sqlite3 ~/Library/Application\ Support/ccie-terminal/sessions.db \
     "SELECT id, tab_type, title FROM tabs WHERE closed_at IS NULL;"
   ```

4. **Restart Clean:**
   ```bash
   # Stop app (Ctrl+C in terminal)
   ./scripts/cleanup-db.sh
   rm -rf node_modules/.vite
   ./run.sh
   ```

---

## Success Criteria

**App is working if:**
- ✅ Window opens with visible UI (not black screen)
- ✅ Can create terminal tabs
- ✅ Can create editor tabs with file explorer
- ✅ Can browse files and open them
- ✅ Can right-click for context menu
- ✅ Can create/rename/delete files
- ✅ No console errors

---

## What's Next

Once verified working:

**Phase 5:** LSP Integration (autocomplete, hover, diagnostics)  
**Phase 6:** LSP Monaco Integration  
**Phase 7:** Git Integration  
**Phase 8:** Polish & Settings

**Current Progress:** 21/35 checkpoints (60%)

---

**Please run through this checklist and report any failures! 🧪**

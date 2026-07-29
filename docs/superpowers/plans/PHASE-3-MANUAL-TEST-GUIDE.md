# Phase 3 Manual Testing Guide

**Date:** 2026-05-12  
**Purpose:** Verify file tree explorer functionality works correctly  
**Time Required:** ~10 minutes

---

## Prerequisites

✅ Dev server must be running:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
bun tauri dev
```

Wait for app window to open.

---

## Test Checklist

### ✅ Test 1: File Explorer Appears

**Steps:**
1. App should show tab bar at top
2. Click the **"+ Editor"** button (blue button with "ED" badge)
3. New editor tab should open

**Expected:**
- [ ] Left sidebar appears (250px wide, dark background #1e1e1e)
- [ ] Sidebar header shows "Explorer" text
- [ ] File tree shows your home directory contents
- [ ] Files and folders are visible in the list

**Screenshot:** (optional) Save as `phase3-test1.png`

---

### ✅ Test 2: Toggle Explorer Visibility

**Steps:**
1. In the editor toolbar (top), find the **◀ button**
2. Click it

**Expected:**
- [ ] Explorer sidebar disappears
- [ ] Editor expands to full width
- [ ] Button icon changes to **▶**

**Steps (continued):**
3. Click the **▶ button** again

**Expected:**
- [ ] Explorer sidebar reappears
- [ ] Button icon changes back to **◀**

---

### ✅ Test 3: Expand/Collapse Directories

**Steps:**
1. Find a folder in the file tree (has 📁 icon)
2. Click on the folder name

**Expected:**
- [ ] Folder expands, showing children indented +16px
- [ ] Subdirectories appear first (📁 icons)
- [ ] Files appear after directories

**Steps (continued):**
3. Click the folder name again

**Expected:**
- [ ] Folder collapses
- [ ] Children disappear

---

### ✅ Test 4: File Icons Display Correctly

**Verification:**
Look at the file tree and verify these icons appear:

- [ ] 📁 for directories
- [ ] 🐍 for `.py` files (Python)
- [ ] 🔷 for `.ts` or `.tsx` files (TypeScript)
- [ ] 📜 for `.js` or `.jsx` files (JavaScript)
- [ ] 📋 for `.json` files
- [ ] 📝 for `.md` files (Markdown)
- [ ] 📄 for other file types

**Notes:** Not all file types may be present in your home directory.

---

### ✅ Test 5: Open File in Editor

**Setup:**
Create a test file:
```bash
echo "Hello from Phase 3!" > ~/phase3-test.txt
```

**Steps:**
1. In file tree, navigate to home directory (if not there already)
2. Scroll down to find `phase3-test.txt`
3. Click on the file name

**Expected:**
- [ ] File path appears in toolbar: `phase3-test.txt`
- [ ] Full path shown in gray text
- [ ] Monaco editor shows file content: "Hello from Phase 3!"
- [ ] Status bar shows: `Ln 1, Col 1`
- [ ] Language shows: `plaintext`
- [ ] No dirty marker (●) until you edit

**Steps (continued):**
4. Edit the text in the editor (add a word)
5. Observe toolbar

**Expected:**
- [ ] Dirty marker (●) appears next to file name
- [ ] "Save" button becomes enabled

**Steps (continued):**
6. Press **Cmd+S** (or click "Save" button)

**Expected:**
- [ ] Dirty marker disappears
- [ ] "Save" button becomes disabled

**Verify file was saved:**
```bash
cat ~/phase3-test.txt
# Should show your edited content
```

**Cleanup:**
```bash
rm ~/phase3-test.txt
```

---

### ✅ Test 6: Sort Order (Directories First)

**Steps:**
1. Find a directory with both subdirectories and files
   - Try: `/usr/local`, `~/Documents`, or `~/Downloads`
2. Expand that directory

**Expected:**
- [ ] ALL directories appear first (alphabetically)
- [ ] ALL files appear after directories (alphabetically)
- [ ] No files mixed between directories

**Example Expected Order:**
```
📁 Applications/
📁 Desktop/
📁 Documents/
📄 .bash_profile
📄 .zshrc
📝 README.md
```

---

### ✅ Test 7: Ignored Folders Don't Show

**Steps:**
1. Navigate to a directory containing any of these folders:
   - `.git`
   - `node_modules`
   - `__pycache__`
   - `target`
   - `.venv`
2. Verify these folders **do NOT appear** in the file tree

**Expected:**
- [ ] Ignored folders are filtered out
- [ ] Other folders/files display normally

---

### ✅ Test 8: Lazy Loading (Performance)

**Steps:**
1. Find a directory with many subdirectories (e.g., `/usr/local`)
2. Observe that children are **not visible** until clicked
3. Click to expand
4. Observe brief delay (may be very fast)
5. Children appear

**Expected:**
- [ ] Directories don't load children until expanded
- [ ] App remains responsive even with many items
- [ ] Subsequent expand/collapse is instant (cached)

---

## Edge Cases (Optional)

### Error Handling

**Test: Permission Denied**
1. Try to expand `/etc` or `/private/var/root`
2. Verify app doesn't crash (may show empty or error)

**Test: Empty Directory**
```bash
mkdir ~/empty-test-phase3
```
1. Navigate to home directory
2. Expand `empty-test-phase3`
3. Verify no children appear (not an error)

Cleanup: `rmdir ~/empty-test-phase3`

---

## Pass/Fail Criteria

**Phase 3 PASSES if:**
- ✅ All 8 core tests pass
- ✅ No console errors in dev tools (Cmd+Option+I)
- ✅ No crashes or freezes
- ✅ File content loads and saves correctly

**Phase 3 FAILS if:**
- ❌ File tree doesn't appear
- ❌ Can't open files
- ❌ Crashes when expanding directories
- ❌ Icons don't display
- ❌ Toggle button doesn't work

---

## Reporting Results

After testing, update `PHASE-3-COMPLETE.md`:

```markdown
### Manual Test Results

**Date:** 2026-05-12  
**Tester:** [Your Name]  
**Status:** [PASS / FAIL / PARTIAL]

**Tests Passed:** [X/8]

**Issues Found:**
- [Describe any issues]

**Screenshots:** [Attach if any]
```

---

## Console Debugging (If Issues Found)

Open dev tools: **Cmd+Option+I**

**Check for errors:**
1. Console tab → Look for red error messages
2. Network tab → Check if `editor_list_directory` calls succeed
3. Tauri tab → Inspect IPC commands

**Common Issues:**
- **"Command not found"** → Rust command not registered in lib.rs
- **"Failed to read directory"** → Permission issue or invalid path
- **"File tree empty"** → Check home directory path is correct

---

## Next Steps After Testing

1. **If ALL tests pass:**
   - ✅ Mark Phase 3 as verified
   - ✅ Proceed to Phase 4: File Operations

2. **If tests fail:**
   - ❌ Document failing tests
   - ❌ Report bugs with console errors
   - ❌ Fix issues before Phase 4

---

**Happy Testing! 🚀**

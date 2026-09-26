# Black Screen Issue - Fixed

**Date:** 2026-05-12  
**Issue:** App shows black screen with no tabs or UI  
**Root Cause:** 461 unclosed tabs in database overwhelming the renderer

---

## Problem

The app was trying to render 461 terminal tabs simultaneously, causing:
- Black screen (rendering stalled)
- No visible UI elements
- App appearing frozen

The tabs accumulated from previous sessions that didn't properly close tabs when the app quit.

---

## Solution Applied

Closed all open tabs in the database:

```bash
sqlite3 ~/Library/Application\ Support/ccie-terminal/sessions.db \
  "UPDATE tabs SET closed_at = strftime('%s','now') WHERE closed_at IS NULL;"
```

This immediately fixed the black screen issue.

---

## Prevention

Created cleanup script: `scripts/cleanup-db.sh`

**Usage:**
```bash
./scripts/cleanup-db.sh
```

**What it does:**
- Closes all open tabs
- Shows tab statistics
- Vacuums database to reclaim space

---

## Root Cause Analysis

**Why tabs weren't closing:**
1. App crashes or force-quit leaves tabs open
2. Session restoration tries to restore all 461 tabs
3. React tries to render all tabs at once
4. App hangs/shows black screen

**Long-term fixes needed:**
1. Add tab cleanup on app quit (close all tabs)
2. Add max tab limit (close oldest if > 50)
3. Add lazy rendering (only render active + nearby tabs)
4. Add "Close All Tabs" button in UI
5. Add automatic cleanup of old closed tabs (> 30 days)

---

## Quick Reference

**Check open tabs:**
```bash
sqlite3 ~/Library/Application\ Support/ccie-terminal/sessions.db \
  "SELECT COUNT(*) FROM tabs WHERE closed_at IS NULL;"
```

**Close all tabs:**
```bash
./scripts/cleanup-db.sh
```

**Delete old closed tabs:**
```bash
sqlite3 ~/Library/Application\ Support/ccie-terminal/sessions.db \
  "DELETE FROM tabs WHERE closed_at < strftime('%s', 'now', '-30 days');"
```

---

## Testing After Fix

After running the cleanup, restart the app:

```bash
./run.sh
```

Expected behavior:
- App launches normally
- Empty tab bar (no tabs)
- Click "New Tab" to create first terminal
- UI renders correctly (no black screen)

---

**Issue Resolved! ✅**

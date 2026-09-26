# Black Screen Issue - Complete Fix

**Date:** 2026-05-12  
**Issue:** App shows black screen with error: "Attempted to assign to readonly property"  
**Root Causes:** Two separate issues

---

## Issue #1: Database Tab Overload (Fixed)

**Problem:** 461 unclosed tabs in database  
**Solution:** Closed all tabs with `scripts/cleanup-db.sh`  
**Status:** ✅ Fixed

---

## Issue #2: Missing Export in App.tsx (Fixed)

**Problem:** 
```
[Error] Unhandled Promise Rejection: TypeError: Attempted to assign to readonly property.
    init (main.tsx:14)
```

**Root Cause:**
- `src/App.tsx` had no `export default App;` statement
- Import in `main.tsx` was failing
- Polyfill conflict with readonly properties

**Solution Applied:**

1. **Added export to App.tsx:**
   ```typescript
   export default App;
   ```

2. **Fixed main.tsx imports:**
   ```typescript
   // Changed from dynamic import to static
   import App from "./App";
   ```

3. **Improved polyfills in index.html:**
   ```javascript
   // Use Object.defineProperty with try/catch
   Object.defineProperty(window, 'global', {
     value: window,
     writable: true,
     configurable: true
   });
   ```

---

## How to Test

If you're still seeing a black screen:

1. **Refresh the app:** Press `Cmd+R` in the app window
2. **Or restart:** Stop `./run.sh` (Ctrl+C) and restart it

**Expected behavior after fix:**
- App launches normally
- Tab bar visible at top
- Click "New Tab" to create terminal
- Click "+ Editor" to test file explorer
- No console errors

---

## Verification Checklist

Open browser console (Cmd+Option+I) and verify:

- [x] No "readonly property" errors
- [x] Sees: `xterm loaded from CDN successfully`
- [x] Sees: `[vite] connected.`
- [x] No red errors in console
- [x] Tab bar is visible
- [x] Background is dark (not black)

---

## If Still Black Screen

Run these commands:

```bash
# 1. Stop the app (Ctrl+C)

# 2. Clean database
./scripts/cleanup-db.sh

# 3. Clear Vite cache
rm -rf node_modules/.vite

# 4. Restart
./run.sh
```

If that doesn't work:

```bash
# Full clean restart
rm -rf node_modules/.vite dist
bun install
./run.sh
```

---

## Technical Details

**Why the export was missing:**

The App.tsx function component was defined but never exported. TypeScript/React allowed this to compile, but at runtime when main.tsx tried to import it, the module had no default export, causing the import to fail and triggering the polyfill error chain.

**Why polyfills caused errors:**

Vite config defines `process.env: {}` which conflicts with the window.process polyfill. The error manifested during the failed import attempt.

**Why static import works better:**

Dynamic imports (`await import()`) can fail silently or with cryptic errors. Static imports fail at compile time, making issues easier to debug.

---

## Prevention

This was caused by incomplete code from development. Going forward:

1. Always include `export default` for main components
2. Check for TypeScript/ESLint errors before committing
3. Test app launch after major changes
4. Use static imports for critical modules

---

## Files Modified

1. `src/App.tsx` - Added `export default App;`
2. `src/main.tsx` - Changed to static import, improved error handling
3. `index.html` - Safer polyfill implementation with try/catch
4. `scripts/cleanup-db.sh` - Database cleanup utility (NEW)

---

**Both issues resolved! App should now work normally! ✅**

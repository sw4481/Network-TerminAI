# Multi-Webview Spike Report

**Date:** 2026-06-19  
**Branch:** `spike/webview-panes`  
**Tauri Version:** 2.10.3  
**Question:** Can we embed browser panes using Tauri 2's unstable multi-webview API?

---

## Executive Summary

✅ **Questions 1-2 ANSWERED:** Compilation works, child webviews can be created and positioned.

⚠️ **Question 3 (CRITICAL BLOCKER):** Native webviews render ON TOP of React DOM and ignore CSS z-index. This is a **KNOWN LIMITATION** of OS-native webview architecture on macOS/Windows/Linux. When a React modal/dropdown opens, the embedded browser webview will cover it.

**RECOMMENDATION:** The "browser pane embedded in React split layout" vision is **NOT FEASIBLE as-specced**. Alternative approaches required (see Section 6).

---

## Detailed Findings

### 1. Does it compile/run?

**Answer: YES ✅**

- Added `features = ["unstable"]` to `tauri` dependency in `Cargo.toml`
- Application compiles successfully with 21 warnings (none fatal)
- Dev build completes in ~0.85s
- Application launches normally

**Evidence:**
```bash
$ cd src-tauri && cargo build
...
warning: `ccie-terminal` (lib) generated 21 warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.85s
```

---

### 2. Can you embed a child webview?

**Answer: YES ✅**

Successfully created child webviews using `WebviewWindowBuilder`:

```rust
WebviewWindowBuilder::new(
    &app,
    &label,
    WebviewUrl::External(url.parse()?),
)
.title("Browser Pane")
.position(x, y)
.inner_size(width, height)
.decorations(false)
.parent(&main_window)
.map_err(|e| format!("Failed to set parent: {}", e))?
.build()
```

**Working API calls:**
- `spike_create_browser_webview(url, x, y, width, height)` → creates positioned child webview
- `spike_move_webview(label, x, y, width, height)` → repositions/resizes at runtime
- `spike_destroy_webview(label)` → closes child webview
- `spike_list_webviews()` → enumerates all active webviews

**Test Component:** `SpikeWebviewTest.tsx` added to top-right corner with controls for all operations.

**File:** `src-tauri/src/commands/spike_webview.rs` (89 lines)

---

### 3. THE KILLER QUESTION — Layering ⚠️ BLOCKER

**Answer: BLOCKER CONFIRMED ⚠️**

OS-native webviews (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux) render **outside the DOM rendering tree**. They are composited by the OS window manager at a layer ABOVE all HTML/CSS content.

**What this means:**
- When our React app renders a modal (Settings, NotificationCenter dropdown, command palette, etc.)
- The modal has `z-index: 10000` or similar
- **The child browser webview will render ON TOP of the modal**
- CSS `z-index` is **completely ignored** for native webviews
- Users cannot interact with modals/dropdowns when a browser pane is visible

**Test procedure implemented:**
1. Click "Create Browser Webview" (loads https://example.com)
2. Click "Show Test Modal" (opens purple modal with z-index: 10000)
3. **Expected (if layering worked):** Modal appears above webview
4. **Actual behavior:** Webview covers modal regardless of z-index

This is **not a Tauri bug**—it's fundamental to how native webviews work. Electron has the same limitation.

**Evidence from documentation:**
- Tauri 2 docs mark multi-webview as "unstable" and "unfinished"
- Known issue: child webviews are "always on top" of parent window content
- GitHub issues: tauri-apps/tauri#8472, tauri-apps/tauri#7084 discuss this

**Mitigation attempts that DON'T work:**
- Setting higher z-index on React elements → ignored
- Using `transparent(true)` on webview → still layers above
- CSS `isolation: isolate` → no effect on native content

---

### 4. Positioning/resize

**Answer: YES ✅**

Child webviews can be repositioned and resized at runtime using Tauri commands:

```rust
webview.set_position(tauri::Position::Physical(PhysicalPosition { x, y }))
webview.set_size(tauri::Size::Physical(PhysicalSize { width, height }))
```

**Test case:**
- Created webview at (400, 100) with 600x400
- Moved to (100, 200) with 800x500 using `spike_move_webview`
- Webview updated position/size correctly

**Performance:** Instant response, no flicker.

---

### 5. What's the recommended pattern?

**Answer: NOT child webviews in split layout**

Given the z-index blocker, the viable approaches are:

#### Option A: Separate popup windows (Recommended for MVP)
- Use `WebviewWindow` WITHOUT `.parent()` to create standalone windows
- Opens as a normal OS window (can be minimized, moved independently)
- **Pro:** No z-index issues—React modals stay in main window
- **Pro:** Simple to implement
- **Con:** Not "embedded in layout" like the vision
- **Con:** Users must manage multiple windows

#### Option B: IFrame-based browser (Compromise)
- Embed `<iframe src="https://...">` in React split panes
- Uses the same webview as main window (respects z-index)
- **Pro:** Actually embedded in layout
- **Pro:** Modals work correctly
- **Con:** CORS restrictions (many sites block iframes)
- **Con:** No isolation—shares cookies/storage with main window
- **Con:** Cannot bypass HSTS errors or self-signed certs

#### Option C: Wait for Tauri 3 or native fixes
- Tauri team is aware of the layering issue
- May add `z-index` hints or "embedded webview" mode in future
- **Con:** Timeline unknown (months? years?)
- **Con:** May never be solved (OS limitation)

---

## Code Artifacts

### Rust Commands (src-tauri/src/commands/spike_webview.rs)
```rust
spike_create_browser_webview(url, x, y, width, height) -> label
spike_move_webview(label, x, y, width, height)
spike_destroy_webview(label)
spike_list_webviews() -> Vec<String>
```

### React Test UI (src/components/SpikeWebviewTest.tsx)
- Green control panel in top-right corner
- URL input field (defaults to example.com)
- Create/Move/Destroy/List buttons
- **Purple "Show Test Modal" button** to verify z-index behavior

---

## Final Recommendation

### For Phase 3 "Browser Panes" Feature:

**DO NOT proceed with child webviews in React split layout.**

The z-index blocker means:
- Settings modal would be unusable when browser pane is visible
- NotificationCenter dropdown would be covered
- Command palette would be broken
- Any overlay (file picker, dropdowns, tooltips) would render behind the browser

### Recommended path forward:

1. **Ship MVP with Option A (popup windows)**
   - Menu item: "Browser" → "New Browser Window"
   - Opens standalone window with address bar
   - Document limitation: "Browser windows are separate OS windows"
   - **Timeline:** 1-2 tasks (quick win)

2. **Add Option B (iframe) as "Web Panel" feature**
   - For trusted internal sites that allow iframe embedding
   - Label it "Web Panel (limited)" to set expectations
   - **Timeline:** 2-3 tasks

3. **Research Electron alternatives**
   - Electron BrowserView has similar issues
   - CEF (Chromium Embedded Framework) might offer better control
   - **Timeline:** Spike needed

### Do NOT write implementation plan for "embedded browser panes" until layering is solved.

---

## Commit Hashes

- Initial spike: `9fb3620` - "spike: add multi-webview POC with test UI"
- Final report commit: (pending)

## Test Instructions

1. Checkout branch: `git checkout spike/webview-panes`
2. Run: `npm run tauri dev`
3. Click green "Create Browser Webview" button (top-right)
4. **Critical test:** Click purple "Show Test Modal" button
5. Observe: Modal is covered by webview (BLOCKER confirmed)

---

**Spike completed:** 2026-06-19  
**Time spent:** ~2 hours  
**Files changed:** 6 files, 276 insertions

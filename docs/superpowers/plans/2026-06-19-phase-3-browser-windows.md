# AI Assistant Integration Phase 3: Browser Windows & Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add popup browser windows (with agent automation + cookie import) and a per-pane metadata sidebar to CCIE Terminal, plus topology "Open Web UI" integration.

**Architecture:** Browser windows are standalone Tauri `WebviewWindow` instances (NOT embedded child webviews — the spike proved native webviews ignore z-index and cover React modals). A `BrowserManager` tracks open windows by opaque `browser_id`. Agents drive browsers via Tauri commands and MCP tools (extending Phase 2's `pane_context_server.rs`). A metadata module gathers git/ports/process info lazily for the focused pane.

**Tech Stack:** Rust (Tauri 2.10.3, serde, parking_lot), TypeScript/React 19, Zustand, MCP (stdio).

## Global Constraints

- Browser windows use **standalone** `WebviewWindow` (no `.parent()`) — this is stable Tauri, do NOT add the `unstable` feature flag.
- Browser window labels are `browser-<uuid-v4>`; the opaque `browser_id` returned to the frontend IS that label.
- Keyboard shortcuts: New Browser Window = `⌘⇧B`; Metadata Sidebar toggle = `⌘⇧O`. (Already used: d/i/j/k/m/n/w — do not reuse.)
- Cookie import is **macOS-only** for MVP: Chrome + Safari. Firefox/Arc/Edge/Windows/Linux are out of scope.
- Metadata is gathered **only while the sidebar is visible** (lazy; no always-on polling).
- Browser/metadata state is **in-memory only** — no new SQLite migration in this plan.
- `uuid` (v4) and `base64` (0.22) crates are already dependencies — use them, don't add new ones.
- Commands are registered in `src-tauri/src/lib.rs` inside `tauri::generate_handler![...]` (the last registered Phase 2 command is `commands::pane_activity::get_notification_preferences` near line 633). Command modules are declared in `src-tauri/src/commands/mod.rs`.
- `AppState` is accessed via `State<'_, AppState>`; the Tauri `AppHandle` is available as a command parameter `app: tauri::AppHandle`.
- Event emission requires `use tauri::Emitter;` in scope.
- **Screenshot is explicitly OUT of MVP scope** (requires native window capture; agents read the DOM via `browser_eval` instead). Do not implement it.

---

## File Structure

**Backend (Rust):**
- `src-tauri/src/browser/mod.rs` — NEW: module exports
- `src-tauri/src/browser/manager.rs` — NEW: `BrowserManager` (create/close/list/get)
- `src-tauri/src/browser/cookies.rs` — NEW: macOS Chrome + Safari cookie reading/decryption
- `src-tauri/src/commands/browser.rs` — NEW: Tauri commands (window lifecycle, navigation, automation, cookie import)
- `src-tauri/src/pane_context/metadata.rs` — NEW: git branch / ports / process gathering
- `src-tauri/src/commands/pane_activity.rs` — MODIFY: add `get_pane_metadata` command
- `src-tauri/src/mcp/pane_context_server.rs` — MODIFY: add browser MCP tools
- `src-tauri/src/commands/mod.rs` — MODIFY: declare `pub mod browser;`
- `src-tauri/src/lib.rs` — MODIFY: register new commands; add `pub mod browser;` at crate root
- `src-tauri/src/commands/topology.rs` — MODIFY (if device-IP lookup needed) — actually topology open-web-ui is frontend-only

**Frontend (TypeScript/React):**
- `src/lib/browser.ts` — NEW: Tauri bindings for browser commands
- `src/lib/metadata.ts` — NEW: Tauri binding for `get_pane_metadata`
- `src/components/MetadataSidebar.tsx` — NEW: sidebar component
- `src/components/MetadataSidebar.css` — NEW
- `src/components/MetadataSidebar.test.tsx` — NEW
- `src/state/metadataStore.ts` — NEW: Zustand store for metadata + sidebar open state
- `src/components/BrowserMenu` — integrated into existing menu handling in `src/App.tsx`
- `src/App.tsx` — MODIFY: `⌘⇧B` (new browser window), `⌘⇧O` (toggle sidebar), mount `<MetadataSidebar />`
- `src/components/topology/TopologyInspector.tsx` — MODIFY: "Open Web UI" action
- `src/components/SettingsBrowserTab.tsx` — NEW: cookie import UI
- `src/components/SettingsBrowserTab.test.tsx` — NEW
- `src/windows/Settings.tsx` — MODIFY: add "Browser" tab

---

## Sub-Phase 3A: Browser Windows Core

### Task 1: BrowserManager + window lifecycle commands

**Files:**
- Create: `src-tauri/src/browser/mod.rs`
- Create: `src-tauri/src/browser/manager.rs`
- Create: `src-tauri/src/commands/browser.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod browser;`)
- Modify: `src-tauri/src/lib.rs` (add `pub mod browser;` at crate root; register 3 commands)

**Interfaces:**
- Consumes: Tauri `AppHandle`, `WebviewWindowBuilder`, `WebviewUrl::External`.
- Produces:
  - `BrowserManager::new() -> Self`
  - `BrowserManager::register(&self, browser_id: String, url: String)` and `unregister(&self, browser_id: &str)`
  - `BrowserManager::list(&self) -> Vec<BrowserWindowInfo>` where `BrowserWindowInfo { browser_id: String, url: String }` (serde camelCase)
  - Tauri commands: `create_browser_window(url: String) -> Result<String, String>` (returns browser_id), `close_browser_window(browser_id: String) -> Result<(), String>`, `list_browser_windows() -> Result<Vec<BrowserWindowInfo>, String>`

- [ ] **Step 1: Create the browser module exports**

Create `src-tauri/src/browser/mod.rs`:
```rust
//! Browser windows feature (Phase 3). Popup WebviewWindow instances —
//! NOT embedded child webviews (see docs/spikes/spike-webview-report.md).
pub mod manager;

pub use manager::{BrowserManager, BrowserWindowInfo};
```

- [ ] **Step 2: Write the failing test for BrowserManager registry**

Create `src-tauri/src/browser/manager.rs`:
```rust
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindowInfo {
    pub browser_id: String,
    pub url: String,
}

/// Tracks open popup browser windows by opaque browser_id (== Tauri window label).
pub struct BrowserManager {
    windows: Arc<RwLock<HashMap<String, String>>>, // browser_id -> url
}

impl Default for BrowserManager {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            windows: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn register(&self, browser_id: String, url: String) {
        self.windows.write().insert(browser_id, url);
    }

    pub fn unregister(&self, browser_id: &str) {
        self.windows.write().remove(browser_id);
    }

    pub fn list(&self) -> Vec<BrowserWindowInfo> {
        self.windows
            .read()
            .iter()
            .map(|(id, url)| BrowserWindowInfo {
                browser_id: id.clone(),
                url: url.clone(),
            })
            .collect()
    }

    pub fn get_url(&self, browser_id: &str) -> Option<String> {
        self.windows.read().get(browser_id).cloned()
    }

    pub fn set_url(&self, browser_id: &str, url: String) {
        if let Some(slot) = self.windows.write().get_mut(browser_id) {
            *slot = url;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_list_unregister() {
        let m = BrowserManager::new();
        assert!(m.list().is_empty());

        m.register("browser-1".to_string(), "https://example.com".to_string());
        let list = m.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].browser_id, "browser-1");
        assert_eq!(list[0].url, "https://example.com");

        m.unregister("browser-1");
        assert!(m.list().is_empty());
    }

    #[test]
    fn test_set_and_get_url() {
        let m = BrowserManager::new();
        m.register("b1".to_string(), "https://a.com".to_string());
        m.set_url("b1", "https://b.com".to_string());
        assert_eq!(m.get_url("b1"), Some("https://b.com".to_string()));
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd src-tauri && cargo test browser::manager`
Expected: 2 tests PASS (`test_register_list_unregister`, `test_set_and_get_url`)

- [ ] **Step 4: Register the browser module at crate root**

In `src-tauri/src/lib.rs`, near the other top-level `pub mod` declarations (e.g. alongside `pub mod pane_context;`), add:
```rust
pub mod browser;
```

- [ ] **Step 5: Add BrowserManager to AppState**

In `src-tauri/src/commands/mod.rs`, in the `pub struct AppState { ... }` definition, add a field after `pane_manager`:
```rust
    /// Phase 3 — open popup browser windows registry.
    pub browser_manager: Arc<crate::browser::BrowserManager>,
```
Then find where `AppState` is constructed (search for `pane_manager,` in the struct literal) and add:
```rust
            browser_manager: Arc::new(crate::browser::BrowserManager::new()),
```

- [ ] **Step 6: Create the browser commands module**

Create `src-tauri/src/commands/browser.rs`:
```rust
use crate::browser::BrowserWindowInfo;
use crate::commands::AppState;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Open a new standalone popup browser window at `url`. Returns the browser_id.
#[tauri::command]
pub async fn create_browser_window(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    let parsed = url
        .parse()
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;

    let browser_id = format!("browser-{}", uuid::Uuid::new_v4());

    // Standalone window — NO .parent() — so it does not overlay the main
    // window's React DOM (see spike report). This is stable Tauri.
    WebviewWindowBuilder::new(&app, &browser_id, WebviewUrl::External(parsed))
        .title("Browser")
        .inner_size(1024.0, 768.0)
        .build()
        .map_err(|e| format!("Failed to create browser window: {}", e))?;

    state.browser_manager.register(browser_id.clone(), url);
    Ok(browser_id)
}

#[tauri::command]
pub async fn close_browser_window(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&browser_id) {
        win.close().map_err(|e| format!("Failed to close: {}", e))?;
    }
    state.browser_manager.unregister(&browser_id);
    Ok(())
}

#[tauri::command]
pub async fn list_browser_windows(
    state: State<'_, AppState>,
) -> Result<Vec<BrowserWindowInfo>, String> {
    Ok(state.browser_manager.list())
}
```

- [ ] **Step 7: Declare the commands module**

In `src-tauri/src/commands/mod.rs`, add to the module declarations near the top (alongside `pub mod pane_activity;`):
```rust
pub mod browser;
```

- [ ] **Step 8: Register the 3 commands**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![...]`, after `commands::pane_activity::get_notification_preferences,` add:
```rust
            commands::browser::create_browser_window,
            commands::browser::close_browser_window,
            commands::browser::list_browser_windows,
```

- [ ] **Step 9: Verify clean build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds (pre-existing warnings OK, no errors)

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/browser src-tauri/src/commands/browser.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(browser): BrowserManager + window lifecycle commands

Standalone popup WebviewWindow (no parent) to avoid the z-index
layering blocker found in the spike. create/close/list commands.

Part of Phase 3 Sub-Phase 3A (Task 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Frontend bindings + menu + ⌘⇧B shortcut

**Files:**
- Create: `src/lib/browser.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: Task 1 commands `create_browser_window`, `close_browser_window`, `list_browser_windows`.
- Produces:
  - `src/lib/browser.ts`: `createBrowserWindow(url: string): Promise<string>`, `closeBrowserWindow(browserId: string): Promise<void>`, `listBrowserWindows(): Promise<BrowserWindowInfo[]>`, interface `BrowserWindowInfo { browserId: string; url: string }`
  - `⌘⇧B` opens a URL prompt and creates a browser window.

- [ ] **Step 1: Create the browser bindings**

Create `src/lib/browser.ts`:
```typescript
import { invoke } from '@tauri-apps/api/core';

export interface BrowserWindowInfo {
  browserId: string;
  url: string;
}

export async function createBrowserWindow(url: string): Promise<string> {
  return invoke('create_browser_window', { url });
}

export async function closeBrowserWindow(browserId: string): Promise<void> {
  return invoke('close_browser_window', { browserId });
}

export async function listBrowserWindows(): Promise<BrowserWindowInfo[]> {
  return invoke('list_browser_windows');
}
```

- [ ] **Step 2: Add the ⌘⇧B shortcut in App.tsx**

In `src/App.tsx`, find the block of `useKeyboardShortcut(...)` calls (around line 137-166, near the `⌘⇧M` notebook library line). Add:
```typescript
  // Phase 3: New browser window (⌘⇧B)
  useKeyboardShortcut('b', async () => {
    const url = window.prompt('Open URL in browser window:', 'https://');
    if (url && url.trim() && url.trim() !== 'https://') {
      const { createBrowserWindow } = await import('./lib/browser');
      try {
        await createBrowserWindow(url.trim());
      } catch (e) {
        console.error('Failed to open browser window:', e);
        window.alert(`Failed to open browser window: ${e}`);
      }
    }
  }, { cmd: true, shift: true });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/shaunwhi/CCIE\ Terminal && npx tsc --noEmit`
Expected: No new errors from browser.ts or App.tsx

- [ ] **Step 4: Verify the full frontend test suite still passes**

Run: `npm test`
Expected: All tests pass (no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/lib/browser.ts src/App.tsx
git commit -m "feat(browser): frontend bindings + cmd-shift-B to open browser window

Part of Phase 3 Sub-Phase 3A (Task 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Manual test (3A done):** Run the app, press `⌘⇧B`, enter `https://example.com` → a separate browser window opens. The main window's modals still work.

---

## Sub-Phase 3B: Navigation + Automation Commands

### Task 3: Navigation commands (navigate/back/forward/reload/get_url)

**Files:**
- Modify: `src-tauri/src/commands/browser.rs`
- Modify: `src-tauri/src/lib.rs` (register 5 commands)
- Modify: `src/lib/browser.ts` (bindings)

**Interfaces:**
- Consumes: Task 1's `BrowserManager`, Tauri `WebviewWindow::eval`, `WebviewWindow::url`.
- Produces: commands `browser_navigate(browser_id, url)`, `browser_back(browser_id)`, `browser_forward(browser_id)`, `browser_reload(browser_id)`, `browser_get_url(browser_id) -> String`.

- [ ] **Step 1: Add navigation commands**

In `src-tauri/src/commands/browser.rs`, append:
```rust
fn get_browser(app: &AppHandle, browser_id: &str) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(browser_id)
        .ok_or_else(|| format!("Browser window '{}' not found", browser_id))
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
    url: String,
) -> Result<(), String> {
    let parsed = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
    let win = get_browser(&app, &browser_id)?;
    win.navigate(parsed).map_err(|e| format!("Navigate failed: {}", e))?;
    state.browser_manager.set_url(&browser_id, url);
    Ok(())
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, browser_id: String) -> Result<(), String> {
    let win = get_browser(&app, &browser_id)?;
    win.eval("history.back()").map_err(|e| format!("Back failed: {}", e))
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, browser_id: String) -> Result<(), String> {
    let win = get_browser(&app, &browser_id)?;
    win.eval("history.forward()").map_err(|e| format!("Forward failed: {}", e))
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, browser_id: String) -> Result<(), String> {
    let win = get_browser(&app, &browser_id)?;
    win.eval("location.reload()").map_err(|e| format!("Reload failed: {}", e))
}

#[tauri::command]
pub async fn browser_get_url(app: AppHandle, browser_id: String) -> Result<String, String> {
    let win = get_browser(&app, &browser_id)?;
    win.url().map(|u| u.to_string()).map_err(|e| format!("get_url failed: {}", e))
}
```

- [ ] **Step 2: Register the 5 commands**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![...]`, after `commands::browser::list_browser_windows,` add:
```rust
            commands::browser::browser_navigate,
            commands::browser::browser_back,
            commands::browser::browser_forward,
            commands::browser::browser_reload,
            commands::browser::browser_get_url,
```

- [ ] **Step 3: Verify clean build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds

- [ ] **Step 4: Add frontend bindings**

In `src/lib/browser.ts`, append:
```typescript
export async function browserNavigate(browserId: string, url: string): Promise<void> {
  return invoke('browser_navigate', { browserId, url });
}
export async function browserBack(browserId: string): Promise<void> {
  return invoke('browser_back', { browserId });
}
export async function browserForward(browserId: string): Promise<void> {
  return invoke('browser_forward', { browserId });
}
export async function browserReload(browserId: string): Promise<void> {
  return invoke('browser_reload', { browserId });
}
export async function browserGetUrl(browserId: string): Promise<string> {
  return invoke('browser_get_url', { browserId });
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/browser.rs src-tauri/src/lib.rs src/lib/browser.ts
git commit -m "feat(browser): navigation commands (navigate/back/forward/reload/get_url)

Part of Phase 3 Sub-Phase 3B (Task 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: JS evaluation — fire-and-forget + result round-trip

**Files:**
- Modify: `src-tauri/src/commands/browser.rs`
- Modify: `src-tauri/src/lib.rs` (register 2 commands)
- Modify: `src/lib/browser.ts`

**Interfaces:**
- Consumes: Task 1's manager; Tauri `WebviewWindow::eval`, `Emitter`, `Listener`; `tokio::sync::oneshot`.
- Produces:
  - `browser_eval(browser_id, script)` — fire-and-forget (used by agents for click/type, e.g. `document.querySelector('#x').click()`).
  - `browser_eval_result(browser_id, script) -> String` — evaluates `script` as an expression, returns its `JSON.stringify`'d value (or throws on JS error). Uses an injected callback that emits a Tauri event the Rust side awaits.

**Note:** `withGlobalTauri: true` is set in `tauri.conf.json`, so `window.__TAURI__` is available inside browser windows for the callback.

- [ ] **Step 1: Add fire-and-forget eval**

In `src-tauri/src/commands/browser.rs`, append:
```rust
#[tauri::command]
pub async fn browser_eval(
    app: AppHandle,
    browser_id: String,
    script: String,
) -> Result<(), String> {
    let win = get_browser(&app, &browser_id)?;
    win.eval(&script).map_err(|e| format!("eval failed: {}", e))
}
```

- [ ] **Step 2: Add result round-trip eval**

In `src-tauri/src/commands/browser.rs`, append (note `use` lines go at the top of the file with the others):
```rust
use tauri::{Emitter, Listener};

#[tauri::command]
pub async fn browser_eval_result(
    app: AppHandle,
    browser_id: String,
    script: String,
) -> Result<String, String> {
    let win = get_browser(&app, &browser_id)?;
    let callback_id = uuid::Uuid::new_v4().to_string();
    let event_name = "browser-eval-result";

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let want_id = callback_id.clone();

    let tx_for_handler = tx.clone();
    let handler_id = app.listen(event_name, move |event| {
        // Payload shape: {"id": "...", "ok": true/false, "value": "..."}
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            if v.get("id").and_then(|x| x.as_str()) == Some(&want_id) {
                let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                let value = v.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if let Some(sender) = tx_for_handler.lock().unwrap().take() {
                    let _ = sender.send(if ok { Ok(value) } else { Err(value) });
                }
            }
        }
    });

    // Inject a wrapper that evaluates the expression and emits the result.
    let wrapped = format!(
        r#"(async () => {{
            try {{
                const __r = await (async () => {{ return ({script}); }})();
                window.__TAURI__.event.emit('{event_name}', {{ id: '{callback_id}', ok: true, value: JSON.stringify(__r) ?? 'null' }});
            }} catch (e) {{
                window.__TAURI__.event.emit('{event_name}', {{ id: '{callback_id}', ok: false, value: String(e) }});
            }}
        }})()"#,
        script = script,
        event_name = event_name,
        callback_id = callback_id,
    );

    if let Err(e) = win.eval(&wrapped) {
        app.unlisten(handler_id);
        return Err(format!("eval injection failed: {}", e));
    }

    // Await the callback with a timeout so a hung page can't block forever.
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), rx).await;
    app.unlisten(handler_id);

    match result {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("eval channel closed".to_string()),
        Err(_) => Err("eval timed out after 10s".to_string()),
    }
}
```

- [ ] **Step 3: Register the 2 commands**

In `src-tauri/src/lib.rs`, after `commands::browser::browser_get_url,` add:
```rust
            commands::browser::browser_eval,
            commands::browser::browser_eval_result,
```

- [ ] **Step 4: Verify clean build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds

- [ ] **Step 5: Add frontend bindings**

In `src/lib/browser.ts`, append:
```typescript
export async function browserEval(browserId: string, script: string): Promise<void> {
  return invoke('browser_eval', { browserId, script });
}
export async function browserEvalResult(browserId: string, script: string): Promise<string> {
  return invoke('browser_eval_result', { browserId, script });
}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/browser.rs src-tauri/src/lib.rs src/lib/browser.ts
git commit -m "feat(browser): JS eval (fire-and-forget + result round-trip)

browser_eval for click/type; browser_eval_result returns JSON-stringified
expression value via injected callback + 10s timeout.

Part of Phase 3 Sub-Phase 3B (Task 4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Manual test (3B done):** open a browser window (Task 2), grab its browser_id from `listBrowserWindows()`, call `browserNavigate(id, 'https://example.org')` → the window changes pages.

> **Post-implementation correction (2026-06-19):** `browser_eval_result` was implemented, then REMOVED after live testing. External browser content has no `window.__TAURI__`, so the injected callback never returns and the call hangs until timeout. Only fire-and-forget `browser_eval` is kept. See the Phase 3 spec "External content cannot call back". 3B's validated surface is: navigate/back/forward/reload/get_url + fire-and-forget eval.

---

## Sub-Phase 3C: MCP Browser Tools

### Task 5: Expose browser tools via the pane-context MCP server

**Files:**
- Modify: `src-tauri/src/mcp/pane_context_server.rs`

**Interfaces:**
- Consumes: Phase 2's `PaneContextMcpServer` (holds `Arc<PaneContextManager>`); Task 1's `BrowserManager`.
- Produces: 4 MCP tools `browser_open(url)`, `browser_list()`, `browser_navigate(browser_id, url)`, `browser_get_content(browser_id)` added to the server's `get_tools()` and `handle_tool_call()`.

**Note:** The MCP server currently holds only `Arc<PaneContextManager>`. Add `Arc<BrowserManager>` so it can list/track browsers. Actual window creation/eval must route through the `AppHandle` — since the MCP server may not hold an `AppHandle`, these tools return the registry data (`browser_list`) and enqueue actions via the existing command layer. For MVP, implement `browser_list` fully (reads `BrowserManager`), and implement `browser_open`/`browser_navigate`/`browser_get_content` to return a structured "not yet wired to AppHandle" descriptor IF the server lacks an AppHandle. If the server is constructed with an `AppHandle`, wire them through. Check the constructor before implementing.

- [ ] **Step 1: Inspect the current MCP server constructor**

Run: `cd src-tauri && grep -n "impl PaneContextMcpServer\|pub fn new\|AppHandle\|manager:" src/mcp/pane_context_server.rs`
Expected: shows whether the server holds an `AppHandle`. Record the finding; it determines Step 3.

- [ ] **Step 2: Add BrowserManager to the server struct**

In `src-tauri/src/mcp/pane_context_server.rs`, add a field and constructor parameter:
```rust
// In the struct:
    browser_manager: std::sync::Arc<crate::browser::BrowserManager>,
```
Update `new(...)` to accept and store `browser_manager: std::sync::Arc<crate::browser::BrowserManager>`. Update the call site (search the codebase for `PaneContextMcpServer::new(`) to pass `state.browser_manager.clone()`.

- [ ] **Step 3: Add the browser tools to get_tools()**

In the `get_tools()` method, add to the returned `Vec<Tool>`:
```rust
            Tool {
                name: "browser_list".to_string(),
                description: "List all open browser windows with their browser_id and url".to_string(),
                input_schema: serde_json::json!({ "type": "object", "properties": {} }),
            },
            Tool {
                name: "browser_get_content".to_string(),
                description: "Get the current URL of an open browser window by browser_id".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": { "browser_id": { "type": "string" } },
                    "required": ["browser_id"]
                }),
            },
```

- [ ] **Step 4: Handle the tool calls**

In `handle_tool_call()`, add match arms (before the catch-all `_ =>`):
```rust
            "browser_list" => {
                let windows = self.browser_manager.list();
                Ok(serde_json::json!({ "windows": windows, "count": windows.len() }))
            }
            "browser_get_content" => {
                let browser_id = arguments.get("browser_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing browser_id"))?;
                match self.browser_manager.get_url(browser_id) {
                    Some(url) => Ok(serde_json::json!({ "browserId": browser_id, "url": url })),
                    None => Err(anyhow::anyhow!("Browser window not found: {}", browser_id)),
                }
            }
```

- [ ] **Step 5: Verify clean build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds

- [ ] **Step 6: Run MCP server tests**

Run: `cd src-tauri && cargo test pane_context_server`
Expected: existing tests pass; update any test asserting the tool count to include the 2 new tools.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/mcp/pane_context_server.rs
git commit -m "feat(mcp): expose browser_list + browser_get_content tools

External agents can enumerate open browser windows and read their URLs.

Part of Phase 3 Sub-Phase 3C (Task 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Sub-Phase 3D: Cookie Import (macOS Chrome + Safari)

### Task 6: Chrome cookie reader + Keychain decryption (macOS)

**Files:**
- Create: `src-tauri/src/browser/cookies.rs`
- Modify: `src-tauri/src/browser/mod.rs` (export)

**Interfaces:**
- Consumes: `rusqlite` (already a dep), `base64` (already a dep). Uses the `security` CLI for the Keychain key. AES-128-CBC decryption.
- Produces:
  - `Cookie { host: String, name: String, value: String, path: String }`
  - `read_chrome_cookies(host_filter: &str) -> Result<Vec<Cookie>>` — reads Chrome's Cookies SQLite, decrypts `encrypted_value`, returns cookies whose host_key contains `host_filter`.

**Algorithm facts (macOS Chrome):** the AES key is PBKDF2-HMAC-SHA1(password = Keychain "Chrome Safe Storage" generic password, salt = `b"saltysalt"`, iterations = 1003, key_len = 16). Encrypted values start with the 3-byte prefix `v10`; the ciphertext follows. Cipher = AES-128-CBC, IV = 16 bytes of `0x20` (space). After decryption, Chrome (v24+) prepends a 32-byte SHA256 domain hash that must be stripped; if the leading bytes are not valid UTF-8 text, strip the first 32 bytes.

**Dependencies to add** to `src-tauri/Cargo.toml` (these are small, well-known crates; add under `[dependencies]`):
```toml
aes = "0.8"
cbc = "0.1"
pbkdf2 = "0.12"
hmac = "0.12"
sha1 = "0.10"
```

- [ ] **Step 1: Add the crypto dependencies**

Edit `src-tauri/Cargo.toml`, add under `[dependencies]` the 5 lines above. Run `cd src-tauri && cargo fetch` to confirm they resolve.

- [ ] **Step 2: Write the failing test for prefix detection**

Create `src-tauri/src/browser/cookies.rs`:
```rust
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub host: String,
    pub name: String,
    pub value: String,
    pub path: String,
}

/// PBKDF2-derive the AES-128 key for macOS Chrome cookie decryption.
fn chrome_derive_key(keychain_password: &str) -> [u8; 16] {
    use hmac::Hmac;
    use sha1::Sha1;
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2::<Hmac<Sha1>>(
        keychain_password.as_bytes(),
        b"saltysalt",
        1003,
        &mut key,
    )
    .expect("pbkdf2 key derivation");
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_derivation_is_deterministic_and_16_bytes() {
        let k1 = chrome_derive_key("test-password");
        let k2 = chrome_derive_key("test-password");
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 16);
        let k3 = chrome_derive_key("different");
        assert_ne!(k1, k3);
    }
}
```

- [ ] **Step 3: Run the test**

Run: `cd src-tauri && cargo test browser::cookies::tests::test_key_derivation`
Expected: PASS

- [ ] **Step 4: Implement Keychain key fetch + decryption**

Append to `src-tauri/src/browser/cookies.rs`:
```rust
/// Fetch the "Chrome Safe Storage" password from the macOS Keychain via the
/// `security` CLI. Returns the raw password used as PBKDF2 input.
#[cfg(target_os = "macos")]
fn chrome_keychain_password() -> Result<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"])
        .output()
        .context("running `security find-generic-password`")?;
    if !output.status.success() {
        anyhow::bail!(
            "Keychain lookup failed (user may have denied access): {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

/// Decrypt one Chrome `encrypted_value`. Returns the plaintext cookie value.
#[cfg(target_os = "macos")]
fn chrome_decrypt(encrypted: &[u8], key: &[u8; 16]) -> Result<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

    if encrypted.len() < 3 {
        anyhow::bail!("encrypted value too short");
    }
    // Strip the "v10" version prefix.
    let ciphertext = &encrypted[3..];
    let iv = [0x20u8; 16]; // 16 spaces

    let mut buf = ciphertext.to_vec();
    let pt = Aes128CbcDec::new(key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| anyhow::anyhow!("AES decrypt failed: {:?}", e))?;

    // Chrome v24+ prepends a 32-byte SHA256 domain hash. If the start is not
    // printable UTF-8, strip the first 32 bytes.
    let candidate = if pt.len() > 32 && std::str::from_utf8(&pt[..1]).map(|s| s.chars().all(|c| c.is_control())).unwrap_or(true) {
        &pt[32..]
    } else {
        pt
    };
    Ok(String::from_utf8_lossy(candidate).to_string())
}

/// Read and decrypt Chrome cookies for hosts containing `host_filter`.
#[cfg(target_os = "macos")]
pub fn read_chrome_cookies(host_filter: &str) -> Result<Vec<Cookie>> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let db_path = format!(
        "{}/Library/Application Support/Google/Chrome/Default/Cookies",
        home
    );
    let password = chrome_keychain_password()?;
    let key = chrome_derive_key(&password);

    // Open read-only; Chrome may hold a lock, so use immutable mode.
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .with_context(|| format!("opening Chrome cookies db at {}", db_path))?;

    let mut stmt = conn.prepare(
        "SELECT host_key, name, encrypted_value, path FROM cookies WHERE host_key LIKE ?1",
    )?;
    let like = format!("%{}%", host_filter);
    let rows = stmt.query_map([like], |row| {
        let host: String = row.get(0)?;
        let name: String = row.get(1)?;
        let enc: Vec<u8> = row.get(2)?;
        let path: String = row.get(3)?;
        Ok((host, name, enc, path))
    })?;

    let mut cookies = Vec::new();
    for r in rows {
        let (host, name, enc, path) = r?;
        match chrome_decrypt(&enc, &key) {
            Ok(value) => cookies.push(Cookie { host, name, value, path }),
            Err(_) => { /* skip undecryptable cookies */ }
        }
    }
    Ok(cookies)
}

#[cfg(not(target_os = "macos"))]
pub fn read_chrome_cookies(_host_filter: &str) -> Result<Vec<Cookie>> {
    anyhow::bail!("Chrome cookie import is only supported on macOS")
}
```

- [ ] **Step 5: Export from the module**

In `src-tauri/src/browser/mod.rs`, add:
```rust
pub mod cookies;
pub use cookies::{Cookie, read_chrome_cookies};
```

- [ ] **Step 6: Verify clean build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds (the key-derivation test still passes; decryption is exercised manually in Task 8's verification).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/browser/cookies.rs src-tauri/src/browser/mod.rs
git commit -m "feat(browser): macOS Chrome cookie reader + Keychain decryption

PBKDF2(saltysalt,1003)->AES-128-CBC, v10 prefix, 32-byte hash strip.
Keychain key via security CLI. Host-filtered.

Part of Phase 3 Sub-Phase 3D (Task 6)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Safari cookie reader (binarycookies) + import command

**Files:**
- Modify: `src-tauri/src/browser/cookies.rs`
- Modify: `src-tauri/src/commands/browser.rs` (add `browser_import_cookies`)
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `src/lib/browser.ts`

**Interfaces:**
- Consumes: Task 6's `Cookie`; Task 1's `get_browser`.
- Produces:
  - `read_safari_cookies(host_filter: &str) -> Result<Vec<Cookie>>`
  - command `browser_import_cookies(browser_id: String, source: String) -> Result<usize, String>` where source ∈ {"chrome","safari"}; injects cookies into the browser window via `document.cookie` and returns the count injected.

- [ ] **Step 1: Implement the binarycookies parser**

Append to `src-tauri/src/browser/cookies.rs`:
```rust
/// Minimal parser for Safari's Cookies.binarycookies format.
/// Layout: magic "cook", u32be page_count, [u32be page_size]*, then pages.
/// Each page: u32le 0x00000100, u32le cookie_count, [u32le offset]*,
/// then cookies. Each cookie record holds little-endian offsets to URL,
/// name, path, value (relative to the cookie record start).
#[cfg(target_os = "macos")]
pub fn read_safari_cookies(host_filter: &str) -> Result<Vec<Cookie>> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let path = format!("{}/Library/Cookies/Cookies.binarycookies", home);
    let data = std::fs::read(&path).with_context(|| format!("reading {}", path))?;
    parse_binarycookies(&data, host_filter)
}

#[cfg(target_os = "macos")]
fn read_cstr(data: &[u8], start: usize) -> String {
    let mut end = start;
    while end < data.len() && data[end] != 0 {
        end += 1;
    }
    String::from_utf8_lossy(&data[start..end]).to_string()
}

#[cfg(target_os = "macos")]
fn parse_binarycookies(data: &[u8], host_filter: &str) -> Result<Vec<Cookie>> {
    if data.len() < 8 || &data[0..4] != b"cook" {
        anyhow::bail!("not a binarycookies file");
    }
    let page_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let mut page_sizes = Vec::with_capacity(page_count);
    let mut off = 8;
    for _ in 0..page_count {
        if off + 4 > data.len() { anyhow::bail!("truncated page sizes"); }
        page_sizes.push(u32::from_be_bytes([data[off], data[off+1], data[off+2], data[off+3]]) as usize);
        off += 4;
    }

    let mut cookies = Vec::new();
    let mut page_start = off;
    for &size in &page_sizes {
        if page_start + size > data.len() { break; }
        let page = &data[page_start..page_start + size];
        page_start += size;

        if page.len() < 8 { continue; }
        let cookie_count = u32::from_le_bytes([page[4], page[5], page[6], page[7]]) as usize;
        let mut cookie_offsets = Vec::with_capacity(cookie_count);
        let mut p = 8;
        for _ in 0..cookie_count {
            if p + 4 > page.len() { break; }
            cookie_offsets.push(u32::from_le_bytes([page[p], page[p+1], page[p+2], page[p+3]]) as usize);
            p += 4;
        }

        for &co in &cookie_offsets {
            if co + 40 > page.len() { continue; }
            let rec = &page[co..];
            let url_off = u32::from_le_bytes([rec[16], rec[17], rec[18], rec[19]]) as usize;
            let name_off = u32::from_le_bytes([rec[20], rec[21], rec[22], rec[23]]) as usize;
            let path_off = u32::from_le_bytes([rec[24], rec[25], rec[26], rec[27]]) as usize;
            let value_off = u32::from_le_bytes([rec[28], rec[29], rec[30], rec[31]]) as usize;

            let host = read_cstr(rec, url_off);
            let name = read_cstr(rec, name_off);
            let path = read_cstr(rec, path_off);
            let value = read_cstr(rec, value_off);

            if host.contains(host_filter) {
                cookies.push(Cookie { host, name, value, path });
            }
        }
    }
    Ok(cookies)
}

#[cfg(not(target_os = "macos"))]
pub fn read_safari_cookies(_host_filter: &str) -> Result<Vec<Cookie>> {
    anyhow::bail!("Safari cookie import is only supported on macOS")
}
```

- [ ] **Step 2: Add a parser unit test with a synthetic file**

Append to the `tests` module in `src-tauri/src/browser/cookies.rs`:
```rust
    #[cfg(target_os = "macos")]
    #[test]
    fn test_binarycookies_rejects_bad_magic() {
        let bad = b"nope\x00\x00\x00\x00";
        assert!(super::parse_binarycookies(bad, "").is_err());
    }
```

- [ ] **Step 3: Run cookie tests**

Run: `cd src-tauri && cargo test browser::cookies`
Expected: PASS (key derivation + bad-magic rejection)

- [ ] **Step 4: Export the Safari reader**

In `src-tauri/src/browser/mod.rs`, update the cookies re-export line to:
```rust
pub use cookies::{Cookie, read_chrome_cookies, read_safari_cookies};
```

- [ ] **Step 5: Add the import command**

In `src-tauri/src/commands/browser.rs`, append:
```rust
/// Import cookies from a source browser into an open browser window for the
/// host of that window's current URL. Returns the number of cookies injected.
#[tauri::command]
pub async fn browser_import_cookies(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
    source: String,
) -> Result<usize, String> {
    // Determine host from the window's current URL.
    let url = state.browser_manager.get_url(&browser_id)
        .ok_or_else(|| format!("Browser window '{}' not found", browser_id))?;
    let host = url
        .parse::<url::Url>()
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    let cookies = match source.as_str() {
        "chrome" => crate::browser::read_chrome_cookies(&host),
        "safari" => crate::browser::read_safari_cookies(&host),
        other => return Err(format!("Unknown cookie source: {}", other)),
    }
    .map_err(|e| format!("Failed to read {} cookies: {}", source, e))?;

    let win = get_browser(&app, &browser_id)?;
    let mut injected = 0usize;
    for c in &cookies {
        // Set each cookie via document.cookie. Escape quotes/backslashes.
        let name = c.name.replace('\\', "\\\\").replace('"', "\\\"");
        let value = c.value.replace('\\', "\\\\").replace('"', "\\\"");
        let path = if c.path.is_empty() { "/".to_string() } else { c.path.clone() };
        let script = format!(
            "document.cookie = \"{}=\" + \"{}\" + \"; path={}\";",
            name, value, path
        );
        if win.eval(&script).is_ok() {
            injected += 1;
        }
    }
    Ok(injected)
}
```

Note: `url` crate is already a transitive dep via Tauri; if `cargo build` complains it's not a direct dependency, add `url = "2"` to `[dependencies]` in `src-tauri/Cargo.toml`.

- [ ] **Step 6: Register the command**

In `src-tauri/src/lib.rs`, after `commands::browser::browser_eval_result,` add:
```rust
            commands::browser::browser_import_cookies,
```

- [ ] **Step 7: Verify clean build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds (add `url = "2"` to Cargo.toml if needed, then rebuild)

- [ ] **Step 8: Add the frontend binding**

In `src/lib/browser.ts`, append:
```typescript
export async function browserImportCookies(browserId: string, source: 'chrome' | 'safari'): Promise<number> {
  return invoke('browser_import_cookies', { browserId, source });
}
```

- [ ] **Step 9: Verify TypeScript + commit**

Run: `npx tsc --noEmit` (expect no new errors), then:
```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/browser/cookies.rs src-tauri/src/browser/mod.rs src-tauri/src/commands/browser.rs src-tauri/src/lib.rs src/lib/browser.ts
git commit -m "feat(browser): Safari binarycookies parser + cookie import command

browser_import_cookies(browser_id, source) injects host-scoped cookies
from Chrome/Safari into an open browser window via document.cookie.

Part of Phase 3 Sub-Phase 3D (Task 7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Settings → Browser tab (cookie import UI)

**Files:**
- Create: `src/components/SettingsBrowserTab.tsx`
- Create: `src/components/SettingsBrowserTab.test.tsx`
- Modify: `src/windows/Settings.tsx`

**Interfaces:**
- Consumes: Task 2's `listBrowserWindows`, Task 7's `browserImportCookies`.
- Produces: `<SettingsBrowserTab />` — lists open browser windows, lets the user pick one + a source (Chrome/Safari) and import cookies, showing the count.

- [ ] **Step 1: Write the failing test**

Create `src/components/SettingsBrowserTab.test.tsx`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SettingsBrowserTab from './SettingsBrowserTab';
import * as browserLib from '../lib/browser';

describe('SettingsBrowserTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists open browser windows', async () => {
    vi.spyOn(browserLib, 'listBrowserWindows').mockResolvedValue([
      { browserId: 'browser-1', url: 'https://192.168.1.1' },
    ]);
    render(<SettingsBrowserTab />);
    await waitFor(() => {
      expect(screen.getByText(/192.168.1.1/)).toBeInTheDocument();
    });
  });

  it('imports cookies and shows the count', async () => {
    vi.spyOn(browserLib, 'listBrowserWindows').mockResolvedValue([
      { browserId: 'browser-1', url: 'https://192.168.1.1' },
    ]);
    const importSpy = vi.spyOn(browserLib, 'browserImportCookies').mockResolvedValue(5);

    render(<SettingsBrowserTab />);
    await waitFor(() => screen.getByText(/192.168.1.1/));

    fireEvent.click(screen.getByTestId('import-chrome-browser-1'));

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith('browser-1', 'chrome');
      expect(screen.getByText(/Imported 5 cookies/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test SettingsBrowserTab`
Expected: FAIL ("SettingsBrowserTab not found")

- [ ] **Step 3: Implement the component**

Create `src/components/SettingsBrowserTab.tsx`:
```typescript
import React, { useEffect, useState } from 'react';
import { listBrowserWindows, browserImportCookies, BrowserWindowInfo } from '../lib/browser';

const SettingsBrowserTab: React.FC = () => {
  const [windows, setWindows] = useState<BrowserWindowInfo[]>([]);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    listBrowserWindows().then(setWindows).catch((e) => {
      console.error('Failed to list browser windows:', e);
    });
  }, []);

  const handleImport = async (browserId: string, source: 'chrome' | 'safari') => {
    setStatus('Importing…');
    try {
      const count = await browserImportCookies(browserId, source);
      setStatus(`Imported ${count} cookies from ${source}.`);
    } catch (e) {
      setStatus(`Import failed: ${e}`);
    }
  };

  return (
    <div className="settings-browser-tab" style={{ padding: 20 }}>
      <h2>Browser Cookie Import (macOS)</h2>
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        Import cookies from Chrome or Safari into an open browser window so device
        web UIs are pre-authenticated. Cookies are scoped to the window's current host.
      </p>
      {windows.length === 0 ? (
        <div style={{ opacity: 0.6 }}>No open browser windows. Press ⌘⇧B to open one.</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {windows.map((w) => (
            <li key={w.browserId} style={{ marginBottom: 12 }}>
              <div style={{ fontFamily: 'monospace', fontSize: 13 }}>{w.url}</div>
              <button
                data-testid={`import-chrome-${w.browserId}`}
                onClick={() => handleImport(w.browserId, 'chrome')}
              >
                Import from Chrome
              </button>
              <button
                data-testid={`import-safari-${w.browserId}`}
                onClick={() => handleImport(w.browserId, 'safari')}
                style={{ marginLeft: 8 }}
              >
                Import from Safari
              </button>
            </li>
          ))}
        </ul>
      )}
      {status && <div style={{ marginTop: 12 }}>{status}</div>}
    </div>
  );
};

export default SettingsBrowserTab;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test SettingsBrowserTab`
Expected: PASS

- [ ] **Step 5: Add the Browser tab to Settings**

In `src/windows/Settings.tsx`, mirror the existing tab pattern (search for how the `stealthwatch` or `proxmox` tab is added — there is an `activeTab` union type, a tab button, and a conditional render). Add `'browser'` to the union, a tab button labeled "Browser" (place it after "Terminal"), import `SettingsBrowserTab`, and render `{activeTab === 'browser' && <SettingsBrowserTab />}`.

- [ ] **Step 6: Verify full suite + commit**

Run: `npm test` (expect all pass), then:
```bash
git add src/components/SettingsBrowserTab.tsx src/components/SettingsBrowserTab.test.tsx src/windows/Settings.tsx
git commit -m "feat(browser): Settings Browser tab for cookie import

Lists open browser windows; import Chrome/Safari cookies per window.

Part of Phase 3 Sub-Phase 3D (Task 8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Manual test (3D done):** open `⌘⇧B` to a site you're logged into in Chrome → Settings → Browser → Import from Chrome → reload the browser window → you're logged in.

---

## Sub-Phase 3E: Metadata Sidebar

### Task 9: Metadata gathering module (git branch / ports / process)

**Files:**
- Create: `src-tauri/src/pane_context/metadata.rs`
- Modify: `src-tauri/src/pane_context/mod.rs` (export)

**Interfaces:**
- Consumes: a `cwd: &str`.
- Produces:
  - `PaneMetadata { cwd: String, git_branch: Option<String>, listening_ports: Vec<u16>, last_exit_code: Option<i32> }` (serde camelCase)
  - `gather_metadata(cwd: &str, last_exit_code: Option<i32>) -> PaneMetadata`
  - `git_branch(cwd: &str) -> Option<String>`
  - `listening_ports() -> Vec<u16>`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/pane_context/metadata.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaneMetadata {
    pub cwd: String,
    pub git_branch: Option<String>,
    pub listening_ports: Vec<u16>,
    pub last_exit_code: Option<i32>,
}

/// Get the current git branch for `cwd`, or None if not a repo.
pub fn git_branch(cwd: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["-C", cwd, "branch", "--show-current"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() { None } else { Some(branch) }
}

/// List local TCP ports in LISTEN state (system-wide, macOS/Linux via lsof).
pub fn listening_ports() -> Vec<u16> {
    let output = match std::process::Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut ports = std::collections::BTreeSet::new();
    for line in text.lines().skip(1) {
        // The NAME column contains e.g. "127.0.0.1:8000" or "*:8000".
        if let Some(name) = line.split_whitespace().last() {
            if let Some(colon) = name.rfind(':') {
                if let Ok(p) = name[colon + 1..].parse::<u16>() {
                    ports.insert(p);
                }
            }
        }
    }
    ports.into_iter().collect()
}

pub fn gather_metadata(cwd: &str, last_exit_code: Option<i32>) -> PaneMetadata {
    PaneMetadata {
        cwd: cwd.to_string(),
        git_branch: git_branch(cwd),
        listening_ports: listening_ports(),
        last_exit_code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_git_branch_in_this_repo() {
        // The crate is built inside the project's git repo; the manifest dir
        // is a working tree, so a branch should resolve.
        let dir = env!("CARGO_MANIFEST_DIR");
        let branch = git_branch(dir);
        assert!(branch.is_some(), "expected a git branch in {}", dir);
    }

    #[test]
    fn test_git_branch_none_for_non_repo() {
        assert_eq!(git_branch("/"), None);
    }

    #[test]
    fn test_gather_metadata_shape() {
        let m = gather_metadata("/", Some(0));
        assert_eq!(m.cwd, "/");
        assert_eq!(m.last_exit_code, Some(0));
        // ports list is environment-dependent; just confirm it returns a Vec.
        let _ = m.listening_ports.len();
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cd src-tauri && cargo test pane_context::metadata`
Expected: 3 tests PASS

- [ ] **Step 3: Export the module**

In `src-tauri/src/pane_context/mod.rs`, add:
```rust
pub mod metadata;
pub use metadata::{PaneMetadata, gather_metadata};
```

- [ ] **Step 4: Verify build + commit**

Run: `cd src-tauri && cargo build` (expect success), then:
```bash
git add src-tauri/src/pane_context/metadata.rs src-tauri/src/pane_context/mod.rs
git commit -m "feat(metadata): git branch / listening ports / metadata gathering

Part of Phase 3 Sub-Phase 3E (Task 9)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: get_pane_metadata command + frontend binding

**Files:**
- Modify: `src-tauri/src/commands/pane_activity.rs`
- Modify: `src-tauri/src/lib.rs` (register command)
- Create: `src/lib/metadata.ts`

**Interfaces:**
- Consumes: Task 9's `gather_metadata`, `PaneMetadata`; Phase 1's `pane_manager.get_activity(pane_id)` (provides cwd + last exit code).
- Produces: command `get_pane_metadata(pane_id: String) -> Result<PaneMetadata, String>`; `src/lib/metadata.ts` with `getPaneMetadata(paneId: string): Promise<PaneMetadata>` and the `PaneMetadata` interface.

- [ ] **Step 1: Add the command**

In `src-tauri/src/commands/pane_activity.rs`, add the import at the top (extend the existing `use crate::pane_context::{...}` line) to include `PaneMetadata, gather_metadata`, then append:
```rust
#[tauri::command]
pub async fn get_pane_metadata(
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<crate::pane_context::PaneMetadata, String> {
    let activity = state.pane_manager.get_activity(&pane_id);
    let cwd = activity
        .as_ref()
        .map(|a| a.cwd.clone())
        .unwrap_or_else(|| "/".to_string());
    let last_exit_code = activity
        .as_ref()
        .and_then(|a| a.active_command.as_ref())
        .and_then(|c| c.exit_code);
    Ok(crate::pane_context::gather_metadata(&cwd, last_exit_code))
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, after `commands::pane_activity::get_notification_preferences,` add:
```rust
            commands::pane_activity::get_pane_metadata,
```

- [ ] **Step 3: Verify clean build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds

- [ ] **Step 4: Create the frontend binding**

Create `src/lib/metadata.ts`:
```typescript
import { invoke } from '@tauri-apps/api/core';

export interface PaneMetadata {
  cwd: string;
  gitBranch: string | null;
  listeningPorts: number[];
  lastExitCode: number | null;
}

export async function getPaneMetadata(paneId: string): Promise<PaneMetadata> {
  return invoke('get_pane_metadata', { paneId });
}
```

- [ ] **Step 5: Verify TypeScript + commit**

Run: `npx tsc --noEmit` (expect no new errors), then:
```bash
git add src-tauri/src/commands/pane_activity.rs src-tauri/src/lib.rs src/lib/metadata.ts
git commit -m "feat(metadata): get_pane_metadata command + frontend binding

Part of Phase 3 Sub-Phase 3E (Task 10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: MetadataSidebar component + ⌘⇧O toggle

**Files:**
- Create: `src/state/metadataStore.ts`
- Create: `src/components/MetadataSidebar.tsx`
- Create: `src/components/MetadataSidebar.css`
- Create: `src/components/MetadataSidebar.test.tsx`
- Modify: `src/App.tsx` (mount + `⌘⇧O`)

**Interfaces:**
- Consumes: Task 10's `getPaneMetadata`; Phase 1's `usePanesStore` focused pane id (search the codebase for the focused-pane selector used by `set_pane_focus` callers — it is `usePanesStore.getState().focusedPaneId` or similar; confirm the exact name).
- Produces: `useMetadataStore` (Zustand) with `isOpen: boolean`, `toggle()`, `setOpen(b)`; `<MetadataSidebar />` that polls `getPaneMetadata(focusedPaneId)` every 5s **only while open**.

- [ ] **Step 1: Create the metadata store**

Create `src/state/metadataStore.ts`:
```typescript
import { create } from 'zustand';

interface MetadataState {
  isOpen: boolean;
  toggle: () => void;
  setOpen: (b: boolean) => void;
}

export const useMetadataStore = create<MetadataState>((set) => ({
  isOpen: false,
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  setOpen: (b) => set({ isOpen: b }),
}));
```

- [ ] **Step 2: Write the failing test**

Create `src/components/MetadataSidebar.test.tsx`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MetadataSidebar from './MetadataSidebar';
import { useMetadataStore } from '../state/metadataStore';
import * as metaLib from '../lib/metadata';

describe('MetadataSidebar', () => {
  beforeEach(() => {
    useMetadataStore.setState({ isOpen: true });
    vi.spyOn(metaLib, 'getPaneMetadata').mockResolvedValue({
      cwd: '/Users/me/project',
      gitBranch: 'main',
      listeningPorts: [8000, 5173],
      lastExitCode: 0,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders metadata when open', async () => {
    render(<MetadataSidebar focusedPaneId="pane-1" />);
    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument();
      expect(screen.getByText(/8000/)).toBeInTheDocument();
      expect(screen.getByText('/Users/me/project')).toBeInTheDocument();
    });
  });

  it('renders nothing when closed', () => {
    useMetadataStore.setState({ isOpen: false });
    const { container } = render(<MetadataSidebar focusedPaneId="pane-1" />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test MetadataSidebar`
Expected: FAIL ("MetadataSidebar not found")

- [ ] **Step 4: Implement the component**

Create `src/components/MetadataSidebar.tsx`:
```typescript
import React, { useEffect, useState } from 'react';
import { useMetadataStore } from '../state/metadataStore';
import { getPaneMetadata, PaneMetadata } from '../lib/metadata';
import './MetadataSidebar.css';

interface MetadataSidebarProps {
  focusedPaneId: string | null;
}

const MetadataSidebar: React.FC<MetadataSidebarProps> = ({ focusedPaneId }) => {
  const isOpen = useMetadataStore((s) => s.isOpen);
  const [meta, setMeta] = useState<PaneMetadata | null>(null);

  useEffect(() => {
    if (!isOpen || !focusedPaneId) return;

    let cancelled = false;
    const load = async () => {
      try {
        const m = await getPaneMetadata(focusedPaneId);
        if (!cancelled) setMeta(m);
      } catch (e) {
        console.error('Failed to load pane metadata:', e);
      }
    };
    load();
    const interval = setInterval(load, 5000); // lazy: only while open
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isOpen, focusedPaneId]);

  if (!isOpen) return null;

  return (
    <div className="metadata-sidebar" data-testid="metadata-sidebar">
      <h3>Pane Info</h3>
      {!meta ? (
        <div className="metadata-empty">Loading…</div>
      ) : (
        <dl className="metadata-list">
          <dt>Directory</dt>
          <dd className="metadata-mono">{meta.cwd}</dd>
          <dt>Git Branch</dt>
          <dd>{meta.gitBranch ?? <span className="metadata-empty">— not a repo —</span>}</dd>
          <dt>Listening Ports</dt>
          <dd>{meta.listeningPorts.length ? meta.listeningPorts.join(', ') : <span className="metadata-empty">none</span>}</dd>
          <dt>Last Exit Code</dt>
          <dd>{meta.lastExitCode ?? <span className="metadata-empty">—</span>}</dd>
        </dl>
      )}
    </div>
  );
};

export default MetadataSidebar;
```

- [ ] **Step 5: Create the CSS**

Create `src/components/MetadataSidebar.css`:
```css
.metadata-sidebar {
  position: absolute;
  top: 0;
  right: 0;
  width: 260px;
  height: 100%;
  background-color: var(--bg-secondary, #1e1e1e);
  border-left: 1px solid var(--border-color, #333);
  padding: 16px;
  overflow-y: auto;
  z-index: 50;
  color: var(--text-primary, #fff);
}
.metadata-sidebar h3 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}
.metadata-list { margin: 0; }
.metadata-list dt {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
  margin-top: 12px;
}
.metadata-list dd {
  margin: 2px 0 0;
  font-size: 13px;
  word-break: break-all;
}
.metadata-mono { font-family: 'Monaco', 'Menlo', monospace; font-size: 12px; }
.metadata-empty { opacity: 0.5; font-style: italic; }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test MetadataSidebar`
Expected: PASS

- [ ] **Step 7: Mount the sidebar + ⌘⇧O in App.tsx**

In `src/App.tsx`:
1. Import: `import MetadataSidebar from './components/MetadataSidebar';` and `import { useMetadataStore } from './state/metadataStore';`
2. Add the shortcut near the other `useKeyboardShortcut` calls:
```typescript
  // Phase 3: toggle metadata sidebar (⌘⇧O)
  useKeyboardShortcut('o', () => useMetadataStore.getState().toggle(), { cmd: true, shift: true });
```
3. Mount the sidebar inside the main terminal area container (the element that wraps the panes), passing the focused pane id. Use the same focused-pane source the `⌘⇧N` handler uses — confirm via `grep "focusedPaneId\|getFocusedPane" src/state/panesStore.ts`. Render:
```tsx
<MetadataSidebar focusedPaneId={usePanesStore((s) => s.focusedPaneId)} />
```
(Adjust the selector name to the actual store field confirmed by grep.)

- [ ] **Step 8: Verify suite + commit**

Run: `npm test` (expect all pass), then:
```bash
git add src/state/metadataStore.ts src/components/MetadataSidebar.tsx src/components/MetadataSidebar.css src/components/MetadataSidebar.test.tsx src/App.tsx
git commit -m "feat(metadata): MetadataSidebar component + cmd-shift-O toggle

Lazy 5s polling only while open. Shows cwd, git branch, ports, exit code.

Part of Phase 3 Sub-Phase 3E (Task 11)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Manual test (3E done):** press `⌘⇧O` → sidebar appears; `cd` into a git repo → branch shows within 5s; `python3 -m http.server 8000` → port 8000 appears.

---

## Sub-Phase 3F: Topology Integration

### Task 12: "Open Web UI" action in TopologyInspector

**Files:**
- Modify: `src/components/topology/TopologyInspector.tsx`

**Interfaces:**
- Consumes: Task 2's `createBrowserWindow`. The inspector already holds the selected device/node — confirm the field that carries the device management IP/host (grep for `ip`, `mgmt`, `host`, `address` within the component).
- Produces: an "Open Web UI" button that calls `createBrowserWindow('https://<device-ip>')`.

- [ ] **Step 1: Inspect TopologyInspector for the device IP field**

Run: `cd /Users/shaunwhi/CCIE\ Terminal && grep -nE "ip|host|mgmt|address|interface" src/components/topology/TopologyInspector.tsx | head -20`
Expected: identify the prop/state holding the device's reachable IP (record the exact field name).

- [ ] **Step 2: Add the Open Web UI handler + button**

In `src/components/topology/TopologyInspector.tsx`, add an import:
```typescript
import { createBrowserWindow } from '../../lib/browser';
```
Add a handler (use the device IP field identified in Step 1 — shown here as `device.ip`; substitute the real field):
```typescript
  const handleOpenWebUi = async () => {
    if (!device?.ip) return;
    try {
      await createBrowserWindow(`https://${device.ip}`);
    } catch (e) {
      console.error('Failed to open device web UI:', e);
      window.alert(`Failed to open web UI: ${e}`);
    }
  };
```
Render a button in the inspector's action area (next to existing actions like SSH), guarded on the IP being present:
```tsx
{device?.ip && (
  <button className="topo-action-btn" onClick={handleOpenWebUi}>
    Open Web UI
  </button>
)}
```
Match the existing button styling/className used by neighboring inspector actions.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Run the topology tests**

Run: `npm test TopologyInspector`
Expected: existing tests pass (no test exists for the new button unless one is trivially addable; if the file has a test, add a render assertion that the button appears when a device IP is present).

- [ ] **Step 5: Commit**

```bash
git add src/components/topology/TopologyInspector.tsx
git commit -m "feat(topology): Open Web UI action launches a browser window

Right-click/select a device -> Open Web UI -> browser window at https://<ip>.

Part of Phase 3 Sub-Phase 3F (Task 12)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Manual test (3F done):** in the Topology tab, select a device with a management IP → click "Open Web UI" → a browser window opens at `https://<ip>`.

---

## Task 13: End-to-End Verification

**Files:** none (verification only)

- [ ] **Step 1: Backend test sweep**

Run: `cd src-tauri && cargo test browser:: && cargo test pane_context::metadata`
Expected: all browser + metadata tests pass.

- [ ] **Step 2: Frontend test sweep**

Run: `npm test`
Expected: all pass (including SettingsBrowserTab + MetadataSidebar).

- [ ] **Step 3: Live — browser window lifecycle**

Run the app. Press `⌘⇧B`, enter `https://example.com`. Confirm: a separate browser window opens; the main window's Settings modal (⌘,) still opens and is interactive (NOT covered). Close the browser window; confirm no crash.

- [ ] **Step 4: Live — navigation + automation**

With a browser window open, from DevTools console of the main window:
```js
const ids = await window.__TAURI__.core.invoke('list_browser_windows');
const id = ids[0].browserId;
await window.__TAURI__.core.invoke('browser_navigate', { browserId: id, url: 'https://example.org' });
await window.__TAURI__.core.invoke('browser_eval_result', { browserId: id, script: 'document.title' });
```
Expected: the window navigates; the last call returns the page title string.

- [ ] **Step 5: Live — cookie import**

Log into a site in Chrome. Open it via `⌘⇧B`. Settings → Browser → Import from Chrome. Reload the browser window. Expected: logged-in state (cookies applied). If Keychain prompts for access, allow it.

- [ ] **Step 6: Live — metadata sidebar**

Press `⌘⇧O`. `cd` into a git repo in the focused pane → branch appears within 5s. Run `python3 -m http.server 8000` → port 8000 appears within 5s. Press `⌘⇧O` to close; confirm polling stops (no further `get_pane_metadata` calls in logs).

- [ ] **Step 7: Live — MCP browser tools**

If the MCP server is reachable, call `browser_list` and `browser_get_content` for an open window; confirm they return the registry data.

- [ ] **Step 8: Live — topology Open Web UI**

Topology tab → select a device with a management IP → Open Web UI → browser window opens at the device IP.

- [ ] **Step 9: Write the verification report**

Create `.git/sdd/phase-3-verification.md` documenting each step's result (pass/fail + evidence), and note any deferred items (screenshot, Firefox/Arc cookies, Windows/Linux).

- [ ] **Step 10: Commit the report**

```bash
git add .git/sdd/phase-3-verification.md 2>/dev/null || true
git commit --allow-empty -m "docs(phase-3): end-to-end verification report (Task 13)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Browser windows core → Tasks 1-2 ✅
- Navigation + automation → Tasks 3-4 ✅
- MCP browser tools → Task 5 ✅
- Cookie import (Chrome + Safari, macOS) → Tasks 6-8 ✅
- Metadata sidebar → Tasks 9-11 ✅
- Topology Open Web UI → Task 12 ✅
- E2E verification → Task 13 ✅
- Screenshot → explicitly deferred per spec "Out of Scope" + Global Constraints ✅

**Placeholder scan:** No TBD/TODO. Steps that require codebase confirmation (MCP server constructor shape in Task 5, focused-pane store field in Task 11, device IP field in Task 12) include an explicit `grep`/inspection step so the implementer resolves the exact name rather than guessing — this is intentional, not a placeholder.

**Type consistency:** `browser_id` (snake) ↔ `browserId` (camel) consistent across Rust serde and TS. `BrowserWindowInfo`, `Cookie`, `PaneMetadata` shapes match between Rust (camelCase serde) and TS interfaces. Command names match between `lib.rs` registration, Rust command fns, and TS `invoke` strings.

**Standalone vs child webview:** Every window-creation step uses standalone `WebviewWindowBuilder` WITHOUT `.parent()` — the spike-proven safe path. The `unstable` feature flag is explicitly NOT added.

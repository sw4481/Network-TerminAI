# AI Assistant Integration Phase 3: Browser Windows & Metadata Design

**Date:** 2026-06-19
**Status:** Approved Design
**Supersedes:** The "browser panes embedded in split layout" portion of the original AI Assistant Integration design (2026-06-18), based on spike findings.

## Spike-Driven Design Change

The original Phase 3 vision called for browser panes **embedded in the React split layout**. A proof-of-concept spike (branch `spike/webview-panes`, report at `docs/spikes/spike-webview-report.md`) proved this is **not viable**:

- Native OS webviews (WKWebView/WebView2/WebKitGTK) render in a compositor layer **above** all React DOM and **ignore CSS z-index**.
- An embedded browser pane would cover the Settings modal, NotificationCenter dropdown, and command palette, making them unusable.
- This is an OS-level limitation (Electron has it too), not a Tauri bug.

**Decision:** Phase 3 uses **popup browser windows** — separate `WebviewWindow` instances — instead of embedded panes. This avoids the layering blocker entirely and provides full native WebView power (real cookie stores, self-signed cert handling, JS evaluation) which network engineers need for device web UIs.

## Goals

1. **Browser windows** — open arbitrary URLs (and device web UIs) in dedicated browser windows with navigation controls.
2. **Agent browser automation** — agents can navigate, click, type, evaluate JS, and screenshot browser windows via Tauri commands and MCP tools.
3. **Cookie import** — import cookies from Chrome/Safari (macOS-first) so device web UIs are pre-authenticated.
4. **Metadata sidebar** — show rich per-terminal-pane context (git branch, listening ports, processes, cwd).
5. **Topology integration** — right-click a device → "Open Web UI" launches a browser window at the device IP.

## Architecture

### Browser Window Manager (Rust)

A `BrowserManager` tracks open browser windows keyed by an opaque `browser_id`. Each browser window is a Tauri `WebviewWindow` created with `WebviewUrl::External(url)` and a custom React chrome is NOT used — the window shows the site directly, with navigation driven by Tauri window APIs and an injected control strip (see "Navigation Controls" below).

```
Frontend (menu / topology)
   → create_browser_window(url) Tauri command
       → BrowserManager creates WebviewWindow (External URL)
       → returns browser_id
   → browser_navigate / back / forward / reload (browser_id, ...)
   → browser_evaluate_js / click / type (browser_id, ...)  [agent automation]
   → browser_import_cookies(source)  [pre-auth]
```

**State tracked per browser window:**
- `browser_id` (opaque string)
- `url` (current)
- `title`
- `window_label` (Tauri label)

### Navigation Controls

Tauri 2 `WebviewWindow` showing an external URL does not give us a React address bar inside that window. Two sub-options, decided in the plan:
- **Controls via main-window command palette / menu:** "Browser → Navigate…", "Browser → Back" act on the focused browser window. Simplest, no injection.
- **Injected control strip:** inject a small fixed-position HTML/JS bar via `eval`/init script. More work; deferred unless needed.

MVP uses **menu/command-driven navigation** plus the window's own native back/forward (two-finger swipe on macOS). An address bar is a later enhancement.

### Browser Automation (Rust + MCP)

Agent-facing commands operate on a `browser_id`:
- `browser_navigate(browser_id, url)`
- `browser_go_back / go_forward / reload(browser_id)`
- `browser_eval(browser_id, script)` — **fire-and-forget only** (click, type, scroll, set cookies)
- `browser_get_url(browser_id)`

**External content cannot call back (verified live 2026-06-19):** A result-returning
`browser_eval_result` was prototyped and removed. Browser windows load EXTERNAL
content (device web UIs at arbitrary IPs). Tauri does not inject `window.__TAURI__`
into untrusted remote pages, and `dangerousRemoteUrlIpcAccess` only whitelists
specific pre-declared trusted domains — not arbitrary device IPs. So injected JS
cannot emit a result back to Rust; any round-trip hangs until timeout. Reading
values out of the page is therefore **not feasible** and is out of scope. Agents
drive browsers via fire-and-forget actions + navigation; they read page state by
other means (the URL registry, or the user). Screenshot is also out of scope.

These are also exposed as MCP tools (extending Phase 2's `pane_context_server.rs`) so external agents (Claude Code) can drive browser windows.

### Cookie Import (Rust, macOS-first)

`browser_import_cookies(source)` where source ∈ {chrome, safari}:
- **Chrome (macOS):** read `~/Library/Application Support/Google/Chrome/Default/Cookies` (SQLite). Values are AES-128-CBC encrypted with a key from the macOS Keychain (`Chrome Safe Storage`). Decrypt and inject relevant cookies into the target browser window via `eval`/cookie APIs.
- **Safari (macOS):** `~/Library/Cookies/Cookies.binarycookies` (binary format) — parse the documented binarycookies layout.
- Firefox/Arc/Edge: **deferred** (Firefox is SQLite-unencrypted and easy, but out of MVP scope to keep the surface small).

Cookie import is scoped: import only cookies for the host of the target URL, not the entire jar.

### Metadata Sidebar (Rust + React)

A collapsible sidebar (toggle via a toolbar button + the `⌘⇧O` shortcut — "Overview"; chosen because d/i/j/k/m/n/w are already bound) showing, for the **focused terminal pane**:
- Current working directory (already tracked via OSC 7 in `pane_activity`)
- Git branch — `git -C <cwd> branch --show-current` (run on cwd change, cached)
- Listening ports — `lsof -nP -iTCP -sTCP:LISTEN` filtered to the pane's process tree (poll every 5s only while sidebar is open)
- Running foreground process — from the active command in `pane_activity`
- Last command exit code — from `pane_activity`

Metadata is gathered lazily (only when the sidebar is visible) to avoid overhead.

## Sub-Phases (each independently testable)

### Sub-Phase 3A: Browser Windows Core
- `BrowserManager` + `create_browser_window` / `close_browser_window` / `list_browser_windows`
- Menu: "Browser → New Browser Window…" (prompts for URL) + `⌘⇧B` shortcut
- Frontend binding + a simple "open URL" entry point
- **Test:** open https://example.com in a browser window; it appears as a separate OS window; closing it cleans up state.

### Sub-Phase 3B: Browser Navigation + Automation Commands
- `browser_navigate / back / forward / reload`
- `browser_evaluate_js`, `browser_get_url`, `browser_get_title`, `browser_screenshot`
- **Test:** drive a browser window via commands; evaluate `document.title` and get it back; screenshot returns PNG bytes.

### Sub-Phase 3C: MCP Browser Tools
- Extend `pane_context_server.rs` with browser tools mirroring 3B.
- **Test:** MCP tool list includes browser tools; calling `browser_navigate` via MCP works.

### Sub-Phase 3D: Cookie Import (macOS Chrome + Safari)
- `browser_import_cookies(source)` with Keychain decryption for Chrome, binarycookies parse for Safari.
- Settings → Browser → "Import Cookies From" UI.
- **Test:** import Chrome cookies for a logged-in site; open that site in a browser window; confirm logged-in state.

### Sub-Phase 3E: Metadata Sidebar
- Rust `metadata` module (git branch, ports, process) + `get_pane_metadata(pane_id)` command.
- React `MetadataSidebar` component, toggle, lazy polling.
- **Test:** cd into a git repo → sidebar shows branch; `python -m http.server 8000` → sidebar shows port 8000.

### Sub-Phase 3F: Topology Integration
- `TopologyInspector` gets an "Open Web UI" action → `create_browser_window(https://<device-ip>)`.
- **Test:** right-click device in topology → Open Web UI → browser window opens at device IP.

## Key Design Decisions

**Why popup windows, not embedded panes:** Spike-proven OS layering limitation. Popup windows give full WebView capability with zero z-index conflicts. (See spike report.)

**Why macOS-first for cookies:** The operator runs macOS; Chrome/Safari cover the common cases. Cross-platform cookie import is a large surface for marginal MVP value.

**Why lazy metadata:** `lsof` polling every 5s for every pane always-on would waste cycles. Gather only when the sidebar is visible.

**Migration:** Browser/metadata state is ephemeral (in-memory). No new SQLite table required for MVP. Next free migration remains V0055 if one becomes necessary.

## Out of Scope (Future)

- Embedded browser-in-split-layout (blocked until Tauri solves native webview layering)
- Injected in-window address bar / bookmarks
- Firefox/Arc/Edge cookie import; Windows/Linux cookie import
- Browser session restoration
- Advanced metadata (network connections, resource graphs)

## Verification Strategy

Each sub-phase has an explicit live test (above). Final end-to-end: topology device → Open Web UI (Chrome cookies imported) → terminal pane SSH'd to same device → agent reads both browser title and terminal context.

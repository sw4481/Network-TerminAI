# Parsing Sidecar Failure Modes — Manual Testing Guide

**Plan reference:** `Plans/00-foundation-sidecar-parsing.md` Task 4.2

## Overview

The E2E spec at `e2e/sidecar-failure.spec.ts` is currently **skipped** for the
same reason as `command-blocks.spec.ts`: `e2e/tauri-driver.ts` exposes a mock
page object, not a real WebDriver session, and Tauri webviews are not
Chromium so Playwright cannot drive them today.

Until `tauri-driver` is wired up, run the three failure scenarios below by
hand against `bun run tauri dev`.

## Why Tests Are Skipped

Same constraints as `COMMAND_BLOCKS_MANUAL_TEST.md`:

1. **Mock Page Object** — `tauri-driver.ts` returns a stub `Page` whose
   `click`, `fill`, etc. only `console.log`.
2. **No WebDriver** — Tauri uses platform-native webviews (WebKit on macOS,
   WebView2 on Windows, WebKitGTK on Linux). None of these speak Chromium DevTools Protocol out of the box.
3. **No tauri-driver** — the WebDriver bridge for Tauri is not installed or
   configured in this repo.

### To Enable Automated Tests (Future Work)

1. `cargo install tauri-driver`
2. Replace the mock in `e2e/tauri-driver.ts` with a real WebDriver client.
3. Configure Playwright to connect via the WebDriver protocol.
4. Remove `test.describe.skip(...)` from `e2e/sidecar-failure.spec.ts`.
5. Wire up the slow-sidecar injection point (see Test 3 below).

## Selector Notes

The current `SidecarStatusChip` (`src/components/SidecarStatusChip.tsx`) does
**not** expose a `data-testid`. Selectors today must use:

- `.status-pill.running` / `.status-pill.stopped` — the chip toggles these
  classes based on heartbeat state.
- `.status-label` text — `"Sidecar: vX.Y.Z"` when running, `"Sidecar: down"`
  when stale.

Recommend adding `data-testid="sidecar-status-chip"` when test-driver lands
to disambiguate from the neighboring FTP chip.

## Setup

1. Build and launch the app in dev mode:
   ```bash
   bun run tauri dev
   ```
2. Wait for the footer to render. The bottom-left corner should show two
   pills side by side: `Sidecar: vX.Y.Z` (green) and `FTP: ...` (separate).
3. Open DevTools (right-click → Inspect, or Cmd+Opt+I) so you can drive
   `parse_show` from the renderer console.

---

## Test 1: Sidecar killed mid-session

**Scenario:** External SIGKILL on the bundled python process. The supervisor
must notice, the chip must flip to "down", a parse call must fail with a
user-readable error (no panic, no hang), and the next call must succeed
because the supervisor respawned.

**Steps:**

1. Confirm chip shows `Sidecar: vX.Y.Z` in green.
2. In a terminal:
   ```bash
   pkill -f ccie_sidecar
   ```
   (Match name covers both the bundled portable-python invocation and
   `python -m ccie_sidecar` dev runs.)
3. Wait up to ~90 seconds — the chip polls every 10s and the heartbeat row
   goes stale after ~30s.
4. From DevTools console, fire a parse:
   ```js
   await window.__TAURI__.core.invoke('parse_show', {
     args: { vendor: 'cisco', platform: 'iosxe', command: 'show version',
             raw: 'Cisco IOS XE Software, Version 17.9.1' },
   });
   ```
5. Wait a few seconds, then re-issue the same call.

**Expected:**

- After step 2 the chip flips to red/grey `Sidecar: down` within ~90s.
- The first `parse_show` after the kill rejects with a string error like
  `"sidecar parse.request error: ..."` or a transport error from the agent
  bridge — **not** a panic, **not** a hang. Total wait < 30s.
- The second `parse_show` succeeds (returns `{ parser, data, from_cache }`)
  because the supervisor respawned the python process. The chip flips back
  to green `Sidecar: vX.Y.Z`.

**Actual:** ___________

**Status:** [ ] PASS [ ] FAIL

**Notes:** _____________________________

---

## Test 2: `NoParserError` from dispatcher

**Scenario:** Vendor/platform combination with no registered parser. The
dispatcher raises `NoParserError`, the sidecar returns a JSON error, the
Rust bridge surfaces it, and the UI must display a "no parser available"
banner over the raw output instead of crashing.

**Wire-level coverage already exists:**
`sidecar/tests/test_parse_ndjson.py::test_parse_request_unsupported_returns_error`.
This manual step covers the UI-visible end of the same path.

**Steps:**

1. Confirm chip is green.
2. From DevTools console:
   ```js
   try {
     await window.__TAURI__.core.invoke('parse_show', {
       args: { vendor: 'vendor_unknown', platform: 'os_unknown',
               command: 'show foo', raw: 'irrelevant raw output' },
     });
   } catch (e) {
     console.error('expected:', String(e));
   }
   ```
3. If you have a UI surface that displays parse output (e.g. a command block
   with a "Parsed" tab), trigger that flow with the same vendor/platform.

**Expected:**

- The promise rejects with a string error containing the substring
  `no parser` (case-insensitive). Sample: `"sidecar parse.request error:
  no parser registered for vendor_unknown/os_unknown"`.
- The error is one short line — **not** a stack dump.
- The chip stays green — `NoParserError` is a normal dispatcher response,
  **not** a sidecar fault.
- (When a parsed-output UI exists) the consumer surface shows the raw
  output with a banner along the lines of "no parser available for this
  command — showing raw output".

**Actual:** ___________

**Status:** [ ] PASS [ ] FAIL

**Notes:** _____________________________

---

## Test 3: Slow sidecar (>5s response)

**Scenario:** The sidecar takes longer than 5 seconds to answer a parse.
The UI must show a loading indicator, must **not** block the UI thread, and
must eventually resolve (or time out) gracefully.

**LIMITATION (2026-05-14):** There is no debug-delay injection point in the
production sidecar today. To exercise this path, add a one-liner `sleep`
to a dev build:

1. Edit `sidecar/src/ccie_sidecar/server.py`. In the `parse.request`
   handler (around line 464, just before `result = parse_show(...)`), add:
   ```python
   import time; time.sleep(6)  # TEMP: Plan 00 Task 4.2 manual smoke
   ```
2. Restart the app (`bun run tauri dev`).
3. Run a parse call from DevTools (same payload as Test 1 step 4).
4. **REVERT THE SLEEP** before committing anything.

**Expected:**

- The DevTools console call takes ~6s but eventually resolves with a normal
  parse response.
- During the wait the UI stays interactive — you can switch tabs, type in
  the terminal, click chrome. The renderer is not blocked.
- (When a parsed-output UI exists) a spinner / "parsing…" indicator is
  visible during the wait.
- The chip stays green — a slow response is not a sidecar death.

**Future automation notes (when WebDriver is wired up):**

- Add a debug-only Tauri command `__test_set_parse_delay(ms)` behind
  `#[cfg(debug_assertions)]` in `src-tauri/src/commands/parsers.rs` that
  forwards a delay parameter to the sidecar. This lets the spec inject a
  delay without patching python source.
- Alternative: ship a stub sidecar binary that always sleeps for N seconds
  before answering, and point `AGENT_BRIDGE_BIN` at it for this spec only.

**Actual:** ___________

**Status:** [ ] PASS [ ] FAIL

**Notes:** _____________________________

---

## Test Results Summary

| Test                              | Status | Notes |
| --------------------------------- | ------ | ----- |
| 1. Sidecar killed mid-session     |        |       |
| 2. NoParserError → UI surface     |        |       |
| 3. Slow sidecar keeps UI live     |        |       |

**Overall Status:** ___________

**Tested By:** ___________

**Date:** ___________

**Environment:**
- OS: ___________
- App version / commit: ___________
- Sidecar version: ___________

## Known Issues

1. ___________________________________________
2. ___________________________________________
3. ___________________________________________

## Follow-Up Tasks

- [ ] Add `data-testid="sidecar-status-chip"` to `SidecarStatusChip` for
      stable selection.
- [ ] Add a debug-only `__test_set_parse_delay(ms)` IPC command (or stub
      sidecar binary) so Test 3 can run automated.
- [ ] Wire up `tauri-driver` in `e2e/tauri-driver.ts` and remove
      `test.describe.skip(...)` from `e2e/sidecar-failure.spec.ts`.
- [ ] Once a parsed-output UI exists, pin its loading-state and
      no-parser-banner selectors in this checklist and the spec.

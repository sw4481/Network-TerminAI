### Task 3 — Phase 3: Live terminal customization

- [x] **3.1 — SEQUENTIAL:** Record the actual runtime contract for the CDN
  xterm 5.5.0 build. Add adapter tests before relying on mutable options. Do not
  upgrade xterm as part of this phase.
- [x] **3.2 — SEQUENTIAL:** Extract one `createTerminalOptions()` resolver and
  use it from both `terminalRegistry.ts` and the legacy `usePty.ts` path,
  removing their duplicated literals.
- [x] **3.3 — SEQUENTIAL:** Add a registry update API that applies theme and
  font options to every live xterm instance, runs fit/refresh after font metric
  changes, and propagates any new rows/columns to `ptyResize`.
- [x] **3.4 — SEQUENTIAL:** Add the corresponding live update effect to the
  legacy PTY path so the rollback switch remains functional.
- [x] **3.5 — SEQUENTIAL:** Extend the existing Terminal Settings tab with:
  - Follow application theme.
  - Dark, Grey, Matrix, and Custom terminal presets.
  - Basic colors: font/foreground, background, cursor, and selection.
  - Advanced 16-color ANSI palette.
  - Font family, size, weight, and line height.
  - Cursor block/bar/underline and blink.
  - A live ANSI preview and per-section reset controls.
- [ ] **3.6 — Regression:** Prove that changing any terminal appearance option
  preserves PTY ID, shell process, scrollback, selection, command history,
  remote SSH state, split-pane attachment, and session restoration.

Implementation note:

The current xterm API supports runtime font-family changes; the official
web-font guidance calls for a fit after font metrics change. The implementation
must verify every mutable option against TerminAI's actual CDN 5.5.0 runtime
instead of assuming behavior from the installed 6.x package.

Acceptance gate:

- Existing terminals update live; new terminals start with the saved settings.
- No appearance change recreates, kills, or reconnects a PTY.
- ANSI applications remain legible in every preset.

Completion evidence: focused adapter, registry, legacy, provider, and settings
tests prove in-place option updates and PTY lifecycle call invariants; the full
frontend suite and relaxed build pass. Task 3.6 remains unchecked until native
operator observation verifies retained scrollback, selection, history, SSH
state, split attachment, and restored-session behavior in a real xterm/Tauri
window.

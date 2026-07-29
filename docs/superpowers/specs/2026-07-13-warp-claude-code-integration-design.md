# Warp-style Claude Code Integration — Design

**Date:** 2026-07-13
**Status:** Approved for planning

## Summary

Warp's "Universal Agent Support" wraps a CLI coding agent (Claude Code, Codex) running in a
pane and layers terminal-native features on top of it. This project ports four of those
features into CCIE Terminal, reusing the existing lifecycle-hook pipeline wherever possible:

1. **Notify when Claude needs input** — OS notification on the `needs_attention` transition.
2. **Per-pane statusLine** — app-managed `statusLine` written into the Claude config dir.
3. **Agent toolbelt** — a small overlay that appears when a pane's foreground process is an
   agent CLI, showing live state + Compose/Focus actions.
4. **Rich input composer** — a modal textarea that writes multi-line text to a pane's PTY.

Explicitly **out of scope:** inline code review (deferred by request).

## Guiding constraints

From `CLAUDE.md` (project rules):

- **Simplicity First** — minimum code that solves the problem; no speculative abstraction.
- **Surgical Changes** — every changed line traces directly to this request; match existing
  style; do not refactor adjacent code.
- **Goal-Driven Execution** — each phase has explicit, independently verifiable success
  criteria.
- **OOP** — new logic units are classes with clear single responsibilities.

## Existing infrastructure this builds on

The current pipeline (verified by codebase exploration):

```
pty.rs exports CCIE_PANE_ID + CLAUDE_CONFIG_DIR
  → in-pane `claude` loads app-managed hooks (claude_hooks.rs)
  → hook curls control_server /agent_status  (browser/control_server.rs:130)
  → PaneContextManager::set_agent_status      (pane_context/manager.rs:355)
       Working→Running, Waiting→NeedsAttention, Idle→Idle
  → emits pane_activity_updated
  → paneActivityStore (src/state/paneActivityStore.ts) updates activities Map
  → TabBar derives dots via tabActivityState(); NotificationCenter lists needs_attention
```

Backend keys activity by the **PTY tab id**; the frontend bridges via
`terminalRegistry.ptyTabIdFor(terminalId)`.

Key anchors:
- `src-tauri/src/claude_hooks.rs` — `config_dir()`, `build_hooks_settings(port, token)`,
  `install(port, token)`. Writes `settings.json` (hooks only today) into
  `~/Library/Application Support/ccie-terminal/claude-config`.
- `src-tauri/src/pty.rs` — `spawn_pty()` (`:240`), env injection (`:266-280`), reader thread,
  `child.process_id()` (`:283`, currently unused for detection).
- `src-tauri/src/pane_context/manager.rs` — `AGENT_CLIS = ["claude","codex"]` (`:16`),
  `is_agent_command()` (`:22`), `set_agent_status()` (`:355`).
- `src-tauri/src/pane_context/types.rs` — `NotificationState{Idle,Running,NeedsAttention}`,
  `AgentStatus{Working,Waiting,Idle}`, `PaneActivity`.
- `src/state/paneActivityStore.ts` — `usePaneActivityStore`, `subscribeToEvents()` (`:72`).
- `src/lib/paneActivity.ts` — types + invoke wrappers + `listenPaneActivityUpdated`.
- `src/state/heartbeatStore.ts:129-143` — existing `new Notification(...)` usage pattern.
- `src/components/TftpStatusPill.tsx` — the self-contained component-local template.
- `src/components/MetadataCard.tsx` + `src/state/metadataStore.ts` — floating-card pattern.
- `src/components/CommandPalette.tsx` — `STATIC_ACTIONS` (`:34`) + `dispatchAction` (`:159`).
- `src/hooks/useKeyboardShortcut.ts`; native menu in `src-tauri/src/lib.rs:748+`;
  `menu:*` emit arms (`:1032+`); App.tsx `listen('menu:...')` handlers.
- `src/lib/terminalRegistry.ts` — `ptyTabIdFor()`, entries hold `ptyTabId`.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Notification mechanism | Reuse Web Notification API (like `heartbeatStore`); no new dep, no Tauri plugin. |
| Rich input ambition | Minimal modal textarea → write text + `\n` to focused pane PTY. |
| Toolbelt v1 contents | Status chip + Compose + Focus. |
| Toolbelt detection | **PID/foreground-process poll** (new backend) — accurate/instant, not hook-lagged. |
| Shared-skills meaning | Unify with statusLine: write `statusLine` into the app-managed Claude config. |

## Phases

### Phase 1 — Notify when Claude needs input (frontend only)

**Goal:** on a pane activity transition into `needs_attention`, fire an OS notification;
clicking it focuses that pane/tab. Fire only on the *edge* into `needs_attention`, never
repeatedly.

**Design:**
- New `src/lib/agentNotifications.ts` exporting an `AgentNotifier` class:
  - Holds `private lastState: Map<paneId, NotificationState>`.
  - `start()` subscribes to `listenPaneActivityUpdated`; on each update, if
    `prev !== 'needs_attention' && next === 'needs_attention'`, fires
    `new Notification('Claude needs your input', { body, tag: 'pane-'+paneId })`.
  - `onclick` resolves paneId → tab and focuses it (reuse the focus resolution used by
    `NotificationCenter` / App focus reporting).
  - Respects existing `notification_preferences` (via `getNotificationPreferences`).
- Mounted once in `App.tsx`, next to the existing `subscribeToEvents()` mount (`:689-704`),
  guarded by the same permission request already present (`:709-712`).

**Success criteria:**
- Driving a pane's activity to `needs_attention` fires exactly one notification.
- A subsequent `working`→`needs_attention` after intervening idle fires again.
- Staying in `needs_attention` does not re-fire.
- Clicking the notification focuses the correct tab.

**Files:** +1 new (`agentNotifications.ts`), ~1 edit (`App.tsx`). No backend, no deps.

### Phase 2 — Per-pane statusLine in app-managed Claude config (backend)

**Goal:** `claude` running in a pane displays a statusline (model · dir · branch · pane
label), written by the app.

**Design:**
- `claude_hooks.rs`:
  - `install()` additionally writes `statusline.sh` (adapted from Warp's: reads stdin JSON,
    extracts `.model.display_name`, cwd basename, git branch; appends `$CCIE_PANE_ID` when
    present) into the app-managed config dir, `chmod +x`.
  - `build_hooks_settings()` (or a renamed `build_settings()`) additionally emits:
    ```json
    "statusLine": { "type": "command", "command": "<config_dir>/statusline.sh" }
    ```
  - Purely additive to the existing `settings.json` write at `lib.rs:1159`.
- Codex unchanged (no statusLine concept).

**Success criteria:**
- After boot, `<config_dir>/settings.json` contains both `hooks` and `statusLine`.
- `<config_dir>/statusline.sh` exists, is executable, and prints
  `[model] 📁 dir | Branch: x` given Claude's status JSON on stdin.
- Launching `claude` in a pane shows the statusline.

**Files:** ~1 edit (`claude_hooks.rs`) + 1 new script asset. No new command, no migration.

### Phase 3 — Agent toolbelt with foreground-process detection (backend + frontend)

**Goal:** when a pane's foreground process is `claude`/`codex`, render a compact toolbelt over
that pane showing live state (working/waiting/idle) + **[Compose]** and **[Focus]** buttons.

**Design — backend (new, tightly scoped):**
- Retain the PTY master fd in the PTY registry entry (currently the reader thread owns it;
  keep a raw fd copy for `tcgetpgrp`).
- A poll task (~1.5s, only iterating live PTYs) calls `tcgetpgrp(master_fd)` to get the
  foreground process group, resolves that pgid's leader process name via `libproc`
  (macOS) / `sysinfo`.
- Reuse `is_agent_command()` semantics (final path segment ∈ `AGENT_CLIS`) to classify.
- When the foreground agent for a pane changes, emit `pane_foreground_agent`
  `{ paneId, agent: Option<String> }`.
- New Tauri command `get_pane_foreground_agent(paneId) -> Option<String>` for initial hydrate.
- This is the only genuinely new subsystem; scoped to one poll + one event + one command.

**Design — frontend:**
- New `src/components/AgentToolbelt.tsx`, positioned relative to the focused (or hovered)
  pane. Presence gated by the new `pane_foreground_agent` signal; live state read from
  `paneActivityStore.activities` for that pane's PTY id.
- **[Compose]** opens the Phase 4 composer targeting that pane.
- **[Focus]** reuses existing focus resolution.
- New small store or component-local subscription for the foreground-agent map (mirror the
  `paneActivityStore` subscription shape).
- Mounted in `App.tsx`; CSS in a new stylesheet or appended to `App.css` following existing
  overlay conventions.

**Success criteria:**
- Running `claude` in a pane (without it having fired a hook yet) makes the toolbelt appear
  within ~2s.
- Exiting `claude` back to the shell removes the toolbelt.
- The status chip reflects working/waiting/idle live.
- **[Focus]** focuses the pane; **[Compose]** opens the composer targeting that pane.

**Files:** ~2 backend edits (`pty.rs` retain fd + poll module, `commands` + `lib.rs`
register) + 1 new command + `AgentToolbelt.tsx` + mount + CSS. Possibly a new dep
(`libproc`/`sysinfo`) — chosen at plan time, smallest that works on macOS.

### Phase 4 — Rich input composer (frontend)

**Goal:** a menu accelerator opens a modal textarea; **⌘↵ Send** writes text + `\n` to the
focused pane's PTY; **Esc** cancels. Also invokable from Phase 3's **[Compose]** button
(targets that pane).

**Design:**
- New `src/components/RichInputModal.tsx`: multi-line `<textarea>`, Send + Cancel; on Send
  writes via the existing PTY write path (`ptyWrite`/registry send) to the target pane, then
  closes.
- Target pane = the pane passed by **[Compose]**, else the focused pane.
- Trigger: native menu item (xterm swallows key combos, so a menu accelerator — a free combo
  such as ⌘⇧Return, confirmed unused at plan time) → `menu:rich_input` emit arm in `lib.rs`
  → `listen('menu:rich_input')` in App.tsx. Plus a `CommandPalette` `STATIC_ACTIONS` entry
  dispatching a `ccie:` custom event.
- Small state (open + target pane id), following the `metadataStore` toggle pattern.

**Success criteria:**
- Accelerator opens the modal; typing multi-line text and pressing ⌘↵ writes it verbatim
  (plus a trailing newline) to the focused pane's PTY.
- Esc cancels without writing.
- **[Compose]** from the toolbelt targets the associated pane.
- Palette entry opens the same modal.

**Files:** +1 new component, ~3 edits (menu `lib.rs`, `App.tsx`, `CommandPalette`) + CSS.

## Sequencing rationale

- Phases 1 and 2 are near-free and independently shippable; do them first.
- Phase 4 is built before or alongside Phase 3's Compose button so Compose has a working
  target.
- Each phase is verifiable on its own (Goal-Driven Execution).

## Risks / notes

- **Phase 3 is the largest surface** and the only new backend subsystem; keep the poll and
  process-name resolution minimal and macOS-focused (the app is macOS-only per environment).
- Retaining the PTY master fd must not race the reader thread's ownership; the plan will
  specify exact fd lifetime handling.
- The chosen menu accelerator for Phase 4 must be verified unused against `lib.rs` menu ids
  at plan time.
- No DB migration is required by any phase.

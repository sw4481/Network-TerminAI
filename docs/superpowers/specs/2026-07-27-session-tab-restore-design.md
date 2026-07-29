# Session & Tab Restore — Design

**Date:** 2026-07-27
**Status:** Approved (design), pending spec review → implementation plan

## Problem

The app persists terminal scrollback (~120 MB across 453k rows) and has full
backend machinery to save/restore sessions — but **the frontend never calls
save or restore**. Consequences:

- Closing a tab is permanent; there is no "reopen closed tab".
- Quitting the app loses all tabs; nothing comes back on relaunch.
- The scrollback table is therefore written but never read for its intended
  purpose (only transiently read by the command-output diff in `pty_runner.rs`).

We want two user-facing behaviors, which finally make the stored scrollback earn
its keep:

1. **Restore on restart** — reopen the terminal tabs that were open at quit.
2. **Reopen accidentally closed tab** — ⌘⇧T + a "Recently Closed" list.

## Hard constraint

A terminal's running process (shell, and any SSH session inside it) is a live OS
process. When the app quits, it dies and **cannot be resumed**. Therefore
"reopen a tab" means: **spawn a fresh shell in the tab's last working directory
and replay the saved scrollback above it** (read-only history), then the live
shell continues below. This matches iTerm/Warp behavior.

## What already exists (reused, not rebuilt)

- `save_current_session(activeTabId)` → writes the `__last__` snapshot
  (`session::save_session_snapshot`). Rust command already registered
  (`commands/mod.rs`), TS wrapper `saveCurrentSession` already in `tauri.ts`.
- `restore_last_session()` → returns `SessionSnapshot { tabs[], activeTabId }`
  (`session::load_session_snapshot`). TS wrapper `restoreLastSession` exists.
- `scrollback` table — bounded per-tab at 2 MB (recent fix), streamed live on the
  PTY output path. TS reader `tabScrollback(tabId)` exists.
- `pane_layouts` table + `panes_save_layout` / `loadLayoutForTab` — pane splits
  are persisted **separately, keyed by `tab_id`**.

**None of `restoreLastSession`, `saveCurrentSession`, or `tabScrollback` has any
caller in the frontend today.** This work wires them up.

No new SQLite migration and no schema change are required.

## Architecture

Three pieces, almost entirely frontend:

1. **Restore-on-boot** — on app mount, call `restoreLastSession()`; recreate each
   terminal tab (reusing its saved id), spawn a fresh shell in its saved `cwd`,
   and replay its scrollback into xterm before wiring live output.
2. **Continuous save** — subscribe to the tab store; on any tab change
   (add/remove/reorder) and on window close, call `saveCurrentSession`,
   debounced ~1 s (immediate/synchronous on close).
3. **Reopen closed tab** — an in-memory `closedTabsStore` stack records
   `{id, title, cwd, closedAt}` on every close. ⌘⇧T reopens the most recent;
   **View → Recently Closed** lists them for specific pick.

## Data flow

### Boot / restore

```
App mounts
  → restoreLastSession()                       // existing Rust cmd
  → for each tab where tab_type == "terminal":
       useTabs.addTab({ id: SAVED_ID, title, cwd, ... })   // reuse saved id
  → TerminalSlot mounts → registry spawns fresh shell in tab.cwd
  → registry calls tabScrollback(tab.id) ONCE → xterm.write(bytes)  // replay
  → writes a dim separator line: ──── session restored ────
  → live PTY output streams as normal (appears below the separator)
  → setActive(savedActiveTabId)
  → ensureHeartbeatTab()                        // Heartbeat lands in its usual slot
  → if no snapshot / zero terminal tabs → today's default single fresh tab
```

**Critical detail:** reuse the *saved* tab id when recreating tabs. Scrollback
AND pane layouts are keyed by `tab_id`; the id must match or replay/splits find
nothing. Because the id is preserved, **pane splits are restored for free** via
the existing `loadLayoutForTab`.

**Replay ordering:** replay happens *before* live output — restored history sits
above the fresh shell's first prompt. The registry writes scrollback
synchronously at terminal init, then wires the live `onEvent`. A dim
`──── session restored ────` separator marks old-vs-new so the live prompt isn't
confused with history. No separator when there's no history.

### Save

```
tab store changes (add/remove/reorder) OR window close-requested
  → debounce 1 s (immediate/synchronous on close)
  → saveCurrentSession(activeTabId)             // existing Rust cmd
```

Scrollback already streams to the DB live, so save only persists the tab list +
order + active id — cheap.

### Reopen closed

```
removeTab(id)  → closedTabsStore.push({ id, title, cwd, closedAt })   // cap 25
⌘⇧T           → pop most recent → addTab(fresh shell, replay that id's scrollback)
View ▸ Recently Closed → list → pick one → same reopen path
```

Scrollback for a closed tab is **not deleted** on close (capped at 2 MB/tab,
pruned only by existing retention), so replay works minutes later.

## Error handling & edge cases

- **Corrupt/missing snapshot** → `restoreLastSession` returns null or throws →
  catch, log, fall back to a single fresh tab. Restore never blocks boot.
- **Scrollback replay fails for one tab** → that tab still opens with a live
  shell, just no history. Best-effort per tab, wrapped individually.
- **cwd no longer exists** → shell spawn falls back to `$HOME` (confirm
  `pty_spawn` degrades rather than errors).
- **Special tabs** (Heartbeat, Vault, Topology, API) → not restored as
  terminals; keep open-on-demand behavior. `ensureHeartbeatTab()` runs after
  restore.
- **Duplicate-id guard** → `addTab` made idempotent on id, so a double-mount
  (React strict mode) can't double-spawn a terminal — directly guards the
  known registry respawn-loop class of bug.
- **Empty scrollback** → replay writes nothing, no separator; clean tab.
- **Debounced save + crash** → worst case loses a tab opened <1 s before crash;
  acceptable. Close-requested handler saves synchronously so clean quits are
  exact.

## Testing

- **tabsStore / closedTabsStore** (vitest): close pushes to stack; ⌘⇧T pops
  most-recent-first; stack caps at 25; reopen restores title+cwd+id. Follows
  existing `tabsStore.test.ts` patterns.
- **Restore reducer** (vitest): snapshot of N terminal + special tabs → N
  terminal `addTab` calls in order with saved ids, active set correctly; null
  snapshot → no calls (fresh-tab fallback).
- **Backend** (Rust, in-memory DB): save→restore round-trip returns the same tab
  list/order and scrollback keyed correctly (add if not already covered by
  existing `save_session_snapshot`/`load_session_snapshot` tests).
- **Manual live verification** (per "verify before claiming done"): open 3
  terminals with distinct output + cwds, quit, relaunch → all 3 return with
  history + correct dirs; close one, ⌘⇧T → it returns; View ▸ Recently Closed
  lists it. Driven via the running dev server, not asserted blind.

## Out of scope (YAGNI)

- No cross-machine sync.
- No restoring live SSH sessions (impossible — process is dead).
- No persisting the closed-tabs stack across restarts (in-memory only; restart
  restore covers that need).
- No new migration / schema change.

## Notes

- ⌘⇧T confirmed free (in-use shift chords: C,1,2,F,D,G,B,K,I,L native +
  w,m,i,l JS — no T).
- Pane splits restore for free via id reuse + existing `pane_layouts` loader.

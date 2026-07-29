# Restore Blocks Mode + View Menu (Raw/Structured/Diff) — Design

> **Status:** Design approved 2026-07-02. Next: implementation plan via `writing-plans`.
> **Fixes:** the Terminal/Blocks toggle and the View menu's Show Raw/Structured/Diff shortcuts stopped working when the persistent terminal registry became the default terminal renderer (`ENABLE_TERMINAL_REGISTRY = true`, 2026-06-22). Both features still exist in code (`LegacyTerminal`) but that component no longer mounts in normal operation.

## Background

Two related regressions, found and partially fixed in the same investigation (2026-07-01/02):

1. **View menu dead wiring (already fixed 2026-07-02).** The View menu's 7 items (Show Raw/Structured/Diff, Pin Snapshot, Export CSV/JSON, Copy as Markdown) emitted Tauri events correctly and `App.tsx` re-dispatched them as DOM `CustomEvent`s correctly — but their only listener lived inside `CommandBlock.tsx`'s menu-effect, which is only mounted via `BlockList` → reachable only through `LegacyTerminal`'s Blocks mode. Since `LegacyTerminal` never mounts under the registry, the events had nowhere to land. All 7 menu items and their 3 listeners were removed as a narrow, low-risk fix (commit pending in current branch).

2. **Blocks mode itself is unreachable (this spec).** The Terminal/Blocks toggle button, `BlockList`, `CommandBlock` rendering, and `InputEditor` only ever existed inside `LegacyTerminal` (`src/components/Terminal.tsx:42-1073`). When the terminal registry was built (2026-06-22, `docs/superpowers/specs/2026-06-22-persistent-terminal-registry-design.md`), `Terminal.tsx` was split into a hook-free dispatcher plus the renamed `LegacyTerminal`, with a new `TerminalSlot` component for the registry path. `TerminalSlot` is a bare xterm mount — no toggle, no block list. Nobody ported blocks-mode UI into it. This was not a deliberate removal; it was an unported feature left behind when `ENABLE_TERMINAL_REGISTRY` flipped to `true` the same day.

**Operator's explicit constraint:** this work must not regress the persistent terminal registry fix (split-pane content loss / duplicate PTYs), which was the reason `LegacyTerminal` was replaced in the first place.

## Scope

- **Restore Blocks mode** as a straight parity restore: same per-pane Terminal/Blocks toggle button, same `BlockList` + `CommandBlock` rendering, same `InputEditor` command-entry flow — re-plumbed onto the registry (`TerminalSlot`/`Pane`) instead of the dead `LegacyTerminal` path.
- **Restore 3 of the 7 View menu items**: Show Raw Output (⌘1), Show Structured (⌘2), Show Diff (⌘3). Pin Snapshot, Export as CSV/JSON, and Copy as Markdown stay removed from the menu — they remain available as in-block buttons inside `StructuredTab` (unchanged), just not from the menu bar or a global shortcut.
- **Out of scope:** any change to `terminalRegistry.ts`, `blocksStore.ts`, `BlockList.tsx`, `CommandBlock.tsx`'s structured-view rendering, `StructuredTab.tsx`, or the persistent-registry split/dispose logic. Those are reused unchanged.

## Verified Facts (read from code 2026-07-02)

- `terminalRegistry.ts`'s `wireSession` (`:171-465`) already populates `useBlocksStore` via `addBlock`/`completeBlock` (`:290`, `:302`), keyed by the resolved backend `ptyTabId`, identically in shape and keying to the old `usePty.ts` path. This happens **unconditionally**, regardless of whether any UI is showing blocks — confirmed by reading `wireSession`'s `command_start`/`command_end` handling, which has no UI-mode gate. So block history accumulates in the background for every terminal today, whether or not Blocks mode is ever toggled on.
- `BlockList` (`src/components/BlockList.tsx:10-14`) needs only `tabId`, `blocks`, `focusedBlockId?`, `onFocusBlock?` — no dependency on `LegacyTerminal` internals.
- `InputEditor`'s `onExecute` (`src/components/InputEditor.tsx`) is a plain `(command: string) => void` callback — not coupled to any `LegacyTerminal`-only wiring. The caller is responsible for routing it to `ptyWrite`.
- `Pane.tsx` already resolves the backend PTY id via `handleTerminalRegistered` (`:62-76`), but early-returns under `ENABLE_TERMINAL_REGISTRY` before calling `updatePaneTerminalId` — this guard exists specifically to prevent the infinite-PTY-respawn bug fixed 2026-06-23 (mutating the pane's `terminalId` re-keys `TerminalSlot`'s effect). Any new plumbing must not touch this guard or `terminalId` itself.
- `useBlockShortcuts` (`src/hooks/useBlockShortcuts.ts`) currently instantiated only inside `LegacyTerminal` (`Terminal.tsx:108-113`), keyed off `handle?.tabId`. This hook (and its `focusedBlockId`/`setFocusedBlockId` state) has no owner under the registry path today.
- `structuredViewStore`'s `focusedBlockId` (block-level hover-focus, used by `BlockTabStrip`/View-menu wiring) is a **different, already-independent** piece of state from `useBlockShortcuts`' `focusedBlockId` (pane-level keyboard-navigation focus). They must not be conflated.

## Architecture

### Blocks mode: lives in `Pane.tsx`, not `TerminalSlot.tsx`

`TerminalSlot` stays a pure xterm-registry adapter with zero UI-mode awareness — this is deliberate. The registry's entire purpose is decoupling terminal lifecycle from React mount/unmount; `TerminalSlot`'s effect re-keys only on `[terminalId]` (`TerminalSlot.tsx:35`). Blocks-mode toggling must never appear in that dependency array, or it reintroduces exactly the respawn risk the registry was built to eliminate.

Instead:

- `Pane.tsx` gains local `blocksMode` state (`useState(false)`), scoped per pane instance — a correct generalization of the old per-tab toggle, since split panes are now first-class.
- `Pane.tsx` gains local `resolvedPtyTabId` state, set from `handleTerminalRegistered`'s callback **in addition to**, not instead of, the existing early-return logic. This is purely a local mirror for UI plumbing (keying `BlockList`, `useBlockShortcuts`, `InputEditor`'s `ptyWrite` target) — it never calls `updatePaneTerminalId` and never feeds back into the pane's real `terminalId` prop. The respawn-loop fix (`ENABLE_TERMINAL_REGISTRY` early-return in `handleTerminalRegistered`) is untouched.
- Rendering: `<Terminal terminalId=.../>` stays mounted unconditionally, wrapped in a div whose CSS toggles `visibility`/`position`/`zIndex` between visible and hidden-but-mounted — same technique `LegacyTerminal` used (`Terminal.tsx:848-861`) and for the same reason: avoid xterm reflow/remeasure on toggle. `BlockList` + `InputEditor` render as a sibling overlay only when `blocksMode` is true, positioned exactly like `LegacyTerminal`'s `.blocks-overlay` (`Terminal.tsx:880-903`, `App.css:270-283`).
- `useBlockShortcuts` moves from `LegacyTerminal` to `Pane`, gated `enabled: blocksMode && !!resolvedPtyTabId`.
- The mode-toggle button bar (`.terminal-mode-toggle`, `Terminal.tsx:826-841`) moves to `Pane.tsx`, rendered above the terminal/blocks area.

**Regression guard:** no prop passed to `<Terminal>` may depend on `blocksMode` or `resolvedPtyTabId`. Toggling blocks mode must never change `Terminal`'s key or props, so it can never trigger `TerminalSlot`'s attach/detach cycle or a `getOrCreate` respawn.

### View menu: Raw/Structured/Diff only

Simpler than the original 7-item wiring — a single event, no export/pin plumbing:

- **Rust (`src-tauri/src/lib.rs`):** re-add 3 `MenuItem`s (`view_raw` "Show Raw Output" ⌘1, `view_structured` "Show Structured" ⌘2, `view_diff` "Show Diff" ⌘3), a `View` submenu containing just these 3, its slot in `Menu::with_items`, and 3 `match` arms in `on_menu_event` emitting `menu:view_mode` with payload `"raw"`/`"structured"`/`"diff"` (unchanged payload contract from before).
- **Frontend (`src/App.tsx`):** re-add the `menu:view_mode` listener dispatching to `useStructuredView.getState().setViewMode(focusedBlockId, mode)`, and the `useStructuredView` import — both restored exactly as they were before tonight's removal.
- **`CommandBlock.tsx`:** no changes. Its `viewMode`/`setViewMode`/`BlockTabStrip` wiring was never touched by tonight's fix; only the dead pin/export DOM-event effect was removed, and that stays removed.

This restores ⌘1/⌘2/⌘3 and the View menu, scoped to whichever block currently has `structuredViewStore`'s hover-focus in Blocks mode — identical behavior to before, minus Pin/Export/Copy-as-Markdown (still reachable as in-block buttons only).

## Testing & Verification

**Unit tests:**
- `Pane.test.tsx`: blocks-mode toggle renders `BlockList` when true, hides (visibility, not unmount) when false. Assert `Terminal`'s props/key are stable across a `blocksMode` toggle.
- New regression test: enter blocks mode → simulate split → assert original pane's blocks/scrollback survive, and `terminalRegistry.getOrCreate` is not called again for the original `terminalId`.
- New regression test: toggle blocks mode on/off rapidly → assert `getOrCreate` called exactly once (no respawn).
- Existing `terminalRegistry.test.ts` — unchanged, must stay green.
- Existing `CommandBlock.test.tsx` / `CommandBlock.structured.test.tsx` — unchanged, must stay green.
- Rust: `cargo check` / `cargo build` clean, no new warnings beyond pre-existing baseline.
- `tsc --noEmit` — no new errors beyond the pre-existing baseline (confirmed via `git stash` diff, same method used for tonight's fix).
- Full `vitest run` — currently 2533 passing; must stay green.

**Live verification (manual, via the running dev app):**
1. Terminal tab, run a command, toggle to Blocks mode → block appears with output.
2. Split the pane while in Blocks mode → original pane keeps blocks + scrollback; new pane starts fresh in Terminal mode. This is the direct regression check for the operator's stated concern.
3. Switch tabs away and back → blocks mode state and content survive.
4. Focus a block (hover), press ⌘2 → view switches to Structured; ⌘1 → Raw; ⌘3 → Diff.
5. A pane that never toggles Blocks mode behaves exactly as it does today — zero behavior change for the common case.

## Out of Scope (YAGNI)

- Pin Snapshot / Export CSV/JSON / Copy as Markdown menu items and shortcuts — deliberately not restored; still available as in-block buttons.
- Any change to `terminalRegistry.ts` session-wiring, dispose semantics, or the `ENABLE_TERMINAL_REGISTRY` flag itself.
- Persisting `blocksMode` across app restarts or syncing it to the backend — matches prior behavior (was always transient `useState`).
- Deleting `LegacyTerminal` — remains the flag-off fallback, untouched, per the original registry design's rollback contract.

## Key Design Decisions

- **Pane-scoped `blocksMode`, not tab-scoped.** Correctly generalizes the old per-tab toggle now that split panes are first-class; each pane gets its own toggle.
- **`TerminalSlot` stays a pure adapter.** All blocks-mode UI state lives one level up in `Pane`, so nothing about entering/exiting Blocks mode can affect `TerminalSlot`'s mount-effect dependency array.
- **`resolvedPtyTabId` is a new, separate, local-only mirror — not a reuse of the existing `terminalId` reconciliation path.** Keeps the 2026-06-23 respawn-loop fix completely untouched.
- **View menu restoration is a straight revert of tonight's Raw/Structured/Diff removal**, re-pointed at the same `structuredViewStore` plumbing — no new design needed there, just restoring known-good code minus the 4 items staying cut.

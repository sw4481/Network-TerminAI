# Persistent Terminal Registry — Design

> **Status:** Design approved 2026-06-22. Next: implementation plan via `writing-plans`.
> **Fixes:** splitting a pane destroys the original terminal's content + spawns duplicate shells, because xterm + PTY are owned by the React component lifecycle.

## Problem

`usePty` creates the xterm instance (`src/hooks/usePty.ts:95`, `new XTerm(...)`) and spawns the backend PTY (`:290`, `ptySpawn`) **inside the React mount effect**. The xterm instance and the PTY are therefore coupled to the React component lifecycle.

`splitPane` (`src/state/panesStore.ts`) replaces the original leaf node with a split containing two **new-id** leaf nodes. `PaneContainer` keys panes by `child.id`, so React unmounts the original `Terminal` and mounts fresh ones. Result:
- The original xterm buffer (scrollback + live output) is **destroyed**.
- Each new `Terminal` calls `ptySpawn` → **duplicate/extra shells**, both blank.

Confirmed live: running `sleep 8` then splitting wipes the original pane's content and command. This is a pre-existing split-pane architecture gap, not a recent change.

cmux (the inspiration) avoids this by keeping terminal sessions decoupled from the view layer (native ghostty surfaces). The React/xterm equivalent: keep xterm instances in a persistent store **outside React**, and move the live DOM node into whichever pane currently displays it.

## Verified Facts (read from code 2026-06-22)

- xterm created at `usePty.ts:95`; PTY spawned at `:290` — both in the mount effect.
- Every store write in `usePty`'s `onEvent`/`onData` uses stable zustand **actions** (`addBlock`, `completeBlock`, `setCwd`, `setTerminalCwd`, `useSshPasswordStore` getters) — all reachable via `useStore.getState()` WITHOUT a React subscription. So the full session wiring can live outside React.
- Single `usePty` callsite: `src/components/Terminal.tsx:47`.
- A flag pattern already exists to model the gate: `ENABLE_LOCAL_ECHO = false` (`usePty.ts:31`).
- `splitPane` already keeps the original leaf's `terminalId` on the surviving child (`pane1.terminalId = targetPane.terminalId`); only the node `id` changes.
- `closePane` (and tab close) already call `ptyKill` — the dispose hook point exists.

## Architecture

A module-level **terminal registry** outside React owns each live session, keyed by `terminalId`:

```
terminalRegistry: Map<terminalId, TerminalEntry>
```

- A pane renders an empty **mount-slot** `<div ref={slot}>`. React owns the slot.
- On attach, the slot `appendChild`s the registry entry's persistent `el`. No entry yet → registry creates xterm + spawns PTY + wires events once. Moving a live DOM node preserves its xterm buffer + scroll.
- On React unmount (split, tab-switch, re-render), the slot **detaches** `el` — does NOT destroy it. Session stays alive.
- **Dispose** (xterm.dispose + ptyKill) happens ONLY on explicit pane/tab close or shell exit — never on React unmount.

**Rollback safety:** gated behind `ENABLE_TERMINAL_REGISTRY` (mirrors `ENABLE_LOCAL_ECHO`). Flag off → today's `usePty` path runs unchanged. Flipping one constant reverts behavior with no git revert. The legacy path is NOT deleted during this work.

## Registry Module (`src/lib/terminalRegistry.ts`, no React)

```ts
interface TerminalEntry {
  xterm: XTerm;
  fitAddon: FitAddon;
  el: HTMLDivElement;      // reparented between slots; never destroyed on detach
  ptyTabId: string;        // backend PTY id from ptySpawn
  disposed: boolean;
}

const registry = new Map<string, TerminalEntry>();

getOrCreate(terminalId, { shell, cwd, skipTabRegistration }): TerminalEntry
  // exists → return; else create el + XTerm + FitAddon, ptySpawn, wire all
  // events once, store, return.

attach(terminalId, slot: HTMLDivElement): void
  // slot.appendChild(entry.el); fitAddon.fit(); xterm.refresh(); focus if needed.

detach(terminalId): void
  // entry.el.remove() — DOM node detached, entry kept (alive).

dispose(terminalId): void
  // idempotent: ptyKill(ptyTabId); xterm.dispose(); registry.delete().
```

**"Wire all events once"** — the event-handling logic is **ported** (copied, then adapted to `getState()`) from `usePty`'s mount effect into `getOrCreate`. The existing `usePty` hook is **left untouched** so it remains the working flag-off fallback; the registry is a parallel implementation, not an edit of `usePty`. Uses `getState()` actions:
- `xterm.onData` → `ptyWrite` (user input)
- `onEvent` → OSC-133 block parsing (`useBlocksStore.getState().addBlock/completeBlock`), OSC-7 cwd (`useTabs.getState().setCwd` + `useIacStateStore.getState().setTerminalCwd`), SSH password autofill (`useSshPasswordStore.getState()`), output write
- resize → `ptyResize`
- recording tap unchanged (backend-side `attach_tap`)

**Re-fit on attach:** after `appendChild` moves `el` to a new slot, xterm must `fitAddon.fit()` + `refresh()` to re-measure the new container and repaint — otherwise stale dimensions. `attach()` always does this.

**terminalId stability across split:** registry keyed by `terminalId`. `splitPane` already keeps the survivor's `terminalId`; the new child gets a fresh one. So split = survivor re-attaches its existing session (content intact), new pane creates a fresh session.

## React Integration

**`Terminal.tsx` branch (single callsite):**
```tsx
if (ENABLE_TERMINAL_REGISTRY) {
  return <TerminalSlot terminalId={…} shell={shell} cwd={cwd} … />;
} else {
  const handle = usePty(xtermContainer, shell, cwd, skipTabRegistration); // unchanged
  …
}
```

**`TerminalSlot` (new, thin):**
```tsx
function TerminalSlot({ terminalId, shell, cwd, skipTabRegistration, onRegistered }) {
  const slotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const entry = terminalRegistry.getOrCreate(terminalId, { shell, cwd, skipTabRegistration });
    terminalRegistry.attach(terminalId, slotRef.current!);
    onRegistered?.(entry.ptyTabId);
    return () => terminalRegistry.detach(terminalId);  // detach, NOT dispose
  }, [terminalId]);
  return <div ref={slotRef} className="terminal-slot" style={{ height: '100%' }} />;
}
```

**terminalId prop:** registry is keyed by it, so `Terminal`/slot must receive `terminalId`.
- Split panes: `Pane` already has `terminalId`; thread through `Terminal`.
- Root/single tabs: root pane's `terminalId` is its tabId; pass that. The spawn-then-adopt reconciliation (`onRegistered` → `updatePaneTerminalId`) still fires for store bookkeeping.

**Dispose routing:** under the flag, `closePane` / tab-close route through `terminalRegistry.dispose(terminalId)` (tears down xterm too, not just `ptyKill`). Flag-gated edit in the close paths.

**Flag default:** `ENABLE_TERMINAL_REGISTRY = false` on merge → zero behavior change. Flip to `true` only after live verification, in its own commit.

## Testing & Verification

**Unit tests** (`terminalRegistry.test.ts`, mocked XTerm + ptySpawn/ptyKill/ptyWrite):
- `getOrCreate` twice for same id → same entry, **ptySpawn called once** (no duplicate shells)
- `attach` → `slot.appendChild(el)` + `fit()`/`refresh()` invoked
- `detach` → `el` removed from DOM, entry **still in registry**
- attach → detach → attach (split/re-render sim) → same xterm instance, no new ptySpawn
- `dispose` → ptyKill + xterm.dispose + entry removed; double-dispose safe (idempotent)
- regression: term for `term-A`, simulate split (detach + reattach to new slot) → same buffer-bearing node, ptySpawn count stays 1

**Existing suite:** full vitest (2412) stays green. Flag off → legacy path unchanged → existing terminal tests unaffected.

**Live verification (flag ON), reported honestly:**
1. Split preserves content: `sleep 8` + echo text → split → original keeps scrollback + running cmd; new pane fresh.
2. No duplicate shells: after split, backend log shows exactly one new `Event loop started`.
3. Tab-switch preserves content + scroll.
4. Close kills: close pane/tab → backend PTY exits, registry entry gone.
5. Activity indicators (just-shipped fix) still work under registry path.
6. Resize/fit correct after split + after panel resize.

**Rollout (each its own commit):**
1. Registry module + unit tests (flag unused) — inert.
2. `TerminalSlot` + `Terminal.tsx` branch + thread `terminalId` — flag=false.
3. Dispose routing in close paths — flag-gated.
4. Flip flag to `true` — separate commit, after 1–3 build/green.
5. Live verification → keep; legacy `usePty` stays as instant fallback.

**Rollback:** flip `ENABLE_TERMINAL_REGISTRY` back to `false` (one line) → restores today's behavior, no revert. Deleting the legacy path is a separate future cleanup.

## Out of Scope (YAGNI)
- Showing one terminal in two panes at once (slot refcounting).
- Deleting the legacy `usePty` path (future cleanup once trusted).
- Scrollback persistence across app restart.

## Key Design Decisions
- **Imperative DOM reparent into a mount slot** (standard xterm-in-React pattern) over a fixed-position overlay layer (no continuous geometry syncing needed).
- **Dispose only on explicit close / shell exit** — never on React unmount. This is the entire point.
- **Registry owns the full PTY-bound session** (xterm + PTY + all event wiring) since store writes work via `getState()` — avoids a fiddly re-subscribe path.
- **Feature-flag gated, legacy path retained** — for the operator's stated rollback-safety requirement.
- No backend changes, no SQLite migration.

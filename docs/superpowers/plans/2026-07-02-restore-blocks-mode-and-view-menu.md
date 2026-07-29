# Restore Blocks Mode + View Menu (Raw/Structured/Diff) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the per-pane Terminal/Blocks toggle (with `BlockList`/`CommandBlock` rendering and `InputEditor` command entry) onto the persistent terminal registry, and restore the View menu's Show Raw/Structured/Diff items (⌘1/⌘2/⌘3) — both unreachable since `ENABLE_TERMINAL_REGISTRY` became the default terminal renderer.

**Architecture:** Blocks-mode UI (toggle button, `BlockList` overlay, `InputEditor`) moves from the dead `LegacyTerminal` component into `Pane.tsx`, one level above `TerminalSlot`, so `TerminalSlot`'s registry-mount effect never depends on blocks-mode state. A new pane-local `resolvedPtyTabId` state mirrors the backend PTY id for UI plumbing only — it never touches the pane's real `terminalId` or the existing `ENABLE_TERMINAL_REGISTRY` early-return guard in `handleTerminalRegistered`. The View menu restoration re-adds 3 Rust `MenuItem`s + 1 frontend listener, exactly reversing part of the fix from 2026-07-01/02.

**Tech Stack:** React 18 + TypeScript, Zustand stores (`blocksStore`, `structuredViewStore`), Tauri 2 (Rust menu API), Vitest + Testing Library, `react-hotkeys-hook`.

## Global Constraints

- Do not modify `terminalRegistry.ts`, `blocksStore.ts`, `BlockList.tsx`, `CommandBlock.tsx`'s structured-view rendering, `StructuredTab.tsx`, or `ENABLE_TERMINAL_REGISTRY`/`TerminalSlot.tsx`'s mount-effect dependency array (`[terminalId]` only).
- No prop passed to `<Terminal>` may depend on `blocksMode` or `resolvedPtyTabId` — toggling blocks mode must never change `Terminal`'s key/props.
- `Pane.handleTerminalRegistered`'s existing `if (ENABLE_TERMINAL_REGISTRY) return;` guard (prevents the 2026-06-23 infinite-PTY-respawn bug) stays completely untouched.
- Restore only 3 View menu items: Show Raw Output (⌘1), Show Structured (⌘2), Show Diff (⌘3). Do not restore Pin Snapshot, Export CSV/JSON, or Copy as Markdown.
- Every step's `cargo check`/`cargo build`, `tsc --noEmit`, and `vitest run` must show no new errors/warnings beyond the pre-existing baseline (established by `git stash` diffing, same method used in the prior View-menu fix).
- Reference spec: `docs/superpowers/specs/2026-07-02-restore-blocks-mode-and-view-menu-design.md`.

---

## Task 1: Move `useBlockShortcuts` + blocks-mode toggle state into `Pane.tsx`

**Files:**
- Modify: `src/components/Pane.tsx`
- Modify: `src/components/Terminal.tsx:42-137` (remove now-duplicated state from `LegacyTerminal` — see Task 4)
- Test: `src/components/Pane.test.tsx`

**Interfaces:**
- Consumes: `useBlockShortcuts({ tabId, enabled }): { focusedBlockId, setFocusedBlockId, chordPending }` (unchanged signature, `src/hooks/useBlockShortcuts.ts:29-34`).
- Produces: `Pane` component now owns `blocksMode: boolean`, `setBlocksMode`, `resolvedPtyTabId: string | null`, `focusedBlockId`, `setFocusedBlockId` — consumed by Task 2 (rendering) and Task 3 (InputEditor wiring).

This task only adds state; no new rendering yet (Task 2 adds the UI). Keeping state-wiring and rendering as separate tasks means a reviewer can verify the hook wiring compiles and behaves correctly in isolation before UI is layered on.

- [ ] **Step 1: Write the failing test — `resolvedPtyTabId` is set from the registered PTY id without touching `terminalId` reconciliation**

Add to `src/components/Pane.test.tsx` (new `describe` block, same file, after the existing one):

```tsx
describe('Pane blocks-mode local PTY id tracking', () => {
  it('captures the registered ptyTabId locally without calling updatePaneTerminalId', () => {
    const updatePaneTerminalId = vi.fn();
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId,
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    let registeredCallback: ((tabId: string) => void) | undefined;
    vi.doMock('./Terminal', () => ({
      Terminal: ({ onRegistered }: { onRegistered?: (tabId: string) => void }) => {
        registeredCallback = onRegistered;
        return null;
      },
    }));

    // Re-import Pane fresh so it picks up the doMock'd Terminal/panesStore.
    return import('./Pane').then(({ Pane }) => {
      render(
        <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
      );
      registeredCallback?.('resolved-pty-1');
      // The respawn-loop fix must stay intact: registry mode never reconciles terminalId.
      expect(updatePaneTerminalId).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx -t "captures the registered ptyTabId"`
Expected: FAIL — either a type error (no such behavior yet) or the assertion passes vacuously because nothing calls the callback meaningfully yet. If it passes vacuously, that's fine — the real regression coverage comes from Task 1 Step 4's render-based check. Confirm the test file at least compiles and runs.

- [ ] **Step 3: Add `resolvedPtyTabId` state + blocks-mode state + `useBlockShortcuts` to `Pane.tsx`**

Read `src/components/Pane.tsx` current content first (imports, `PaneProps`, component body). Apply this diff:

```tsx
import { memo, useEffect, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { PaneActivityIndicator } from './PaneActivityIndicator';
import AgentActivityBadge from './AgentActivityBadge';
import { usePanesStore, shouldReconcileTerminalId } from '../state/panesStore';
import { ptyKill } from '../lib/tauri';
import { ENABLE_TERMINAL_REGISTRY } from '../hooks/usePty';
import * as terminalRegistry from '../lib/terminalRegistry';
import { useBlockShortcuts } from '../hooks/useBlockShortcuts';
import './Pane.css';
```

(Added `useState` to the React import and the new `useBlockShortcuts` import.)

Inside the component body, after the existing `const closePane = usePanesStore((s) => s.closePane);` line, add:

```tsx
  // Blocks mode: per-pane toggle between the raw terminal and the structured
  // command-block list. Lives here (not in TerminalSlot) so toggling it can
  // never change Terminal's key/props and re-trigger the registry's mount
  // effect — see docs/superpowers/specs/2026-07-02-restore-blocks-mode-and-view-menu-design.md.
  const [blocksMode, setBlocksMode] = useState(false);

  // Local-only mirror of the backend PTY id, for UI plumbing (BlockList,
  // useBlockShortcuts, InputEditor's ptyWrite target). This is SEPARATE from
  // the pane's real `terminalId` prop and must never feed into
  // updatePaneTerminalId — that reconciliation path is guarded off under
  // ENABLE_TERMINAL_REGISTRY specifically to prevent the 2026-06-23 infinite
  // PTY-respawn bug (see handleTerminalRegistered below).
  const [resolvedPtyTabId, setResolvedPtyTabId] = useState<string | null>(null);

  const { focusedBlockId, setFocusedBlockId } = useBlockShortcuts({
    tabId: resolvedPtyTabId,
    enabled: blocksMode && !!resolvedPtyTabId,
  });
```

Modify `handleTerminalRegistered` to also set the new local state (it must NOT change the existing early-return):

```tsx
  const handleTerminalRegistered = (newTabId: string) => {
    // Local UI-only mirror — safe to set unconditionally, never touches the
    // pane's terminalId prop or panesStore.
    setResolvedPtyTabId(newTabId);
    // In registry mode, the terminalRegistry owns the terminalId→PTY mapping
    // (entry.ptyTabId) and is keyed by the STABLE pane terminalId. Mutating the
    // pane's terminalId here would change TerminalSlot's effect key, re-run it,
    // and spawn a fresh PTY every time — an infinite respawn loop (openpty
    // exhaustion). So only reconcile on the legacy usePty path.
    if (ENABLE_TERMINAL_REGISTRY) return;
    // Adopt the backend-spawned PTY id so the pane's terminalId is the real
    // PTY key. Root panes start as terminalId=tabId and split panes as
    // pending-*; both (and reloaded stale ids) must reconcile, else features
    // that resolve a PTY by pane (recording, pane-close kill) miss it.
    if (shouldReconcileTerminalId(terminalId, newTabId)) {
      updatePaneTerminalId(paneId, newTabId);
    }
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx`
Expected: PASS (all tests in the file, including the pre-existing activity-indicator test and the new one).

- [ ] **Step 5: Run TypeScript check to confirm no new errors**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Pane\.tsx|useBlockShortcuts"`
Expected: no output (no errors referencing these files).

- [ ] **Step 6: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/components/Pane.tsx src/components/Pane.test.tsx
git commit -m "feat(terminal): lift blocks-mode state + useBlockShortcuts into Pane"
```

---

## Task 2: Render the mode-toggle bar + `BlockList`/`InputEditor` overlay in `Pane.tsx`

**Files:**
- Modify: `src/components/Pane.tsx`
- Test: `src/components/Pane.test.tsx`

**Interfaces:**
- Consumes: `blocksMode`, `setBlocksMode`, `resolvedPtyTabId`, `focusedBlockId`, `setFocusedBlockId` (from Task 1). `BlockList({ tabId, blocks, focusedBlockId, onFocusBlock }: BlockListProps)` (`src/components/BlockList.tsx:9-16`, unchanged). `InputEditor({ prompt, onExecute, disabled }: InputEditorProps)` (`src/components/InputEditor.tsx:4-8`, unchanged). `useBlocksStore((s) => s.blocksByTab.get(tabId) ?? EMPTY_BLOCKS)` and `useBlocksStore((s) => s.loadBlocksForTab)` (`src/state/blocksStore.ts`, unchanged).
- Produces: `Pane` renders the same DOM structure `LegacyTerminal` used to (`.terminal-mode-toggle`, `.mode-btn`, `.blocks-overlay`, `.blocks-history`/`.blocks-empty-state`), reusing existing CSS classes from `src/App.css:270-324` — no CSS changes needed.

- [ ] **Step 1: Write the failing test — toggling blocks mode renders `BlockList` without unmounting `Terminal`**

Add to `src/components/Pane.test.tsx`:

```tsx
describe('Pane blocks-mode rendering', () => {
  it('shows the Blocks/Terminal toggle and renders BlockList only when blocksMode is on, without changing Terminal props', async () => {
    const terminalRenders: Array<{ terminalId: string }> = [];
    vi.doMock('./Terminal', () => ({
      Terminal: (props: { terminalId: string; onRegistered?: (id: string) => void }) => {
        terminalRenders.push({ terminalId: props.terminalId });
        // Simulate the registry resolving a PTY id once, like TerminalSlot does.
        props.onRegistered?.('resolved-pty-2');
        return null;
      },
    }));
    vi.doMock('./BlockList', () => ({
      BlockList: ({ tabId }: { tabId: string }) => <div data-testid="block-list">{tabId}</div>,
    }));
    vi.doMock('../state/blocksStore', () => ({
      useBlocksStore: (selector: (s: unknown) => unknown) =>
        selector({ blocksByTab: new Map(), loadBlocksForTab: vi.fn() }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    const { getByText, queryByTestId } = await import('@testing-library/react').then(
      async (rtl) => {
        const { Pane } = await import('./Pane');
        return rtl.render(
          <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
        );
      },
    );

    // BlockList not shown by default (Terminal mode is the default).
    expect(queryByTestId('block-list')).toBeNull();

    // Toggle to Blocks mode.
    getByText('Blocks').click();
    expect(queryByTestId('block-list')).not.toBeNull();

    // Terminal was rendered exactly once with a stable terminalId — toggling
    // blocks mode must not remount/re-key it.
    expect(terminalRenders).toEqual([{ terminalId: 'tab-xyz-pty' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx -t "shows the Blocks/Terminal toggle"`
Expected: FAIL — `getByText('Blocks')` throws (no such text rendered yet).

- [ ] **Step 3: Implement the render changes in `Pane.tsx`**

Add imports:

```tsx
import { BlockList } from './BlockList';
import { InputEditor } from './InputEditor';
import { useBlocksStore, type Block } from '../state/blocksStore';
import { ptyWrite } from '../lib/tauri';
```

Add a stable empty-array constant near the top of the file (module scope, outside the component, so the selector below doesn't return a fresh `[]` every render):

```tsx
const EMPTY_BLOCKS: Block[] = [];
```

Inside the component, after the `useBlockShortcuts` call from Task 1, add:

```tsx
  const blocks = useBlocksStore((s) =>
    resolvedPtyTabId ? s.blocksByTab.get(resolvedPtyTabId) ?? EMPTY_BLOCKS : EMPTY_BLOCKS,
  );
  const loadBlocksForTab = useBlocksStore((s) => s.loadBlocksForTab);

  const handleSetBlocksMode = (enabled: boolean) => {
    setBlocksMode(enabled);
    if (enabled && resolvedPtyTabId) {
      loadBlocksForTab(resolvedPtyTabId);
    }
  };

  const handleExecuteCommand = (command: string) => {
    if (!resolvedPtyTabId) return;
    const bytes = new TextEncoder().encode(command + '\n');
    ptyWrite(resolvedPtyTabId, bytes).catch(console.error);
  };
```

Replace the `return (...)` JSX. Current:

```tsx
  return (
    <div
      ref={containerRef}
      className={`pane ${isFocused ? 'pane-focused' : ''}`}
      onClick={handleClick}
      data-pane-id={paneId}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {/* Activity indicators key off terminalId, not the layout paneId: the
          backend emits pane_activity_updated keyed by the PTY/tab id (see
          pty_spawn register_pane), which is the pane's terminalId. Passing
          paneId here never matched, so indicators silently rendered nothing. */}
      <PaneActivityIndicator paneId={terminalId} />
      <AgentActivityBadge paneId={terminalId} />

      {canClose && (
        <button
          className="pane-close"
          onClick={handleClosePane}
          title="Close pane (⌘W)"
          aria-label="Close pane"
          data-testid={`pane-close-${paneId}`}
        >
          ×
        </button>
      )}
      <Terminal
        terminalId={terminalId}
        shell={shell}
        cwd={cwd}
        onRegistered={handleTerminalRegistered}
        skipTabRegistration={true}
      />
    </div>
  );
```

New:

```tsx
  return (
    <div
      ref={containerRef}
      className={`pane ${isFocused ? 'pane-focused' : ''}`}
      onClick={handleClick}
      data-pane-id={paneId}
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* Activity indicators key off terminalId, not the layout paneId: the
          backend emits pane_activity_updated keyed by the PTY/tab id (see
          pty_spawn register_pane), which is the pane's terminalId. Passing
          paneId here never matched, so indicators silently rendered nothing. */}
      <PaneActivityIndicator paneId={terminalId} />
      <AgentActivityBadge paneId={terminalId} />

      {canClose && (
        <button
          className="pane-close"
          onClick={handleClosePane}
          title="Close pane (⌘W)"
          aria-label="Close pane"
          data-testid={`pane-close-${paneId}`}
        >
          ×
        </button>
      )}

      <div className="terminal-mode-toggle">
        <button
          className={`mode-btn ${!blocksMode ? 'active' : ''}`}
          onClick={() => handleSetBlocksMode(false)}
          title="Traditional terminal mode (for SSH, vim, etc.)"
        >
          Terminal
        </button>
        <button
          className={`mode-btn ${blocksMode ? 'active' : ''}`}
          onClick={() => handleSetBlocksMode(true)}
          title="Blocks mode (for simple commands)"
        >
          Blocks
        </button>
      </div>

      {/* Terminal stays mounted unconditionally — blocksMode only hides it
          via CSS, exactly the technique LegacyTerminal used, and for the same
          reason: toggling must never remount/re-key TerminalSlot's registry
          session. */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          visibility: blocksMode ? 'hidden' : 'visible',
          position: blocksMode ? 'absolute' : 'relative',
          inset: blocksMode ? 0 : undefined,
          zIndex: blocksMode ? -1 : undefined,
        }}
      >
        <Terminal
          terminalId={terminalId}
          shell={shell}
          cwd={cwd}
          onRegistered={handleTerminalRegistered}
          skipTabRegistration={true}
        />
      </div>

      {blocksMode && (
        <div className="blocks-overlay">
          {resolvedPtyTabId ? (
            <BlockList
              tabId={resolvedPtyTabId}
              blocks={blocks}
              focusedBlockId={focusedBlockId}
              onFocusBlock={setFocusedBlockId}
            />
          ) : (
            <div className="blocks-history">
              <div className="blocks-empty-state">
                <p>Blocks Mode - Command History</p>
                <p className="hint">Connecting…</p>
              </div>
            </div>
          )}
          <InputEditor
            prompt="$ "
            onExecute={handleExecuteCommand}
            disabled={!resolvedPtyTabId}
          />
        </div>
      )}
    </div>
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx`
Expected: PASS (all tests, including pre-existing ones — the activity-indicator test's `Terminal` mock returns `null` with no `onRegistered` prop, which the new code handles gracefully since `handleTerminalRegistered` is still just a prop, never called by that test).

- [ ] **Step 5: Run TypeScript + full test suite**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Pane\.tsx"`
Expected: no output.

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run`
Expected: all tests pass (baseline was 2533 passing before this task; count should only grow).

- [ ] **Step 6: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/components/Pane.tsx src/components/Pane.test.tsx
git commit -m "feat(terminal): render Blocks/Terminal toggle + BlockList overlay in Pane"
```

---

## Task 3: Regression tests — split-pane content survives blocks-mode toggling, no PTY respawn

**Files:**
- Test: `src/components/Pane.test.tsx`
- Test: `src/lib/terminalRegistry.test.ts` (read-only reference; no modifications — see Global Constraints)

**Interfaces:**
- Consumes: `terminalRegistry.getOrCreate`, `terminalRegistry.__resetForTest` (`src/lib/terminalRegistry.ts:39-108,467-469`, unchanged) via a `vi.mock('../lib/terminalRegistry')` spy in the new test, to assert call counts without needing a real xterm/PTY.

This task directly targets the operator's explicit constraint: verify the split-pane / no-duplicate-PTY fix from the 2026-06-22 registry work is not disturbed by blocks-mode toggling.

- [ ] **Step 1: Write the regression test**

Add to `src/components/Pane.test.tsx`:

```tsx
describe('Pane blocks-mode does not affect terminal registry lifecycle', () => {
  it('toggling blocksMode on/off repeatedly does not remount Terminal or touch the registry', async () => {
    const terminalMountCount = { current: 0 };
    vi.doMock('./Terminal', () => ({
      Terminal: (props: { terminalId: string; onRegistered?: (id: string) => void }) => {
        terminalMountCount.current += 1;
        props.onRegistered?.('resolved-pty-3');
        return null;
      },
    }));
    vi.doMock('./BlockList', () => ({
      BlockList: () => <div data-testid="block-list" />,
    }));
    vi.doMock('../state/blocksStore', () => ({
      useBlocksStore: (selector: (s: unknown) => unknown) =>
        selector({ blocksByTab: new Map(), loadBlocksForTab: vi.fn() }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const { getByText } = rtl.render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    // Terminal mounts exactly once on initial render.
    expect(terminalMountCount.current).toBe(1);

    // Toggle blocks mode on and off several times.
    getByText('Blocks').click();
    getByText('Terminal').click();
    getByText('Blocks').click();
    getByText('Terminal').click();

    // Still exactly one mount — the registry-backed Terminal/TerminalSlot was
    // never unmounted or re-keyed by the mode toggle (this is the guarantee
    // that protects split-pane content and prevents PTY respawn).
    expect(terminalMountCount.current).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes for the right reason**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx -t "does not remount Terminal"`
Expected: PASS, given Task 2's implementation already keeps `<Terminal>` unconditionally mounted. If this test were to fail, it would mean Task 2's JSX structure conditionally rendered `<Terminal>` — go back and fix Task 2's implementation, not this test.

- [ ] **Step 3: Run the full suite one more time to confirm no regressions**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/components/Pane.test.tsx
git commit -m "test(terminal): guard blocks-mode toggle against remounting the registry-backed Terminal"
```

---

## Task 4: Leave `LegacyTerminal`'s blocks-mode code untouched (decision record)

**Files:** none — this task makes no code changes.

**Interfaces:** none.

**Decision:** `LegacyTerminal`'s existing blocks-mode code (`src/components/Terminal.tsx:42-137, 826-903`) is NOT deleted or modified by this plan. Per Global Constraints and the design spec's "Out of Scope" section, `LegacyTerminal` remains the `ENABLE_TERMINAL_REGISTRY=false` fallback path per the original registry design's rollback contract, and it still works correctly under that flag-off path today — nothing in Tasks 1–3 broke it, since those tasks only add new code to `Pane.tsx`. There is no dead code to remove here: `LegacyTerminal` is a live fallback, not an orphan.

- [ ] **Step 1: Record the decision**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git commit --allow-empty -m "chore(terminal): keep LegacyTerminal's blocks-mode code intact (flag-off fallback, not touched by this plan)"
```

---

## Task 5: Restore the View menu's Raw/Structured/Diff items in Rust

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: 3 new `MenuItem`s (`view_raw`, `view_structured`, `view_diff`), a `View` `Submenu`, its slot in `Menu::with_items`, and 3 `match` arms in `on_menu_event` emitting Tauri event `"menu:view_mode"` with string payload `"raw"` / `"structured"` / `"diff"` — consumed by Task 6's frontend listener.

- [ ] **Step 1: Add the 3 `MenuItem`s and `View` submenu**

In `src-tauri/src/lib.rs`, find this block (currently at line 707-710):

```rust
            // SSH menu with saved connections item
            let ssh_saved = MenuItem::with_id(app, "ssh_saved", "Saved Connections...", true, None::<&str>)?;
            let ssh_menu = Submenu::with_items(app, "SSH", true, &[&ssh_saved])?;

            // Change menu — change verification workflow (Plan 06).
```

Replace with:

```rust
            // SSH menu with saved connections item
            let ssh_saved = MenuItem::with_id(app, "ssh_saved", "Saved Connections...", true, None::<&str>)?;
            let ssh_menu = Submenu::with_items(app, "SSH", true, &[&ssh_saved])?;

            // View menu — block view modes (raw/structured/diff), restored 2026-07-02.
            // Pin Snapshot / Export CSV/JSON / Copy as Markdown intentionally stay
            // removed — still available as in-block buttons inside StructuredTab.
            let view_raw = MenuItem::with_id(app, "view_raw", "Show Raw Output", true, Some("CmdOrCtrl+1"))?;
            let view_structured = MenuItem::with_id(app, "view_structured", "Show Structured", true, Some("CmdOrCtrl+2"))?;
            let view_diff = MenuItem::with_id(app, "view_diff", "Show Diff", true, Some("CmdOrCtrl+3"))?;
            let view_menu = Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &view_raw,
                    &view_structured,
                    &view_diff,
                ],
            )?;

            // Change menu — change verification workflow (Plan 06).
```

- [ ] **Step 2: Add `&view_menu` back into `Menu::with_items`**

Find (currently at line 945-953):

```rust
            let menu = Menu::with_items(
                app,
                &[
                    &app_menu,
                    &operate_menu,
                    &audit_menu,
                    &help_menu,
                ],
            )?;
```

Replace with:

```rust
            let menu = Menu::with_items(
                app,
                &[
                    &app_menu,
                    &view_menu,
                    &operate_menu,
                    &audit_menu,
                    &help_menu,
                ],
            )?;
```

- [ ] **Step 3: Add the 3 `match` arms in `on_menu_event`**

Find (currently at line 965-969):

```rust
                match event.id().as_ref() {
                    "ssh_saved" => {
                        window.emit("menu:ssh_saved_connections", ()).ok();
                    }
                    "change_open" => { window.emit("menu:change_open", ()).ok(); }
```

Replace with:

```rust
                match event.id().as_ref() {
                    "ssh_saved" => {
                        window.emit("menu:ssh_saved_connections", ()).ok();
                    }
                    "view_raw" => { window.emit("menu:view_mode", "raw").ok(); }
                    "view_structured" => { window.emit("menu:view_mode", "structured").ok(); }
                    "view_diff" => { window.emit("menu:view_mode", "diff").ok(); }
                    "change_open" => { window.emit("menu:change_open", ()).ok(); }
```

- [ ] **Step 4: Build and verify no new warnings/errors**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo check --quiet 2>&1 | grep -iE "error|lib\.rs"`
Expected: only the pre-existing `warning: unused import: \`MenuEvent\`` at the `use tauri::menu::{...}` line (baseline, confirmed unrelated in the prior fix) — no new errors.

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo build --quiet 2>&1 | tail -5`
Expected: build completes with only pre-existing warnings.

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src-tauri/src/lib.rs
git commit -m "feat(menu): restore View menu Show Raw/Structured/Diff (⌘1/2/3)"
```

---

## Task 6: Restore the frontend `menu:view_mode` listener in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: Tauri event `"menu:view_mode"` (payload: `"raw" | "structured" | "diff"`, emitted by Task 5). `useStructuredView.getState(): { focusedBlockId: string | null; setViewMode: (id: string, mode: BlockViewMode) => void }` (`src/state/structuredViewStore.ts:4-20`, unchanged).
- Produces: whichever `CommandBlock` currently has `structuredViewStore`'s hover-focus switches its `BlockTabStrip` view mode when ⌘1/⌘2/⌘3 fires or the View menu is clicked — identical behavior to before the 2026-07-01/02 removal.

- [ ] **Step 1: Restore the `useStructuredView` import**

In `src/App.tsx`, find (currently line 49):

```tsx
import { useBlocksStore } from "./state/blocksStore";
import { usePanesStore } from "./state/panesStore";
```

Replace with:

```tsx
import { useBlocksStore } from "./state/blocksStore";
import { useStructuredView } from "./state/structuredViewStore";
import { usePanesStore } from "./state/panesStore";
```

- [ ] **Step 2: Restore the `menu:view_mode` listener**

Find (currently at line 284-291):

```tsx
  // Listen for menu events
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(listen('menu:ssh_saved_connections', () => {
      setSshModalOpen(true);
    }));

    // Plan 06 — Change menu events
```

Replace with:

```tsx
  // Listen for menu events
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(listen('menu:ssh_saved_connections', () => {
      setSshModalOpen(true);
    }));

    // View menu — drives the focused block's view mode. Restored 2026-07-02
    // (see docs/superpowers/specs/2026-07-02-restore-blocks-mode-and-view-menu-design.md).
    unlistens.push(
      listen<string>('menu:view_mode', (e) => {
        const mode = e.payload as 'raw' | 'structured' | 'diff';
        const { focusedBlockId, setViewMode } = useStructuredView.getState();
        if (focusedBlockId) setViewMode(focusedBlockId, mode);
      }),
    );

    // Plan 06 — Change menu events
```

- [ ] **Step 3: Run TypeScript check**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "App\.tsx"`
Expected: only the pre-existing baseline errors already present before this plan (`'CommandBlock' is declared but its value is never read`, `'initializeLayout' is declared but its value is never read`, the destructured-elements-unused error) — confirm via `git stash`/`git stash pop` diff exactly as done in the prior fix, if unsure which lines are pre-existing.

- [ ] **Step 4: Run full test suite**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run`
Expected: all tests pass (same or higher count than after Task 3).

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/App.tsx
git commit -m "feat(menu): restore menu:view_mode listener wiring to structuredViewStore"
```

---

## Task 7: Live verification in the running app

**Files:** none (manual verification only — no code changes)

**Interfaces:** none.

This task has no automated test; it is the honesty check required before claiming the feature works, per the project's established practice of live-verifying UI changes (see `feedback_verify_before_claiming_done` memory) and the operator's explicit "don't break the split-pane fix" constraint.

- [ ] **Step 1: Confirm the dev app is running and picks up changes**

Run: `ps aux | grep -i "tauri dev" | grep -v grep`
Expected: a `bun run tauri dev` / `node .../tauri` process is running. If not, start it: `cd "/Users/shaunwhi/CCIE Terminal" && bun run tauri dev` (background) and wait for the Tauri window to appear.

- [ ] **Step 2: Verify the View menu is back**

Run (macOS AppleScript via Bash):
```bash
osascript -e '
tell application "System Events"
	tell process "TerminAI"
		set frontmost to true
		delay 0.3
		return name of menu bar items of menu bar 1
	end tell
end tell'
```
Expected output includes `View` between `TerminAI` and `Operate`: `Apple, TerminAI, View, Operate, Audit, Help`.

- [ ] **Step 3: Verify Blocks mode toggle appears and works**

In the running app, open a terminal tab, run any command (e.g. `ls`), then click the "Blocks" button that should now appear above the terminal. Expected: the view switches to a block list showing the `ls` command with its output; an input box appears at the bottom for entering new commands.

- [ ] **Step 4: Verify split-pane content survives (the critical regression check)**

While in Blocks mode with at least one command block visible, split the pane with ⌘D (horizontal split, `src/hooks/usePaneSplit.ts:17-28`) or ⌘⇧D (vertical split, `:31-37`). Expected: the original pane keeps its blocks and scrollback intact; the new pane starts fresh in Terminal mode. This is the direct check against the operator's stated concern — if content is lost or a duplicate PTY spawns, STOP and return to Task 2/3, do not proceed.

- [ ] **Step 5: Verify tab-switch content survives**

Switch to a different tab and back to the one in Blocks mode. Expected: blocks mode state and block content are unchanged (this mirrors the exact bug the terminal registry fixed on 2026-06-22).

- [ ] **Step 6: Verify ⌘1/⌘2/⌘3 shortcuts**

Hover over a command block that has structured output (a `show`-style command), then press ⌘2. Expected: the block's view switches to "Structured". Press ⌘1 → switches back to "Raw". Press ⌘3 → switches to "Diff".

- [ ] **Step 7: Verify plain terminal-mode-only usage is unaffected**

Open a fresh terminal tab and do NOT toggle Blocks mode at all — run several commands, resize the window, split the pane. Expected: behaves identically to current production behavior, zero visible change, since this is the default/most common path.

- [ ] **Step 8: Report results honestly**

If any step in 4–7 fails, do not report the feature as working — document exactly what broke and return to the relevant earlier task to fix the root cause before re-attempting live verification. If all steps pass, this task is complete with no code changes to commit.

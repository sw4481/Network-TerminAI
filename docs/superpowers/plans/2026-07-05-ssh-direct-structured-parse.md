# SSH-Direct Structured Parse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the terminal's right-click context menu (currently unreachable app-wide, same root cause as the Blocks-mode gap fixed 2026-07-02) into `Pane.tsx`, then add a "Run as Structured..." item to it that finally calls the already-built-but-dead `structured_run_and_parse` backend path, making the Structured/Diff view useful for real SSH-into-a-device workflows.

**Architecture:** Port `LegacyTerminal`'s context-menu state/handlers/JSX (`Terminal.tsx:42-1069`) into `Pane.tsx`, wiring `onContextMenu` onto the pane's outer container (selection is read via a new `terminalRegistry.getSelection(terminalId)` export, since `Pane.tsx` has no direct xterm reference). Then add one new context-menu item that opens a new `RunStructuredModal.tsx`, which resolves the tab's SSH connection (via a new shared helper extracted from `ChangeWindowPanel.tsx`) and device type (remembered per-tab via existing `setTabVendor`), runs the command via the existing `runAndParseOverSsh`, and renders the result via the existing, unchanged `StructuredTab`/`StructuredDiff` components.

**Tech Stack:** React 18 + TypeScript, Zustand stores (`tabsStore`, `sshPasswordStore`, `blocksStore`), Tauri 2 (`invoke`), Vitest + Testing Library.

## Global Constraints

- Do not modify `terminalRegistry.ts`'s mount/attach/detach/dispose lifecycle or `TerminalSlot.tsx`'s effect dependencies (`[terminalId]` only) — this plan only adds one new read-only exported function (`getSelection`) to `terminalRegistry.ts`, nothing else in that file changes.
- Do not modify `StructuredTab.tsx`, `StructuredDiff.tsx`, `BlockTabStrip.tsx`, `structured.ts`, or any Rust backend file — the rendering and backend paths are already complete; this plan only adds callers/triggers.
- The ported context menu must preserve all 5 existing items exactly (Ask AI about selection, Ask agent, Ingest Topology, Copy, Paste) — no menu item may be dropped or changed in this port.
- Device type (vendor/platform) has no auto-detection anywhere in this codebase; the new modal must reuse the existing manual per-tab picker pattern (`setTabVendor`), never invent auto-detection.
- Every task's `tsc --noEmit` and `vitest run` must show no new errors/warnings beyond the pre-existing baseline (confirmed via `git stash` diffing if unsure which errors are pre-existing).
- Reference spec: `docs/superpowers/specs/2026-07-05-ssh-direct-structured-parse-design.md`.

---

## Task 1: Expose `getSelection` from `terminalRegistry.ts`

**Files:**
- Modify: `src/lib/terminalRegistry.ts`
- Test: `src/lib/terminalRegistry.test.ts`

**Interfaces:**
- Produces: `terminalRegistry.getSelection(terminalId: string): string` — returns the live xterm selection text for that terminal, or `""` if the entry doesn't exist or has no selection. Consumed by Task 2's ported `handleContextMenu`.

`Pane.tsx` has no direct reference to the xterm instance (it's owned by the registry, keyed by `terminalId`). The ported context-menu code needs `handle.term.getSelection()`'s equivalent. `terminalRegistry.ts` already calls `xterm.getSelection()` internally at `:189` for its own Ctrl+C handling — this task just exposes the same capability as a public function.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/terminalRegistry.test.ts` (following the existing `installFakeXterm`/`getOrCreate` pattern already in that file):

```ts
describe('getSelection', () => {
  it('returns the live xterm selection for an existing entry', () => {
    const e = reg.getOrCreate('t1', OPTS);
    e.xterm.getSelection = vi.fn(() => 'selected text');
    expect(reg.getSelection('t1')).toBe('selected text');
  });

  it('returns empty string for a terminalId with no registry entry', () => {
    expect(reg.getSelection('does-not-exist')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/lib/terminalRegistry.test.ts -t "getSelection"`
Expected: FAIL — `reg.getSelection` is not a function.

- [ ] **Step 3: Implement `getSelection`**

In `src/lib/terminalRegistry.ts`, add this new exported function near the other public getters (`has`, `ptyTabIdFor`, right after `ptyTabIdFor` at line 51):

```ts
/**
 * Read the current text selection in a terminal's xterm instance, if any.
 * Used by Pane's context menu (selection-gated menu items). Returns "" for
 * an unknown terminalId or when nothing is selected.
 */
export function getSelection(terminalId: string): string {
  const entry = registry.get(terminalId);
  if (!entry) return '';
  return entry.xterm.getSelection() ?? '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/lib/terminalRegistry.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones).

- [ ] **Step 5: Run TypeScript check**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "terminalRegistry"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/lib/terminalRegistry.ts src/lib/terminalRegistry.test.ts
git commit -m "feat(terminal): expose getSelection from the terminal registry"
```

---

## Task 2: Port the context menu (state, handlers, JSX) into `Pane.tsx`

**Files:**
- Modify: `src/components/Pane.tsx`
- Test: `src/components/Pane.test.tsx`

**Interfaces:**
- Consumes: `terminalRegistry.getSelection(terminalId)` (Task 1). `useAgentsStore` (`src/state/agentsStore.ts`, unchanged) for the "Ask agent" submenu. `useTopologyStore.getState().ingestFromText(command, selection, vendor, platform, deviceRef, deviceKind)` (`src/state/topologyStore.ts`, unchanged). `TOPOLOGY_TRIGGER_CMD_RE` (`src/lib/topology.ts`, unchanged). `ptyWrite` (`src/lib/tauri.ts`, unchanged, already imported in `Pane.tsx`).
- Produces: `Pane` now owns `contextMenu: {x, y, selection} | null` state and handlers `handleContextMenu`, `handleAskAI`, `handleAskAgent`, `handleCopy`, `handlePaste`, `handleIngestTopology` — consumed by Task 3, which adds one more handler + menu item alongside these.

This is a straight port of working code, not new design — copy the logic faithfully; do not "improve" it while porting (the outside-click-to-close effect, the selection-gated visibility rules, and the inline styles all have working behavior today under the flag-off path and must behave identically here).

- [ ] **Step 1: Write the failing test — context menu opens on right-click and shows selection-gated items**

Add to `src/components/Pane.test.tsx` (model the mocking from the existing "Pane blocks-mode rendering" describe block — same `vi.doMock` pattern for `./Terminal`, `../state/panesStore`):

```tsx
describe('Pane context menu', () => {
  it('opens on right-click, shows Ask AI + Copy only when there is a selection, and closes on outside click', async () => {
    vi.resetModules();
    vi.doMock('./Terminal', () => ({
      Terminal: () => null,
    }));
    vi.doMock('../lib/terminalRegistry', () => ({
      getSelection: vi.fn(() => 'show version output'),
    }));
    vi.doMock('../state/agentsStore', () => ({
      useAgentsStore: (selector: (s: unknown) => unknown) => selector({ agents: [] }),
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
    const { getByText, queryByText, container } = rtl.render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    const paneEl = container.querySelector('[data-pane-id="pane-abc"]')!;
    rtl.fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });

    expect(getByText(/Ask AI about selection/)).toBeTruthy();
    expect(getByText(/Copy/)).toBeTruthy();
    expect(getByText(/Paste/)).toBeTruthy();

    // Outside click closes the menu.
    rtl.fireEvent.click(window);
    expect(queryByText(/Ask AI about selection/)).toBeNull();
  });

  it('hides selection-gated items (Ask AI, Copy) when there is no selection', async () => {
    vi.resetModules();
    vi.doMock('./Terminal', () => ({
      Terminal: () => null,
    }));
    vi.doMock('../lib/terminalRegistry', () => ({
      getSelection: vi.fn(() => ''),
    }));
    vi.doMock('../state/agentsStore', () => ({
      useAgentsStore: (selector: (s: unknown) => unknown) => selector({ agents: [] }),
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
    const { queryByText, container } = rtl.render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    const paneEl = container.querySelector('[data-pane-id="pane-abc"]')!;
    rtl.fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });

    expect(queryByText(/Ask AI about selection/)).toBeNull();
    expect(queryByText(/^Copy$/)).toBeNull();
    // Paste is always shown, selection or not.
    expect(queryByText(/Paste/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx -t "Pane context menu"`
Expected: FAIL — no `contextmenu` handler exists yet, so `getByText(/Ask AI/)` throws.

- [ ] **Step 3: Port the context-menu code into `Pane.tsx`**

Add these imports at the top of `src/components/Pane.tsx` (alongside the existing ones):

```tsx
import { useAgentsStore } from '../state/agentsStore';
import { useTopologyStore } from '../state/topologyStore';
import { TOPOLOGY_TRIGGER_CMD_RE } from '../lib/topology';
import * as terminalRegistry from '../lib/terminalRegistry';
```

(Note: `* as terminalRegistry` is already imported in `Pane.tsx` for `dispose`/`ENABLE_TERMINAL_REGISTRY` handling — do not duplicate the import, just use the existing one. `getSelection` is now available on it from Task 1.)

Add this type near `PaneProps` at the top of the file:

```tsx
type ContextMenuState = {
  x: number;
  y: number;
  selection: string;
};
```

Inside the `Pane` component, after the existing `handleClosePane` definition and before the `return (`, add (this is a faithful port of `Terminal.tsx:443-597`, adapted to read selection via `terminalRegistry.getSelection(terminalId)` instead of `handle.term.getSelection()`, and to use `resolvedPtyTabId` where the original used `handle.tabId`):

```tsx
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const agents = useAgentsStore((s) => s.agents);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const selection = terminalRegistry.getSelection(terminalId);
    // Always show the context menu, even without a selection (for paste).
    setContextMenu({ x: e.clientX, y: e.clientY, selection: selection || '' });
  };

  const handleAskAI = () => {
    if (!contextMenu) return;
    window.dispatchEvent(
      new CustomEvent('ccie:ask-ai-about-selection', {
        detail: { selection: contextMenu.selection },
      }),
    );
    setContextMenu(null);
  };

  const handleAskAgent = (agentId: string) => {
    if (!contextMenu) return;
    window.dispatchEvent(
      new CustomEvent('ccie:invoke-agent', {
        detail: {
          agentId,
          selection: contextMenu.selection,
          message: 'Explain this terminal output and suggest next steps.',
          autoSend: false,
        },
      }),
    );
    setContextMenu(null);
  };

  const handleCopy = () => {
    if (!contextMenu) return;
    navigator.clipboard.writeText(contextMenu.selection).catch(() => {});
    setContextMenu(null);
  };

  const handlePaste = async () => {
    if (!resolvedPtyTabId) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(text);
        await ptyWrite(resolvedPtyTabId, bytes);
      }
    } catch (err) {
      console.error('Failed to paste:', err);
    }
    setContextMenu(null);
  };

  const handleIngestTopology = async () => {
    if (!contextMenu) return;
    const selection = contextMenu.selection.trim();
    if (!selection) return;

    const lines = selection.split('\n');
    let command = '';
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const line = lines[i].trim();
      const cleaned = line.replace(/^[^\s#$>]+[#$>]\s*/, '');
      if (TOPOLOGY_TRIGGER_CMD_RE.test(cleaned)) {
        command = cleaned;
        break;
      }
    }

    if (!command) {
      console.error('[Pane] No topology command found in selection');
      setContextMenu(null);
      return;
    }

    const vendor = 'cisco';
    const platform = 'iosxe';
    const deviceRef = 'unknown-device';
    const deviceKind = 'ssh';

    setContextMenu(null);

    try {
      await useTopologyStore.getState().ingestFromText(
        command,
        selection,
        vendor,
        platform,
        deviceRef,
        deviceKind,
      );
    } catch (err) {
      console.error('[Pane] Topology ingestion failed:', err);
    }
  };

  // Close context menu on any click outside it.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const menuButtonStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '8px 12px',
    background: 'transparent',
    border: 'none',
    color: '#e6e1cf',
    cursor: 'pointer',
    borderRadius: '4px',
    fontSize: '13px',
  };
```

**Note on `vendor`/`platform`/`deviceRef` above:** the original `Terminal.tsx:530-535` looked these up from `useTabs.getState().tabs.find((t) => t.id === handle.tabId)`, falling back to `'cisco'`/`'iosxe'`/`'unknown-device'` if not found. `Pane.tsx` does not currently import `useTabs` — for this port, use the same fallback defaults unconditionally (skip the tab lookup) to keep this task's diff minimal; Task 3 will introduce real tab-based vendor/platform resolution for the new "Run as Structured..." feature, and that same lookup can be reused here in a later cleanup if desired. This is a deliberate, documented simplification of the ported behavior — the Ingest Topology defaults were already a fallback path in the original code, not its primary path.

Now wire `onContextMenu` onto the pane's outer container and add the menu JSX. Modify the `return (` block:

Find:
```tsx
  return (
    <div
      ref={containerRef}
      className={`pane ${isFocused ? 'pane-focused' : ''}`}
      onClick={handleClick}
      data-pane-id={paneId}
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
```

Replace with:
```tsx
  return (
    <div
      ref={containerRef}
      className={`pane ${isFocused ? 'pane-focused' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      data-pane-id={paneId}
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
```

Find the closing `</div>` right before `);` at the end of the component's JSX (the outermost pane wrapper's closing tag, currently the very last line inside `return (`), and insert the context-menu JSX just before it:

```tsx
      {contextMenu && (
        <div
          className="terminal-context-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: '#1a1d23',
            border: '1px solid #262a33',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            padding: '4px',
            zIndex: 10000,
            minWidth: '200px',
            maxHeight: '420px',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.selection && contextMenu.selection.trim() && (
            <>
              <button
                onClick={handleAskAI}
                style={menuButtonStyle}
                onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
                onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                ✨ Ask AI about selection
              </button>
              {agents.length > 0 && (
                <div style={{ borderTop: '1px solid #262a33', margin: '4px 0', paddingTop: '4px' }}>
                  <div
                    style={{
                      padding: '4px 12px',
                      color: '#6c7380',
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    Ask agent
                  </div>
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleAskAgent(a.id)}
                      style={menuButtonStyle}
                      onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
                      onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                      title={a.description}
                    >
                      🤖 {a.name}
                    </button>
                  ))}
                </div>
              )}
              {contextMenu.selection.split('\n').slice(0, 5).some((line) => {
                const cleaned = line.replace(/^[^\s#$>]+[#$>]\s*/, '').trim();
                return TOPOLOGY_TRIGGER_CMD_RE.test(cleaned);
              }) && (
                <>
                  <div style={{ borderTop: '1px solid #262a33', margin: '4px 0' }} />
                  <button
                    onClick={handleIngestTopology}
                    style={menuButtonStyle}
                    onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
                    onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                    title="Parse and add neighbors to topology graph"
                  >
                    🗺️ Ingest Topology
                  </button>
                </>
              )}
              <div style={{ borderTop: '1px solid #262a33', margin: '4px 0' }} />
            </>
          )}
          <div style={{ paddingTop: contextMenu.selection && contextMenu.selection.trim() ? '4px' : '0' }}>
            {contextMenu.selection && contextMenu.selection.trim() && (
              <button
                onClick={handleCopy}
                style={menuButtonStyle}
                onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
                onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                📋 Copy
              </button>
            )}
            <button
              onClick={handlePaste}
              style={menuButtonStyle}
              onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              📄 Paste
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx`
Expected: PASS (all tests, including the pre-existing ones from earlier work in this file).

- [ ] **Step 5: Run TypeScript check**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Pane\.tsx"`
Expected: no output.

- [ ] **Step 6: Run the full suite once**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run`
Expected: all tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/components/Pane.tsx src/components/Pane.test.tsx
git commit -m "feat(terminal): restore right-click context menu (Ask AI, Ask agent, Ingest Topology, Copy, Paste) in Pane"
```

---

## Task 3: Extract `resolveTabConnection` from `ChangeWindowPanel.tsx`

**Files:**
- Create: `src/lib/resolveTabConnection.ts`
- Modify: `src/components/ChangeWindowPanel.tsx`
- Test: `src/lib/resolveTabConnection.test.ts`
- Test: `src/components/ChangeWindowPanel.test.tsx` (re-run only, no new tests required — see Step 6)

**Interfaces:**
- Produces:
  - `interface SshConnection { id: string; name: string; host: string; user: string | null; port: number | null; identity_file: string | null; password_encrypted: string | null; created_at: number; last_used_at: number | null; }`
  - `async function listSshConnections(): Promise<SshConnection[]>` — wraps `invoke<SshConnection[]>("ssh_list_connections")`.
  - `function matchConnectionForTab(connections: SshConnection[], ctx: { host: string; user: string | null } | null): SshConnection | null` — pure function, the extracted matching logic (no I/O), consumed by both `ChangeWindowPanel.tsx` and Task 4's `RunStructuredModal.tsx`.
  - `async function resolveSshPassword(tabId: string, connectionId: string, connections: SshConnection[], getPasswordContext: (tabId: string) => { host: string; password: string } | null): Promise<string | undefined>` — the extracted password-resolution logic from `ChangeWindowPanel.tsx:242-262`.
- Consumes: `invoke` from `@tauri-apps/api/core` (unchanged).

This task changes zero user-visible behavior — it moves working logic into a shared file and repoints `ChangeWindowPanel.tsx` at it. `matchConnectionForTab` is a **pure function** (no `invoke`, no store reads) precisely so it's trivially unit-testable and so Task 4 can call it without duplicating the matching rule.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/resolveTabConnection.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { listSshConnections, matchConnectionForTab, resolveSshPassword, type SshConnection } from './resolveTabConnection';

const CONN_A: SshConnection = {
  id: 'conn-a',
  name: 'Switch A',
  host: '10.0.0.1',
  user: 'admin',
  port: 22,
  identity_file: null,
  password_encrypted: null,
  created_at: 0,
  last_used_at: null,
};

const CONN_B: SshConnection = {
  ...CONN_A,
  id: 'conn-b',
  name: 'Switch B',
  host: '10.0.0.2',
  user: null,
};

describe('listSshConnections', () => {
  it('invokes ssh_list_connections and returns its result', async () => {
    invokeMock.mockResolvedValueOnce([CONN_A]);
    const result = await listSshConnections();
    expect(invokeMock).toHaveBeenCalledWith('ssh_list_connections');
    expect(result).toEqual([CONN_A]);
  });
});

describe('matchConnectionForTab', () => {
  it('returns null when ctx is null', () => {
    expect(matchConnectionForTab([CONN_A, CONN_B], null)).toBeNull();
  });

  it('matches on exact host + exact user', () => {
    const match = matchConnectionForTab([CONN_A, CONN_B], { host: '10.0.0.1', user: 'admin' });
    expect(match?.id).toBe('conn-a');
  });

  it('matches on host when the saved connection has no user recorded', () => {
    const match = matchConnectionForTab([CONN_A, CONN_B], { host: '10.0.0.2', user: 'admin' });
    expect(match?.id).toBe('conn-b');
  });

  it('matches on host when ctx has no user recorded', () => {
    const match = matchConnectionForTab([CONN_A, CONN_B], { host: '10.0.0.1', user: null });
    expect(match?.id).toBe('conn-a');
  });

  it('returns null when host does not match anything', () => {
    expect(matchConnectionForTab([CONN_A, CONN_B], { host: '10.0.0.99', user: 'admin' })).toBeNull();
  });

  it('returns null when host matches but user conflicts', () => {
    expect(matchConnectionForTab([CONN_A], { host: '10.0.0.1', user: 'someone-else' })).toBeNull();
  });
});

describe('resolveSshPassword', () => {
  it('prefers the tab live session password when host matches', async () => {
    const getPasswordContext = vi.fn(() => ({ host: '10.0.0.1', password: 'live-pw' }));
    const pw = await resolveSshPassword('tab-1', 'conn-a', [CONN_A], getPasswordContext);
    expect(pw).toBe('live-pw');
  });

  it('falls back to decrypting the saved password when no live context matches', async () => {
    const connWithSaved: SshConnection = { ...CONN_A, password_encrypted: 'encrypted-blob' };
    const getPasswordContext = vi.fn(() => null);
    invokeMock.mockResolvedValueOnce('decrypted-pw');
    const pw = await resolveSshPassword('tab-1', 'conn-a', [connWithSaved], getPasswordContext);
    expect(invokeMock).toHaveBeenCalledWith('ssh_decrypt_password', { encrypted: 'encrypted-blob' });
    expect(pw).toBe('decrypted-pw');
  });

  it('returns undefined when neither a live context nor a saved password exists', async () => {
    const getPasswordContext = vi.fn(() => null);
    const pw = await resolveSshPassword('tab-1', 'conn-a', [CONN_A], getPasswordContext);
    expect(pw).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/lib/resolveTabConnection.test.ts`
Expected: FAIL — `./resolveTabConnection` module does not exist yet.

- [ ] **Step 3: Create `src/lib/resolveTabConnection.ts`**

```ts
import { invoke } from '@tauri-apps/api/core';

/** Saved SSH connection shape (mirrors the `ssh_list_connections` command). */
export interface SshConnection {
  id: string;
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  password_encrypted: string | null;
  created_at: number;
  last_used_at: number | null;
}

export async function listSshConnections(): Promise<SshConnection[]> {
  return invoke<SshConnection[]>('ssh_list_connections');
}

/**
 * Match a tab's live SSH session (host/user recorded in sshPasswordStore
 * when a saved connection was used to connect) against the saved-connection
 * list. Best-effort: the live context auto-clears after 5 minutes and is
 * empty for key-only auth, so a null return just means "show a picker."
 */
export function matchConnectionForTab(
  connections: SshConnection[],
  ctx: { host: string; user: string | null } | null,
): SshConnection | null {
  if (!ctx) return null;
  return (
    connections.find(
      (c) => c.host === ctx.host && (ctx.user == null || c.user == null || c.user === ctx.user),
    ) ?? null
  );
}

/**
 * Resolve a password for an SSH target without prompting: prefer the tab's
 * live session password, then a saved+encrypted one. Returns undefined when
 * neither is available (caller must prompt).
 */
export async function resolveSshPassword(
  tabId: string,
  connectionId: string,
  connections: SshConnection[],
  getPasswordContext: (tabId: string) => { host: string; password: string } | null,
): Promise<string | undefined> {
  const ctx = getPasswordContext(tabId);
  const conn = connections.find((c) => c.id === connectionId);
  if (ctx && conn && ctx.host === conn.host) {
    return ctx.password;
  }
  if (conn?.password_encrypted) {
    try {
      const pwd = await invoke<string | null>('ssh_decrypt_password', {
        encrypted: conn.password_encrypted,
      });
      if (pwd) return pwd;
    } catch (e) {
      console.warn('Could not decrypt saved password:', e);
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/lib/resolveTabConnection.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Repoint `ChangeWindowPanel.tsx` at the extracted helper**

In `src/components/ChangeWindowPanel.tsx`:

Remove the inline `interface SshConnection { ... }` (lines ~21-32) and add this import instead, alongside the other imports:

```tsx
import {
  listSshConnections,
  matchConnectionForTab,
  resolveSshPassword as resolveSshPasswordHelper,
  type SshConnection,
} from "../lib/resolveTabConnection";
```

Find (the connection-loading + auto-match effect, ~lines 128-150):
```tsx
  useEffect(() => {
    (async () => {
      try {
        const conns = await invoke<SshConnection[]>("ssh_list_connections");
        setSshConnections(conns);

        const ctx = getPasswordContext(tabId);
        if (ctx) {
          const match = conns.find(
            (c) =>
              c.host === ctx.host &&
              (ctx.user == null || c.user == null || c.user === ctx.user),
          );
          if (match) {
            setTarget({ type: "ssh", connectionId: match.id });
          }
        }
      } catch (e) {
        console.error("Failed to load SSH connections:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);
```

Replace with:
```tsx
  useEffect(() => {
    (async () => {
      try {
        const conns = await listSshConnections();
        setSshConnections(conns);

        const ctx = getPasswordContext(tabId);
        const match = matchConnectionForTab(conns, ctx ? { host: ctx.host, user: ctx.user } : null);
        if (match) {
          setTarget({ type: "ssh", connectionId: match.id });
        }
      } catch (e) {
        console.error("Failed to load SSH connections:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);
```

Find (`resolveSshPassword`, ~lines 242-262):
```tsx
  const resolveSshPassword = useCallback(
    async (connectionId: string): Promise<string | undefined> => {
      const ctx = getPasswordContext(tabId);
      const conn = sshConnections.find((c) => c.id === connectionId);
      if (ctx && conn && ctx.host === conn.host) {
        return ctx.password;
      }
      if (conn?.password_encrypted) {
        try {
          const pwd = await invoke<string | null>("ssh_decrypt_password", {
            encrypted: conn.password_encrypted,
          });
          if (pwd) return pwd;
        } catch (e) {
          console.warn("Could not decrypt saved password:", e);
        }
      }
      return undefined;
    },
    [tabId, sshConnections, getPasswordContext],
  );
```

Replace with:
```tsx
  const resolveSshPassword = useCallback(
    (connectionId: string): Promise<string | undefined> =>
      resolveSshPasswordHelper(tabId, connectionId, sshConnections, getPasswordContext),
    [tabId, sshConnections, getPasswordContext],
  );
```

Every other use of `resolveSshPassword` in the file (e.g. `handleRunPreCheck`) stays unchanged — it's still called the same way, just now delegating to the shared helper.

- [ ] **Step 6: Run the full suite to confirm no behavior change**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/ChangeWindowPanel.test.tsx`
Expected: PASS, same pass count as before this task (this file's tests don't cover the extracted logic directly per the design's Testing section, but they exercise `ChangeWindowPanel` end-to-end and must still pass unchanged).

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "ChangeWindowPanel\.tsx|resolveTabConnection"`
Expected: no output.

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run`
Expected: all tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/lib/resolveTabConnection.ts src/lib/resolveTabConnection.test.ts src/components/ChangeWindowPanel.tsx
git commit -m "refactor(ssh): extract tab-to-connection matching + password resolution into a shared helper"
```

---

## Task 4: Build `RunStructuredModal.tsx`

**Files:**
- Create: `src/components/RunStructuredModal.tsx`
- Create: `src/components/RunStructuredModal.css`
- Test: `src/components/RunStructuredModal.test.tsx`

**Interfaces:**
- Consumes: `runAndParseOverSsh(tabId, connectionId, command, vendor, platform, password?): Promise<string>` (`src/lib/structured.ts:45-61`, unchanged). `listSshConnections`, `matchConnectionForTab`, `resolveSshPassword`, `type SshConnection` (Task 3). `useTabs` (`src/state/tabsStore.ts`, unchanged) for reading/writing a tab's vendor/platform via `setTabVendor`. `useSshPasswordStore`'s `getPasswordContext` (unchanged). `PasswordPromptModal` (`src/components/PasswordPromptModal.tsx`, unchanged, props `{isOpen, connectionName, onSubmit, onCancel}`). `StructuredTab` (`src/components/StructuredTab.tsx`, props `{blockId}` minimum). `StructuredDiff` (`src/components/StructuredDiff.tsx`, props `{blockId, tabId, command}`).
- Produces: `RunStructuredModal({ tabId, initialCommand, onClose }: { tabId: string; initialCommand: string; onClose: () => void })` — a React component, consumed by Task 5's `Pane.tsx` wiring.

The same `DEVICE_TYPES` list from `ChangeWindowPanel.tsx:47-59` is needed here for the device-type picker. Rather than importing it from `ChangeWindowPanel.tsx` (which would create an odd cross-dependency between an unrelated panel and this modal), this task duplicates the small constant — 5 entries, unlikely to change independently of the sidecar parser's supported vendor list, and duplicating a 10-line constant is preferable to introducing a shared-constants module for one value at this stage (YAGNI; extract later if a third consumer appears).

- [ ] **Step 1: Write the failing test — full happy path (auto-resolved connection + remembered device type)**

Create `src/components/RunStructuredModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const runAndParseOverSshMock = vi.fn();
vi.mock('../lib/structured', () => ({
  runAndParseOverSsh: (...args: unknown[]) => runAndParseOverSshMock(...args),
}));

const listSshConnectionsMock = vi.fn();
vi.mock('../lib/resolveTabConnection', () => ({
  listSshConnections: () => listSshConnectionsMock(),
  matchConnectionForTab: (
    conns: Array<{ id: string; host: string; user: string | null }>,
    ctx: { host: string; user: string | null } | null,
  ) => {
    if (!ctx) return null;
    return conns.find((c) => c.host === ctx.host) ?? null;
  },
  resolveSshPassword: vi.fn(async () => 'resolved-password'),
}));

const getPasswordContextMock = vi.fn();
vi.mock('../state/sshPasswordStore', () => ({
  useSshPasswordStore: (selector: (s: unknown) => unknown) =>
    selector({ getPasswordContext: getPasswordContextMock }),
}));

const setTabVendorMock = vi.fn();
vi.mock('../state/tabsStore', () => ({
  useTabs: (selector: (s: unknown) => unknown) =>
    selector({
      tabs: [{ id: 'tab-1', vendor: 'cisco', platform: 'iosxe' }],
      setTabVendor: setTabVendorMock,
    }),
}));

vi.mock('./StructuredTab', () => ({
  StructuredTab: ({ blockId }: { blockId: string }) => <div data-testid="structured-tab">{blockId}</div>,
}));
vi.mock('./StructuredDiff', () => ({
  StructuredDiff: ({ blockId }: { blockId: string }) => <div data-testid="structured-diff">{blockId}</div>,
}));
vi.mock('./PasswordPromptModal', () => ({
  PasswordPromptModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="password-modal" /> : null),
}));

import { RunStructuredModal } from './RunStructuredModal';

beforeEach(() => {
  runAndParseOverSshMock.mockReset();
  listSshConnectionsMock.mockReset();
  getPasswordContextMock.mockReset();
  setTabVendorMock.mockReset();
});

describe('RunStructuredModal', () => {
  it('auto-resolves connection + device type, runs the command, and shows the result tabs', async () => {
    listSshConnectionsMock.mockResolvedValue([
      { id: 'conn-1', name: 'Switch 1', host: '10.0.0.1', user: 'admin', port: 22, identity_file: null, password_encrypted: null, created_at: 0, last_used_at: null },
    ]);
    getPasswordContextMock.mockReturnValue({ host: '10.0.0.1', user: 'admin', password: 'ctx-pw' });
    runAndParseOverSshMock.mockResolvedValue('ssh-adhoc-block-1');

    const onClose = vi.fn();
    const { getByText } = render(
      <RunStructuredModal tabId="tab-1" initialCommand="show ip interface brief" onClose={onClose} />,
    );

    await waitFor(() => expect(listSshConnectionsMock).toHaveBeenCalled());

    fireEvent.click(getByText(/^Run$/));

    await waitFor(() =>
      expect(runAndParseOverSshMock).toHaveBeenCalledWith(
        'tab-1',
        'conn-1',
        'show ip interface brief',
        'cisco',
        'iosxe',
        'resolved-password',
      ),
    );

    await waitFor(() => expect(getByText(/ssh-adhoc-block-1/)).toBeTruthy());
  });

  it('surfaces an SSH exec error inline instead of throwing', async () => {
    listSshConnectionsMock.mockResolvedValue([
      { id: 'conn-1', name: 'Switch 1', host: '10.0.0.1', user: 'admin', port: 22, identity_file: null, password_encrypted: null, created_at: 0, last_used_at: null },
    ]);
    getPasswordContextMock.mockReturnValue({ host: '10.0.0.1', user: 'admin', password: 'ctx-pw' });
    runAndParseOverSshMock.mockRejectedValue(new Error('ssh: connection timed out'));

    const { getByText } = render(
      <RunStructuredModal tabId="tab-1" initialCommand="show version" onClose={vi.fn()} />,
    );

    await waitFor(() => expect(listSshConnectionsMock).toHaveBeenCalled());
    fireEvent.click(getByText(/^Run$/));

    await waitFor(() => expect(getByText(/connection timed out/)).toBeTruthy());
    expect(getByText(/Retry/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/RunStructuredModal.test.tsx`
Expected: FAIL — `./RunStructuredModal` module does not exist yet.

- [ ] **Step 3: Create `src/components/RunStructuredModal.css`**

```css
.run-structured-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10001;
}

.run-structured-modal {
  background: #1a1d23;
  border: 1px solid #262a33;
  border-radius: 8px;
  width: 640px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
  padding: 20px;
  color: #e6e1cf;
}

.run-structured-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.run-structured-field {
  margin-bottom: 12px;
}

.run-structured-field label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: #6c7380;
}

.run-structured-field input,
.run-structured-field select {
  width: 100%;
  padding: 8px;
  background: #0f1114;
  border: 1px solid #262a33;
  border-radius: 4px;
  color: #e6e1cf;
  font-size: 13px;
}

.run-structured-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.run-structured-error {
  background: #3a1f1f;
  border: 1px solid #c0392b;
  border-radius: 4px;
  padding: 10px 12px;
  color: #f08080;
  margin-bottom: 12px;
  font-size: 13px;
}

.run-structured-close-btn {
  background: transparent;
  border: none;
  color: #6c7380;
  font-size: 18px;
  cursor: pointer;
}
```

- [ ] **Step 4: Create `src/components/RunStructuredModal.tsx`**

```tsx
import { useState, useEffect, useCallback } from "react";
import { runAndParseOverSsh } from "../lib/structured";
import {
  listSshConnections,
  matchConnectionForTab,
  resolveSshPassword,
  type SshConnection,
} from "../lib/resolveTabConnection";
import { useSshPasswordStore } from "../state/sshPasswordStore";
import { useTabs } from "../state/tabsStore";
import type { Tab } from "../lib/types";
import { PasswordPromptModal } from "./PasswordPromptModal";
import { StructuredTab } from "./StructuredTab";
import { StructuredDiff } from "./StructuredDiff";
import "./RunStructuredModal.css";

/**
 * Device types the sidecar parser supports. Duplicated from
 * ChangeWindowPanel.tsx's DEVICE_TYPES (5 entries) rather than shared, since
 * introducing a shared-constants module for one small list is unwarranted
 * until a third consumer needs it. `vendor` is typed against `Tab["vendor"]`
 * (not a bare `string`) so `setTabVendor` below needs no cast.
 */
const DEVICE_TYPES: { label: string; vendor: NonNullable<Tab["vendor"]>; platform: string }[] = [
  { label: "Cisco IOS-XE", vendor: "cisco", platform: "iosxe" },
  { label: "Cisco IOS", vendor: "cisco", platform: "ios" },
  { label: "Cisco NX-OS", vendor: "cisco", platform: "nxos" },
  { label: "Juniper Junos", vendor: "juniper", platform: "junos" },
  { label: "Arista EOS", vendor: "arista", platform: "eos" },
];

type Stage = "input" | "running" | "result" | "error";

interface RunStructuredModalProps {
  tabId: string;
  initialCommand: string;
  onClose: () => void;
}

export function RunStructuredModal({ tabId, initialCommand, onClose }: RunStructuredModalProps) {
  const [command, setCommand] = useState(initialCommand);
  const [stage, setStage] = useState<Stage>("input");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [blockId, setBlockId] = useState<string | null>(null);

  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);

  const getPasswordContext = useSshPasswordStore((s) => s.getPasswordContext);
  const tabs = useTabs((s) => s.tabs);
  const setTabVendor = useTabs((s) => s.setTabVendor);

  const tab = tabs.find((t) => t.id === tabId);
  const resolvedDeviceIdx = DEVICE_TYPES.findIndex(
    (d) => d.vendor === tab?.vendor && d.platform === tab?.platform,
  );
  const [deviceIdx, setDeviceIdx] = useState(resolvedDeviceIdx >= 0 ? resolvedDeviceIdx : 0);
  const device = DEVICE_TYPES[deviceIdx] ?? DEVICE_TYPES[0];

  // Load saved connections and try to auto-resolve one from the tab's live
  // SSH session, same pattern as ChangeWindowPanel.
  useEffect(() => {
    (async () => {
      try {
        const conns = await listSshConnections();
        setConnections(conns);
        const ctx = getPasswordContext(tabId);
        const match = matchConnectionForTab(conns, ctx ? { host: ctx.host, user: ctx.user } : null);
        if (match) setConnectionId(match.id);
      } catch (e) {
        console.error("Failed to load SSH connections:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const runWithPassword = useCallback(
    async (password: string | undefined) => {
      if (!connectionId) return;
      setStage("running");
      setErrorMsg(null);
      try {
        const newBlockId = await runAndParseOverSsh(
          tabId,
          connectionId,
          command,
          device.vendor,
          device.platform,
          password,
        );
        setBlockId(newBlockId);
        setStage("result");
      } catch (e) {
        setErrorMsg(String(e));
        setStage("error");
      }
    },
    [tabId, connectionId, command, device],
  );

  const handleRun = useCallback(async () => {
    if (!connectionId || !command.trim()) return;
    if (resolvedDeviceIdx < 0) {
      setTabVendor(tabId, device.vendor, device.platform);
    }
    const pwd = await resolveSshPassword(tabId, connectionId, connections, getPasswordContext);
    if (pwd === undefined) {
      setPasswordPromptOpen(true);
      return;
    }
    await runWithPassword(pwd);
  }, [connectionId, command, resolvedDeviceIdx, device, tabId, setTabVendor, connections, getPasswordContext, runWithPassword]);

  const handlePasswordSubmit = useCallback(
    (password: string) => {
      setPasswordPromptOpen(false);
      void runWithPassword(password);
    },
    [runWithPassword],
  );

  return (
    <div className="run-structured-overlay" onClick={onClose}>
      <div className="run-structured-modal" onClick={(e) => e.stopPropagation()}>
        <div className="run-structured-header">
          <h3>Run as Structured...</h3>
          <button className="run-structured-close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {(stage === "input" || stage === "error") && (
          <>
            {errorMsg && (
              <div className="run-structured-error" role="alert">
                {errorMsg}
              </div>
            )}
            <div className="run-structured-field">
              <label htmlFor="rsm-command">Command</label>
              <input
                id="rsm-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="show ip interface brief"
                autoFocus
              />
            </div>
            <div className="run-structured-field">
              <label htmlFor="rsm-connection">SSH connection</label>
              <select
                id="rsm-connection"
                value={connectionId ?? ""}
                onChange={(e) => setConnectionId(e.target.value || null)}
              >
                <option value="" disabled>
                  Select a saved connection…
                </option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.user ? `${c.user}@` : ""}{c.host})
                  </option>
                ))}
              </select>
            </div>
            <div className="run-structured-field">
              <label htmlFor="rsm-device">Device type</label>
              <select
                id="rsm-device"
                value={deviceIdx}
                onChange={(e) => setDeviceIdx(Number(e.target.value))}
              >
                {DEVICE_TYPES.map((d, i) => (
                  <option key={`${d.vendor}-${d.platform}`} value={i}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="run-structured-actions">
              <button onClick={onClose}>Cancel</button>
              <button onClick={handleRun} disabled={!connectionId || !command.trim()}>
                {stage === "error" ? "Retry" : "Run"}
              </button>
            </div>
          </>
        )}

        {stage === "running" && <p>Running &ldquo;{command}&rdquo;…</p>}

        {stage === "result" && blockId && (
          <>
            <StructuredTab blockId={blockId} />
            <StructuredDiff blockId={blockId} tabId={tabId} command={command} />
          </>
        )}

        <PasswordPromptModal
          isOpen={passwordPromptOpen}
          connectionName={connections.find((c) => c.id === connectionId)?.name ?? "SSH connection"}
          onSubmit={handlePasswordSubmit}
          onCancel={() => setPasswordPromptOpen(false)}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/RunStructuredModal.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 6: Run TypeScript check**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "RunStructuredModal\.tsx"`
Expected: no output.

- [ ] **Step 7: Run the full suite once**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run`
Expected: all tests pass, no regressions.

- [ ] **Step 8: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/components/RunStructuredModal.tsx src/components/RunStructuredModal.css src/components/RunStructuredModal.test.tsx
git commit -m "feat(structured): add RunStructuredModal wiring the SSH-direct structured-parse path"
```

---

## Task 5: Wire "Run as Structured..." into Pane's context menu

**Files:**
- Modify: `src/components/Pane.tsx`
- Test: `src/components/Pane.test.tsx`

**Interfaces:**
- Consumes: `RunStructuredModal` (Task 4). `terminalRegistry.getSelection(terminalId)` (Task 1, already used by `handleContextMenu` from Task 2).

- [ ] **Step 1: Write the failing test**

Add to `src/components/Pane.test.tsx`:

```tsx
describe('Pane "Run as Structured..." menu item', () => {
  it('opens RunStructuredModal pre-filled with the first line of the selection, and closes it on modal close', async () => {
    vi.resetModules();
    vi.doMock('./Terminal', () => ({
      Terminal: () => null,
    }));
    vi.doMock('../lib/terminalRegistry', () => ({
      getSelection: vi.fn(() => 'show ip interface brief\nGigabitEthernet1  up  up'),
    }));
    vi.doMock('../state/agentsStore', () => ({
      useAgentsStore: (selector: (s: unknown) => unknown) => selector({ agents: [] }),
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
    let capturedInitialCommand: string | undefined;
    let capturedOnClose: (() => void) | undefined;
    vi.doMock('./RunStructuredModal', () => ({
      RunStructuredModal: (props: { initialCommand: string; onClose: () => void }) => {
        capturedInitialCommand = props.initialCommand;
        capturedOnClose = props.onClose;
        return <div data-testid="run-structured-modal" />;
      },
    }));

    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const { getByText, queryByTestId, container } = rtl.render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    const paneEl = container.querySelector('[data-pane-id="pane-abc"]')!;
    rtl.fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });
    rtl.fireEvent.click(getByText(/Run as Structured/));

    expect(queryByTestId('run-structured-modal')).toBeTruthy();
    expect(capturedInitialCommand).toBe('show ip interface brief');

    capturedOnClose?.();
    await rtl.waitFor(() => expect(queryByTestId('run-structured-modal')).toBeNull());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx -t "Run as Structured"`
Expected: FAIL — no "Run as Structured" menu item exists yet.

- [ ] **Step 3: Add the menu item and modal wiring to `Pane.tsx`**

Add the import at the top of `src/components/Pane.tsx`:

```tsx
import { RunStructuredModal } from './RunStructuredModal';
```

Add new state, alongside `contextMenu`'s declaration:

```tsx
  const [runStructuredOpen, setRunStructuredOpen] = useState(false);
```

Add a handler, alongside `handleIngestTopology`:

```tsx
  const handleOpenRunStructured = () => {
    setRunStructuredOpen(true);
    setContextMenu(null);
  };
```

"Run as Structured..." must be available even without a selection (the modal has its own command input field), unlike Ask AI / Ask Agent / Ingest Topology which are all gated inside Task 2's `{contextMenu.selection && contextMenu.selection.trim() && (...)}` block. So this new button goes in the **always-rendered** wrapper that already holds Copy/Paste, not inside that selection-gated block.

In the context-menu JSX from Task 2, find the always-rendered wrapper div (the one holding Copy and Paste):

```tsx
          <div style={{ paddingTop: contextMenu.selection && contextMenu.selection.trim() ? '4px' : '0' }}>
            {contextMenu.selection && contextMenu.selection.trim() && (
              <button
                onClick={handleCopy}
                style={menuButtonStyle}
                onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
                onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                📋 Copy
              </button>
            )}
            <button
              onClick={handlePaste}
              style={menuButtonStyle}
              onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              📄 Paste
            </button>
          </div>
```

Replace with (adds the new button before Copy, inside the same always-rendered wrapper, with its own separator):

```tsx
          <div style={{ paddingTop: contextMenu.selection && contextMenu.selection.trim() ? '4px' : '0' }}>
            <button
              onClick={handleOpenRunStructured}
              style={menuButtonStyle}
              onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
              title="Run this command over SSH and view it as structured/diffable data"
            >
              🧩 Run as Structured...
            </button>
            <div style={{ borderTop: '1px solid #262a33', margin: '4px 0' }} />
            {contextMenu.selection && contextMenu.selection.trim() && (
              <button
                onClick={handleCopy}
                style={menuButtonStyle}
                onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
                onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                📋 Copy
              </button>
            )}
            <button
              onClick={handlePaste}
              style={menuButtonStyle}
              onMouseOver={(e) => (e.currentTarget.style.background = '#262a33')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              📄 Paste
            </button>
          </div>
```

This item now shows on every right-click regardless of selection, using the first line of any selection as a pre-fill if present, empty otherwise. Extract that first line in the handler:

```tsx
  const handleOpenRunStructured = () => {
    const firstLine = (contextMenu?.selection ?? '').split('\n')[0]?.trim() ?? '';
    setPendingStructuredCommand(firstLine);
    setRunStructuredOpen(true);
    setContextMenu(null);
  };
```

Add the accompanying state next to `runStructuredOpen`:

```tsx
  const [pendingStructuredCommand, setPendingStructuredCommand] = useState('');
```

Finally, render the modal at the end of the component's JSX, as a sibling to the context-menu block (after its closing `)}`):

```tsx
      {runStructuredOpen && (
        <RunStructuredModal
          tabId={resolvedPtyTabId ?? terminalId}
          initialCommand={pendingStructuredCommand}
          onClose={() => setRunStructuredOpen(false)}
        />
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/Pane.test.tsx`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run TypeScript check**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Pane\.tsx"`
Expected: no output.

- [ ] **Step 6: Run the full suite once**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run`
Expected: all tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/components/Pane.tsx src/components/Pane.test.tsx
git commit -m "feat(structured): wire 'Run as Structured...' into the terminal context menu"
```

---

## Task 6: Live verification in the running app

**Files:** none (manual verification only — no code changes)

**Interfaces:** none.

This task has no automated test; it is the honesty check required before claiming the feature works, per established project practice (verify against real devices, don't claim success without proof).

- [ ] **Step 1: Rebuild and start the dev app**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && bun run tauri dev` (background, wait for the window to open — no Rust changes in this plan, so this should be a fast rebuild).

- [ ] **Step 2: Verify the context menu is back for ALL existing items, not just the new one**

Right-click inside any active terminal pane. Confirm the menu appears at the cursor position. If there is a text selection, confirm you see: Ask AI about selection, Ask agent (if any agents configured), Ingest Topology (only if the selection contains a `show cdp/lldp neighbor`-style command), then the new "Run as Structured..." item, then Copy, then Paste. Confirm clicking elsewhere closes the menu.

- [ ] **Step 3: Verify "Run as Structured..." with no active SSH session (should show the picker)**

In a plain local-shell tab (not SSH'd anywhere), right-click, select "Run as Structured...". Confirm the modal opens with an empty/no-match connection dropdown (since there's nothing to auto-resolve) and the device-type dropdown defaulting to "Cisco IOS-XE". Pick a saved connection if you have one, type a command, click Run.

- [ ] **Step 4: Verify the core scenario — SSH'd into a real device**

SSH into a real Cisco/network device via a saved connection (so `sshPasswordStore` records the host/user context). Right-click in that tab, select "Run as Structured...". Confirm the connection dropdown auto-selects the matching saved connection, and (on first use for this tab) the device-type dropdown needs a manual pick. Select the correct device type, type `show ip interface brief` (or another supported `show` command), click Run.

Expected: the modal transitions to "Running...", then shows the Structured tab with parsed table data and the Diff tab (likely empty/no-comparison on the first run, since no prior snapshot exists for this command+tab yet — that's correct).

- [ ] **Step 5: Verify device-type persistence + Diff accumulation**

Without closing the app, right-click the same tab again, run the exact same command again via "Run as Structured...". Confirm: (a) the device-type dropdown is now pre-filled correctly without needing a re-pick, and (b) the Diff tab now shows a real comparison between the two runs (even if the diff is empty because nothing changed on the device — the point is the mechanism works, not that there's a change to show).

- [ ] **Step 6: Verify the error path**

Run a command that is not structured-parseable for the selected vendor/platform (e.g. a nonsense string, or a `show` command outside the sidecar parser's template coverage). Confirm the modal surfaces a clear error message (not a silent failure or a crash) and offers "Retry".

- [ ] **Step 7: Confirm `ChangeWindowPanel` still works unchanged**

Open the Change Verification panel (however it's normally triggered in this app — check the Audit menu) on a tab with a saved SSH connection, and confirm its own connection auto-resolution and device-type dropdown still behave exactly as before this plan's Task 3 extraction (no visible change is the correct outcome here).

- [ ] **Step 8: Report results honestly**

If any step fails, do not report the feature as working — document exactly what broke and return to the relevant task to fix the root cause before re-attempting live verification. If all steps pass, this task is complete with no code changes to commit.

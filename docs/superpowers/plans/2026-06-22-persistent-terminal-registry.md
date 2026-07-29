# Persistent Terminal Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop split-pane / tab-switch from destroying terminal content by moving xterm instances + PTYs into an out-of-React registry keyed by `terminalId`, displayed via imperative DOM reparenting into per-pane mount slots.

**Architecture:** A module-level `terminalRegistry` (`src/lib/terminalRegistry.ts`) owns each live session (xterm + PTY + event wiring), created once per `terminalId`. A thin `TerminalSlot` React component reparents the persistent xterm element into the current pane and detaches (not disposes) on unmount. Dispose happens only on explicit pane/tab close. The whole path is gated behind `ENABLE_TERMINAL_REGISTRY` with the legacy `usePty` path retained for one-line rollback.

**Tech Stack:** React + TypeScript, xterm.js (loaded from CDN via `window.Terminal`/`window.FitAddon`), Zustand stores (accessed via `getState()`), Tauri `ptySpawn`/`ptyWrite`/`ptyResize`/`ptyKill`, vitest.

## Global Constraints

- **Feature flag:** `export const ENABLE_TERMINAL_REGISTRY = false;` — default false on merge. Flipping to `true` is its own commit (Task 5). Mirrors the existing `ENABLE_LOCAL_ECHO` flag in `src/hooks/usePty.ts:31`.
- **Do NOT modify or delete the legacy `usePty` hook.** It remains the flag-off fallback. The registry is a parallel implementation; event-handling logic is COPIED from `usePty` and adapted to `getState()`.
- **Dispose only on explicit close / shell exit** — never on React unmount. Slot unmount = `detach` (keep alive).
- **Store writes use `useStore.getState().action(...)`** — never React subscriptions inside the registry. Verified-stable actions: `useTabs.getState().{setCwd,addTab,removeTab}`, `useIacStateStore.getState().setTerminalCwd`, `useBlocksStore.getState().{addBlock,completeBlock}`, `useSshPasswordStore.getState().{getPasswordContext,clearPasswordContext}`.
- **No backend changes, no SQLite migration.**
- **xterm from CDN:** resolve constructors at runtime via `window.Terminal`, `window.FitAddon?.FitAddon || window.FitAddon`, etc. (same as `usePty.ts:84-87`). Guard for not-loaded-yet.
- **Re-fit on attach:** after reparenting, call `fitAddon.fit()` then `xterm.refresh(0, xterm.rows - 1)`.
- **TDD, frequent commits.** `tsc --noEmit` must stay at the 43-error baseline. Full vitest (2412) stays green.

---

## File Structure

- Create: `src/lib/terminalRegistry.ts` — the registry: `getOrCreate`, `attach`, `detach`, `dispose`, internal session wiring. No React.
- Create: `src/lib/terminalRegistry.test.ts` — lifecycle unit tests (mocked xterm + tauri).
- Create: `src/components/TerminalSlot.tsx` — thin component: get-or-create + attach on mount, detach on unmount.
- Modify: `src/components/Terminal.tsx` — branch on `ENABLE_TERMINAL_REGISTRY`; pass `terminalId` through. Legacy `usePty` branch unchanged.
- Modify: `src/components/Pane.tsx` — pass `terminalId` to `Terminal` (already has it as a prop).
- Modify: `src/hooks/usePty.ts` — add the `ENABLE_TERMINAL_REGISTRY` flag export ONLY (no logic change).
- Modify: `src/state/panesStore.ts` (`closePane`) and `src/components/Pane.tsx` / `src/components/TabBar.tsx` close paths — route dispose through the registry when the flag is on.

---

## Task 1: Add the feature flag (inert)

**Files:**
- Modify: `src/hooks/usePty.ts` (near line 31, beside `ENABLE_LOCAL_ECHO`)

**Interfaces:**
- Produces: `export const ENABLE_TERMINAL_REGISTRY: boolean` — consumed by Tasks 2-5.

- [ ] **Step 1: Add the flag**

In `src/hooks/usePty.ts`, immediately after the `ENABLE_LOCAL_ECHO` line (~31):
```ts
// Phase: persistent terminal registry. When true, Terminal.tsx routes through
// the out-of-React terminalRegistry (xterm+PTY survive splits/tab-switches).
// When false, the legacy usePty path below runs unchanged. One-line rollback.
export const ENABLE_TERMINAL_REGISTRY = false;
```

- [ ] **Step 2: Verify build**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `43` (baseline unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePty.ts
git commit -m "feat(terminal): add ENABLE_TERMINAL_REGISTRY flag (inert, default false)

Gate for the persistent terminal registry. Legacy usePty path unchanged.

Part of persistent terminal registry (Task 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Registry module — lifecycle (create/attach/detach/dispose)

**Files:**
- Create: `src/lib/terminalRegistry.ts`
- Create: `src/lib/terminalRegistry.test.ts`

**Interfaces:**
- Consumes: `ptySpawn`, `ptyKill`, `ptyResize`, `ptyWrite` from `../lib/tauri`; `window.Terminal`/`window.FitAddon` (CDN xterm).
- Produces (used by Tasks 3-5):
  - `interface CreateOpts { shell: string; cwd: string; skipTabRegistration?: boolean }`
  - `interface TerminalEntry { xterm: any; fitAddon: any; el: HTMLDivElement; ptyTabId: string | null; disposed: boolean }`
  - `getOrCreate(terminalId: string, opts: CreateOpts): TerminalEntry`
  - `attach(terminalId: string, slot: HTMLDivElement): void`
  - `detach(terminalId: string): void`
  - `dispose(terminalId: string): void`
  - `has(terminalId: string): boolean` (test/debug helper)
  - `__resetForTest(): void` (clears the map; test-only)

This task implements ONLY lifecycle + DOM reparenting. The PTY event wiring (onData/onEvent/resize) is added in Task 3 — keep `getOrCreate` here minimal: create el + xterm + fitAddon, call a `wireSession(entry, terminalId, opts)` stub that Task 3 fills in, and `ptySpawn`.

- [ ] **Step 1: Write the failing lifecycle tests**

Create `src/lib/terminalRegistry.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tauri PTY calls.
const ptySpawn = vi.fn(async () => 'pty-1');
const ptyKill = vi.fn(async () => {});
vi.mock('./tauri', () => ({
  ptySpawn: (...a: unknown[]) => ptySpawn(...a),
  ptyKill: (...a: unknown[]) => ptyKill(...a),
  ptyResize: vi.fn(async () => {}),
  ptyWrite: vi.fn(async () => {}),
}));

// Minimal fake xterm + addons on window (CDN shape).
function installFakeXterm() {
  const made: any[] = [];
  (window as any).Terminal = class {
    cols = 80; rows = 24;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    open = vi.fn();
    refresh = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    write = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => '');
    constructor() { made.push(this); }
  };
  (window as any).FitAddon = { FitAddon: class { fit = vi.fn(); } };
  (window as any).WebLinksAddon = { WebLinksAddon: class {} };
  (window as any).ClipboardAddon = { ClipboardAddon: class {} };
  return made;
}

import * as reg from './terminalRegistry';

beforeEach(() => {
  reg.__resetForTest();
  ptySpawn.mockClear();
  ptyKill.mockClear();
  installFakeXterm();
});

const OPTS = { shell: '/bin/zsh', cwd: '/home' };

describe('terminalRegistry lifecycle', () => {
  it('getOrCreate spawns one PTY and reuses the entry on second call', () => {
    const a = reg.getOrCreate('t1', OPTS);
    const b = reg.getOrCreate('t1', OPTS);
    expect(a).toBe(b);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
  });

  it('attach appends the persistent el into the slot and fits', () => {
    const e = reg.getOrCreate('t1', OPTS);
    const slot = document.createElement('div');
    reg.attach('t1', slot);
    expect(slot.contains(e.el)).toBe(true);
    expect(e.fitAddon.fit).toHaveBeenCalled();
  });

  it('detach removes el from DOM but keeps the entry alive', () => {
    const e = reg.getOrCreate('t1', OPTS);
    const slot = document.createElement('div');
    reg.attach('t1', slot);
    reg.detach('t1');
    expect(slot.contains(e.el)).toBe(false);
    expect(reg.has('t1')).toBe(true);
  });

  it('attach -> detach -> attach reuses same xterm, no new PTY (split sim)', () => {
    const e1 = reg.getOrCreate('t1', OPTS);
    const slotA = document.createElement('div');
    const slotB = document.createElement('div');
    reg.attach('t1', slotA);
    reg.detach('t1');
    reg.attach('t1', slotB);
    const e2 = reg.getOrCreate('t1', OPTS);
    expect(e2.xterm).toBe(e1.xterm);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(slotB.contains(e1.el)).toBe(true);
  });

  it('dispose kills PTY, disposes xterm, removes entry; idempotent', () => {
    const e = reg.getOrCreate('t1', OPTS);
    reg.dispose('t1');
    expect(ptyKill).toHaveBeenCalledTimes(1);
    expect(e.xterm.dispose).toHaveBeenCalledTimes(1);
    expect(reg.has('t1')).toBe(false);
    reg.dispose('t1'); // no throw, no extra calls
    expect(ptyKill).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/lib/terminalRegistry.test.ts 2>&1 | tail -15`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement the registry lifecycle**

Create `src/lib/terminalRegistry.ts`:
```ts
import { ptySpawn, ptyKill, ptyResize, ptyWrite } from './tauri';
import type { PtyEvent } from '../hooks/usePty';

export interface CreateOpts {
  shell: string;
  cwd: string;
  skipTabRegistration?: boolean;
}

export interface TerminalEntry {
  xterm: any;
  fitAddon: any;
  el: HTMLDivElement;
  ptyTabId: string | null;
  disposed: boolean;
}

const registry = new Map<string, TerminalEntry>();

export function has(terminalId: string): boolean {
  return registry.has(terminalId);
}

export function getOrCreate(terminalId: string, opts: CreateOpts): TerminalEntry {
  const existing = registry.get(terminalId);
  if (existing) return existing;

  // Resolve CDN xterm constructors (same shape as usePty.ts:84-87).
  const XTerm = (window as any).Terminal;
  const FitAddonCtor = (window as any).FitAddon?.FitAddon || (window as any).FitAddon;
  const WebLinksCtor = (window as any).WebLinksAddon?.WebLinksAddon || (window as any).WebLinksAddon;
  const ClipboardCtor = (window as any).ClipboardAddon?.ClipboardAddon || (window as any).ClipboardAddon;
  if (!XTerm || !FitAddonCtor) {
    throw new Error('terminalRegistry: xterm not loaded from CDN yet');
  }

  const el = document.createElement('div');
  el.className = 'terminal-registry-surface';
  el.style.width = '100%';
  el.style.height = '100%';

  const xterm = new XTerm({
    convertEol: true,
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    theme: {
      background: '#0f1114',
      foreground: '#e6e1cf',
      cursor: '#5ccfe6',
      cursorAccent: '#000000',
    },
    rightClickSelectsWord: true,
    cursorBlink: true,
    cursorStyle: 'block',
    allowProposedApi: true,
  });
  const fitAddon = new FitAddonCtor();
  xterm.loadAddon(fitAddon);
  if (WebLinksCtor) xterm.loadAddon(new WebLinksCtor());
  if (ClipboardCtor) xterm.loadAddon(new ClipboardCtor());
  xterm.open(el);

  const entry: TerminalEntry = {
    xterm,
    fitAddon,
    el,
    ptyTabId: null,
    disposed: false,
  };
  registry.set(terminalId, entry);

  // Wire input/output/resize + spawn the PTY (Task 3 fills wireSession).
  wireSession(entry, terminalId, opts);

  return entry;
}

export function attach(terminalId: string, slot: HTMLDivElement): void {
  const entry = registry.get(terminalId);
  if (!entry || entry.disposed) return;
  slot.appendChild(entry.el);
  try {
    entry.fitAddon.fit();
    const rows = entry.xterm.rows ?? 24;
    entry.xterm.refresh(0, Math.max(0, rows - 1));
  } catch {
    /* fit can throw if the slot has zero size mid-layout; harmless */
  }
}

export function detach(terminalId: string): void {
  const entry = registry.get(terminalId);
  if (!entry) return;
  entry.el.remove(); // detach DOM node; KEEP the entry alive
}

export function dispose(terminalId: string): void {
  const entry = registry.get(terminalId);
  if (!entry) return;
  entry.disposed = true;
  if (entry.ptyTabId) {
    ptyKill(entry.ptyTabId).catch(() => {});
  }
  try {
    entry.xterm.dispose();
  } catch {
    /* already disposed */
  }
  entry.el.remove();
  registry.delete(terminalId);
}

// Placeholder; real wiring (onData/onEvent/resize + ptySpawn) lands in Task 3.
function wireSession(entry: TerminalEntry, _terminalId: string, _opts: CreateOpts): void {
  // Task 3 replaces this body. For now, spawn so lifecycle tests pass.
  ptySpawn({
    shell: _opts.shell,
    args: [],
    cwd: _opts.cwd,
    cols: entry.xterm.cols ?? 80,
    rows: entry.xterm.rows ?? 24,
    onEvent: (_e: PtyEvent) => {},
  }).then((id: string) => {
    entry.ptyTabId = id;
  });
  // expose ptyWrite/ptyResize for Task 3; referenced to avoid unused import.
  void ptyWrite;
  void ptyResize;
}

export function __resetForTest(): void {
  registry.clear();
}
```

NOTE on `PtyEvent` import: confirm it is exported from `src/hooks/usePty.ts` (it is used as a type there). If not exported, add `export` to its declaration in `usePty.ts` (type-only, no behavior change) — this is acceptable as it doesn't touch the hook's logic.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/lib/terminalRegistry.test.ts 2>&1 | tail -15`
Expected: PASS (5 tests).

- [ ] **Step 5: tsc**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `43`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/terminalRegistry.ts src/lib/terminalRegistry.test.ts src/hooks/usePty.ts
git commit -m "feat(terminal): registry lifecycle (getOrCreate/attach/detach/dispose)

Out-of-React Map<terminalId, entry>. attach reparents the persistent
xterm el into a slot + re-fits; detach keeps the session alive; dispose
kills PTY + xterm. Split-sim test proves attach->detach->attach reuses
the same xterm with no extra ptySpawn. Event wiring is a stub (Task 3).

Part of persistent terminal registry (Task 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Port the PTY event wiring into the registry

**Files:**
- Modify: `src/lib/terminalRegistry.ts` (replace `wireSession` body)
- Modify: `src/lib/terminalRegistry.test.ts` (add input/output wiring tests)

**Interfaces:**
- Consumes: `useTabs`, `useIacStateStore`, `useBlocksStore`, `useSshPasswordStore` (via `.getState()`); the parser/event shapes used by `usePty`.
- Produces: a fully-wired session — same runtime behavior as `usePty`'s mount effect, minus React.

**This is the порт-heavy task. Read `src/hooks/usePty.ts` lines 70-370 IN FULL first.** The `wireSession` body must reproduce, against `entry.xterm` and the spawned `ptyTabId`:
1. `attachCustomKeyEventHandler` for Ctrl+C copy / Ctrl+V paste (usePty.ts:133-169).
2. The `onEvent` switch: `output` (write bytes, SSH-exit detection, password autofill), `command_start` (`useBlocksStore.getState().addBlock`), `command_end` (`completeBlock`), `cwd` (`useTabs.getState().setCwd` + `useIacStateStore.getState().setTerminalCwd`). (usePty.ts:171-288)
3. `ptySpawn({...onEvent})` then on resolve: store `ptyTabId`; if `!skipTabRegistration`, `useTabs.getState().addTab({...})`; wire `xterm.onData` → `ptyWrite` (usePty.ts:290-345).
4. A `ResizeObserver` on `entry.el` (or reuse fit-on-attach) → `ptyResize`. (usePty.ts:351)
5. On `exit` event → `useTabs.getState().removeTab(ptyTabId)` AND `dispose(terminalId)` (shell-exit is an explicit-dispose trigger per the spec).

Replace every `useXStore(...)` subscription with `useXStore.getState()`. Replace component refs (`lastOutputRef` etc.) with closure-local `let` variables inside `wireSession`.

- [ ] **Step 1: Write wiring tests**

Add to `src/lib/terminalRegistry.test.ts`:
```ts
describe('terminalRegistry session wiring', () => {
  it('writes PTY output bytes to the xterm', async () => {
    const e = reg.getOrCreate('t1', OPTS);
    await Promise.resolve(); // let ptySpawn resolve
    // grab the onEvent passed to ptySpawn
    const onEvent = ptySpawn.mock.calls[0][0].onEvent as (ev: any) => void;
    onEvent({ type: 'output', bytes: Array.from(new TextEncoder().encode('hello')) });
    expect(e.xterm.write).toHaveBeenCalled();
  });

  it('exit event disposes the terminal', async () => {
    reg.getOrCreate('t1', OPTS);
    await Promise.resolve();
    const onEvent = ptySpawn.mock.calls[0][0].onEvent as (ev: any) => void;
    onEvent({ type: 'exit' });
    expect(reg.has('t1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/terminalRegistry.test.ts 2>&1 | tail -15`
Expected: FAIL (stub onEvent is a no-op; `write` not called; exit doesn't dispose).

- [ ] **Step 3: Implement `wireSession`**

Replace the `wireSession` stub in `src/lib/terminalRegistry.ts` with the full port. Reference implementation = `src/hooks/usePty.ts:70-370`, adapted as described above. Skeleton (fill the `// ... port from usePty` regions with the real logic from those exact lines):
```ts
import { useTabs } from '../state/tabsStore';
import { useIacStateStore } from '../state/iacStateStore';
import { useBlocksStore } from '../state/blocksStore';
import { useSshPasswordStore } from '../state/sshPasswordStore';

function wireSession(entry: TerminalEntry, terminalId: string, opts: CreateOpts): void {
  const { xterm } = entry;
  let ptyTabId: string | null = null;
  let lastOutput = '';
  let inRemote = false;
  let passwordSent = false;
  let liveCwd = opts.cwd;
  let currentBlockId: string | null = null;

  // (1) Ctrl+C copy / Ctrl+V paste — port usePty.ts:133-169 (use ptyTabId).
  xterm.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
    // ... port from usePty.ts:133-169 ...
    return true;
  });

  const onEvent = (e: any /* PtyEvent */) => {
    if (entry.disposed) return;
    switch (e.type) {
      case 'output': {
        // ... port usePty.ts:177-250 (write bytes; SSH-exit detect; password
        //     autofill via useSshPasswordStore.getState()) ...
        xterm.write(new Uint8Array(e.bytes));
        break;
      }
      case 'command_start': {
        const blockId = useBlocksStore.getState().addBlock(ptyTabId!, e.cmd, liveCwd);
        currentBlockId = blockId;
        break;
      }
      case 'command_end': {
        // ... port usePty.ts:273 completeBlock(...) using currentBlockId ...
        useBlocksStore.getState().completeBlock(ptyTabId!, currentBlockId, e.exit_code);
        currentBlockId = null;
        break;
      }
      case 'cwd': {
        liveCwd = e.path;
        if (ptyTabId) {
          useIacStateStore.getState().setTerminalCwd(ptyTabId, e.path);
          useTabs.getState().setCwd(ptyTabId, e.path);
        }
        break;
      }
      case 'exit': {
        if (ptyTabId) useTabs.getState().removeTab(ptyTabId);
        dispose(terminalId); // shell exit = explicit dispose trigger
        break;
      }
    }
  };

  ptySpawn({
    shell: opts.shell,
    args: [],
    cwd: opts.cwd,
    cols: xterm.cols ?? 80,
    rows: xterm.rows ?? 24,
    onEvent,
  }).then((id: string) => {
    if (entry.disposed) return;
    ptyTabId = id;
    entry.ptyTabId = id;
    if (!opts.skipTabRegistration) {
      useTabs.getState().addTab({
        id,
        title: opts.shell.split('/').pop() ?? opts.shell,
        shell_cmd: opts.shell,
        cwd: opts.cwd,
        created_at: Date.now() / 1000,
        tab_type: 'terminal',
      });
    }
    xterm.onData((data: string) => {
      const bytes = new TextEncoder().encode(data);
      ptyWrite(id, bytes).catch(() => {});
    });
  });

  // (4) keep PTY rows/cols in sync when the surface resizes.
  const ro = new ResizeObserver(() => {
    try {
      entry.fitAddon.fit();
      if (ptyTabId) ptyResize(ptyTabId, xterm.cols, xterm.rows).catch(() => {});
    } catch { /* zero-size mid-layout */ }
  });
  ro.observe(entry.el);
  // mark unused-suppression vars referenced
  void lastOutput; void inRemote; void passwordSent;
}
```

IMPORTANT: the `void lastOutput …` line is a placeholder — once you port the real output/password logic those variables ARE used, so delete that line. Do NOT ship dead suppressions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/terminalRegistry.test.ts 2>&1 | tail -15`
Expected: PASS (7 tests).

- [ ] **Step 5: tsc**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `43`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/terminalRegistry.ts src/lib/terminalRegistry.test.ts
git commit -m "feat(terminal): port PTY event wiring into the registry

wireSession reproduces usePty's input/output/block/cwd/password/resize
wiring against the registry-owned xterm, using store getState() actions
(no React). Shell exit disposes the terminal. Output + exit covered by
unit tests.

Part of persistent terminal registry (Task 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: TerminalSlot component + Terminal.tsx branch + thread terminalId

**Files:**
- Create: `src/components/TerminalSlot.tsx`
- Modify: `src/components/Terminal.tsx` (add `terminalId` prop + flag branch)
- Modify: `src/components/Pane.tsx` (pass `terminalId` to `Terminal`)

**Interfaces:**
- Consumes: `terminalRegistry.{getOrCreate,attach,detach}`; `ENABLE_TERMINAL_REGISTRY`.
- Produces: `<TerminalSlot terminalId shell cwd skipTabRegistration onRegistered />`.

- [ ] **Step 1: Write the TerminalSlot test**

Create `src/components/TerminalSlot.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const getOrCreate = vi.fn(() => ({ ptyTabId: 'pty-1' }));
const attach = vi.fn();
const detach = vi.fn();
vi.mock('../lib/terminalRegistry', () => ({
  getOrCreate: (...a: unknown[]) => getOrCreate(...a),
  attach: (...a: unknown[]) => attach(...a),
  detach: (...a: unknown[]) => detach(...a),
}));

import { TerminalSlot } from './TerminalSlot';

beforeEach(() => { getOrCreate.mockClear(); attach.mockClear(); detach.mockClear(); });

describe('TerminalSlot', () => {
  it('creates + attaches on mount, detaches (not disposes) on unmount', () => {
    const onRegistered = vi.fn();
    const { unmount } = render(
      <TerminalSlot terminalId="t1" shell="/bin/zsh" cwd="/home" onRegistered={onRegistered} />,
    );
    expect(getOrCreate).toHaveBeenCalledWith('t1', expect.objectContaining({ shell: '/bin/zsh', cwd: '/home' }));
    expect(attach).toHaveBeenCalledWith('t1', expect.any(HTMLElement));
    expect(onRegistered).toHaveBeenCalledWith('pty-1');
    unmount();
    expect(detach).toHaveBeenCalledWith('t1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/TerminalSlot.test.tsx 2>&1 | tail -12`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TerminalSlot**

Create `src/components/TerminalSlot.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import * as terminalRegistry from '../lib/terminalRegistry';

type TerminalSlotProps = {
  terminalId: string;
  shell: string;
  cwd: string;
  skipTabRegistration?: boolean;
  onRegistered?: (ptyTabId: string) => void;
};

export function TerminalSlot({
  terminalId, shell, cwd, skipTabRegistration, onRegistered,
}: TerminalSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!slotRef.current) return;
    const entry = terminalRegistry.getOrCreate(terminalId, { shell, cwd, skipTabRegistration });
    terminalRegistry.attach(terminalId, slotRef.current);
    if (entry.ptyTabId) onRegistered?.(entry.ptyTabId);
    return () => {
      terminalRegistry.detach(terminalId); // detach — NOT dispose
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  return <div ref={slotRef} className="terminal-slot" style={{ width: '100%', height: '100%' }} />;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/TerminalSlot.test.tsx 2>&1 | tail -12`
Expected: PASS.

- [ ] **Step 5: Branch Terminal.tsx on the flag + add terminalId prop**

In `src/components/Terminal.tsx`:
- Add to imports: `import { ENABLE_TERMINAL_REGISTRY } from '../hooks/usePty';` and `import { TerminalSlot } from './TerminalSlot';`
- Add `terminalId?: string;` to `TerminalProps`.
- At the very top of the component body (before the `usePty` call), add:
```tsx
  if (ENABLE_TERMINAL_REGISTRY && terminalId) {
    return (
      <TerminalSlot
        terminalId={terminalId}
        shell={shell}
        cwd={cwd}
        skipTabRegistration={skipTabRegistration}
        onRegistered={onRegistered}
      />
    );
  }
```
Leave the entire existing legacy body (the `usePty(...)` call and JSX) untouched below this guard.

NOTE: calling hooks (`usePty`) only in the legacy branch is fine ONLY because the early `return` is before any hook runs. Place this guard BEFORE the first `useState`/`useRef`/`usePty` in the component. If the component calls hooks before this point, the guard must instead select inside the JSX (render `<TerminalSlot/>` vs legacy) without early-returning — verify hook order and choose the form that keeps hooks unconditional. (React rules of hooks.)

- [ ] **Step 6: Pass terminalId from Pane.tsx**

In `src/components/Pane.tsx`, the `<Terminal ... />` render (~line 116): add `terminalId={terminalId}` to its props (the component already receives `terminalId` as a prop).

- [ ] **Step 7: Build + full suite (flag still false → behavior unchanged)**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -c "error TS"
npx vitest run src/components/TerminalSlot.test.tsx src/lib/terminalRegistry.test.ts src/components/Pane.test.tsx 2>&1 | tail -8
```
Expected: tsc `43`; targeted tests pass. (Flag false ⇒ Terminal still uses usePty; no live change yet.)

- [ ] **Step 8: Commit**

```bash
git add src/components/TerminalSlot.tsx src/components/TerminalSlot.test.tsx src/components/Terminal.tsx src/components/Pane.tsx
git commit -m "feat(terminal): TerminalSlot + flag-gated Terminal branch + thread terminalId

TerminalSlot attaches the registry session on mount, detaches on unmount.
Terminal renders it when ENABLE_TERMINAL_REGISTRY && terminalId, else the
legacy usePty path. Pane passes its terminalId through. Flag still false.

Part of persistent terminal registry (Task 4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Dispose routing + flip the flag + live verification

**Files:**
- Modify: `src/components/Pane.tsx` (close path), `src/components/TabBar.tsx` (close path)
- Modify: `src/hooks/usePty.ts` (flip flag)

**Interfaces:**
- Consumes: `terminalRegistry.dispose`; `ENABLE_TERMINAL_REGISTRY`.

- [ ] **Step 1: Route close paths through dispose (flag-gated)**

In `src/components/Pane.tsx` `handleClosePane` (~line 86-92), replace the `ptyKill` call so that under the flag it disposes the registry entry instead (which kills the PTY + xterm):
```tsx
import { ENABLE_TERMINAL_REGISTRY } from '../hooks/usePty';
import * as terminalRegistry from '../lib/terminalRegistry';
// ...
  const handleClosePane = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (ENABLE_TERMINAL_REGISTRY) {
      terminalRegistry.dispose(terminalId);
    } else if (terminalId && !terminalId.startsWith('pending-')) {
      await ptyKill(terminalId).catch(() => {});
    }
    closePane(paneId);
  };
```
In `src/components/TabBar.tsx` (~line 181, the `ptyKill(t.id)` close path), apply the same guard: under the flag, `terminalRegistry.dispose(t.id)`; else the existing `ptyKill`.

- [ ] **Step 2: Build + suite**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -c "error TS"
npx vitest run 2>&1 | grep -E "Test Files|Tests "
```
Expected: tsc `43`; all vitest pass (flag still false).

- [ ] **Step 3: Commit the dispose routing (flag still false)**

```bash
git add src/components/Pane.tsx src/components/TabBar.tsx
git commit -m "feat(terminal): route pane/tab close through registry.dispose (flag-gated)

Under ENABLE_TERMINAL_REGISTRY, closing a pane/tab disposes the registry
session (kills PTY + xterm). Legacy ptyKill path unchanged when flag off.

Part of persistent terminal registry (Task 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Flip the flag**

In `src/hooks/usePty.ts`, change `export const ENABLE_TERMINAL_REGISTRY = false;` → `= true;`.
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → `43`.

```bash
git add src/hooks/usePty.ts
git commit -m "feat(terminal): enable persistent terminal registry (flip flag)

Part of persistent terminal registry (Task 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: LIVE verification (run the app, report ACTUAL results)**

1. `npm run tauri dev`.
2. **Split preserves content:** in a pane run `echo HELLO && sleep 8`; while running, split the pane (⌘D or the split control). Expected: original pane KEEPS `HELLO` + the running `sleep`; new pane is a fresh shell.
3. **No duplicate shells:** check the log (`~/Library/Application Support/ccie-terminal/logs/ccie-terminal.<date>.log`) — exactly ONE new `Event loop started for tab` after the split (the new pane only).
4. **Tab-switch preserves content:** type text in tab 1, open tab 2, return to tab 1 → text + scroll intact.
5. **Close kills:** close a pane/tab → log shows that PTY exits; no orphaned shells (`ps aux | grep -c "[z]sh -il"` doesn't grow).
6. **Activity indicators** (just-shipped) still render under the registry path: `sleep 8` → running border + badge.
7. **Resize:** split, then drag the divider → terminals re-fit (no clipped/garbled output).

- [ ] **Step 6: Write the verification report**

Create `.git/sdd/terminal-registry-verification.md` with the actual result of each Step-5 scenario (pass/fail + observed behavior + relevant log lines). If any fail, STOP — flip the flag back to `false` (commit) and report; do not merge a broken terminal core.

- [ ] **Step 7: Commit the report**

```bash
git add .git/sdd/terminal-registry-verification.md
git commit -m "docs(terminal): registry live-verification report

Part of persistent terminal registry (Task 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Out-of-React registry keyed by terminalId → Task 2 ✅
- Imperative reparent into mount slot + re-fit → Task 2 (`attach`) ✅
- Full session wiring via getState() → Task 3 ✅
- Detach (not dispose) on unmount → Task 2/4 ✅
- Dispose only on explicit close / shell exit → Task 3 (exit) + Task 5 (close paths) ✅
- TerminalSlot + Terminal flag branch + thread terminalId → Task 4 ✅
- Feature flag, legacy path retained → Task 1 (flag) + Task 4 (branch leaves usePty intact) ✅
- Unit tests (create/attach/detach/dispose/no-respawn/wiring) → Tasks 2,3 ✅
- Live verification (split/no-dup/tab-switch/close/indicators/resize) → Task 5 ✅
- No backend change / no migration → honored throughout ✅
- Rollback = flip flag → Task 5 Step 6 ✅

**Placeholder scan:** Task 3 is intentionally a guided port of real `usePty` logic (the code is too large to transcribe verbatim and must match the working source) — it names the EXACT line ranges to copy and flags the `void` suppressions as must-delete. This is a deliberate, bounded instruction, not a vague TODO. No other placeholders.

**Type consistency:** `getOrCreate/attach/detach/dispose/has/__resetForTest`, `TerminalEntry{xterm,fitAddon,el,ptyTabId,disposed}`, `CreateOpts{shell,cwd,skipTabRegistration}` consistent across Tasks 2-5. `TerminalSlot` props match its callsite in Terminal.tsx. `ENABLE_TERMINAL_REGISTRY` exported once (Task 1), consumed in Tasks 4-5.

**Risk note:** Task 3 is the highest-risk (porting ~250 lines of stateful wiring). Mitigations: the flag stays false through Task 4, so nothing is live until Task 5 Step 4; the legacy path is never modified; rollback is one line. Task 4 Step 5 flags the React-rules-of-hooks ordering constraint explicitly.

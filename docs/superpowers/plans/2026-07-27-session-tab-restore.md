# Session & Tab Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the existing (but uncalled) session-save/restore machinery so terminal tabs reopen on app restart with their scrollback replayed, and accidentally-closed tabs can be reopened via ⌘⇧T + a Recently Closed list.

**Architecture:** Almost entirely frontend wiring of already-registered Tauri commands (`restore_last_session`, `save_current_session`, `tab_scrollback`), plus ONE small backend change: `pty_spawn` gains an optional `preferred_tab_id` so a restored terminal reuses its saved id. Reusing the id is the linchpin — scrollback AND `pane_layouts` are keyed by the backend PTY `tab.id`, so reusing it makes replay and split-restore work with no re-keying. A restored/reopened terminal always gets a **fresh shell** (the old OS process is dead) with saved scrollback replayed above a `──── session restored ────` separator.

**Tech Stack:** Rust (Tauri commands, rusqlite), TypeScript/React, Zustand stores, xterm.js (CDN), vitest, cargo test.

## Global Constraints

- No new SQLite migration and no schema change. Next free migration remains V0084 (do not consume it).
- Object-oriented / module-encapsulated: each new store or helper is a single-responsibility module with a well-defined exported interface.
- Surgical changes only: touch only the files listed per task; do not refactor adjacent code, do not delete pre-existing dead code.
- Match existing style (Zustand `create` stores, `invoke<T>` wrappers in `tauri.ts`, `#[tauri::command]` fns in `commands/mod.rs`).
- Terminal registry is the active path (`ENABLE_TERMINAL_REGISTRY = true`). All terminal work goes through `src/lib/terminalRegistry.ts`, never `LegacyTerminal`.
- Special tabs (`tab_type` of `heartbeat`, `vault`, `topology`, `api`, `netconf`, etc.) are NOT restored as terminals — only `tab_type === "terminal"`.
- ⌘⇧T is the reopen-closed accelerator (confirmed free).
- Reuse saved tab ids on restore/reopen — never mint new ids for a tab that already has scrollback.
- Verify live before claiming done (per project rule): drive the running dev server; do not assert behavior blind.

---

## File Structure

**Backend (Rust):**
- Modify `src-tauri/src/session.rs` — add `create_tab_with_id()`; add save→restore round-trip test.
- Modify `src-tauri/src/commands/mod.rs` — `pty_spawn` accepts optional `preferred_tab_id`.
- Modify `src-tauri/src/lib.rs` — add "Recently Closed" submenu under View; emit `menu:reopen_closed_tab` and `menu:reopen_closed_pick`.

**Frontend (TypeScript/React):**
- Modify `src/lib/tauri.ts` — `ptySpawn` forwards `preferredTabId`.
- Create `src/state/closedTabsStore.ts` — in-memory stack of recently closed tabs.
- Modify `src/state/tabsStore.ts` — `addTab` idempotent on id; `removeTab` pushes closed terminal tabs to the stack.
- Modify `src/lib/terminalRegistry.ts` — `CreateOpts` gains `preferredTabId` + `replayBytes`; `wireSession` replays bytes and forwards the preferred id to `ptySpawn`.
- Create `src/lib/sessionRestore.ts` — pure `planRestore()` reducer + `restoreSessionOnBoot()` orchestration.
- Create `src/hooks/useSessionSave.ts` — debounced save on tab-store change + synchronous save on window close.
- Create `src/components/RecentlyClosedModal.tsx` — minimal list UI for View ▸ Recently Closed.
- Modify `src/App.tsx` — run restore on boot (gate the default slot), mount `useSessionSave`, register ⌘⇧T + menu listeners, render `RecentlyClosedModal`.

---

## Task 1: Backend — `pty_spawn` reuses a preferred tab id

**Files:**
- Modify: `src-tauri/src/session.rs` (add `create_tab_with_id` near `create_tab` at line ~45)
- Modify: `src-tauri/src/commands/mod.rs` (`pty_spawn` at line ~486)
- Test: `src-tauri/src/session.rs` (`#[cfg(test)]` module — reuse the in-memory DB setup already used by `scrollback_tests`)

**Interfaces:**
- Produces: `session::create_tab_with_id(conn: &Connection, id: &str, title: &str, shell_cmd: &str, cwd: &str) -> Result<Tab>` — inserts a terminal tab row with the GIVEN id (INSERT OR IGNORE if it already exists from a prior snapshot), returns the `Tab`.
- Produces: `pty_spawn(..., preferred_tab_id: Option<String>)` — when `Some`, the spawned PTY and all scrollback/pane keys use that id instead of a fresh UUID.

- [ ] **Step 1: Write the failing test** (in `session.rs` test module)

```rust
#[test]
fn create_tab_with_id_reuses_given_id_and_is_idempotent() {
    let conn = new_test_conn(); // same helper used by scrollback_tests
    let t1 = create_tab_with_id(&conn, "fixed-id-123", "zsh", "/bin/zsh", "/tmp").unwrap();
    assert_eq!(t1.id, "fixed-id-123");
    assert_eq!(t1.cwd, "/tmp");
    // Calling again with the same id must not error or duplicate the row.
    let t2 = create_tab_with_id(&conn, "fixed-id-123", "zsh", "/bin/zsh", "/other").unwrap();
    assert_eq!(t2.id, "fixed-id-123");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tabs WHERE id = ?", params!["fixed-id-123"], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
```

If `scrollback_tests` defines a private `new_test_conn()`/setup, reuse it; otherwise copy that module's conn-setup lines verbatim into this test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test create_tab_with_id_reuses_given_id -- --nocapture`
Expected: FAIL — `create_tab_with_id` not found.

- [ ] **Step 3: Implement `create_tab_with_id`** (in `session.rs`, immediately after `create_tab`)

```rust
/// Create a terminal tab row using a CALLER-SUPPLIED id (used by session
/// restore / reopen-closed so scrollback and pane_layouts — both keyed by
/// tab id — line up with the saved data). Idempotent: if the row already
/// exists (e.g. it was never deleted after close), the existing row is kept.
pub fn create_tab_with_id(
    conn: &Connection,
    id: &str,
    title: &str,
    shell_cmd: &str,
    cwd: &str,
) -> Result<Tab> {
    conn.execute(
        "INSERT OR IGNORE INTO tabs (id, title, shell_cmd, cwd, tab_type) \
         VALUES (?, ?, ?, ?, 'terminal')",
        params![id, title, shell_cmd, cwd],
    )
    .context("insert tab with id")?;
    let (title, shell_cmd, cwd, created_at): (String, String, String, i64) = conn
        .query_row(
            "SELECT title, shell_cmd, cwd, created_at FROM tabs WHERE id = ?",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .context("read tab after insert")?;
    Ok(Tab {
        id: id.to_string(),
        title,
        shell_cmd,
        cwd,
        created_at,
        tab_type: "terminal".to_string(),
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test create_tab_with_id_reuses_given_id`
Expected: PASS.

- [ ] **Step 5: Thread `preferred_tab_id` through `pty_spawn`** (`commands/mod.rs`)

Add the parameter to the `pty_spawn` signature (after `rows: u16,`):

```rust
    on_event: Channel<PtyEvent>,
    preferred_tab_id: Option<String>,
) -> Result<String, String> {
```

Replace the tab-creation block (currently `session::create_tab(&db, &shell, &shell, &cwd)`):

```rust
    let tab = {
        let db = state.db.lock();
        match preferred_tab_id.as_deref() {
            Some(id) => session::create_tab_with_id(&db, id, &shell, &shell, &cwd)
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to reuse tab id");
                    e.to_string()
                })?,
            None => session::create_tab(&db, &shell, &shell, &cwd).map_err(|e| {
                tracing::error!(error = %e, "Failed to create tab in database");
                e.to_string()
            })?,
        }
    };
```

- [ ] **Step 6: Verify the whole crate still builds + tests pass**

Run: `cd src-tauri && cargo build && cargo test session::`
Expected: builds clean; session tests pass. (Frontend `ptySpawn` still compiles because Tauri arg binding is by-name and the new arg is `Option`, defaulting to `null` when omitted — verified in Task 2.)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/session.rs src-tauri/src/commands/mod.rs
git commit -m "feat(session): pty_spawn can reuse a preferred tab id for restore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Frontend — `ptySpawn` forwards the preferred id

**Files:**
- Modify: `src/lib/tauri.ts` (`ptySpawn` at line ~85)

**Interfaces:**
- Consumes: backend `pty_spawn(preferred_tab_id: Option<String>)` from Task 1.
- Produces: `ptySpawn(opts: { ...existing, preferredTabId?: string })` — forwards `preferredTabId` to the `preferred_tab_id` command arg.

- [ ] **Step 1: Add the optional field to the `ptySpawn` options type and pass it through**

In `tauri.ts`, extend the `ptySpawn` options object type with `preferredTabId?: string;` and add to the `invoke` payload:

```ts
  return invoke<string>("pty_spawn", {
    shell: opts.shell,
    args: opts.args,
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    onEvent: channel,
    preferredTabId: opts.preferredTabId ?? null,
  });
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. (Existing callers omit `preferredTabId` → `null` → backend `None` → unchanged behavior.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(tauri): ptySpawn forwards optional preferredTabId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `closedTabsStore` — in-memory recently-closed stack

**Files:**
- Create: `src/state/closedTabsStore.ts`
- Test: `src/state/closedTabsStore.test.ts`

**Interfaces:**
- Produces: `ClosedTab = { id: string; title: string; cwd: string; closedAt: number }`
- Produces: `useClosedTabs` Zustand store with `{ items: ClosedTab[]; push(t: ClosedTab): void; popMostRecent(): ClosedTab | null; removeById(id: string): void; }`. `items` is newest-first; capped at 25.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useClosedTabs } from "./closedTabsStore";

const reset = () => useClosedTabs.setState({ items: [] });

describe("closedTabsStore", () => {
  beforeEach(reset);

  it("push prepends newest-first and popMostRecent returns/removes it", () => {
    useClosedTabs.getState().push({ id: "a", title: "A", cwd: "/", closedAt: 1 });
    useClosedTabs.getState().push({ id: "b", title: "B", cwd: "/", closedAt: 2 });
    expect(useClosedTabs.getState().items.map((t) => t.id)).toEqual(["b", "a"]);
    expect(useClosedTabs.getState().popMostRecent()?.id).toBe("b");
    expect(useClosedTabs.getState().items.map((t) => t.id)).toEqual(["a"]);
  });

  it("popMostRecent returns null when empty", () => {
    expect(useClosedTabs.getState().popMostRecent()).toBeNull();
  });

  it("caps at 25 entries, dropping the oldest", () => {
    for (let i = 0; i < 30; i++) {
      useClosedTabs.getState().push({ id: String(i), title: String(i), cwd: "/", closedAt: i });
    }
    const items = useClosedTabs.getState().items;
    expect(items.length).toBe(25);
    expect(items[0].id).toBe("29"); // newest
    expect(items.at(-1)?.id).toBe("5"); // oldest kept
  });

  it("removeById drops a specific entry", () => {
    useClosedTabs.getState().push({ id: "a", title: "A", cwd: "/", closedAt: 1 });
    useClosedTabs.getState().push({ id: "b", title: "B", cwd: "/", closedAt: 2 });
    useClosedTabs.getState().removeById("a");
    expect(useClosedTabs.getState().items.map((t) => t.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/closedTabsStore.test.ts --exclude '**/.worktrees/**'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

```ts
import { create } from "zustand";

export type ClosedTab = {
  id: string;
  title: string;
  cwd: string;
  closedAt: number;
};

const CAP = 25;

type Store = {
  items: ClosedTab[];
  push: (t: ClosedTab) => void;
  popMostRecent: () => ClosedTab | null;
  removeById: (id: string) => void;
};

export const useClosedTabs = create<Store>((set, get) => ({
  items: [],
  push: (t) =>
    set((s) => ({ items: [t, ...s.items.filter((x) => x.id !== t.id)].slice(0, CAP) })),
  popMostRecent: () => {
    const [head, ...rest] = get().items;
    if (!head) return null;
    set({ items: rest });
    return head;
  },
  removeById: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/closedTabsStore.test.ts --exclude '**/.worktrees/**'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/closedTabsStore.ts src/state/closedTabsStore.test.ts
git commit -m "feat(tabs): add in-memory recently-closed tabs store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `tabsStore` — idempotent addTab + record closed terminal tabs

**Files:**
- Modify: `src/state/tabsStore.ts` (`addTab` line ~45, `removeTab` line ~64)
- Test: `src/state/tabsStore.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `useClosedTabs` from Task 3.
- Produces: `addTab(t)` becomes a no-op when a tab with `t.id` already exists (guards double-mount respawn). `removeTab(id)` pushes the removed tab to `useClosedTabs` iff its `tab_type` is `"terminal"` (or undefined, which defaults to terminal).

- [ ] **Step 1: Write the failing tests** (append to `tabsStore.test.ts`)

```ts
import { useClosedTabs } from "./closedTabsStore";

it("addTab is idempotent on id (no duplicate on double-mount)", () => {
  useTabs.setState({ tabs: [], activeTabId: null });
  const tab = { id: "dup", title: "t", shell_cmd: "zsh", cwd: "/", created_at: 1, tab_type: "terminal" as const };
  useTabs.getState().addTab(tab);
  useTabs.getState().addTab(tab);
  expect(useTabs.getState().tabs.filter((t) => t.id === "dup").length).toBe(1);
});

it("removeTab records terminal tabs to the closed-tabs stack", () => {
  useClosedTabs.setState({ items: [] });
  useTabs.setState({
    tabs: [{ id: "x", title: "SSH r1", shell_cmd: "zsh", cwd: "/cfg", created_at: 1, tab_type: "terminal" }],
    activeTabId: "x",
  });
  useTabs.getState().removeTab("x");
  const items = useClosedTabs.getState().items;
  expect(items.length).toBe(1);
  expect(items[0]).toMatchObject({ id: "x", title: "SSH r1", cwd: "/cfg" });
});

it("removeTab does NOT record non-terminal tabs", () => {
  useClosedTabs.setState({ items: [] });
  useTabs.setState({
    tabs: [{ id: "hb", title: "Heartbeat", shell_cmd: "", cwd: "/", created_at: 1, tab_type: "heartbeat" }],
    activeTabId: "hb",
  });
  useTabs.getState().removeTab("hb");
  expect(useClosedTabs.getState().items.length).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/state/tabsStore.test.ts --exclude '**/.worktrees/**'`
Expected: FAIL on the three new cases.

- [ ] **Step 3: Implement — idempotent `addTab`**

Replace the `addTab` implementation:

```ts
  addTab: (t) =>
    set((s) => {
      // Idempotent on id: a double-mount (React strict mode) or a restore that
      // races the default slot must not spawn/register the same tab twice.
      if (s.tabs.some((x) => x.id === t.id)) return { activeTabId: t.id };
      return { tabs: [...s.tabs, t], activeTabId: t.id };
    }),
```

- [ ] **Step 4: Implement — `removeTab` records closed terminal tabs**

Add the import at the top of `tabsStore.ts`:

```ts
import { useClosedTabs } from "./closedTabsStore";
```

Inside `removeTab`, after computing `const tabs = s.tabs.filter(...)` and before the `return`, record the closed tab:

```ts
      const closed = s.tabs.find((t) => t.id === id);
      if (closed && (closed.tab_type === undefined || closed.tab_type === "terminal")) {
        useClosedTabs.getState().push({
          id: closed.id,
          title: closed.title,
          cwd: closed.cwd,
          closedAt: Math.floor(Date.now() / 1000),
        });
      }
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/state/tabsStore.test.ts --exclude '**/.worktrees/**'`
Expected: PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/state/tabsStore.ts src/state/tabsStore.test.ts
git commit -m "feat(tabs): idempotent addTab; record closed terminal tabs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Registry — replay scrollback + reuse id on spawn

**Files:**
- Modify: `src/lib/terminalRegistry.ts` (`CreateOpts` line ~9; `wireSession`/spawn at lines ~208 and ~383)
- Test: `src/lib/terminalRegistry.test.ts` (existing — add a replay case)

**Interfaces:**
- Consumes: `ptySpawn({ preferredTabId })` from Task 2.
- Produces: `CreateOpts` gains `preferredTabId?: string` and `replayBytes?: number[]`. On create, if `replayBytes` is non-empty, the registry writes them to xterm followed by a dim `\r\n──── session restored ────\r\n` separator, BEFORE any live PTY output. `preferredTabId` is forwarded to `ptySpawn`.

- [ ] **Step 1: Write the failing test** (append to `terminalRegistry.test.ts`, following its existing mock pattern)

```ts
it("replays scrollback bytes into xterm before live output", () => {
  const e = reg.getOrCreate("t-replay", {
    ...OPTS,
    replayBytes: Array.from(new TextEncoder().encode("prev output")),
  });
  const written = (e.xterm.write as any).mock.calls.map((c: any[]) => c[0]);
  // First write is the replay bytes; a separator write follows.
  const decoded = written.map((w: any) =>
    typeof w === "string" ? w : new TextDecoder().decode(new Uint8Array(w)),
  );
  expect(decoded.some((d: string) => d.includes("prev output"))).toBe(true);
  expect(decoded.some((d: string) => d.includes("session restored"))).toBe(true);
});
```

If the existing test's xterm mock does not record `write`, extend the mock in that file's setup to include `write: vi.fn()` (surgical: only add the missing method).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/terminalRegistry.test.ts --exclude '**/.worktrees/**'`
Expected: FAIL — no replay behavior.

- [ ] **Step 3: Extend `CreateOpts`**

```ts
export interface CreateOpts {
  shell: string;
  cwd: string;
  skipTabRegistration?: boolean;
  /** Restore: reuse this saved tab id so scrollback/pane_layouts line up. */
  preferredTabId?: string;
  /** Restore: raw scrollback bytes to replay above the fresh shell. */
  replayBytes?: number[];
  onPtyReady?: (ptyTabId: string) => void;
}
```

- [ ] **Step 4: Replay in `getOrCreate`** (after `xterm` is constructed and addons loaded, before `wireSession`)

```ts
  if (opts.replayBytes && opts.replayBytes.length > 0) {
    xterm.write(new Uint8Array(opts.replayBytes));
    // Dim separator marks where restored history ends and the live shell begins.
    xterm.write("\r\n\x1b[2m──── session restored ────\x1b[0m\r\n");
  }
```

- [ ] **Step 5: Forward `preferredTabId` to `ptySpawn`** (in `wireSession`, the `ptySpawn({...})` call at line ~383)

```ts
  const promise = ptySpawn({
    shell: opts.shell,
    args: [],
    cwd: opts.cwd,
    cols: xterm.cols ?? 80,
    rows: xterm.rows ?? 24,
    onEvent,
    preferredTabId: opts.preferredTabId,
  });
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/lib/terminalRegistry.test.ts --exclude '**/.worktrees/**'`
Expected: PASS (existing + replay case).

- [ ] **Step 7: Commit**

```bash
git add src/lib/terminalRegistry.ts src/lib/terminalRegistry.test.ts
git commit -m "feat(registry): replay scrollback + reuse saved tab id on spawn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `sessionRestore` — pure restore reducer

**Files:**
- Create: `src/lib/sessionRestore.ts`
- Test: `src/lib/sessionRestore.test.ts`

**Interfaces:**
- Consumes: `SessionSnapshot`, `TabSnapshot` from `tauri.ts`.
- Produces: `planRestore(snapshot: SessionSnapshot | null): RestorePlan` where
  `RestorePlan = { tabs: Array<{ id: string; title: string; shell_cmd: string; cwd: string; created_at: number; replayBytes: number[] }>; activeTabId: string | null }`.
  Filters to terminal tabs only (a `TabSnapshot` has no `tab_type`, so terminal-ness is inferred: a tab is a terminal iff it has a non-empty `shell_cmd` — API/special tabs store empty `shell_cmd`). Returns `{ tabs: [], activeTabId: null }` for null/empty snapshots.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { planRestore } from "./sessionRestore";
import type { SessionSnapshot } from "./tauri";

const snap = (tabs: any[], active: string | null): SessionSnapshot => ({
  id: "s", name: "__last__", active_tab_id: active, tabs, created_at: 0,
});

describe("planRestore", () => {
  it("returns empty plan for null snapshot", () => {
    expect(planRestore(null)).toEqual({ tabs: [], activeTabId: null });
  });

  it("keeps terminal tabs (non-empty shell_cmd), drops special tabs", () => {
    const plan = planRestore(snap([
      { id: "t1", title: "zsh", shell_cmd: "/bin/zsh", cwd: "/a", created_at: 1, scrollback: [104, 105], ai_messages: [] },
      { id: "api1", title: "API", shell_cmd: "", cwd: "/", created_at: 2, scrollback: [], ai_messages: [] },
    ], "t1"));
    expect(plan.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(plan.tabs[0].replayBytes).toEqual([104, 105]);
    expect(plan.activeTabId).toBe("t1");
  });

  it("clears activeTabId when the active tab was not a terminal", () => {
    const plan = planRestore(snap([
      { id: "t1", title: "zsh", shell_cmd: "/bin/zsh", cwd: "/a", created_at: 1, scrollback: [], ai_messages: [] },
      { id: "api1", title: "API", shell_cmd: "", cwd: "/", created_at: 2, scrollback: [], ai_messages: [] },
    ], "api1"));
    // active falls back to the first restored terminal tab
    expect(plan.activeTabId).toBe("t1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/sessionRestore.test.ts --exclude '**/.worktrees/**'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `planRestore`**

```ts
import type { SessionSnapshot } from "./tauri";

export type RestoreTab = {
  id: string;
  title: string;
  shell_cmd: string;
  cwd: string;
  created_at: number;
  replayBytes: number[];
};

export type RestorePlan = {
  tabs: RestoreTab[];
  activeTabId: string | null;
};

/**
 * Pure reducer: turn a saved session snapshot into a restore plan. A tab is a
 * terminal iff it has a non-empty shell_cmd (API/special tabs persist empty
 * shell_cmd). Active id falls back to the first restored terminal when the
 * saved active tab was not a terminal.
 */
export function planRestore(snapshot: SessionSnapshot | null): RestorePlan {
  if (!snapshot || snapshot.tabs.length === 0) {
    return { tabs: [], activeTabId: null };
  }
  const tabs: RestoreTab[] = snapshot.tabs
    .filter((t) => t.shell_cmd.trim() !== "")
    .map((t) => ({
      id: t.id,
      title: t.title,
      shell_cmd: t.shell_cmd,
      cwd: t.cwd,
      created_at: t.created_at,
      replayBytes: t.scrollback,
    }));
  if (tabs.length === 0) return { tabs: [], activeTabId: null };
  const savedActiveIsTerminal = tabs.some((t) => t.id === snapshot.active_tab_id);
  return {
    tabs,
    activeTabId: savedActiveIsTerminal ? snapshot.active_tab_id : tabs[0].id,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/sessionRestore.test.ts --exclude '**/.worktrees/**'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessionRestore.ts src/lib/sessionRestore.test.ts
git commit -m "feat(session): pure planRestore reducer for boot restore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `useSessionSave` — debounced save + save on close

**Files:**
- Create: `src/hooks/useSessionSave.ts`
- Test: `src/hooks/useSessionSave.test.ts`

**Interfaces:**
- Consumes: `saveCurrentSession(activeTabId)` from `tauri.ts`; `useTabs` store.
- Produces: `useSessionSave(): void` — a hook that (a) subscribes to `useTabs` and calls `saveCurrentSession(activeTabId)` debounced 1000 ms on any tab-list/active change, and (b) registers a Tauri window `onCloseRequested` handler that calls `saveCurrentSession` synchronously (awaits it) before allowing close. Exports the pure debounce helper `makeDebouncedSaver(save, delayMs)` for testing.

- [ ] **Step 1: Write the failing test** (test the pure debounce helper — no React/Tauri needed)

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDebouncedSaver } from "./useSessionSave";

describe("makeDebouncedSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid calls into one save with the latest arg", () => {
    const save = vi.fn();
    const saver = makeDebouncedSaver(save, 1000);
    saver("a");
    saver("b");
    saver("c");
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("c");
  });

  it("flush() saves immediately with the pending arg", () => {
    const save = vi.fn();
    const saver = makeDebouncedSaver(save, 1000);
    saver("x");
    saver.flush();
    expect(save).toHaveBeenCalledWith("x");
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1); // not double-fired
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/hooks/useSessionSave.test.ts --exclude '**/.worktrees/**'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook + helper**

```ts
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabs } from "../state/tabsStore";
import { saveCurrentSession } from "../lib/tauri";

type Saver = ((activeTabId: string | null) => void) & { flush: () => void };

/** Debounce saves; `flush()` fires the pending save now (used on window close). */
export function makeDebouncedSaver(
  save: (activeTabId: string | null) => void,
  delayMs: number,
): Saver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  let hasPending = false;
  const run = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (hasPending) { hasPending = false; save(pending); }
  };
  const saver = ((activeTabId: string | null) => {
    pending = activeTabId;
    hasPending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  }) as Saver;
  saver.flush = run;
  return saver;
}

/**
 * Persist the session snapshot continuously: debounced on tab-store changes
 * and synchronously on window close, so restore survives crashes/force-quit.
 */
export function useSessionSave(): void {
  useEffect(() => {
    const saver = makeDebouncedSaver(
      (activeTabId) => { saveCurrentSession(activeTabId).catch(() => {}); },
      1000,
    );
    // Save whenever the tab list or active tab changes.
    const unsub = useTabs.subscribe((s) => saver(s.activeTabId));

    // Synchronous save on close so a clean quit captures the exact state.
    let unlistenClose: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async () => {
        const activeTabId = useTabs.getState().activeTabId;
        try { await saveCurrentSession(activeTabId); } catch { /* best effort */ }
      })
      .then((fn) => { unlistenClose = fn; })
      .catch(() => {});

    return () => {
      unsub();
      saver.flush();
      unlistenClose?.();
    };
  }, []);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/hooks/useSessionSave.test.ts --exclude '**/.worktrees/**'`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSessionSave.ts src/hooks/useSessionSave.test.ts
git commit -m "feat(session): debounced session save + save-on-close hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `RecentlyClosedModal` — pick a closed tab to reopen

**Files:**
- Create: `src/components/RecentlyClosedModal.tsx`
- Test: `src/components/RecentlyClosedModal.test.tsx`

**Interfaces:**
- Consumes: `useClosedTabs` from Task 3.
- Produces: `RecentlyClosedModal({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (tab: ClosedTab) => void })` — renders the closed-tab list (title + cwd), each row clickable → `onPick(tab)` then `onClose()`. Renders nothing when `open` is false or the list is empty (shows an "No recently closed tabs" line if open+empty).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecentlyClosedModal } from "./RecentlyClosedModal";
import { useClosedTabs } from "../state/closedTabsStore";

beforeEach(() => useClosedTabs.setState({ items: [] }));

describe("RecentlyClosedModal", () => {
  it("lists closed tabs and fires onPick", () => {
    useClosedTabs.setState({ items: [{ id: "a", title: "SSH r1", cwd: "/cfg", closedAt: 1 }] });
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<RecentlyClosedModal open onClose={onClose} onPick={onPick} />);
    fireEvent.click(screen.getByText("SSH r1"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<RecentlyClosedModal open={false} onClose={() => {}} onPick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/RecentlyClosedModal.test.tsx --exclude '**/.worktrees/**'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component** (match the existing modal/overlay style used by e.g. `FanoutGroupsPanel`; keep minimal)

```tsx
import { useClosedTabs, type ClosedTab } from "../state/closedTabsStore";

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (tab: ClosedTab) => void;
};

export function RecentlyClosedModal({ open, onClose, onPick }: Props) {
  const items = useClosedTabs((s) => s.items);
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card recently-closed" onClick={(e) => e.stopPropagation()}>
        <h3>Recently Closed</h3>
        {items.length === 0 ? (
          <p className="empty">No recently closed tabs</p>
        ) : (
          <ul className="closed-list">
            {items.map((t) => (
              <li key={t.id}>
                <button
                  className="closed-row"
                  onClick={() => { onPick(t); onClose(); }}
                >
                  <span className="title">{t.title}</span>
                  <span className="cwd">{t.cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

If `modal-overlay`/`modal-card` classes are not already global, add a small scoped block to `src/App.css` for `.recently-closed .closed-row { display:flex; justify-content:space-between; width:100%; }` — surgical, only the classes this component introduces.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/RecentlyClosedModal.test.tsx --exclude '**/.worktrees/**'`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/RecentlyClosedModal.tsx src/components/RecentlyClosedModal.test.tsx src/App.css
git commit -m "feat(tabs): Recently Closed modal to reopen a specific tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Backend — View ▸ Recently Closed menu items

**Files:**
- Modify: `src-tauri/src/lib.rs` (menu construction near the other `CmdOrCtrl+Shift+*` items ~line 815; View submenu)

**Interfaces:**
- Produces: two native menu items emitting frontend events — `reopen_closed_tab` (accelerator `CmdOrCtrl+Shift+T`) → emits `menu:reopen_closed_tab`; `reopen_closed_pick` ("Recently Closed…") → emits `menu:reopen_closed_pick`. Placed in the View menu (create the View submenu if one does not already exist; otherwise append).

- [ ] **Step 1: Add the menu items** (follow the exact pattern of existing `MenuItem::with_id` + the `menu event` match arm that calls `app.emit`/`window.emit`)

```rust
let reopen_closed_tab = MenuItem::with_id(
    app, "reopen_closed_tab", "Reopen Closed Tab", true, Some("CmdOrCtrl+Shift+T"),
)?;
let reopen_closed_pick = MenuItem::with_id(
    app, "reopen_closed_pick", "Recently Closed…", true, None::<&str>,
)?;
```

Add both to the View submenu's item list (mirror how `pane_metadata_toggle` / `change_open` are added to their submenus).

- [ ] **Step 2: Route the menu events** (in the `on_menu_event` handler, mirror existing arms)

```rust
"reopen_closed_tab" => { let _ = window.emit("menu:reopen_closed_tab", ()); }
"reopen_closed_pick" => { let _ = window.emit("menu:reopen_closed_pick", ()); }
```

(Use whatever emit target the neighboring arms use — `window.emit` or `app.emit`.)

- [ ] **Step 3: Build to verify**

Run: `cd src-tauri && cargo build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(menu): View > Reopen Closed Tab (Cmd+Shift+T) + Recently Closed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: App wiring — restore on boot, save hook, reopen handlers

**Files:**
- Modify: `src/App.tsx` (default `termSlots` init line ~101; add boot-restore effect; mount `useSessionSave`; add menu/⌘⇧T listeners; render `RecentlyClosedModal`)

**Interfaces:**
- Consumes: `planRestore` (Task 6), `restoreLastSession`/`tabScrollback` (`tauri.ts`), registry `getOrCreate` with `preferredTabId`+`replayBytes` (Task 5), `useSessionSave` (Task 7), `useClosedTabs` (Task 3), `RecentlyClosedModal` (Task 8).
- Produces: on boot, terminal tabs are restored (fresh shell + replayed history, saved ids) before the default empty slot spawns; ⌘⇧T reopens the most-recent closed tab; View ▸ Recently Closed opens the modal.

- [ ] **Step 1: Gate the default slot behind restore**

Change the initial `termSlots` state so the default empty slot is NOT seeded until restore has run:

```ts
  const [termSlots, setTermSlots] = useState<TermSlot[]>([]); // seeded by boot-restore effect
  const [restoreDone, setRestoreDone] = useState(false);
```

- [ ] **Step 2: Add the boot-restore effect** (runs once, before anything seeds a default slot)

```tsx
  // One-time session restore. Recreate terminal tabs (fresh shell + replayed
  // scrollback, reusing saved ids so scrollback/pane_layouts line up). Falls
  // back to a single fresh slot when there is nothing to restore.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let plan: import("./lib/sessionRestore").RestorePlan = { tabs: [], activeTabId: null };
      try {
        const { restoreLastSession } = await import("./lib/tauri");
        const { planRestore } = await import("./lib/sessionRestore");
        plan = planRestore(await restoreLastSession());
      } catch (e) {
        console.warn("[restore] failed; starting fresh:", e);
      }
      if (cancelled) return;

      if (plan.tabs.length === 0) {
        setTermSlots([{ spawnKey: "init-" + Date.now(), tabId: null }]);
        setRestoreDone(true);
        return;
      }

      const terminalRegistry = await import("./lib/terminalRegistry");
      for (const t of plan.tabs) {
        // Reuse the saved id as the registry terminalId AND the backend tab id.
        terminalRegistry.getOrCreate(t.id, {
          shell: t.shell_cmd,
          cwd: t.cwd,
          preferredTabId: t.id,
          replayBytes: t.replayBytes,
          skipTabRegistration: false,
        });
        addTab({
          id: t.id,
          title: t.title,
          shell_cmd: t.shell_cmd,
          cwd: t.cwd,
          created_at: t.created_at,
          tab_type: "terminal",
        });
        setTermSlots((prev) => [...prev, { spawnKey: "restore-" + t.id, tabId: t.id }]);
      }
      if (plan.activeTabId) useTabs.getState().setActive(plan.activeTabId);
      setRestoreDone(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

Note: if the existing render maps `termSlots` to `<Terminal terminalId=... />`, confirm restored slots pass `terminalId={slot.tabId}` so the registry entry created above is the one attached (id reuse). Adjust the slot→Terminal mapping only if it currently derives `terminalId` differently.

- [ ] **Step 3: Mount the save hook** (near the other top-level hooks, after `useTabs()`)

```tsx
  useSessionSave();
```

with `import { useSessionSave } from "./hooks/useSessionSave";` at the top.

- [ ] **Step 4: Add reopen state + a reopen helper**

```tsx
  const [recentlyClosedOpen, setRecentlyClosedOpen] = useState(false);

  const reopenClosedTab = useCallback(async (tabId: string, title: string, cwd: string) => {
    if (useTabs.getState().tabs.some((t) => t.id === tabId)) {
      useTabs.getState().setActive(tabId);
      return;
    }
    const terminalRegistry = await import("./lib/terminalRegistry");
    const { tabScrollback } = await import("./lib/tauri");
    let replayBytes: number[] = [];
    try { replayBytes = await tabScrollback(tabId); } catch { /* no history */ }
    terminalRegistry.getOrCreate(tabId, {
      shell: defaultShell(), cwd, preferredTabId: tabId, replayBytes,
    });
    addTab({ id: tabId, title, shell_cmd: defaultShell(), cwd, created_at: Math.floor(Date.now() / 1000), tab_type: "terminal" });
    setTermSlots((prev) => [...prev, { spawnKey: "reopen-" + tabId, tabId }]);
    useClosedTabs.getState().removeById(tabId);
  }, [addTab]);
```

(with `import { useClosedTabs } from "./state/closedTabsStore";`)

- [ ] **Step 5: Wire ⌘⇧T + menu listeners** (in the existing menu-listener `useEffect` that pushes `unlistens`)

```tsx
    unlistens.push(listen('menu:reopen_closed_tab', () => {
      const t = useClosedTabs.getState().popMostRecent();
      if (t) reopenClosedTab(t.id, t.title, t.cwd);
    }));
    unlistens.push(listen('menu:reopen_closed_pick', () => setRecentlyClosedOpen(true)));
```

The `CmdOrCtrl+Shift+T` accelerator is handled natively (Task 9), so no JS `useKeyboardShortcut` is needed — the xterm focus-swallow problem is why we route through the native menu (same rationale as ⌘⇧B).

- [ ] **Step 6: Render the modal** (near the other modals in the return JSX)

```tsx
      <RecentlyClosedModal
        open={recentlyClosedOpen}
        onClose={() => setRecentlyClosedOpen(false)}
        onPick={(t) => reopenClosedTab(t.id, t.title, t.cwd)}
      />
```

with `import { RecentlyClosedModal } from "./components/RecentlyClosedModal";`.

- [ ] **Step 7: Type-check + run the full frontend suite**

Run: `npx tsc --noEmit && npx vitest run --exclude '**/.worktrees/**'`
Expected: no type errors; all suites pass (including new tabsStore/closedTabsStore/registry/sessionRestore/useSessionSave/RecentlyClosedModal tests).

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx
git commit -m "feat(session): restore tabs on boot, save hook, reopen-closed wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Backend round-trip test + live verification

**Files:**
- Test: `src-tauri/src/session.rs` (add a save→restore round-trip test if not already covered)

**Interfaces:**
- Consumes: `save_session_snapshot`, `load_session_snapshot`, `create_tab_with_id`, `append_scrollback_with_limit`.

- [ ] **Step 1: Write the round-trip test**

```rust
#[test]
fn save_then_restore_roundtrips_terminal_tab_with_scrollback() {
    let conn = new_test_conn();
    let tab = create_tab_with_id(&conn, "rt-1", "zsh", "/bin/zsh", "/work").unwrap();
    append_scrollback_with_limit(&conn, &tab.id, b"hello world", MAX_SCROLLBACK_BYTES_PER_TAB).unwrap();
    save_session_snapshot(&conn, "__last__", Some(&tab.id)).unwrap();

    let snap = load_session_snapshot(&conn, "__last__").unwrap().expect("snapshot");
    assert_eq!(snap.active_tab_id.as_deref(), Some("rt-1"));
    let restored = snap.tabs.iter().find(|t| t.id == "rt-1").expect("tab present");
    assert_eq!(restored.cwd, "/work");
    assert_eq!(restored.scrollback, b"hello world");
}
```

Adjust `append_scrollback_with_limit`'s argument order/const name to match its real signature in `session.rs` (line ~245) if this differs.

- [ ] **Step 2: Run to verify pass**

Run: `cd src-tauri && cargo test save_then_restore_roundtrips`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/session.rs
git commit -m "test(session): save->restore round-trip preserves scrollback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Live verification** (dev server must be RUNNING — per project rule, do not claim done without this)

1. `npm run tauri dev` (or confirm the running instance picked up the rebuild).
2. Open 3 terminal tabs; in each run a distinct command (`echo TAB1`, `cd /tmp && echo TAB2`, `ls -la`) so each has unique scrollback + cwd.
3. Quit the app cleanly. Relaunch.
4. **Verify:** all 3 terminal tabs return, in order; each shows its prior output above a `──── session restored ────` separator with a live prompt below; each is in its saved cwd; the previously-active tab is focused. Heartbeat tab is present (not duplicated).
5. Close one tab. Press ⌘⇧T. **Verify:** it reopens with its history replayed.
6. Close another tab. View ▸ Recently Closed. **Verify:** it lists the closed tab; clicking it reopens with history.
7. Confirm no infinite PTY respawn (watch the console for repeated `[terminalRegistry] PTY … ready` on a single tab — the idempotent `addTab` guards this).

- [ ] **Step 5: Update memory** after live verification passes

Append a memory file `project_session_tab_restore.md` recording: what shipped, the id-reuse linchpin (`preferred_tab_id`), scrollback now serves restore, ⌘⇧T + Recently Closed, and link `[[project_heartbeat_starvation]]` (the scrollback-cap work that preceded this). Add a pointer line to `MEMORY.md`.

---

## Self-Review

**Spec coverage:**
- Restore on restart → Tasks 6, 10 (planRestore + boot effect). ✔
- Fresh shell + replayed history → Task 5 (replay) + Task 1 (id reuse). ✔
- Reopen closed tab (⌘⇧T) → Tasks 3, 4, 9, 10. ✔
- Recently Closed list → Tasks 8, 9, 10. ✔
- Continuous save + save-on-close → Task 7. ✔
- Pane splits restore for free (id reuse) → Task 1 enables it; verified in Task 11 live step (splits reappear because `loadLayoutForTab` keys on the reused id). ✔
- Special tabs not restored as terminals → Task 6 (`shell_cmd` filter). ✔
- Error handling (null snapshot, replay failure, duplicate id) → Task 6 (empty plan), Task 10 (try/catch around restore + tabScrollback), Task 4 (idempotent addTab). ✔
- No migration/schema change → honored (uses existing tables). ✔

**Placeholder scan:** No TBD/TODO; every code step has concrete code. Two explicit "adjust to match real signature" notes (Task 11 scrollback arg order; Task 5 xterm mock) are verification instructions, not placeholders — the surrounding code is complete.

**Type consistency:** `RestoreTab`/`RestorePlan` (Task 6) consumed unchanged in Task 10. `ClosedTab` (Task 3) used by Tasks 4, 8, 10. `CreateOpts.preferredTabId`/`replayBytes` (Task 5) consumed by Task 10. `preferredTabId` naming consistent across Tasks 2/5/10. `create_tab_with_id` signature identical in Tasks 1 and 11.

**Scope:** Single coherent feature; no decomposition needed.

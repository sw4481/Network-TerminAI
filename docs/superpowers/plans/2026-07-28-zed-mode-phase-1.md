# Zed Mode Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reversible Settings toggle that gives every CCIE Terminal Monaco editor a Zed-style One Dark theme, slim editor chrome, breadcrumbs, Zed keybindings, and optional Vim mode while preserving the exact current Monaco behavior when Zed Mode is off.

**Architecture:** Keep Monaco as the only editor engine. Persist only `app_flags.ccie_editor_mode` (`"monaco"` by default, or `"zed"`) through two small Tauri commands. A root `ZedModeProvider` hydrates that flag, persists the independent Vim preference in `localStorage`, synchronizes all windows through a `zed-mode-changed` Tauri event, and toggles a body-level `.zed-mode` CSS scope. Monaco-specific theme, keybinding, and Vim lifecycle logic lives in focused helper modules so each behavior is unit-testable without mounting the whole application.

**Tech Stack:** Rust, Tauri 2, rusqlite, TypeScript 5.8, React 19, Monaco Editor 0.52, `monaco-vim` 0.4.4, Bun, Vitest 4, Testing Library, Playwright.

## Global Constraints

- This plan implements **Phase 1 only** from `Plans/ZED.md`. Splits/pop-outs, Git decorations, project-wide LSP, and DAP remain Phases 2–5 and require separate approved plans.
- Monaco remains the renderer. Do not add CodeMirror, embed or launch the Zed binary, or create an external-Zed handoff.
- The only backend persistence added is `app_flags.ccie_editor_mode`, with exact values `"monaco"` and `"zed"`. No migration is needed; next-free migration V0084 remains unused.
- The independent Vim preference is frontend-only under `localStorage["ccie.zed.vimEnabled"]`, defaulting to `false`. Preserve the preference while classic Monaco is active, but attach Vim only when `mode === "zed" && vimEnabled`.
- `ZedModeProvider` is the single source of truth. Settings and editor components must not keep shadow copies of mode or Vim state.
- Turning Zed Mode off must remove the `.zed-mode` class, restore Monaco theme `"vs-dark"` and the existing font stack, dispose every Zed action/Vim handle, hide breadcrumbs, and leave current global shortcuts unchanged.
- Zed shortcuts are editor-focus scoped. Monaco must consume owned key events before window-level handlers see them.
- Do **not** register Zed's ⌘⇧L binding in Phase 1. CCIE Terminal owns that accelerator both in `App.tsx` and as the native `CmdOrCtrl+Shift+L` metadata menu item in `src-tauri/src/lib.rs`; a webview handler cannot reliably override the native menu.
- Preserve the current ⌘D pane split and ⌘⌥Arrow pane navigation outside a focused Zed editor. Inside a focused Zed editor, Monaco owns ⌘D and ⌘⌥↑/↓.
- Use Bun for frontend dependency and build commands. Pin `monaco-vim` to `0.4.4` and commit both `package.json` and `bun.lock`; do not update unrelated packages.
- Run every Vitest command with `--exclude '**/.worktrees/**'`.
- The worktree was already dirty when this plan was written. Every commit must stage explicit task files only, inspect `git diff --cached`, and leave all unrelated modified, deleted, and untracked files untouched. Never use `git add .`.
- Live verification in the running Tauri app is mandatory before completion.

---

## File Structure and Responsibilities

**Backend**

- Modify `src-tauri/src/commands/editor.rs` — pure app-flag helpers, Tauri commands, and in-memory SQLite tests.
- Modify `src-tauri/src/lib.rs` — register `editor_mode_get` and `editor_mode_set`.

**State and Settings**

- Modify `src/lib/tauri.ts` — typed `EditorMode` invoke wrappers.
- Create `src/lib/editorMode.test.ts` — frontend command-contract tests.
- Create `src/components/editor/ZedModeProvider.tsx` — persisted mode, local Vim preference, cross-window event sync, and body CSS scope.
- Create `src/components/editor/ZedModeProvider.test.tsx` — hydration, persistence, event, class, and cleanup tests.
- Create `src/components/settings/EditorSettingsTab.tsx` and `.css` — editor style and Vim controls.
- Create `src/components/settings/EditorSettingsTab.test.tsx` — accessible UI behavior and error-state tests.
- Modify `src/windows/Settings.tsx` — register and render the new Editor tab. The approved design's proposed `src/windows/settings/EditorSettingsTab.tsx` path is corrected to the repository's established `src/components/settings/EditorSettingsTab.tsx` location.
- Modify `src/main.tsx` — mount the provider once above `App`.

**Monaco Features**

- Create `src/components/editor/themes/zed-one-dark.ts` and `.test.ts` — theme data, theme selection, and exact classic fallback.
- Create `src/components/editor/zedKeybindings.ts` and `.test.ts` — reversible Monaco actions and focused-event ownership.
- Modify `src/hooks/useKeyboardShortcut.ts`; create `src/hooks/useKeyboardShortcut.test.tsx` — honor events already consumed by Monaco.
- Create `src/components/editor/useVimMode.ts` and `.test.tsx` — attach exactly once and dispose on disable/unmount.
- Create `src/components/editor/MonacoEditor.css` — full-size shell and fallback Vim status overlay for Monaco hosts without their own status bar.
- Modify `src/components/editor/MonacoEditor.tsx` — consume provider state and compose theme, keybindings, and Vim.
- Create `src/components/editor/EditorBreadcrumbs.tsx` and `.test.tsx` — derive and render root-relative file segments.
- Create `src/components/editor/zed-mode.css` — `.zed-mode`-scoped tab/editor chrome.
- Modify `src/components/editor/EditorTab.tsx` and `EditorTab.css` — breadcrumb/canvas structure and Vim status target.

**Dependency and Acceptance Coverage**

- Modify `package.json` and `bun.lock` — add `monaco-vim@0.4.4`.
- Create `e2e/tests/zed-mode.spec.ts` — Settings-to-editor mode switch and reversal.

---

## Task 1: Persist and validate `ccie_editor_mode` in Rust

**Files:**

- Modify: `src-tauri/src/commands/editor.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/commands/editor.rs`

**Interfaces:**

- Produces: `editor_mode_get(state: State<'_, AppState>) -> Result<String, String>`
- Produces: `editor_mode_set(state: State<'_, AppState>, mode: String) -> Result<(), String>`
- Internal seam: `load_editor_mode(conn: &Connection)` and `store_editor_mode(conn: &Connection, mode: &str)` so unit tests do not need a Tauri runtime.
- Invariant: absent or corrupt stored data reads as `"monaco"`; invalid writes fail and do not alter the stored value.

- [ ] **Step 1: Write the failing in-memory SQLite tests**

Add a new `editor_mode_tests` module at the bottom of `editor.rs`, separate from `iac_studio_tests`:

```rust
#[cfg(test)]
mod editor_mode_tests {
    use super::*;

    fn test_conn() -> Connection {
        Connection::open_in_memory().expect("open in-memory sqlite")
    }

    #[test]
    fn editor_mode_defaults_to_monaco() {
        let conn = test_conn();
        assert_eq!(load_editor_mode(&conn).unwrap(), "monaco");
    }

    #[test]
    fn editor_mode_round_trips_both_supported_values() {
        let conn = test_conn();
        store_editor_mode(&conn, "zed").unwrap();
        assert_eq!(load_editor_mode(&conn).unwrap(), "zed");
        store_editor_mode(&conn, "monaco").unwrap();
        assert_eq!(load_editor_mode(&conn).unwrap(), "monaco");
    }

    #[test]
    fn editor_mode_rejects_invalid_values_without_overwriting() {
        let conn = test_conn();
        store_editor_mode(&conn, "zed").unwrap();
        let error = store_editor_mode(&conn, "vim").unwrap_err();
        assert!(error.contains("unsupported editor mode"));
        assert_eq!(load_editor_mode(&conn).unwrap(), "zed");
    }

    #[test]
    fn editor_mode_degrades_corrupt_rows_to_monaco() {
        let conn = test_conn();
        ensure_app_flags_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO app_flags(key, value) VALUES (?1, ?2)",
            rusqlite::params![EDITOR_MODE_FLAG_KEY, "unexpected"],
        )
        .unwrap();
        assert_eq!(load_editor_mode(&conn).unwrap(), "monaco");
    }

    #[test]
    fn editor_mode_supports_legacy_two_column_app_flags_table() {
        let conn = test_conn();
        conn.execute_batch(
            "CREATE TABLE app_flags (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .unwrap();
        store_editor_mode(&conn, "zed").unwrap();
        assert_eq!(load_editor_mode(&conn).unwrap(), "zed");
    }
}
```

- [ ] **Step 2: Run the focused test and confirm the intended failure**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml editor_mode -- --nocapture
```

Expected: compile failure because the constants/helpers do not exist yet.

- [ ] **Step 3: Add the pure persistence helpers and Tauri wrappers**

Change the import to `use rusqlite::{Connection, OptionalExtension};`, then add this block before the existing editor commands:

```rust
const EDITOR_MODE_FLAG_KEY: &str = "ccie_editor_mode";
const DEFAULT_EDITOR_MODE: &str = "monaco";

fn ensure_app_flags_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|error| format!("Failed to ensure app_flags: {error}"))
}

fn load_editor_mode(conn: &Connection) -> Result<String, String> {
    ensure_app_flags_table(conn)?;
    let stored = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![EDITOR_MODE_FLAG_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read editor mode: {error}"))?;

    Ok(match stored.as_deref() {
        Some("zed") => "zed".to_string(),
        Some("monaco") | None => DEFAULT_EDITOR_MODE.to_string(),
        Some(_) => DEFAULT_EDITOR_MODE.to_string(),
    })
}

fn store_editor_mode(conn: &Connection, mode: &str) -> Result<(), String> {
    if !matches!(mode, "monaco" | "zed") {
        return Err(format!("unsupported editor mode: {mode}"));
    }

    ensure_app_flags_table(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
        rusqlite::params![EDITOR_MODE_FLAG_KEY, mode],
    )
    .map_err(|error| format!("Failed to save editor mode: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn editor_mode_get(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock();
    load_editor_mode(&conn)
}

#[tauri::command]
pub fn editor_mode_set(
    state: State<'_, AppState>,
    mode: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    store_editor_mode(&conn, &mode)
}
```

- [ ] **Step 4: Register both commands**

In the editor command block in `src-tauri/src/lib.rs`, add:

```rust
commands::editor::editor_mode_get,
commands::editor::editor_mode_set,
```

Keep them adjacent to the other `commands::editor::*` entries.

- [ ] **Step 5: Verify focused and complete Rust behavior**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml editor_mode -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: five mode tests pass, including compatibility with the repository's
older two-column `app_flags` schema, and the Tauri command registration compiles.

- [ ] **Step 6: Commit only the backend files**

```bash
git add src-tauri/src/commands/editor.rs src-tauri/src/lib.rs
git diff --cached --check
git diff --cached
git commit -m "feat(editor): persist validated editor mode"
```

---

## Task 2: Add the typed frontend command bridge

**Files:**

- Modify: `src/lib/tauri.ts`
- Create: `src/lib/editorMode.test.ts`

**Interfaces:**

- Produces: `export type EditorMode = "monaco" | "zed"`
- Produces: `editorModeGet(): Promise<EditorMode>`
- Produces: `editorModeSet(mode: EditorMode): Promise<void>`
- Consumes: Rust commands from Task 1.

- [ ] **Step 1: Write the failing invoke-contract tests**

Create `src/lib/editorMode.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { editorModeGet, editorModeSet } from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

const invokeMock = vi.mocked(invoke);

describe("editor mode Tauri bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("reads the persisted editor mode", async () => {
    invokeMock.mockResolvedValueOnce("zed");
    await expect(editorModeGet()).resolves.toBe("zed");
    expect(invokeMock).toHaveBeenCalledWith("editor_mode_get");
  });

  it("writes the selected editor mode", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await editorModeSet("monaco");
    expect(invokeMock).toHaveBeenCalledWith("editor_mode_set", {
      mode: "monaco",
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm missing exports**

Run:

```bash
bunx vitest run src/lib/editorMode.test.ts --exclude '**/.worktrees/**'
```

Expected: FAIL because `editorModeGet` and `editorModeSet` are not exported.

- [ ] **Step 3: Add the bridge beside the other app-flag helpers**

In `src/lib/tauri.ts`, immediately before the context-graph helpers, add:

```ts
export type EditorMode = "monaco" | "zed";

export const editorModeGet = () =>
  invoke<EditorMode>("editor_mode_get");

export const editorModeSet = (mode: EditorMode) =>
  invoke<void>("editor_mode_set", { mode });
```

- [ ] **Step 4: Verify tests and type-check**

Run:

```bash
bunx vitest run src/lib/editorMode.test.ts --exclude '**/.worktrees/**'
bunx tsc --noEmit
```

Expected: both contract tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tauri.ts src/lib/editorMode.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat(editor): add typed editor mode bridge"
```

---

## Task 3: Build the root `ZedModeProvider`

**Files:**

- Create: `src/components/editor/ZedModeProvider.tsx`
- Create: `src/components/editor/ZedModeProvider.test.tsx`
- Modify: `src/main.tsx`

**Interfaces:**

```ts
export type ZedModeContextValue = {
  mode: EditorMode;
  vimEnabled: boolean;
  setMode: (mode: EditorMode) => Promise<void>;
  setVimEnabled: (enabled: boolean) => Promise<void>;
};

export const ZED_MODE_CHANGED_EVENT = "zed-mode-changed";
export const ZED_VIM_STORAGE_KEY = "ccie.zed.vimEnabled";
export function useZedMode(): ZedModeContextValue;
```

**Event payload:** `{ mode: EditorMode; vimEnabled: boolean }`. Always send the complete snapshot so newly added detached windows do not need to merge partial state.

- [ ] **Step 1: Write provider tests first**

Create a provider test that covers hydration, persisted writes, live events, the body class, and teardown:

```tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorMode } from "../../lib/tauri";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  emit: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  editorModeGet: mocks.get,
  editorModeSet: mocks.set,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

import {
  ZED_MODE_CHANGED_EVENT,
  ZED_VIM_STORAGE_KEY,
  ZedModeProvider,
  useZedMode,
} from "./ZedModeProvider";

type Payload = { mode: EditorMode; vimEnabled: boolean };
let deliverEvent: ((event: { payload: Payload }) => void) | undefined;

function Probe() {
  const value = useZedMode();
  return (
    <>
      <output data-testid="mode">{value.mode}</output>
      <output data-testid="vim">{String(value.vimEnabled)}</output>
      <button onClick={() => void value.setMode("zed")}>zed</button>
      <button onClick={() => void value.setVimEnabled(true)}>vim</button>
    </>
  );
}

describe("ZedModeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.classList.remove("zed-mode");
    deliverEvent = undefined;
    mocks.get.mockReset().mockResolvedValue("monaco");
    mocks.set.mockReset().mockResolvedValue(undefined);
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.unlisten.mockReset();
    mocks.listen.mockReset().mockImplementation(
      async (_name: string, handler: (event: { payload: Payload }) => void) => {
        deliverEvent = handler;
        return mocks.unlisten;
      },
    );
  });

  it("hydrates persisted mode and applies the scoped body class", async () => {
    mocks.get.mockResolvedValueOnce("zed");
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("zed"));
    expect(document.body).toHaveClass("zed-mode");
  });

  it("persists and broadcasts a complete mode snapshot", async () => {
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    screen.getByRole("button", { name: "zed" }).click();
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith("zed"));
    expect(mocks.emit).toHaveBeenCalledWith(ZED_MODE_CHANGED_EVENT, {
      mode: "zed",
      vimEnabled: false,
    });
  });

  it("applies cross-window events and persists the Vim preference", async () => {
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(deliverEvent).toBeDefined());
    act(() => deliverEvent?.({
      payload: { mode: "zed", vimEnabled: true },
    }));
    expect(screen.getByTestId("vim")).toHaveTextContent("true");
    expect(localStorage.getItem(ZED_VIM_STORAGE_KEY)).toBe("true");
  });

  it("removes listeners and the body class on unmount", async () => {
    mocks.get.mockResolvedValueOnce("zed");
    const view = render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(document.body).toHaveClass("zed-mode"));
    view.unmount();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveClass("zed-mode");
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing module**

Run:

```bash
bunx vitest run src/components/editor/ZedModeProvider.test.tsx --exclude '**/.worktrees/**'
```

Expected: FAIL because `ZedModeProvider.tsx` does not exist.

- [ ] **Step 3: Implement the provider**

Create `src/components/editor/ZedModeProvider.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import {
  emit,
  listen,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import {
  editorModeGet,
  editorModeSet,
  type EditorMode,
} from "../../lib/tauri";

export const ZED_MODE_CHANGED_EVENT = "zed-mode-changed";
export const ZED_VIM_STORAGE_KEY = "ccie.zed.vimEnabled";

type ZedModeChangedPayload = {
  mode: EditorMode;
  vimEnabled: boolean;
};

export type ZedModeContextValue = ZedModeChangedPayload & {
  setMode: (mode: EditorMode) => Promise<void>;
  setVimEnabled: (enabled: boolean) => Promise<void>;
};

const ZedModeContext = createContext<ZedModeContextValue | undefined>(undefined);

function readVimPreference(): boolean {
  try {
    return localStorage.getItem(ZED_VIM_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeVimPreference(enabled: boolean): void {
  try {
    localStorage.setItem(ZED_VIM_STORAGE_KEY, String(enabled));
  } catch (error) {
    console.warn("Failed to persist Vim preference:", error);
  }
}

export function ZedModeProvider({ children }: PropsWithChildren) {
  const [mode, setModeState] = useState<EditorMode>("monaco");
  const [vimEnabled, setVimEnabledState] = useState(readVimPreference);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let receivedLiveEvent = false;

    const applySnapshot = (payload: ZedModeChangedPayload) => {
      setModeState(payload.mode);
      setVimEnabledState(payload.vimEnabled);
      writeVimPreference(payload.vimEnabled);
    };

    void (async () => {
      try {
        const stopListening = await listen<ZedModeChangedPayload>(
          ZED_MODE_CHANGED_EVENT,
          (event) => {
            receivedLiveEvent = true;
            if (!disposed) applySnapshot(event.payload);
          },
        );
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      } catch (error) {
        console.error("Failed to listen for Zed mode changes:", error);
      }

      try {
        const storedMode = await editorModeGet();
        if (!disposed && !receivedLiveEvent) setModeState(storedMode);
      } catch (error) {
        console.error("Failed to load editor mode:", error);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("zed-mode", mode === "zed");
    return () => document.body.classList.remove("zed-mode");
  }, [mode]);

  const broadcast = useCallback(async (payload: ZedModeChangedPayload) => {
    try {
      await emit(ZED_MODE_CHANGED_EVENT, payload);
    } catch (error) {
      console.error("Failed to broadcast Zed mode change:", error);
    }
  }, []);

  const setMode = useCallback(
    async (nextMode: EditorMode) => {
      await editorModeSet(nextMode);
      setModeState(nextMode);
      await broadcast({
        mode: nextMode,
        vimEnabled,
      } satisfies ZedModeChangedPayload);
    },
    [broadcast, vimEnabled],
  );

  const setVimEnabled = useCallback(
    async (enabled: boolean) => {
      writeVimPreference(enabled);
      setVimEnabledState(enabled);
      await broadcast({
        mode,
        vimEnabled: enabled,
      } satisfies ZedModeChangedPayload);
    },
    [broadcast, mode],
  );

  const value = useMemo<ZedModeContextValue>(
    () => ({ mode, vimEnabled, setMode, setVimEnabled }),
    [mode, vimEnabled, setMode, setVimEnabled],
  );

  return (
    <ZedModeContext.Provider value={value}>
      {children}
    </ZedModeContext.Provider>
  );
}

export function useZedMode(): ZedModeContextValue {
  const value = useContext(ZedModeContext);
  if (!value) {
    throw new Error("useZedMode must be used within ZedModeProvider");
  }
  return value;
}
```

- [ ] **Step 4: Mount the provider once**

In `src/main.tsx`, import the provider and change only the root render:

```tsx
import { ZedModeProvider } from "./components/editor/ZedModeProvider";
```

```tsx
ReactDOM.createRoot(root).render(
  <ZedModeProvider>
    <App />
  </ZedModeProvider>,
);
```

- [ ] **Step 5: Verify provider behavior**

Run:

```bash
bunx vitest run src/components/editor/ZedModeProvider.test.tsx --exclude '**/.worktrees/**'
bunx tsc --noEmit
```

Expected: all provider cases pass and `App` is under exactly one provider.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/ZedModeProvider.tsx src/components/editor/ZedModeProvider.test.tsx src/main.tsx
git diff --cached --check
git diff --cached
git commit -m "feat(editor): add live Zed mode provider"
```

---

## Task 4: Add the Settings → Editor UI

**Files:**

- Create: `src/components/settings/EditorSettingsTab.tsx`
- Create: `src/components/settings/EditorSettingsTab.css`
- Create: `src/components/settings/EditorSettingsTab.test.tsx`
- Modify: `src/windows/Settings.tsx`

**Interfaces:**

- Consumes: `useZedMode()`.
- Editor style is an accessible two-button selection with `aria-pressed`.
- Vim is an accessible checkbox, disabled while classic Monaco is active.
- A failed persisted mode write leaves the old state selected and renders `role="alert"`.

- [ ] **Step 1: Write the UI tests**

Create `src/components/settings/EditorSettingsTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "monaco" as "monaco" | "zed",
  vimEnabled: false,
  setMode: vi.fn(),
  setVimEnabled: vi.fn(),
}));

vi.mock("../editor/ZedModeProvider", () => ({
  useZedMode: () => state,
}));

import EditorSettingsTab from "./EditorSettingsTab";

describe("EditorSettingsTab", () => {
  beforeEach(() => {
    state.mode = "monaco";
    state.vimEnabled = false;
    state.setMode.mockReset().mockResolvedValue(undefined);
    state.setVimEnabled.mockReset().mockResolvedValue(undefined);
  });

  it("selects Zed Mode through the provider", async () => {
    render(<EditorSettingsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Zed Mode" }));
    await waitFor(() => expect(state.setMode).toHaveBeenCalledWith("zed"));
  });

  it("disables Vim in classic mode and writes it in Zed Mode", async () => {
    const classic = render(<EditorSettingsTab />);
    expect(screen.getByRole("checkbox", { name: "Vim mode" })).toBeDisabled();
    classic.unmount();

    state.mode = "zed";
    render(<EditorSettingsTab />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Vim mode" }));
    await waitFor(() => expect(state.setVimEnabled).toHaveBeenCalledWith(true));
  });

  it("shows a persistence error without claiming the new mode", async () => {
    state.setMode.mockRejectedValueOnce(new Error("database locked"));
    render(<EditorSettingsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Zed Mode" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("database locked");
    expect(screen.getByRole("button", { name: "Monaco (classic)" }))
      .toHaveAttribute("aria-pressed", "true");
  });
});
```

- [ ] **Step 2: Confirm the missing component failure**

Run:

```bash
bunx vitest run src/components/settings/EditorSettingsTab.test.tsx --exclude '**/.worktrees/**'
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the Settings tab**

Create `src/components/settings/EditorSettingsTab.tsx`:

```tsx
import { useState } from "react";
import { useZedMode } from "../editor/ZedModeProvider";
import type { EditorMode } from "../../lib/tauri";
import "./EditorSettingsTab.css";

export default function EditorSettingsTab() {
  const { mode, vimEnabled, setMode, setVimEnabled } = useZedMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectMode = async (nextMode: EditorMode) => {
    if (nextMode === mode) return;
    setBusy(true);
    setError(null);
    try {
      await setMode(nextMode);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleVim = async (enabled: boolean) => {
    setError(null);
    try {
      await setVimEnabled(enabled);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="editor-settings-tab" data-testid="editor-settings-tab">
      <header>
        <h2>Editor</h2>
        <p>Choose the editor experience used by all code editor tabs.</p>
      </header>

      <div className="editor-settings-section">
        <h3>Editor style</h3>
        <div className="editor-style-picker" role="group" aria-label="Editor style">
          <button
            type="button"
            aria-pressed={mode === "monaco"}
            disabled={busy}
            data-testid="editor-mode-monaco"
            onClick={() => void selectMode("monaco")}
          >
            Monaco (classic)
          </button>
          <button
            type="button"
            aria-pressed={mode === "zed"}
            disabled={busy}
            data-testid="editor-mode-zed"
            onClick={() => void selectMode("zed")}
          >
            Zed Mode
          </button>
        </div>
        <p className="editor-settings-help">
          Changes apply immediately. Zed Mode keeps Monaco and adds Zed-style
          theme, chrome, keybindings, and optional Vim editing.
        </p>
      </div>

      <div className="editor-settings-section">
        <label className="editor-vim-toggle">
          <span>
            <strong>Vim mode</strong>
            <small>Enable modal editing inside Zed Mode editors.</small>
          </span>
          <input
            type="checkbox"
            aria-label="Vim mode"
            checked={vimEnabled}
            disabled={mode !== "zed"}
            onChange={(event) => void toggleVim(event.target.checked)}
          />
        </label>
      </div>

      {error && <div className="editor-settings-error" role="alert">{error}</div>}
    </section>
  );
}
```

Create `src/components/settings/EditorSettingsTab.css`:

```css
.editor-settings-tab {
  color: #d7dae0;
  max-width: 760px;
}

.editor-settings-tab header p,
.editor-settings-help,
.editor-vim-toggle small {
  color: #8f96a3;
}

.editor-settings-section {
  margin-top: 24px;
  padding: 18px;
  border: 1px solid #343842;
  border-radius: 8px;
  background: #1b1e24;
}

.editor-style-picker {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border-radius: 7px;
  background: #111318;
}

.editor-style-picker button {
  padding: 8px 14px;
  border: 1px solid transparent;
  border-radius: 5px;
  color: #aeb4bf;
  background: transparent;
  cursor: pointer;
}

.editor-style-picker button[aria-pressed="true"] {
  color: #eef0f4;
  border-color: #528bff;
  background: #2b313b;
}

.editor-vim-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.editor-vim-toggle span {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.editor-vim-toggle input {
  width: 18px;
  height: 18px;
}

.editor-settings-error {
  margin-top: 16px;
  color: #e06c75;
}
```

- [ ] **Step 4: Register the tab in the existing Settings window**

In `src/windows/Settings.tsx`:

1. Import `EditorSettingsTab` from `../components/settings/EditorSettingsTab`.
2. Add `"editor"` to the `activeTab` union.
3. Add an **Editor** tab button immediately after **General**:

```tsx
<button
  className={activeTab === "editor" ? "active" : ""}
  onClick={() => setActiveTab("editor")}
>
  Editor
</button>
```

4. Add the panel directly after the General panel:

```tsx
{activeTab === "editor" && <EditorSettingsTab />}
```

- [ ] **Step 5: Verify behavior and registration**

Run:

```bash
bunx vitest run src/components/settings/EditorSettingsTab.test.tsx --exclude '**/.worktrees/**'
bunx tsc --noEmit
```

Expected: three UI tests pass; the Settings union/import/render all type-check.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/EditorSettingsTab.tsx src/components/settings/EditorSettingsTab.css src/components/settings/EditorSettingsTab.test.tsx src/windows/Settings.tsx
git diff --cached --check
git diff --cached
git commit -m "feat(settings): add Editor style and Vim controls"
```

---

## Task 5: Define One Dark and switch Monaco theme/font live

**Files:**

- Create: `src/components/editor/themes/zed-one-dark.ts`
- Create: `src/components/editor/themes/zed-one-dark.test.ts`
- Modify: `src/components/editor/MonacoEditor.tsx`

**Interfaces:**

- Produces: `ZED_ONE_DARK_THEME_ID = "ccie-zed-one-dark"`
- Produces: `themeForEditorMode(mode)`, `fontFamilyForEditorMode(mode)`, and `applyEditorModeTheme(monaco, mode)`.
- Invariant: classic mode always selects exact current theme `"vs-dark"` and exact current font family `"'SF Mono', 'Menlo', 'Monaco', monospace"`.

- [ ] **Step 1: Write theme selection tests**

Create `src/components/editor/themes/zed-one-dark.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  CLASSIC_MONACO_THEME_ID,
  ZED_ONE_DARK_THEME_ID,
  applyEditorModeTheme,
  fontFamilyForEditorMode,
  themeForEditorMode,
} from "./zed-one-dark";

function fakeMonaco() {
  const defineTheme = vi.fn();
  const setTheme = vi.fn();
  return {
    monaco: { editor: { defineTheme, setTheme } } as unknown as typeof Monaco,
    defineTheme,
    setTheme,
  };
}

describe("Zed One Dark theme", () => {
  it("defines and applies Zed One Dark in Zed Mode", () => {
    const fake = fakeMonaco();
    applyEditorModeTheme(fake.monaco, "zed");
    expect(fake.defineTheme).toHaveBeenCalledWith(
      ZED_ONE_DARK_THEME_ID,
      expect.objectContaining({ base: "vs-dark", inherit: true }),
    );
    expect(fake.setTheme).toHaveBeenCalledWith(ZED_ONE_DARK_THEME_ID);
  });

  it("restores classic Monaco without redefining the Zed theme", () => {
    const fake = fakeMonaco();
    applyEditorModeTheme(fake.monaco, "monaco");
    expect(fake.defineTheme).not.toHaveBeenCalled();
    expect(fake.setTheme).toHaveBeenCalledWith(CLASSIC_MONACO_THEME_ID);
    expect(themeForEditorMode("monaco")).toBe("vs-dark");
    expect(fontFamilyForEditorMode("monaco"))
      .toBe("'SF Mono', 'Menlo', 'Monaco', monospace");
  });
});
```

- [ ] **Step 2: Confirm the missing theme module**

Run:

```bash
bunx vitest run src/components/editor/themes/zed-one-dark.test.ts --exclude '**/.worktrees/**'
```

Expected: FAIL because the theme module does not exist.

- [ ] **Step 3: Implement the theme and exact fallback**

Create `src/components/editor/themes/zed-one-dark.ts`:

```ts
import type * as Monaco from "monaco-editor";
import type { EditorMode } from "../../../lib/tauri";

export const CLASSIC_MONACO_THEME_ID = "vs-dark";
export const ZED_ONE_DARK_THEME_ID = "ccie-zed-one-dark";

const CLASSIC_FONT = "'SF Mono', 'Menlo', 'Monaco', monospace";
const ZED_FONT =
  '"Zed Mono", "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace';

export const ZED_ONE_DARK_THEME: Monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5C6370", fontStyle: "italic" },
    { token: "keyword", foreground: "C678DD" },
    { token: "string", foreground: "98C379" },
    { token: "number", foreground: "D19A66" },
    { token: "type.identifier", foreground: "E5C07B" },
    { token: "identifier.function", foreground: "61AFEF" },
    { token: "variable", foreground: "E06C75" },
    { token: "regexp", foreground: "56B6C2" },
    { token: "delimiter", foreground: "ABB2BF" },
  ],
  colors: {
    "editor.background": "#282C34",
    "editor.foreground": "#ABB2BF",
    "editorCursor.foreground": "#528BFF",
    "editor.selectionBackground": "#3E4451",
    "editor.inactiveSelectionBackground": "#343842",
    "editor.lineHighlightBackground": "#2C313C",
    "editorLineNumber.foreground": "#636D83",
    "editorLineNumber.activeForeground": "#ABB2BF",
    "editorGutter.background": "#282C34",
    "editorIndentGuide.background1": "#3B4048",
    "editorIndentGuide.activeBackground1": "#5C6370",
    "editorWhitespace.foreground": "#3B4048",
    "editorWidget.background": "#21252B",
    "editorWidget.border": "#3E4451",
    "editorSuggestWidget.selectedBackground": "#2C313C",
  },
};

export function themeForEditorMode(mode: EditorMode): string {
  return mode === "zed" ? ZED_ONE_DARK_THEME_ID : CLASSIC_MONACO_THEME_ID;
}

export function fontFamilyForEditorMode(mode: EditorMode): string {
  return mode === "zed" ? ZED_FONT : CLASSIC_FONT;
}

export function applyEditorModeTheme(
  monaco: typeof Monaco,
  mode: EditorMode,
): void {
  if (mode === "zed") {
    monaco.editor.defineTheme(ZED_ONE_DARK_THEME_ID, ZED_ONE_DARK_THEME);
  }
  monaco.editor.setTheme(themeForEditorMode(mode));
}
```

- [ ] **Step 4: Wire theme and font switching into Monaco**

In `MonacoEditor.tsx`:

1. Import `useZedMode` and the three theme helpers.
2. Read `const { mode } = useZedMode();`.
3. Immediately before the existing `monaco.editor.create` call, add:

```ts
if (mode === "zed") {
  applyEditorModeTheme(monaco, mode);
}
```

4. In the existing options object, replace only the hard-coded `theme` and
   `fontFamily` values with:

```ts
theme: themeForEditorMode(mode),
fontFamily: fontFamilyForEditorMode(mode),
```

5. Add a live theme effect:

```ts
useEffect(() => {
  if (!monaco) return;
  applyEditorModeTheme(monaco, mode);
}, [monaco, mode]);
```

6. Add `fontFamily: fontFamilyForEditorMode(mode)` to the existing `updateOptions` effect and change its dependencies to `[settings, mode]`.
7. Add `data-editor-theme={themeForEditorMode(mode)}` to `.monaco-editor-wrapper`.

- [ ] **Step 5: Verify theme helpers and integration type safety**

Run:

```bash
bunx vitest run src/components/editor/themes/zed-one-dark.test.ts --exclude '**/.worktrees/**'
bunx tsc --noEmit
```

Expected: theme tests pass; Monaco's public API accepts the theme and option types.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/themes/zed-one-dark.ts src/components/editor/themes/zed-one-dark.test.ts src/components/editor/MonacoEditor.tsx
git diff --cached --check
git diff --cached
git commit -m "feat(editor): add live Zed One Dark theme"
```

---

## Task 6: Register reversible Zed keybindings without triggering app shortcuts

**Files:**

- Modify: `src/hooks/useKeyboardShortcut.ts`
- Create: `src/hooks/useKeyboardShortcut.test.tsx`
- Create: `src/components/editor/zedKeybindings.ts`
- Create: `src/components/editor/zedKeybindings.test.ts`
- Modify: `src/components/editor/MonacoEditor.tsx`

**Interfaces:**

- `useKeyboardShortcut` ignores `KeyboardEvent.defaultPrevented`.
- `installZedKeybindings(editor, monaco): Monaco.IDisposable` installs only the approved Zed bindings and returns one complete teardown handle.
- Zed bindings:
  - ⌘⇧P — app command palette through `emit("menu:open_palette")`
  - ⌘D — next matching selection
  - ⌘⌥↑ / ⌘⌥↓ — insert cursor above/below
  - ⌥↑ / ⌥↓ — move line
  - ⌥⇧↑ / ⌥⇧↓ — duplicate line
- Deliberately absent: ⌘⇧L.

- [ ] **Step 1: Prove the global hook currently reacts to consumed events**

Create `src/hooks/useKeyboardShortcut.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKeyboardShortcut } from "./useKeyboardShortcut";

function Harness({ onHit }: { onHit: () => void }) {
  useKeyboardShortcut("d", onHit, { cmd: true });
  return null;
}

describe("useKeyboardShortcut", () => {
  it("ignores a key event already consumed by a focused editor", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const onHit = vi.fn();
    render(<Harness onHit={onHit} />);

    const event = new KeyboardEvent("keydown", {
      key: "d",
      metaKey: true,
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(onHit).not.toHaveBeenCalled();
  });
});
```

Run:

```bash
bunx vitest run src/hooks/useKeyboardShortcut.test.tsx --exclude '**/.worktrees/**'
```

Expected: FAIL because the current hook does not inspect `defaultPrevented`.

- [ ] **Step 2: Add the consumed-event guard**

At the first line of the hook's `handler`:

```ts
if (e.defaultPrevented) return;
```

Re-run the test; expected PASS. This is the protection that lets Monaco own ⌘D and ⌘⌥Arrow without invoking `usePaneSplit`.

- [ ] **Step 3: Write keybinding installation/teardown tests**

Create `src/components/editor/zedKeybindings.test.ts` with a fake editor that records `addAction`, `onKeyDown`, and every disposable:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { emit } from "@tauri-apps/api/event";
import { installZedKeybindings } from "./zedKeybindings";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));

const key = {
  KeyP: 1,
  KeyD: 2,
  KeyL: 3,
  UpArrow: 4,
  DownArrow: 5,
};
const mod = { CtrlCmd: 1 << 8, Shift: 1 << 9, Alt: 1 << 10 };

function harness() {
  const actionDisposers: Array<ReturnType<typeof vi.fn>> = [];
  const actions: Monaco.editor.IActionDescriptor[] = [];
  let keyHandler: ((event: Monaco.IKeyboardEvent) => void) | undefined;
  const keyDispose = vi.fn();
  const runBuiltIn = vi.fn().mockResolvedValue(undefined);

  const editor = {
    addAction: vi.fn((action: Monaco.editor.IActionDescriptor) => {
      actions.push(action);
      const dispose = vi.fn();
      actionDisposers.push(dispose);
      return { dispose };
    }),
    getAction: vi.fn(() => ({ run: runBuiltIn })),
    onKeyDown: vi.fn((handler: (event: Monaco.IKeyboardEvent) => void) => {
      keyHandler = handler;
      return { dispose: keyDispose };
    }),
  } as unknown as Monaco.editor.IStandaloneCodeEditor;

  const monaco = {
    KeyCode: key,
    KeyMod: mod,
  } as unknown as typeof Monaco;

  return {
    editor,
    monaco,
    actions,
    actionDisposers,
    keyDispose,
    runBuiltIn,
    deliverKey: (event: Monaco.IKeyboardEvent) => keyHandler?.(event),
  };
}

describe("installZedKeybindings", () => {
  beforeEach(() => vi.mocked(emit).mockReset().mockResolvedValue(undefined));

  it("registers the approved actions and omits Cmd+Shift+L", () => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);
    const ids = h.actions.map((action) => action.id);
    expect(ids).toContain("ccie.zed.commandPalette");
    expect(ids).toContain("ccie.zed.addSelectionNext");

    const forbidden = mod.CtrlCmd | mod.Shift | key.KeyL;
    const allBindings = h.actions.flatMap((action) => action.keybindings ?? []);
    expect(allBindings).not.toContain(forbidden);
  });

  it("bridges the command palette and consumes an owned chord", async () => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);
    const palette = h.actions.find(
      (action) => action.id === "ccie.zed.commandPalette",
    );
    expect(palette).toBeDefined();
    await palette?.run(h.editor);
    expect(emit).toHaveBeenCalledWith("menu:open_palette");

    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    h.deliverKey({
      keyCode: key.KeyD,
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault,
      stopPropagation,
    } as unknown as Monaco.IKeyboardEvent);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("disposes the key listener and every action", () => {
    const h = harness();
    const installed = installZedKeybindings(h.editor, h.monaco);
    installed.dispose();
    expect(h.keyDispose).toHaveBeenCalledOnce();
    for (const dispose of h.actionDisposers) {
      expect(dispose).toHaveBeenCalledOnce();
    }
  });
});
```

- [ ] **Step 4: Confirm the keybinding module is missing**

Run:

```bash
bunx vitest run src/components/editor/zedKeybindings.test.ts --exclude '**/.worktrees/**'
```

Expected: FAIL because `zedKeybindings.ts` does not exist.

- [ ] **Step 5: Implement focused actions and complete teardown**

Create `src/components/editor/zedKeybindings.ts`:

```ts
import { emit } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";

function runEditorAction(
  editor: Monaco.editor.IStandaloneCodeEditor,
  actionId: string,
): Promise<void> {
  const action = editor.getAction(actionId);
  return action ? action.run() : Promise.resolve();
}

function isOwnedZedChord(
  event: Monaco.IKeyboardEvent,
  monaco: typeof Monaco,
): boolean {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const verticalArrow =
    event.keyCode === monaco.KeyCode.UpArrow ||
    event.keyCode === monaco.KeyCode.DownArrow;

  return (
    (primary && event.shiftKey && !event.altKey &&
      event.keyCode === monaco.KeyCode.KeyP) ||
    (primary && !event.shiftKey && !event.altKey &&
      event.keyCode === monaco.KeyCode.KeyD) ||
    (primary && event.altKey && !event.shiftKey && verticalArrow) ||
    (!primary && event.altKey && verticalArrow)
  );
}

export function installZedKeybindings(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
): Monaco.IDisposable {
  const actions: Monaco.IDisposable[] = [
    editor.addAction({
      id: "ccie.zed.commandPalette",
      label: "Zed: Command Palette",
      keybindings: [
        monaco.KeyMod.CtrlCmd |
          monaco.KeyMod.Shift |
          monaco.KeyCode.KeyP,
      ],
      run: () => emit("menu:open_palette"),
    }),
    editor.addAction({
      id: "ccie.zed.addSelectionNext",
      label: "Zed: Add Selection to Next Match",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD],
      run: () => runEditorAction(
        editor,
        "editor.action.addSelectionToNextFindMatch",
      ),
    }),
    editor.addAction({
      id: "ccie.zed.cursorAbove",
      label: "Zed: Add Cursor Above",
      keybindings: [
        monaco.KeyMod.CtrlCmd |
          monaco.KeyMod.Alt |
          monaco.KeyCode.UpArrow,
      ],
      run: () => runEditorAction(editor, "editor.action.insertCursorAbove"),
    }),
    editor.addAction({
      id: "ccie.zed.cursorBelow",
      label: "Zed: Add Cursor Below",
      keybindings: [
        monaco.KeyMod.CtrlCmd |
          monaco.KeyMod.Alt |
          monaco.KeyCode.DownArrow,
      ],
      run: () => runEditorAction(editor, "editor.action.insertCursorBelow"),
    }),
    editor.addAction({
      id: "ccie.zed.moveLineUp",
      label: "Zed: Move Line Up",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.UpArrow],
      run: () => runEditorAction(editor, "editor.action.moveLinesUpAction"),
    }),
    editor.addAction({
      id: "ccie.zed.moveLineDown",
      label: "Zed: Move Line Down",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.DownArrow],
      run: () => runEditorAction(editor, "editor.action.moveLinesDownAction"),
    }),
    editor.addAction({
      id: "ccie.zed.duplicateLineUp",
      label: "Zed: Duplicate Line Up",
      keybindings: [
        monaco.KeyMod.Alt |
          monaco.KeyMod.Shift |
          monaco.KeyCode.UpArrow,
      ],
      run: () => runEditorAction(editor, "editor.action.copyLinesUpAction"),
    }),
    editor.addAction({
      id: "ccie.zed.duplicateLineDown",
      label: "Zed: Duplicate Line Down",
      keybindings: [
        monaco.KeyMod.Alt |
          monaco.KeyMod.Shift |
          monaco.KeyCode.DownArrow,
      ],
      run: () => runEditorAction(editor, "editor.action.copyLinesDownAction"),
    }),
  ];

  const keyListener = editor.onKeyDown((event) => {
    if (!isOwnedZedChord(event, monaco)) return;
    event.preventDefault();
    event.stopPropagation();
  });

  return {
    dispose() {
      keyListener.dispose();
      actions.forEach((action) => action.dispose());
    },
  };
}
```

- [ ] **Step 6: Install only while Zed Mode is active**

In `MonacoEditor.tsx`, import `installZedKeybindings` and add this effect **after editor creation but before the Vim hook added in Task 7**:

```ts
useEffect(() => {
  if (!monaco || !editorRef.current || mode !== "zed") return;
  const installed = installZedKeybindings(editorRef.current, monaco);
  return () => installed.dispose();
}, [monaco, mode]);
```

- [ ] **Step 7: Verify shortcut behavior**

Run:

```bash
bunx vitest run src/hooks/useKeyboardShortcut.test.tsx src/components/editor/zedKeybindings.test.ts --exclude '**/.worktrees/**'
bunx tsc --noEmit
```

Expected: consumed events do not invoke global callbacks; every Zed action and listener is disposed.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useKeyboardShortcut.ts src/hooks/useKeyboardShortcut.test.tsx src/components/editor/zedKeybindings.ts src/components/editor/zedKeybindings.test.ts src/components/editor/MonacoEditor.tsx
git diff --cached --check
git diff --cached
git commit -m "feat(editor): add scoped reversible Zed keybindings"
```

---

## Task 7: Add optional `monaco-vim` with exact attach/detach lifecycle

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `src/components/editor/useVimMode.ts`
- Create: `src/components/editor/useVimMode.test.tsx`
- Create: `src/components/editor/MonacoEditor.css`
- Modify: `src/components/editor/MonacoEditor.tsx`
- Modify: `src/components/editor/EditorTab.tsx`
- Modify: `src/components/editor/EditorTab.css`

**Interfaces:**

- Dependency: exact `monaco-vim@0.4.4`.
- Produces: `useVimMode(editor, statusRef, enabled): void`.
- Invariant: one enabled editor gets one `initVimMode` handle; disabling, changing editor, or unmounting calls that handle's `dispose()` exactly once and clears stale status text.
- Every `MonacoEditor` gets Vim behavior. `EditorTab` supplies its visible status-bar ref; other shared Monaco hosts use the component's small fallback status overlay.
- The Zed keydown handler from Task 6 is registered before `initVimMode`, matching `monaco-vim`'s integration guidance for app-owned keys.

- [ ] **Step 1: Add the pinned dependency**

Run:

```bash
bun add monaco-vim@0.4.4
```

Inspect the diff and confirm no unrelated dependency versions changed:

```bash
git diff -- package.json bun.lock
```

- [ ] **Step 2: Write lifecycle tests**

Create `src/components/editor/useVimMode.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("monaco-vim", () => ({
  initVimMode: mocks.init,
}));

import { useVimMode } from "./useVimMode";

describe("useVimMode", () => {
  beforeEach(() => {
    mocks.init.mockReset();
    mocks.dispose.mockReset();
    mocks.init.mockReturnValue({ dispose: mocks.dispose });
  });

  it("attaches once when enabled and disposes when disabled", () => {
    const editor = {} as Monaco.editor.IStandaloneCodeEditor;
    const status = document.createElement("span");
    const statusRef = { current: status };
    const view = renderHook(
      ({ enabled }) => useVimMode(editor, statusRef, enabled),
      { initialProps: { enabled: false } },
    );
    expect(mocks.init).not.toHaveBeenCalled();

    view.rerender({ enabled: true });
    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.init).toHaveBeenCalledWith(editor, status);

    status.textContent = "-- NORMAL --";
    view.rerender({ enabled: false });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(status).toHaveTextContent("");
  });

  it("disposes an active Vim handle on unmount", () => {
    const editor = {} as Monaco.editor.IStandaloneCodeEditor;
    const statusRef = { current: document.createElement("span") };
    const view = renderHook(() => useVimMode(editor, statusRef, true));
    view.unmount();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Confirm the missing hook failure**

Run:

```bash
bunx vitest run src/components/editor/useVimMode.test.tsx --exclude '**/.worktrees/**'
```

Expected: FAIL because `useVimMode.ts` does not exist.

- [ ] **Step 4: Implement the lifecycle hook**

Create `src/components/editor/useVimMode.ts`:

```ts
import { useEffect, type RefObject } from "react";
import { initVimMode } from "monaco-vim";
import type * as Monaco from "monaco-editor";

export function useVimMode(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  statusRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
): void {
  useEffect(() => {
    const statusElement = statusRef?.current;
    if (!enabled || !editor || !statusElement) return;

    const vimMode = initVimMode(editor, statusElement);
    return () => {
      vimMode.dispose();
      statusElement.textContent = "";
    };
  }, [editor, statusRef, enabled]);
}
```

- [ ] **Step 5: Expose the editor instance and compose the hook**

In `MonacoEditor.tsx`:

1. Import `type RefObject`, `useVimMode`, and read both `{ mode, vimEnabled }`.
2. Add this optional prop:

```ts
vimStatusRef?: RefObject<HTMLSpanElement | null>;
```

3. Add state next to the existing `monaco` state:

```ts
const [editorInstance, setEditorInstance] =
  useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
const fallbackVimStatusRef = useRef<HTMLSpanElement | null>(null);
const activeVimStatusRef = vimStatusRef ?? fallbackVimStatusRef;
```

4. Immediately after `editorRef.current = editor`, call:

```ts
setEditorInstance(editor);
```

5. Change the Task 6 keybinding effect to consume `editorInstance`, so its
   setup and cleanup participate in the same explicit lifecycle:

```ts
useEffect(() => {
  if (!monaco || !editorInstance || mode !== "zed") return;
  const installed = installZedKeybindings(editorInstance, monaco);
  return () => installed.dispose();
}, [monaco, editorInstance, mode]);
```

6. Immediately after that effect, invoke:

```ts
useVimMode(
  editorInstance,
  activeVimStatusRef,
  mode === "zed" && vimEnabled,
);
```

7. In the existing editor-creation cleanup, retain cleanup for content,
   cursor, and Ask-AI disposables, but remove the direct `editor.dispose()` and
   `editorRef.current = null` calls. Then, **after** `useVimMode`, add the final
   editor-disposal effect:

```ts
useEffect(() => {
  if (!editorInstance) return;
  return () => {
    editorInstance.dispose();
    if (editorRef.current === editorInstance) {
      editorRef.current = null;
    }
  };
}, [editorInstance]);
```

This declaration order guarantees keybinding cleanup, then Vim cleanup, then
Monaco disposal on unmount. It avoids asking `monaco-vim` to detach from an
already-disposed editor.

8. Replace the final Monaco container return with a full-size shell. Keep the
   existing error/loading returns above it unchanged:

```tsx
return (
  <div className="monaco-editor-shell">
    <div
      ref={containerRef}
      className="monaco-editor-wrapper"
      data-editor-mode={mode}
      data-editor-theme={themeForEditorMode(mode)}
      data-vim-enabled={String(mode === "zed" && vimEnabled)}
      style={{ height: "100%", width: "100%" }}
    />
    {!vimStatusRef && (
      <span
        ref={fallbackVimStatusRef}
        className="zed-vim-status zed-vim-status--overlay"
        aria-live="polite"
      />
    )}
  </div>
);
```

Import `./MonacoEditor.css` and create that stylesheet:

```css
.monaco-editor-shell {
  position: relative;
  width: 100%;
  height: 100%;
}

.zed-vim-status--overlay {
  display: none;
}

.zed-mode .zed-vim-status--overlay:not(:empty) {
  position: absolute;
  z-index: 5;
  bottom: 3px;
  left: 8px;
  display: block;
  padding: 1px 5px;
  color: #98c379;
  background: rgb(33 37 43 / 92%);
  border-radius: 3px;
  font: 600 11px/18px "SFMono-Regular", Menlo, monospace;
  pointer-events: none;
}
```

- [ ] **Step 6: Provide a stable visible status element from `EditorTab`**

In `EditorTab.tsx`, add:

```ts
const vimStatusRef = useRef<HTMLSpanElement | null>(null);
```

Pass `vimStatusRef={vimStatusRef}` to `MonacoEditor`. Replace the existing status bar contents with:

```tsx
<div className="editor-status-bar">
  <span
    ref={vimStatusRef}
    className="zed-vim-status"
    aria-live="polite"
  />
  <span>
    Ln {state.cursor_position.line}, Col {state.cursor_position.column}
  </span>
  <span>{state.language}</span>
</div>
```

In `EditorTab.css`, add:

```css
.zed-vim-status:empty {
  display: none;
}
```

The empty span is visually absent in classic mode; it exists only to give `monaco-vim` a stable DOM target.

- [ ] **Step 7: Verify dependency, lifecycle, and build**

Run:

```bash
bunx vitest run src/components/editor/useVimMode.test.tsx --exclude '**/.worktrees/**'
bunx tsc --noEmit
bun run build
```

Expected: hook tests pass, `monaco-vim` types resolve, and the production bundle builds.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock src/components/editor/useVimMode.ts src/components/editor/useVimMode.test.tsx src/components/editor/MonacoEditor.css src/components/editor/MonacoEditor.tsx src/components/editor/EditorTab.tsx src/components/editor/EditorTab.css
git diff --cached --check
git diff --cached
git commit -m "feat(editor): add optional Monaco Vim mode"
```

---

## Task 8: Add Zed breadcrumbs and fully scoped editor chrome

**Files:**

- Create: `src/components/editor/EditorBreadcrumbs.tsx`
- Create: `src/components/editor/EditorBreadcrumbs.test.tsx`
- Create: `src/components/editor/zed-mode.css`
- Modify: `src/components/editor/EditorTab.tsx`
- Modify: `src/components/editor/EditorTab.css`
- Modify: `src/main.tsx`

**Interfaces:**

- Produces: `breadcrumbSegments(filePath, rootPath): string[]`.
- Breadcrumbs render only in Zed Mode and only when a file is open.
- `.zed-mode` CSS can style global tabs because the provider places that class on `body`; every selector remains explicitly scoped.
- The classic editor keeps the existing toolbar, sizing, colors, and hidden breadcrumb.

- [ ] **Step 1: Write breadcrumb derivation/render tests**

Create `src/components/editor/EditorBreadcrumbs.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EditorBreadcrumbs,
  breadcrumbSegments,
} from "./EditorBreadcrumbs";

describe("EditorBreadcrumbs", () => {
  it("uses a project-root-relative path when possible", () => {
    expect(
      breadcrumbSegments(
        "/work/project/src/components/App.tsx",
        "/work/project",
      ),
    ).toEqual(["src", "components", "App.tsx"]);
  });

  it("falls back to absolute path segments outside the root", () => {
    expect(
      breadcrumbSegments("/tmp/example.py", "/work/project"),
    ).toEqual(["tmp", "example.py"]);
  });

  it("renders ordered segments with the file marked current", () => {
    render(
      <EditorBreadcrumbs
        filePath="/work/project/src/main.tsx"
        rootPath="/work/project"
      />,
    );
    expect(screen.getByLabelText("Editor breadcrumb"))
      .toHaveTextContent("src›main.tsx");
    expect(screen.getByText("main.tsx")).toHaveAttribute("aria-current", "page");
  });
});
```

- [ ] **Step 2: Confirm the missing component failure**

Run:

```bash
bunx vitest run src/components/editor/EditorBreadcrumbs.test.tsx --exclude '**/.worktrees/**'
```

Expected: FAIL because the breadcrumb module does not exist.

- [ ] **Step 3: Implement the breadcrumb component**

Create `src/components/editor/EditorBreadcrumbs.tsx`:

```tsx
export function breadcrumbSegments(
  filePath: string,
  rootPath: string | null,
): string[] {
  const normalizedRoot = rootPath?.replace(/\/+$/, "") ?? null;
  const relative =
    normalizedRoot &&
    (filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}/`))
      ? filePath.slice(normalizedRoot.length)
      : filePath;

  return relative.split("/").filter(Boolean);
}

export function EditorBreadcrumbs({
  filePath,
  rootPath,
}: {
  filePath: string;
  rootPath: string | null;
}) {
  const segments = breadcrumbSegments(filePath, rootPath);
  return (
    <nav className="editor-breadcrumb" aria-label="Editor breadcrumb">
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <span className="editor-breadcrumb-part" key={`${segment}-${index}`}>
            {index > 0 && <span className="editor-breadcrumb-separator">›</span>}
            <span aria-current={isLast ? "page" : undefined}>{segment}</span>
          </span>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Insert the breadcrumb without breaking Monaco sizing**

In `EditorTab.tsx`:

1. Import `useZedMode` and `EditorBreadcrumbs`.
2. Read `const { mode } = useZedMode();`.
3. Replace the current `.editor-content` block with this complete equivalent
   structure:

```tsx
<div className="editor-content">
  {mode === "zed" && state.file_path && (
    <EditorBreadcrumbs
      filePath={state.file_path}
      rootPath={state.root_path}
    />
  )}
  <div className="editor-canvas">
    <MonacoEditor
      value={state.content}
      language={state.language}
      onChange={(content) => setContent(tab.id, content)}
      onCursorChange={(pos) => setCursor(tab.id, pos.line, pos.column)}
      onSave={onSave}
      settings={settings}
      tabId={tab.id}
      filePath={state.file_path}
      vimStatusRef={vimStatusRef}
      onEditorReady={(editor) => {
        editorRef.current = editor;
      }}
    />
    {showFind && (
      <FindReplace
        editor={editorRef.current}
        onClose={() => setShowFind(false)}
      />
    )}
    {showSettings && (
      <EditorSettingsPanel
        settings={settings}
        onSave={setSettings}
        onClose={() => setShowSettings(false)}
      />
    )}
  </div>
</div>
```

4. Add `data-editor-mode={mode}` to the root `[data-testid="editor-tab"]`.

In `EditorTab.css`, add the classic-safe canvas rule:

```css
.editor-canvas {
  position: relative;
  height: 100%;
  min-height: 0;
}
```

- [ ] **Step 5: Add only `.zed-mode`-scoped chrome**

Create `src/components/editor/zed-mode.css`:

```css
.zed-mode .tabbar {
  gap: 0;
  padding: 2px 8px 0;
  min-height: 30px;
  background: #181a1f;
  border-bottom-color: #30343d;
}

.zed-mode .tab {
  gap: 6px;
  padding: 3px 9px;
  border-radius: 0;
  border-right: 1px solid #30343d;
  background: #1f2228;
  color: #7f8794;
}

.zed-mode .tab-active {
  background: #282c34;
  color: #d7dae0;
}

.zed-mode .editor-tab {
  background: #282c34;
  color: #abb2bf;
  font-family: -apple-system, BlinkMacSystemFont, "Zed Sans", sans-serif;
}

.zed-mode .editor-toolbar {
  min-height: 28px;
  padding: 3px 8px;
  background: #21252b;
  border-bottom-color: #30343d;
}

.zed-mode .editor-file-info {
  gap: 6px;
  font-size: 12px;
}

.zed-mode .editor-actions {
  gap: 4px;
}

.zed-mode .editor-actions button {
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: 3px;
  color: #abb2bf;
  background: transparent;
}

.zed-mode .editor-actions button:hover:not(:disabled) {
  border-color: #3e4451;
  background: #2c313c;
}

.zed-mode .editor-content {
  display: flex;
  flex-direction: column;
}

.zed-mode .editor-canvas {
  flex: 1;
  height: auto;
  min-height: 0;
}

.zed-mode .editor-breadcrumb {
  display: flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  overflow: hidden;
  color: #7f8794;
  background: #282c34;
  border-bottom: 1px solid #30343d;
  font-size: 11px;
  white-space: nowrap;
}

.zed-mode .editor-breadcrumb-part {
  display: inline-flex;
  align-items: center;
}

.zed-mode .editor-breadcrumb-separator {
  padding: 0 5px;
  color: #5c6370;
}

.zed-mode .editor-breadcrumb [aria-current="page"] {
  color: #c8ccd4;
}

.zed-mode .editor-status-bar {
  min-height: 20px;
  padding: 1px 8px;
  gap: 12px;
  justify-content: flex-end;
  background: #21252b;
  color: #8f96a3;
  border-top: 1px solid #30343d;
}

.zed-mode .zed-vim-status {
  margin-right: auto;
  color: #98c379;
  font-weight: 600;
}
```

Import the stylesheet once from `src/main.tsx`:

```ts
import "./components/editor/zed-mode.css";
```

Remove any duplicate component-local import if Step 4 added one; the final code must have exactly one global import.

- [ ] **Step 6: Verify unit behavior and production CSS bundling**

Run:

```bash
bunx vitest run src/components/editor/EditorBreadcrumbs.test.tsx --exclude '**/.worktrees/**'
bunx tsc --noEmit
bun run build
```

Expected: path tests pass, TypeScript passes, and Vite includes the new stylesheet.

- [ ] **Step 7: Commit**

```bash
git add src/components/editor/EditorBreadcrumbs.tsx src/components/editor/EditorBreadcrumbs.test.tsx src/components/editor/zed-mode.css src/components/editor/EditorTab.tsx src/components/editor/EditorTab.css src/main.tsx
git diff --cached --check
git diff --cached
git commit -m "feat(editor): add scoped Zed chrome and breadcrumbs"
```

---

## Task 9: Add the end-to-end toggle test and complete the verification matrix

**Files:**

- Create: `e2e/tests/zed-mode.spec.ts`
- Test only: all Phase 1 files from Tasks 1–8

**Interfaces and acceptance seam:**

- Settings controls expose `data-testid="editor-mode-zed"` and `"editor-mode-monaco"`.
- Editor roots expose `data-editor-mode`.
- Monaco wrappers expose `data-editor-theme` and `data-vim-enabled`.
- The E2E flow must return the persisted mode to classic at the end so it does not contaminate other tests.

- [ ] **Step 1: Add the Settings-to-editor E2E flow**

Create `e2e/tests/zed-mode.spec.ts`:

```ts
import { test, expect } from "../fixtures";

test.describe("Zed Mode foundation", () => {
  test("applies Zed Mode live and cleanly returns to classic Monaco", async ({
    tauriPage,
  }) => {
    await tauriPage.waitForSelector(".tabbar", { timeout: 10_000 });

    await tauriPage.locator(".tab-settings").click();
    await tauriPage.locator(".settings-tabs button", { hasText: "Editor" }).click();
    await expect(
      tauriPage.locator('[data-testid="editor-settings-tab"]'),
    ).toBeVisible();

    await tauriPage.locator('[data-testid="editor-mode-zed"]').click();
    await expect(tauriPage.locator("body")).toHaveClass(/zed-mode/);

    const vim = tauriPage.getByRole("checkbox", { name: "Vim mode" });
    await expect(vim).toBeEnabled();
    await vim.check();
    await tauriPage.locator(".settings-header .close-btn").click();

    await tauriPage.locator('[data-testid="tab-new-chooser"]').click();
    await tauriPage.locator('[data-testid="tab-new-editor"]').click();

    const editorTab = tauriPage.locator('[data-testid="editor-tab"]');
    const monaco = tauriPage.locator(".monaco-editor-wrapper");
    await expect(editorTab).toHaveAttribute("data-editor-mode", "zed");
    await expect(monaco).toHaveAttribute(
      "data-editor-theme",
      "ccie-zed-one-dark",
    );
    await expect(monaco).toHaveAttribute("data-vim-enabled", "true");

    await tauriPage.locator(".tab-settings").click();
    await tauriPage.locator(".settings-tabs button", { hasText: "Editor" }).click();
    await tauriPage.locator('[data-testid="editor-mode-monaco"]').click();
    await expect(tauriPage.locator("body")).not.toHaveClass(/zed-mode/);
    await tauriPage.locator(".settings-header .close-btn").click();

    await expect(editorTab).toHaveAttribute("data-editor-mode", "monaco");
    await expect(monaco).toHaveAttribute("data-editor-theme", "vs-dark");
    await expect(monaco).toHaveAttribute("data-vim-enabled", "false");
  });
});
```

- [ ] **Step 2: Run all focused frontend tests**

Run:

```bash
bunx vitest run \
  src/lib/editorMode.test.ts \
  src/components/editor/ZedModeProvider.test.tsx \
  src/components/settings/EditorSettingsTab.test.tsx \
  src/components/editor/themes/zed-one-dark.test.ts \
  src/hooks/useKeyboardShortcut.test.tsx \
  src/components/editor/zedKeybindings.test.ts \
  src/components/editor/useVimMode.test.tsx \
  src/components/editor/EditorBreadcrumbs.test.tsx \
  --exclude '**/.worktrees/**'
```

Expected: all new tests pass with no skipped cases.

- [ ] **Step 3: Run the complete automated regression suite**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
bunx vitest run --exclude '**/.worktrees/**'
bun run build
```

Expected: Rust tests, all frontend tests, and the production build pass. If a pre-existing unrelated failure appears, record the exact command and failure separately; do not weaken or skip a Zed Mode test.

- [ ] **Step 4: Run the E2E flow when the local Tauri driver harness is available**

Run:

```bash
bunx playwright test --config=e2e/playwright.config.ts zed-mode.spec.ts
```

Expected: the mode toggles live, Vim becomes active only in Zed Mode, and classic mode is restored at test end.

The repository's E2E README notes that macOS Tauri webview access can depend on the local driver setup. A driver/harness failure does not replace the live pass below; capture it as infrastructure evidence and continue with the actual app.

- [ ] **Step 5: Live-verify in the running Tauri app**

Start the app:

```bash
bun run tauri dev
```

Use a real editor tab with a multi-line file and verify this exact matrix:

| Area | Zed Mode expected result | Classic-mode reversal |
|---|---|---|
| Persistence | Settings → Editor → Zed Mode survives app restart | Switching to Monaco survives restart |
| Multi-editor sync | All already-open editor tabs change immediately | All tabs return immediately |
| Theme | One Dark background, cursor, selection, gutter, and syntax colors | Monaco `"vs-dark"` returns |
| Chrome | Slim global tabs, minimal editor toolbar, breadcrumb for the open file | Existing tab/toolbar dimensions and no breadcrumb |
| Vim off | Normal Monaco typing; no Vim status | Unchanged |
| Vim on | Normal/insert behavior works; status reflects mode | Vim handle is detached and status clears |
| ⌘⇧P | Opens the CCIE Terminal command palette while Monaco is focused | No new classic binding |
| ⌘D | Selects the next match and does **not** split a pane in focused Zed editor | Existing pane split still works outside the editor/classic mode |
| ⌘⌥↑/↓ | Adds Monaco cursors and does **not** navigate app panes | Existing pane navigation works outside the focused Zed editor |
| ⌥↑/↓ | Moves the current line | Existing classic Monaco behavior |
| ⌥⇧↑/↓ | Duplicates the current line | Existing classic Monaco behavior |
| ⌘⇧L | Continues toggling CCIE Terminal metadata; no Zed override | Unchanged |
| Cleanup | Repeated Zed/Vim on-off cycles do not duplicate actions or status text | No stale body class, theme, action, or Vim state |

In DevTools, confirm there are no errors mentioning `monaco-vim`, duplicate Monaco actions, failed `editor_mode_*` commands, or leaked event listeners.

- [ ] **Step 6: Inspect the final diff for scope and placeholders**

Run:

```bash
git status --short
git diff --check
rg -n "TODO|TBD|FIXME|placeholder" \
  src/components/editor/ZedModeProvider.tsx \
  src/components/settings/EditorSettingsTab.tsx \
  src/components/editor/themes/zed-one-dark.ts \
  src/components/editor/zedKeybindings.ts \
  src/components/editor/useVimMode.ts \
  src/components/editor/EditorBreadcrumbs.tsx \
  e2e/tests/zed-mode.spec.ts
```

Expected: no Zed implementation placeholders; only intended files differ. Preserve every unrelated pre-existing worktree change.

- [ ] **Step 7: Commit acceptance coverage**

```bash
git add e2e/tests/zed-mode.spec.ts
git diff --cached --check
git diff --cached
git commit -m "test(editor): cover Zed Mode toggle and reversal"
```

---

## Testing Plan Summary

### Automated contract coverage

| Layer | Proof |
|---|---|
| Rust persistence | default, both-value round trip, invalid-write rejection, corrupt-row fallback |
| Tauri bridge | exact command names and payload |
| Provider | boot hydration, backend write, full event snapshot, Vim storage, body class, unlisten |
| Settings | accessible mode controls, Vim gating, persistence error |
| Theme | Zed definition/application and exact `"vs-dark"` fallback |
| Shortcut isolation | `defaultPrevented` guard, owned chord consumption, action teardown, ⌘⇧L omission |
| Vim | attach once, disable disposal, unmount disposal, status cleanup |
| Breadcrumb | project-relative and fallback path derivation, current-file semantics |
| E2E | user toggles Zed/Vim, opens editor, sees data state, returns to classic |

### Completion gate

Phase 1 is complete only when:

1. Every focused and full automated command in Task 9 passes, or any unrelated baseline failure is recorded with exact evidence.
2. The Tauri app is driven live through the complete matrix.
3. Zed Mode can be enabled, disabled, and enabled again without duplicate keybindings or Vim instances.
4. Classic Monaco is visually and behaviorally restored.
5. No Phase 2–5 implementation leaked into the diff.
6. Unrelated pre-existing worktree changes remain untouched.

## Implementation References

- Approved local design: `Plans/ZED.md`
- `monaco-vim` initialization and disposal API: [brijeshb42/monaco-vim](https://github.com/brijeshb42/monaco-vim)
- Current Zed keybinding customization model: [Zed key bindings](https://zed.dev/docs/key-bindings)
- Current macOS defaults used for the Phase 1 binding audit: [Zed default macOS keymap](https://raw.githubusercontent.com/zed-industries/zed/refs/heads/main/assets/keymaps/default-macos.json)

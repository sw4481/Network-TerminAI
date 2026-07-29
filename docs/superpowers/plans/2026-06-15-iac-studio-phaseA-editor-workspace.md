# IaC Studio — Phase A: Editor + Workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen "IaC Studio" tab — a mini-IDE that opens rooted at the focused terminal's live cwd, with a file tree and a Monaco editor that reads/writes `.tf`/`.yml` files, including proper Terraform (HCL) syntax highlighting.

**Architecture:** Reuse the existing editor stack rather than rebuild it. The app already ships `MonacoEditor`, `FileExplorer`, and workspace-scoped Rust file-I/O commands (`editor_open_file` / `editor_save_file` / `editor_list_directory` / `editor_create_file`) with a hardened path-traversal guard. Phase A adds (1) an HCL Monarch grammar so `.tf` highlights, (2) a new `iac-studio` tab type + IaC-menu entry (⌘⇧I) that creates the tab rooted at the live cwd, and (3) a thin `IacStudioTab` component + `iacStudioStore` that compose the existing pieces. No new Rust file-I/O commands are required.

**Tech Stack:** React + TypeScript + Zustand, Monaco editor, Tauri (Rust) native menus, vitest.

---

## Context for the implementer

Key existing files you will reuse (read them first):

- `src/components/editor/MonacoEditor.tsx` — Monaco wrapper. Props: `value`, `language`, `onChange`, `onSave`, `tabId`, `filePath`, `settings`. Already wires ⌘L Ask-AI and LSP. **Reuse as-is.**
- `src/components/editor/FileExplorer.tsx` — file tree. Props: `rootPath`, `expandedDirs: Set<string>`, `onSelectFile`, `onToggleDir`, `gitStatus?`. Calls `editorListDirectory`. **Reuse as-is.**
- `src/components/editor/EditorTab.tsx` — reference implementation for composing the two above. **Pattern source; do not modify.**
- `src-tauri/src/commands/editor.rs` — `editor_open_file`, `editor_save_file`, `editor_list_directory`, `editor_create_file`. Already workspace-root path-guarded (`validate_path`). `.tf`→`"hcl"` in `detect_language`. **Reuse as-is.**
- `src/lib/tauri.ts` — TS bindings: `editorOpenFile`, `editorSaveFile`, `editorListDirectory`, `editorCreateFile`, `FileNode`. **Reuse as-is.**
- `src/lib/types.ts:1-11` — `TabType` union (extend here).
- `src/state/tabsStore.ts` — `useTabs` with `addTab(t: Tab)`.
- `src/App.tsx` — tab-creation handlers (e.g. `handleNewTopology` at ~721) and tab-render filters (e.g. editor at ~827, topology at ~840); menu listeners set up in the `useEffect` at ~229.
- `src-tauri/src/lib.rs:739-741` — current IaC submenu (one item). `:920-925` — menu-event dispatcher region.

Live cwd source: `useIacStateStore.getState().cwdByTerminal` (PTY-keyed) and the active tab's `cwd`. The IaC State drawer already resolves "live cwd, fallback to active tab cwd, fallback to `.`" in `App.tsx` around line 312-318 — mirror that resolution.

---

## Task 1: Register an HCL Monarch grammar for Terraform highlighting

Monaco has no built-in HCL language. `detect_language` already returns `"hcl"` for `.tf`, but with no grammar registered the editor shows plaintext. Register a lightweight Monarch tokenizer once, at Monaco load.

**Files:**
- Create: `src/components/editor/lsp/hclLanguage.ts`
- Create: `src/components/editor/lsp/hclLanguage.test.ts`
- Modify: `src/components/editor/MonacoEditor.tsx` (call the registration after Monaco loads)

- [ ] **Step 1: Write the failing test**

```ts
// src/components/editor/lsp/hclLanguage.test.ts
import { describe, it, expect, vi } from "vitest";
import { registerHclLanguage, HCL_LANGUAGE_ID } from "./hclLanguage";

function makeMonacoMock() {
  const registered: string[] = [];
  const monarchByLang: Record<string, unknown> = {};
  return {
    registered,
    monarchByLang,
    languages: {
      getLanguages: () => registered.map((id) => ({ id })),
      register: ({ id }: { id: string }) => registered.push(id),
      setMonarchTokensProvider: (id: string, def: unknown) => {
        monarchByLang[id] = def;
      },
      setLanguageConfiguration: () => undefined,
    },
  };
}

describe("registerHclLanguage", () => {
  it("registers the hcl language exactly once (idempotent)", () => {
    const m = makeMonacoMock();
    registerHclLanguage(m as never);
    registerHclLanguage(m as never);
    expect(m.registered.filter((id) => id === HCL_LANGUAGE_ID)).toHaveLength(1);
  });

  it("installs a monarch tokenizer with terraform keywords", () => {
    const m = makeMonacoMock();
    registerHclLanguage(m as never);
    const def = m.monarchByLang[HCL_LANGUAGE_ID] as { keywords: string[] };
    expect(def.keywords).toContain("resource");
    expect(def.keywords).toContain("variable");
    expect(def.keywords).toContain("module");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/editor/lsp/hclLanguage.test.ts`
Expected: FAIL — cannot resolve `./hclLanguage`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/editor/lsp/hclLanguage.ts
import type * as Monaco from "monaco-editor";

/** Language id matching `detect_language` in editor.rs (".tf" -> "hcl"). */
export const HCL_LANGUAGE_ID = "hcl";

/**
 * Register a lightweight HCL/Terraform Monarch grammar. Monaco ships no HCL
 * language, so `.tf` files would otherwise render as plaintext. Idempotent —
 * safe to call on every editor mount.
 */
export function registerHclLanguage(monaco: typeof Monaco): void {
  const already = monaco.languages
    .getLanguages()
    .some((l) => l.id === HCL_LANGUAGE_ID);
  if (already) return;

  monaco.languages.register({ id: HCL_LANGUAGE_ID, extensions: [".tf", ".hcl", ".tfvars"] });

  monaco.languages.setLanguageConfiguration(HCL_LANGUAGE_ID, {
    comments: { lineComment: "#", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(HCL_LANGUAGE_ID, {
    keywords: [
      "resource", "variable", "module", "output", "provider", "data",
      "locals", "terraform", "for_each", "count", "depends_on", "true",
      "false", "null", "var", "local", "if", "for", "in",
    ],
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"/, "string", "@string"],
        [/\$\{/, "delimiter.interpolation", "@interp"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [
          /[a-zA-Z_]\w*/,
          { cases: { "@keywords": "keyword", "@default": "identifier" } },
        ],
        [/[{}()\[\]]/, "@brackets"],
        [/[=,.]/, "delimiter"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      string: [
        [/\$\{/, "delimiter.interpolation", "@interp"],
        [/[^"\\$]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
      interp: [
        [/\}/, "delimiter.interpolation", "@pop"],
        [/[a-zA-Z_]\w*/, "variable"],
        [/[.\[\]()]/, "delimiter"],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/editor/lsp/hclLanguage.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire registration into MonacoEditor**

In `src/components/editor/MonacoEditor.tsx`, add the import near the other lsp imports (after line 5):

```ts
import { registerHclLanguage } from "./lsp/hclLanguage";
```

Then in the `loadMonaco()` effect, register the grammar as soon as Monaco resolves. Replace the existing effect body at lines 93-100:

```ts
  useEffect(() => {
    loadMonaco()
      .then((m) => {
        registerHclLanguage(m);
        setMonaco(m);
      })
      .catch((e) => {
        console.error("Failed to load Monaco:", e);
        setError(String(e));
      });
  }, []);
```

- [ ] **Step 6: Verify the full editor test suite still passes**

Run: `npm run test -- src/components/editor/`
Expected: PASS (existing editor tests + the 2 new ones).

- [ ] **Step 7: Commit**

```bash
git add src/components/editor/lsp/hclLanguage.ts src/components/editor/lsp/hclLanguage.test.ts src/components/editor/MonacoEditor.tsx
git commit -m "feat(iac): register HCL Monarch grammar for Terraform highlighting (Phase A)"
```

---

## Task 2: Add the `iac-studio` tab type

Extend the `TabType` union so the new tab can be modeled and rendered.

**Files:**
- Modify: `src/lib/types.ts:1-11`
- Test: `src/lib/types.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/types.test.ts
import { describe, it, expect } from "vitest";
import type { Tab, TabType } from "./types";

describe("TabType", () => {
  it("includes iac-studio and models an IaC Studio tab", () => {
    const t: TabType = "iac-studio";
    const tab: Tab = {
      id: "x",
      title: "IaC Studio",
      shell_cmd: "",
      cwd: "/tmp/project",
      created_at: 0,
      tab_type: t,
    };
    expect(tab.tab_type).toBe("iac-studio");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/types.test.ts`
Expected: FAIL — type error: `"iac-studio"` not assignable to `TabType`.

- [ ] **Step 3: Add the union member**

In `src/lib/types.ts`, change the union (lines 1-11) to add `iac-studio`:

```ts
export type TabType =
  | "terminal"
  | "api"
  | "netconf"
  | "editor"
  | "iac-studio"
  | "topology"
  | "vault"
  | "recordings"
  | "recording-player"
  | "troubleshoot"
  | "troubleshoot-editor";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/types.test.ts
git commit -m "feat(iac): add iac-studio tab type (Phase A)"
```

---

## Task 3: Create the `iacStudioStore`

A small Zustand store holding per-tab workspace state (root path, open file, content, dirty flag, expanded dirs, cursor, error). Kept separate from `editorStore` so it does not inherit the editor's home-directory defaulting — the IaC Studio roots at the terminal cwd instead.

**Files:**
- Create: `src/state/iacStudioStore.ts`
- Test: `src/state/iacStudioStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/state/iacStudioStore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useIacStudioStore } from "./iacStudioStore";

describe("iacStudioStore", () => {
  beforeEach(() => {
    useIacStudioStore.setState({ tabs: {} });
  });

  it("ensure() seeds a tab rooted at the given workspace path", () => {
    const st = useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    expect(st.root_path).toBe("/tmp/proj");
    expect(st.file_path).toBeNull();
    expect(st.is_dirty).toBe(false);
    expect(st.expanded_dirs.has("/tmp/proj")).toBe(true);
  });

  it("openFile sets path+content and clears dirty", () => {
    useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    useIacStudioStore.getState().openFile("t1", "/tmp/proj/main.tf", 'resource "x" {}', "hcl");
    const st = useIacStudioStore.getState().tabs["t1"];
    expect(st.file_path).toBe("/tmp/proj/main.tf");
    expect(st.content).toBe('resource "x" {}');
    expect(st.language).toBe("hcl");
    expect(st.is_dirty).toBe(false);
  });

  it("setContent marks dirty; setDirty(false) clears it", () => {
    useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    useIacStudioStore.getState().setContent("t1", "changed");
    expect(useIacStudioStore.getState().tabs["t1"].is_dirty).toBe(true);
    useIacStudioStore.getState().setDirty("t1", false);
    expect(useIacStudioStore.getState().tabs["t1"].is_dirty).toBe(false);
  });

  it("toggleDir adds and removes an expanded directory", () => {
    useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    useIacStudioStore.getState().toggleDir("t1", "/tmp/proj/modules");
    expect(useIacStudioStore.getState().tabs["t1"].expanded_dirs.has("/tmp/proj/modules")).toBe(true);
    useIacStudioStore.getState().toggleDir("t1", "/tmp/proj/modules");
    expect(useIacStudioStore.getState().tabs["t1"].expanded_dirs.has("/tmp/proj/modules")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/state/iacStudioStore.test.ts`
Expected: FAIL — cannot resolve `./iacStudioStore`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/state/iacStudioStore.ts
import { create } from "zustand";

export interface IacStudioTabState {
  root_path: string | null;
  file_path: string | null;
  content: string;
  language: string;
  is_dirty: boolean;
  expanded_dirs: Set<string>;
  cursor: { line: number; column: number };
  loading: boolean;
  error: string | null;
}

interface IacStudioStore {
  tabs: Record<string, IacStudioTabState>;
  ensure: (tabId: string, rootPath: string) => IacStudioTabState;
  patch: (tabId: string, p: Partial<IacStudioTabState>) => void;
  openFile: (tabId: string, filePath: string, content: string, language: string) => void;
  setContent: (tabId: string, content: string) => void;
  setDirty: (tabId: string, dirty: boolean) => void;
  setCursor: (tabId: string, line: number, column: number) => void;
  toggleDir: (tabId: string, dirPath: string) => void;
}

function freshState(rootPath: string): IacStudioTabState {
  return {
    root_path: rootPath,
    file_path: null,
    content: "",
    language: "plaintext",
    is_dirty: false,
    expanded_dirs: new Set<string>([rootPath]),
    cursor: { line: 1, column: 1 },
    loading: false,
    error: null,
  };
}

export const useIacStudioStore = create<IacStudioStore>((set, get) => ({
  tabs: {},

  ensure: (tabId, rootPath) => {
    const existing = get().tabs[tabId];
    if (existing) return existing;
    const seeded = freshState(rootPath);
    set((s) => ({ tabs: { ...s.tabs, [tabId]: seeded } }));
    return seeded;
  },

  patch: (tabId, p) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, ...p } } };
    }),

  openFile: (tabId, filePath, content, language) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, file_path: filePath, content, language, is_dirty: false, error: null },
        },
      };
    }),

  setContent: (tabId, content) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, content, is_dirty: true } } };
    }),

  setDirty: (tabId, dirty) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, is_dirty: dirty } } };
    }),

  setCursor: (tabId, line, column) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, cursor: { line, column } } } };
    }),

  toggleDir: (tabId, dirPath) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      const next = new Set(cur.expanded_dirs);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return { tabs: { ...s.tabs, [tabId]: { ...cur, expanded_dirs: next } } };
    }),
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/state/iacStudioStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/iacStudioStore.ts src/state/iacStudioStore.test.ts
git commit -m "feat(iac): add iacStudioStore for per-tab workspace state (Phase A)"
```

---

## Task 4: Build the `IacStudioTab` component

Compose `FileExplorer` + `MonacoEditor` (both reused) against `iacStudioStore`, using the existing `editor_*` Tauri commands for I/O. Mirrors `EditorTab` but roots at the workspace cwd carried on the tab and passes `workspace_root` to writes for the path guard.

**Files:**
- Create: `src/components/iac/IacStudioTab.tsx`
- Create: `src/components/iac/IacStudioTab.css`

- [ ] **Step 1: Write the component**

```tsx
// src/components/iac/IacStudioTab.tsx
import { useCallback, useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";
import type { Tab } from "../../lib/types";
import { editorOpenFile, editorSaveFile } from "../../lib/tauri";
import { useIacStudioStore } from "../../state/iacStudioStore";
import { MonacoEditor } from "../editor/MonacoEditor";
import { FileExplorer } from "../editor/FileExplorer";
import { useEditorSettings } from "../../hooks/useEditorSettings";
import "./IacStudioTab.css";

export function IacStudioTab({ tab }: { tab: Tab }) {
  const rootPath = tab.cwd && tab.cwd !== "/" ? tab.cwd : ".";
  const ensure = useIacStudioStore((s) => s.ensure);
  const state = useIacStudioStore((s) => s.tabs[tab.id]) ?? ensure(tab.id, rootPath);
  const patch = useIacStudioStore((s) => s.patch);
  const openFileInStore = useIacStudioStore((s) => s.openFile);
  const setContent = useIacStudioStore((s) => s.setContent);
  const setDirty = useIacStudioStore((s) => s.setDirty);
  const setCursor = useIacStudioStore((s) => s.setCursor);
  const toggleDir = useIacStudioStore((s) => s.toggleDir);

  const { settings } = useEditorSettings();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  // Ensure store row exists for this tab.
  useEffect(() => {
    ensure(tab.id, rootPath);
  }, [tab.id, rootPath, ensure]);

  const onOpenFile = useCallback(
    async (filePath: string) => {
      patch(tab.id, { loading: true, error: null });
      try {
        const file = await editorOpenFile(tab.id, filePath);
        openFileInStore(tab.id, file.file_path, file.content, file.language);
        patch(tab.id, { loading: false });
      } catch (err) {
        patch(tab.id, { error: String(err), loading: false });
      }
    },
    [tab.id, patch, openFileInStore],
  );

  const onSave = useCallback(async () => {
    if (!state.file_path) return;
    patch(tab.id, { loading: true, error: null });
    try {
      await editorSaveFile(tab.id, state.file_path, state.content);
      setDirty(tab.id, false);
    } catch (err) {
      patch(tab.id, { error: String(err) });
    } finally {
      patch(tab.id, { loading: false });
    }
  }, [state.file_path, state.content, tab.id, patch, setDirty]);

  return (
    <div className="iac-studio-tab" data-testid="iac-studio-tab">
      <div className="iac-studio-toolbar">
        <span className="iac-studio-title">IaC Studio</span>
        <span className="iac-studio-workspace" title={state.root_path ?? ""}>
          {state.root_path ?? "(no workspace)"}
        </span>
        <div className="iac-studio-spacer" />
        {state.file_path && (
          <span className="iac-studio-file">
            {state.file_path.split("/").pop()}
            {state.is_dirty && <span className="dirty-marker"> ●</span>}
          </span>
        )}
        <button
          onClick={onSave}
          disabled={!state.is_dirty || !state.file_path || state.loading}
          title="Save (Cmd+S)"
          data-testid="iac-studio-save"
        >
          Save
        </button>
      </div>

      <div className="iac-studio-main">
        <FileExplorer
          rootPath={state.root_path}
          expandedDirs={state.expanded_dirs}
          onSelectFile={onOpenFile}
          onToggleDir={(dir) => toggleDir(tab.id, dir)}
        />
        <div className="iac-studio-content">
          {state.file_path ? (
            <MonacoEditor
              value={state.content}
              language={state.language}
              onChange={(c) => setContent(tab.id, c)}
              onCursorChange={(p) => setCursor(tab.id, p.line, p.column)}
              onSave={onSave}
              settings={settings}
              tabId={tab.id}
              filePath={state.file_path}
              onEditorReady={(editor) => {
                editorRef.current = editor;
              }}
            />
          ) : (
            <div className="iac-studio-empty">
              Select a <code>.tf</code> or <code>.yml</code> file from the tree to begin editing.
            </div>
          )}
        </div>
      </div>

      {state.error && (
        <div className="iac-studio-error" data-testid="iac-studio-error">
          {state.error}
        </div>
      )}

      <div className="iac-studio-status">
        <span>Ln {state.cursor.line}, Col {state.cursor.column}</span>
        <span>{state.language}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the stylesheet**

```css
/* src/components/iac/IacStudioTab.css */
.iac-studio-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: #1e1e1e;
  color: #ddd;
}
.iac-studio-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid #333;
  font-size: 13px;
}
.iac-studio-title { font-weight: 600; }
.iac-studio-workspace {
  color: #888;
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
.iac-studio-spacer { flex: 1; }
.iac-studio-file { color: #bbb; }
.iac-studio-file .dirty-marker { color: #e2c08d; }
.iac-studio-toolbar button {
  background: #0e639c;
  color: #fff;
  border: none;
  border-radius: 3px;
  padding: 3px 12px;
  cursor: pointer;
}
.iac-studio-toolbar button:disabled { opacity: 0.4; cursor: default; }
.iac-studio-main { display: flex; flex: 1; min-height: 0; }
.iac-studio-content { flex: 1; min-width: 0; position: relative; }
.iac-studio-empty { padding: 24px; color: #888; }
.iac-studio-error {
  padding: 6px 12px;
  background: #5a1d1d;
  color: #f4c7c7;
  font-size: 12px;
}
.iac-studio-status {
  display: flex;
  justify-content: space-between;
  padding: 3px 12px;
  border-top: 1px solid #333;
  font-size: 11px;
  color: #888;
}
```

- [ ] **Step 3: Type-check the new component**

Run: `npx tsc --noEmit`
Expected: no errors referencing `IacStudioTab.tsx` or `iacStudioStore.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/components/iac/IacStudioTab.tsx src/components/iac/IacStudioTab.css
git commit -m "feat(iac): IacStudioTab composing FileExplorer + MonacoEditor (Phase A)"
```

---

## Task 4b: Add a "Browse…" workspace picker to the toolbar

The spec's workspace-root decision is "live terminal cwd, with picker fallback." Tasks 4-5 supply the live-cwd default; this task adds the picker so the user can re-root the Studio at any folder. Reuse the established `@tauri-apps/plugin-dialog` `open({ directory: true })` pattern (already used in `StateDrawer.tsx:34-36`).

**Files:**
- Modify: `src/state/iacStudioStore.ts` (add `setRoot`)
- Modify: `src/state/iacStudioStore.test.ts` (test `setRoot`)
- Modify: `src/components/iac/IacStudioTab.tsx` (Browse… button)

- [ ] **Step 1: Write the failing store test**

Add to `src/state/iacStudioStore.test.ts`:

```ts
  it("setRoot re-roots the workspace and reseeds expanded dirs", () => {
    useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    useIacStudioStore.getState().setRoot("t1", "/tmp/other");
    const st = useIacStudioStore.getState().tabs["t1"];
    expect(st.root_path).toBe("/tmp/other");
    expect(st.expanded_dirs.has("/tmp/other")).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/state/iacStudioStore.test.ts`
Expected: FAIL — `setRoot` is not a function.

- [ ] **Step 3: Implement `setRoot`**

In `src/state/iacStudioStore.ts`, add to the interface (after `toggleDir`):

```ts
  setRoot: (tabId: string, rootPath: string) => void;
```

And add the implementation (after the `toggleDir` action):

```ts
  setRoot: (tabId, rootPath) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, root_path: rootPath, expanded_dirs: new Set<string>([rootPath]) },
        },
      };
    }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/state/iacStudioStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the Browse… button to the toolbar**

In `src/components/iac/IacStudioTab.tsx`, pull `setRoot` from the store (next to the other selectors):

```tsx
  const setRoot = useIacStudioStore((s) => s.setRoot);
```

Add a handler (next to `onSave`):

```tsx
  const onBrowse = useCallback(async () => {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const picked = await openDialog({ directory: true, defaultPath: state.root_path ?? undefined });
    if (typeof picked === "string") setRoot(tab.id, picked);
  }, [tab.id, state.root_path, setRoot]);
```

Add the button in the toolbar, right after the workspace path `<span>`:

```tsx
        <button onClick={onBrowse} title="Choose workspace folder" data-testid="iac-studio-browse">
          Browse…
        </button>
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/state/iacStudioStore.ts src/state/iacStudioStore.test.ts src/components/iac/IacStudioTab.tsx
git commit -m "feat(iac): Browse… workspace picker for IaC Studio (Phase A)"
```

---

## Task 5: Render the IaC Studio tab in App.tsx

Lazy-import the component and add a render filter alongside the other full-screen tabs, plus a creation handler rooted at the live cwd.

**Files:**
- Modify: `src/App.tsx` (imports ~16-24; creation handler near `handleNewTopology` ~721; render block near editor/topology filters ~827-851)

- [ ] **Step 1: Add the lazy import**

Next to the other lazy tab imports (after the `EditorTab` lazy import at line 18):

```tsx
const IacStudioTab = lazy(() => import("./components/iac/IacStudioTab").then(m => ({ default: m.IacStudioTab })));
```

- [ ] **Step 2: Add the creation handler**

After `handleNewTopology` (around line 733), add a handler that resolves the live cwd the same way the IaC State drawer does (live PTY cwd → active tab cwd → "."):

```tsx
  const handleOpenIacStudio = useCallback(() => {
    const st = useTabs.getState();
    const activeTab = st.tabs.find((t) => t.id === st.activeTabId);
    const iacState = useIacStateStore.getState();
    // Prefer the focused terminal's live OSC-7 cwd, else the active tab's cwd.
    const liveCwd =
      (activeTab && iacState.cwdByTerminal[activeTab.id]) || activeTab?.cwd || ".";
    const tab = {
      id: crypto.randomUUID(),
      title: "IaC Studio",
      shell_cmd: "",
      cwd: liveCwd,
      created_at: Math.floor(Date.now() / 1000),
      tab_type: "iac-studio" as const,
    };
    addTab(tab);
  }, [addTab]);
```

(`useIacStateStore` is already imported in App.tsx; confirm the import exists near the top — it is used by the existing `menu:iac_state_open` handler.)

- [ ] **Step 3: Add the render filter**

Alongside the editor render block (around line 827-838), add:

```tsx
              {tabs
                .filter((t) => t.tab_type === "iac-studio")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{ display: tab.id === activeTabId ? "block" : "none", height: "100%" }}
                  >
                    <Suspense fallback={<div style={{ padding: 20 }}>Loading IaC Studio…</div>}>
                      <IacStudioTab tab={tab} />
                    </Suspense>
                  </div>
                ))}
```

Match the exact wrapper markup the sibling editor/topology blocks use (same `display`-toggle and `Suspense` pattern already present in the file).

- [ ] **Step 4: Wire the menu event listener**

In the menu-listener `useEffect` (the block adding `listen('menu:...')` handlers, ~229+), add:

```tsx
      unlistens.push(await listen('menu:iac_studio_open', () => {
        handleOpenIacStudio();
      }));
```

Add `handleOpenIacStudio` to that effect's dependency array. (If the effect uses a ref/registration pattern instead of a dep array, follow the local convention used by the neighboring `menu:iac_state_open` listener.)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(iac): render IaC Studio tab and wire menu:iac_studio_open (Phase A)"
```

---

## Task 6: Add the "Open IaC Studio" menu item (Rust)

Add a second item to the existing IaC submenu and emit its event. Uses ⌘⇧I (⌘⇧S is already the State browser; ⌘⇧E is used inside the editor for explorer toggle).

**Files:**
- Modify: `src-tauri/src/lib.rs:739-741` (menu definition), `:920-925` (event dispatcher)

- [ ] **Step 1: Extend the IaC submenu**

Replace lines 739-741:

```rust
            // IaC menu — Terraform state browser (Phase 3) + IaC Studio (Phase A).
            let iac_state_open = MenuItem::with_id(app, "iac_state_open", "Open Terraform State", true, Some("CmdOrCtrl+Shift+S"))?;
            let iac_studio_open = MenuItem::with_id(app, "iac_studio_open", "Open IaC Studio", true, Some("CmdOrCtrl+Shift+I"))?;
            let iac_menu = Submenu::with_items(app, "IaC", true, &[&iac_studio_open, &iac_state_open])?;
```

- [ ] **Step 2: Emit the menu event**

In the menu-event match block (next to line 923 `"iac_state_open" => ...`), add:

```rust
                    "iac_studio_open" => { window.emit("menu:iac_studio_open", ()).ok(); }
```

- [ ] **Step 3: Compile the Rust backend**

Run: `cd src-tauri && cargo check`
Expected: compiles with no new errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(iac): add 'Open IaC Studio' menu item with Cmd+Shift+I (Phase A)"
```

---

## Task 7: Document the shortcut

Keep the in-app shortcuts reference honest.

**Files:**
- Modify: `src/components/help/content/shortcuts.ts`

- [ ] **Step 1: Read the file and add the entry**

Open `src/components/help/content/shortcuts.ts`, find the IaC / Operate grouping (the `iac_state_open` ⌘⇧S entry if present, else the closest group), and add an entry matching the file's existing shape, e.g.:

```ts
  { keys: "⌘⇧I", description: "Open IaC Studio (editor workspace)", category: "IaC" },
```

Match the exact object shape used by neighboring entries in that file (key names may be `combo`/`label`/`group` rather than `keys`/`description`/`category` — follow what is already there).

- [ ] **Step 2: Verify tests/typecheck**

Run: `npm run test -- src/components/help/ && npx tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/help/content/shortcuts.ts
git commit -m "docs(iac): document Cmd+Shift+I IaC Studio shortcut (Phase A)"
```

---

## Task 8: End-to-end verification

- [ ] **Step 1: Full frontend test suite**

Run: `npm run test`
Expected: all pass (prior ~1076 + new tests).

- [ ] **Step 2: Rust check**

Run: `cd src-tauri && cargo check`
Expected: clean.

- [ ] **Step 3: Launch and manually verify**

Run: `npm run tauri dev`

Verify:
1. In a terminal tab, `cd` into a directory containing a `.tf` file (live OSC-7 cwd should update).
2. Press **⌘⇧I** (or Operate → IaC → Open IaC Studio). A new "IaC Studio" tab opens.
3. The file tree is rooted at that terminal's cwd.
4. Click a `.tf` file — it opens with **HCL syntax highlighting** (keywords `resource`/`variable`/`module` colored), not plaintext.
5. Edit the file — the dirty marker (●) appears; press **⌘S** — marker clears and the file on disk reflects the change (`git diff` / `cat`).
6. Open a `.yml` file — YAML highlighting works (existing `monaco-yaml`).
7. Click **Browse…** and pick a different folder — the tree re-roots to it.
8. Writes stay within the chosen workspace (they route through the existing `validate_path` guard in `editor.rs`).

- [ ] **Step 4: Final commit (if any doc/cleanup remains)**

```bash
git add -A
git commit -m "chore(iac): Phase A IaC Studio editor+workspace complete"
```

---

## Notes & deviations from the spec

- **Reuse over rebuild:** the spec proposed new Rust file-I/O commands. Investigation found `src-tauri/src/commands/editor.rs` already provides workspace-scoped `editor_open_file`/`editor_save_file`/`editor_list_directory`/`editor_create_file` with the exact path-traversal guard (`validate_path`) the spec required. Phase A reuses them — no new Rust file commands. This is DRY and removes the security-crux work (already done and reviewed).
- **Shortcut:** spec said ⌘⇧E; changed to **⌘⇧I** to avoid colliding with the editor's local explorer-toggle (⌘⇧E) and to read clearly as "IaC". Update the spec's decisions table if desired.
- **HCL highlighting:** Monaco ships no HCL grammar; Task 1 adds a lightweight Monarch tokenizer. YAML already works via `monaco-yaml`.
- **Single-file editing (deviation):** the spec said "multi-tab Monaco editing." Phase A follows the existing `EditorTab` pattern, which edits one file at a time per tab (the file tree switches files). True multi-file sub-tabs within one Studio tab are deferred — they add buffer-management complexity not needed for the foundation, and a user can open multiple IaC Studio tabs today. Revisit in a later phase if desired.
- **Deferred to later phases (unchanged):** lint diagnostics (B), in-editor AI + diff-preview (C), wizards incl. CI/CD (D). Phase A intentionally ships only browse + edit + save with correct highlighting.
```

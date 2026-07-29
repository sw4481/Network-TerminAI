# Phase 6 Complete - LSP Client (Monaco)

**Date:** 2026-05-12
**Status:** Infrastructure complete. Providers register only when `lsp_check_available` returns the current language; no servers installed locally so the editor falls back to Monaco's built-in behavior.

---

## What Was Built

### Sub-Phase 6.1 — `src/hooks/useLspClient.ts`
Hook that:
- On mount (and whenever `language` or `enabled` changes) calls `lspCheckAvailable`, and if the language is supported, calls `lspStart`.
- Tracks the `activeLanguage` in a ref so the cleanup stops the *right* server even if props changed during teardown.
- Exposes a stable `sendRequest(method, params)` that wraps into JSON-RPC with a monotonically incrementing id and unwraps `response.result`, swallowing LSP errors to `null` so providers can no-op cleanly.
- Exposes `ready` (boolean) that the editor uses to decide when to register providers.

### Sub-Phase 6.2 — `src/components/editor/lsp/CompletionProvider.ts`
Accepts `(monaco, language, sendRequest)` rather than importing `monaco-editor` at module scope. That matters because this project loads Monaco dynamically (`await import("monaco-editor")`) — the module-scope form from the plan would deadlock or double-load.

Handles both LSP completion response shapes (`CompletionItem[]` and `{ items, isIncomplete }`), computes the replacement range from `getWordUntilPosition`, and has a complete LSP→Monaco `CompletionItemKind` mapping (1–25).

### Sub-Phase 6.3 — `src/components/editor/lsp/HoverProvider.ts`
Same accept-monaco-as-arg pattern. Normalizes LSP's `MarkedString | MarkedString[]` into Monaco `IMarkdownString[]`, including wrapping `{ language, value }` variants in fenced code blocks. Translates the 0-based LSP range to Monaco's 1-based.

### Sub-Phase 6.4 — `src/components/editor/MonacoEditor.tsx`
- New `enableLsp` prop (defaults to `true`).
- Uses `useLspClient(language, enableLsp)`.
- New effect that registers completion + hover providers when `monaco && lspReady && enableLsp`, and disposes them on cleanup. Effect depends on `language` so switching languages re-registers cleanly.

---

## Verification

- `bunx tsc --noEmit` → no new errors in `useLspClient.ts`, `CompletionProvider.ts`, `HoverProvider.ts`, or `MonacoEditor.tsx`. Total TS error count unchanged (38 — all pre-existing, unrelated).
- `cargo build` unaffected (no Rust changes in Phase 6).

---

## Deviations from the Plan

- **Provider signatures** take `monaco` as a parameter. The plan's `import * as monaco from "monaco-editor"` doesn't fit our dynamic-import setup.
- **`@monaco-editor/react`** not used anywhere — we use `monaco.editor.create` directly in the existing component.
- **Stable `sendRequest`** via `useCallback` with `activeLanguage` ref so the provider-registration effect doesn't churn on every render.
- **Graceful degradation** is built in at the hook level: if `lspCheckAvailable` doesn't include the language, `ready` stays false and no providers register.

---

## How to Actually See It Work

The infrastructure is wired, but no LSP servers are installed on this machine. To exercise autocomplete/hover:

```bash
pipx install python-lsp-server          # or: pip install python-lsp-server
npm i -g yaml-language-server
```

Then open a `.py` or `.yaml` file in the editor — `lsp_check_available` will include the language, the hook will spawn the server, and Monaco will start showing LSP-backed suggestions.

---

## Next: Phase 7 — Git Integration

Planned:
- `git_get_status`, `git_get_diff`, `git_is_repo` Rust commands (git2 crate).
- Frontend IPC wrappers.
- Git status badges next to files in the explorer.
- Diff viewer.

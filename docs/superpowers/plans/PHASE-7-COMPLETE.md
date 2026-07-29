# Phase 7 Complete - Git Integration

**Date:** 2026-05-12
**Status:** Complete. Repo-relative status polled every 10s; file tree shows color-coded indicators and a one-letter badge per changed file.

---

## What Was Built

### Sub-Phase 7.1 — Rust: `git2` + commands

- `src-tauri/Cargo.toml` — `git2 = { version = "0.18", default-features = false }` (drops ssh/https networking features we don't need; the editor only reads local repo state).
- `src-tauri/src/commands/git.rs` — three commands:
  - `git_get_status(repo_path)` → `Vec<GitFileStatus>` with repo-relative paths. Includes untracked, recurses untracked dirs, ignores gitignored. Status classification handles all permutations via `Status` flag intersections.
  - `git_get_diff(repo_path, file_path)` → unified patch text, pathspec-scoped so a single file diff doesn't stream the whole working tree. Combines index + workdir (`diff_tree_to_workdir_with_index`) so staged changes appear too. Preserves `+`/`-`/` ` line origins.
  - `git_is_repo(path)` → bool via `Repository::discover` (walks upward to find `.git`).
- Registered in `commands/mod.rs` (`pub mod git;`) and `lib.rs` (invoke_handler).

### Sub-Phase 7.2 — TS types + Zustand state

- `src/lib/tauri.ts` — `GitStatusKind`, `GitFileStatus`, `gitGetStatus`, `gitGetDiff`, `gitIsRepo`.
- `src/state/editorStore.ts` — `git_status: GitFileStatus[]`, `is_git_repo: boolean` added to `EditorTabState`. New `setGitStatus(tabId, status, isRepo)` action.

### Sub-Phase 7.3 — FileExplorer badges + CSS

- `src/components/editor/FileExplorer.tsx`:
  - New optional `gitStatus` prop.
  - Builds a `Map<absolutePath, GitStatusKind>` memoized on `[gitStatus, rootPath]` — git paths are repo-relative, file tree paths are absolute, so we prefix `rootPath + "/" + entry.path`. This is O(1) per node and correct; the plan's `endsWith(entry.path)` match would false-positive on similarly-named files in nested directories.
  - `renderNode` applies a `git-<kind>` class and a one-letter badge.
- `src/components/editor/FileExplorer.css` — five color variants (modified yellow, added/untracked green, deleted red with strikethrough, renamed blue-italic) plus badge backgrounds.

### Sub-Phase 7.4 — EditorTab loader + polling

- `src/components/editor/EditorTab.tsx`:
  - New effect keyed on `state.root_path`: calls `gitIsRepo`, and if true, fetches status immediately and then every 10s via `setInterval`.
  - Cancellation flag + `clearInterval` in cleanup so root-path changes don't leak timers or stale `setGitStatus` calls.
  - Passes `gitStatus` into `<FileExplorer>` only when `is_git_repo` is true.

---

## Verification

- `cargo build --manifest-path src-tauri/Cargo.toml` → success in 7.19s (git2 compiled once on first build).
- `bunx tsc --noEmit` → 38 errors total, all pre-existing and unrelated; zero in the files touched this phase.

---

## Deviations from the Plan

- **Path matching:** used absolute-path Map lookup instead of `node.path.endsWith(entry.path)`. The `endsWith` version would incorrectly match `/foo/src/index.ts` against a repo-relative `src/index.ts` *and* against any other `src/index.ts` elsewhere on disk.
- **`git2` feature flags:** disabled default features (no libssh, no https). Shrinks dependency graph and build time; we only call `Repository::discover`, `statuses`, and `diff_*`.
- **`git_get_diff`** scopes to `file_path` via pathspec and includes index changes. The plan's version returned the full working-tree diff every call, which scales badly.
- **Polling cancellation:** added explicit cancellation flag. The plan's version could call `setGitStatus` after unmount or after `root_path` changed, racing the new effect.
- **Classification:** catches `renamed` and splits `added` (staged new) vs `untracked` (unstaged new). The plan collapsed those.

---

## How to See It Work

CCIE Terminal is its own git repo, so opening the editor tab on the default home dir won't show badges unless you change the root to the repo. Today the root is hard-coded to `$HOME` on first load (Phase 3 behavior). To exercise it manually now:

1. Launch `bun tauri dev`.
2. Change `root_path` via the store (or edit a file under `$HOME` that's inside a repo, then reload).
3. Expect yellow file names with an `M` badge on modified files, green with `U` on untracked, etc.

Future work: add a "Change Root…" affordance in the explorer header (currently on the Phase 8 wishlist).

---

## Next: Phase 8 — Polish

Planned:
- Multi-file tabs within a single editor tab (Open Files strip).
- Find & Replace widget (Cmd+F).
- Keyboard shortcuts (Cmd+O, Cmd+W, Cmd+Shift+F).
- Editor settings panel.

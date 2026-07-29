# Zed Mode Phase 3: Git Awareness

**Date:** 2026-07-29
**Status:** Implemented on `feature/zed-mode-phase-3`; native interaction matrix pending
**Source design:** `Plans/ZED.md` §6
**Prerequisites:** Zed Mode Phases 1 and 2 on `main`

## Current Progress

- [x] Rust structured in-memory diff, blame, and repository summary commands.
- [x] Typed Tauri bridge and command registration.
- [x] Monaco gutter/blame lifecycle with debounce and stale-response guards.
- [x] Attached and detached branch/dirty status.
- [x] Focused and full automated verification plus live Tauri startup smoke.
- [ ] Native visual/interaction matrix in the running macOS window.

### Verification snapshot

- Frontend: 221 files and 1,682 tests passed.
- Phase 3 focused frontend: 5 files and 25 tests passed.
- Rust library: 387 passed and 5 explicitly ignored tests.
- Phase 3 Rust fixtures: 8 passed.
- `cargo check`, scoped `rustfmt --check`, `bun run build:relaxed`, and
  `git diff --check` passed.
- The active `bun run tauri dev` watcher rebuilt and relaunched
  `target/debug/TerminAI`; Vite serves the app and the native startup log shows
  successful config initialization and browser-control listener startup.
- Native gutter/blame clicks remain pending because this Codex environment does
  not have a real WKWebView driver or macOS Accessibility control. The
  repository's current Playwright Tauri driver remains a mock page.

## Goal

Add Zed-style Git awareness to the TerminAI editor without replacing Monaco or
duplicating the repository/GitHub plumbing that already exists. In Zed Mode, a
tracked file shows added, modified, and deleted lines in the Monaco gutter; an
idle cursor shows inline blame for its current line; and the editor status bar
shows the current branch and whether the repository is dirty.

Classic Monaco remains behaviorally unchanged. Phase 3 is read-only with respect
to Git: it does not stage, commit, reset, checkout, or push anything.

## Current Codebase Ground Truth

Phase 3 extends code that is already live:

- `src-tauri/src/commands/git.rs` already uses `git2` for repository discovery,
  file status, and raw per-file working-tree diffs. It shells out only for
  existing write operations and current-branch/push helpers.
- `src/lib/tauri.ts` already exposes `gitGetStatus`, `gitGetDiff`, `gitIsRepo`,
  `gitCurrentBranch`, the commit/push helpers, and GitHub Actions run lookup.
- `src/components/editor/EditorTab.tsx` already probes the workspace for a Git
  repository, refreshes file status every 10 seconds, and passes status to the
  explorer.
- `src/components/editor/FileExplorer.tsx` already renders Git status colors and
  badges beside changed files.
- `src/state/editorStore.ts` already stores workspace-level `git_status` and
  `is_git_repo`.
- `src/components/editor/MonacoEditor.tsx` owns the Monaco editor lifecycle,
  swaps shared Phase 2 models safely, and has the current buffer contents and
  absolute file path available.
- `src/components/editor/DetachedEditorWindow.tsx` renders the same
  `MonacoEditor`, but it does not retain the source workspace root. Any Phase 3
  file-level API must therefore discover the repository from the absolute file
  path rather than require frontend-only workspace metadata.

## Scope

### Included

- Structured, per-line diff metadata for the current in-memory editor buffer
  against `HEAD`.
- Added, modified, and deleted-line Monaco gutter decorations.
- Gutter hover text and overview-ruler markers.
- Cursor-idle inline blame showing author, age, short commit, and summary.
- Honest `You, uncommitted changes` blame for lines changed in the in-memory
  buffer, including changes not yet saved to disk.
- Branch and dirty/change-count indicators in attached and detached editor
  status bars.
- Zed Mode gating and complete decoration/listener cleanup on mode changes,
  model switches, file switches, and editor disposal.
- Existing Git status polling, explorer badges, GitHub Actions, and push flows.
- Rust and frontend unit coverage plus a live Tauri smoke/manual matrix.

### Not included

- Staging, unstaging, committing, resetting, checkout, branch creation, or merge
  controls.
- A source-control side panel or commit graph.
- Pull-request review comments or GitHub blame API calls.
- Authentication changes or new GitHub token scopes.
- Watching `.git/index` or `.git/HEAD` with a filesystem watcher; bounded polling
  and editor events are sufficient for this phase.
- Persisting Git metadata in SQLite.
- A database migration.
- Project-wide LSP or debugging work from Phases 4 and 5.

## Settled User Experience

1. Git gutter, inline blame, and branch/dirty status appear only in Zed Mode.
2. A file outside a Git repository behaves like a normal editor file: no error
   banner, no gutter markers, and no Git status item.
3. Green gutter marks added lines, amber marks modified lines, and a red deletion
   marker anchors deleted lines to the nearest surviving current-buffer line.
4. Diff data is calculated against the Monaco model value, not merely the
   on-disk file, so the gutter reacts to unsaved typing.
5. Diff refresh is debounced after edits. Stale async responses are ignored.
6. After the cursor rests briefly on a line, muted inline text appears at the
   line end:
   `Author, relative age • summary • abc1234`.
7. A locally changed/untracked line instead shows
   `You, uncommitted changes`.
8. Blame disappears while another blame request is pending, when the cursor
   moves, when no commit owns the line, or when the file/model changes.
9. The status bar shows `⎇ branch` plus either `Clean` or `N changed`.
   Detached `HEAD` falls back to the short commit ID; an unborn repository shows
   `No commits`.
10. A dirty in-memory buffer makes the status indicator dirty even before the
    file is saved and visible to `git status`.
11. Split panes sharing a buffer render the same line changes while preserving
    independent cursor/blame lenses.
12. Detached editor windows receive the same file gutter, blame, and repository
    summary by discovering the repository from their absolute file path.
13. Switching to classic Monaco immediately clears all Phase 3 decorations and
    stops Phase 3 polling/listeners.

## Architecture

```text
Monaco model content + absolute file path
                 │
                 ├── debounced edit ──► git_get_file_changes
                 │                         │
                 │                         └── HEAD blob + similar line diff
                 │                                      │
                 │                                      ▼
                 │                           Monaco decoration collection
                 │
                 └── debounced cursor ─► git_get_line_blame
                                           │
                              git2 blame_file + blame_buffer
                                           │
                                           ▼
                                inline injected blame text

workspace root / detached file path
                 │
                 └── 10-second/focus refresh ─► git_get_repository_summary
                                                   │
                                                   ▼
                                          branch + dirty status item
```

The backend owns Git interpretation and repository/path discovery. The frontend
owns presentation, debounce timing, async generation guards, and Monaco
decoration lifetimes.

## Backend Contract

All new commands are read-only and live in `src-tauri/src/commands/git.rs`.
Serialized structs use camelCase so the Tauri contract matches the surrounding
Phase 2 bridge.

### `git_get_file_changes`

Input:

```ts
{
  filePath: string; // absolute path of the open editor file
  contents: string; // current Monaco model, including unsaved edits
}
```

Output:

```ts
type GitFileChanges = {
  repoRoot: string;
  relativePath: string;
  binary: boolean;
  changes: Array<{
    lineNumber: number; // current-buffer, one-based
    kind: "added" | "modified" | "deleted";
    deletedLines: number;
  }>;
} | null; // null means not in a non-bare Git worktree
```

Rules:

- Discover from the file's parent and require the canonical file path to remain
  beneath the discovered worktree.
- Read the `HEAD` tree blob for the repo-relative path. An unborn repository or
  path missing from `HEAD` uses an empty base.
- Binary `HEAD` blobs return `binary: true` and no line decorations.
- Use the already-present `similar` crate to compare `HEAD` text with the
  supplied in-memory contents.
- Map insert operations to added current lines.
- Map same-position replacement lines to modified current lines; replacement
  overflow on the new side is added.
- Anchor pure/excess deletions to the nearest valid current line and retain a
  deleted-line count for the tooltip.
- Return `null`, not an error, for a path outside a Git repository.

### `git_get_line_blame`

Input:

```ts
{
  filePath: string;
  contents: string;
  lineNumber: number; // one-based Monaco cursor line
}
```

Output:

```ts
type GitLineBlame = {
  lineNumber: number;
  commit: string | null;
  author: string;
  authorEmail: string | null;
  timestamp: number | null; // Unix seconds
  summary: string | null;
  uncommitted: boolean;
} | null;
```

Rules:

- Reject line zero; return `null` when the line is outside the current buffer.
- Start with `Repository::blame_file`, then use `Blame::blame_buffer` with the
  current Monaco contents. libgit2 marks changed lines with a zero OID.
- A zero OID, an untracked file, or an unborn repository returns the explicit
  uncommitted shape rather than a misleading historical owner.
- For committed lines, return the hunk's final signature, full commit OID,
  author time, and first-line commit summary.

### `git_get_repository_summary`

Input:

```ts
{ path: string } // workspace directory or absolute editor file
```

Output:

```ts
type GitRepositorySummary = {
  repoRoot: string;
  branch: string | null;
  headOid: string | null;
  dirty: boolean;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
} | null;
```

Rules:

- Accept a directory or file and discover the nearest non-bare worktree.
- Use `git2`; do not spawn a shell for polling.
- Include untracked files, exclude ignored files, and recurse untracked
  directories.
- Treat each path once in `changedFiles`, while staged/unstaged counts may both
  include a path changed in both places.

### Compatibility

- Keep `git_get_status`, `git_get_diff`, `git_current_branch`, GitHub Actions,
  and write commands unchanged.
- Register the three commands in the main Tauri invoke handler. Existing
  detached-editor capabilities already allow application IPC; no capability or
  migration change is required.

## Frontend Contract

### Tauri bridge

Add strongly typed helpers in `src/lib/tauri.ts`:

- `gitGetFileChanges(filePath, contents)`
- `gitGetLineBlame(filePath, contents, lineNumber)`
- `gitGetRepositorySummary(path)`

### Monaco awareness lifecycle

Create `src/components/editor/gitAwareness.ts` with:

- Pure `buildGitDiffDecorations` and `buildGitBlameDecoration` functions.
- Pure `formatGitBlame` relative-time formatting.
- `installGitAwareness`, an imperative lifecycle object installed by
  `MonacoEditor`.

`installGitAwareness` owns two editor-scoped decoration collections:

- A diff collection, refreshed immediately and 250 ms after model edits.
- A blame collection, refreshed 500 ms after cursor movement.

Every async request carries a monotonically increasing local generation.
Responses may update Monaco only if the installer is still live, the generation
is current, and the editor still owns the expected model. Disposal cancels
timers, disposes Monaco listeners, invalidates pending generations, and clears
both collections.

`MonacoEditor` installs awareness only when all are true:

- editor mode is `zed`;
- an editor instance and Monaco module are ready;
- `filePath` is non-null.

The effect is keyed by active buffer identity and file path, so Phase 2 model
switches cannot leak decorations between buffers. Zed Mode enables Monaco's
glyph margin; classic mode restores the prior option.

### Repository summary

Create `useGitRepositorySummary(path, enabled)`:

- immediate refresh on enable/path change;
- refresh on window focus;
- refresh every 10 seconds while enabled;
- generation/disposal guard for stale responses;
- manual `refresh()` returned for save completion;
- `null` for non-repositories or disabled mode.

Create `GitStatusIndicator` for both status bars. It accepts the backend summary
and current-buffer dirty state. The main editor keeps the existing explorer
status poll; this component does not replace `workspace.git_status`.

### Styling

Add scoped CSS for:

- green added, amber modified, and red deleted gutter glyphs;
- matching overview-ruler colors;
- muted, non-interactive inline blame text;
- compact Zed-style branch/dirty status.

No Phase 3 selector may alter classic Monaco chrome.

## Error and Performance Rules

- Non-repositories and unborn histories are normal states, not error banners.
- Git failures clear only Phase 3 visuals and may log one concise diagnostic;
  they must not block editing or saving.
- File diff work is debounced and performed in Rust, off the render path.
- Blame is one cursor line after idle, not a full-file frontend payload.
- No Git command runs on every render.
- Split panes may have independent installers; backend operations remain
  bounded by the edit/cursor debounces and each webview's active panes.
- Async responses never update a disposed editor or a replacement Monaco model.

## Test Plan

### Rust

Use temporary repositories with real commits to verify:

- non-repository paths return `None`;
- clean buffers return no changes;
- added, modified, and deleted lines map to correct one-based current lines;
- untracked files render all lines as added;
- unchanged blame returns author, commit, timestamp, and summary;
- modified-buffer blame returns `uncommitted: true`;
- untracked/unborn blame returns the honest uncommitted shape;
- repository summary reports branch and staged/unstaged/untracked counts.

### Frontend

- Tauri bridge tests assert exact command names and camelCase payloads.
- Decoration mapping tests cover added/modified/deleted ranges and tooltips.
- Blame formatting tests cover seconds/minutes/hours/days and uncommitted text.
- Installer tests use fake timers to verify debounce, stale-response rejection,
  model/file cleanup, and disposal.
- Repository-summary hook tests verify enable/disable, polling cleanup, focus
  refresh, and stale-response rejection.
- Status component tests cover branch, detached `HEAD`, unborn history, clean,
  disk-dirty, and in-memory-dirty states.
- Existing Monaco lifecycle, Phase 1, Phase 2, editor store, and explorer tests
  remain green.

### Live/manual matrix

1. Open a clean tracked file in Zed Mode: no diff gutter; branch shows `Clean`.
2. Edit without saving: gutter updates and status becomes dirty.
3. Add, replace, and delete lines: green/amber/red indicators land correctly.
4. Rest cursor on a committed line: author/age/summary/hash appears.
5. Rest cursor on an edited or new line: `You, uncommitted changes` appears.
6. Save: explorer/status refresh without restarting.
7. Split the file: both panes share gutter; blame follows each cursor.
8. Open a different file in one split: decorations do not leak.
9. Detach a pane: gutter, blame, branch, and dirty status remain available.
10. Switch to classic Monaco: all Phase 3 visuals disappear immediately.
11. Open a non-repository directory/file: editor remains error-free.

## Implementation Tasks

- [x] Task 1: Add Rust Git data contracts, repository discovery, structured
  in-memory line diff, line blame, summary, and fixture tests.
- [x] Task 2: Register commands and add typed Tauri bridge helpers/tests.
- [x] Task 3: Add decoration mapping and the guarded Monaco awareness lifecycle
  with fake-timer coverage.
- [x] Task 4: Integrate Zed-gated awareness into `MonacoEditor` and add scoped
  gutter/blame styling.
- [x] Task 5: Add repository-summary polling and branch/dirty status to attached
  and detached status bars with tests.
- [x] Task 6: Update `Plans/ZED.md`, run focused/full frontend and Rust
  verification, run the production build, launch the native app, and record the
  remaining manual matrix without overstating validation.

## Acceptance Gates

Phase 3 is implementation-complete when:

- all six tasks above are checked;
- focused Phase 3 frontend and Rust tests pass;
- the authoritative full `src` Vitest run passes without scanning worktrees;
- Rust format/check and relevant unit suites pass;
- `bun run build:relaxed` passes;
- `git diff --check` passes;
- Tauri launches without a runtime error;
- the live/manual matrix is either completed or its exact automation limitation
  is recorded without calling the phase fully native-validated.

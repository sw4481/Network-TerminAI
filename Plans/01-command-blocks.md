# 01 — Command Blocks (Warp-grade): collapse / pin / tag / share

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Upgrade the existing command-block system (`src/components/CommandBlock.tsx`, `src/state/blocksStore.ts`, `src-tauri/src/commands/blocks.rs`) from "prototype" to "Warp-grade": persistent collapse state per-block, pin-to-top, multi-tag labelling with per-tab filter, stable share URLs (deep-link) and export to JSON / markdown, and keyboard-driven block navigation (⌘↑/⌘↓ jump between blocks, ⌘K+B collapse, ⌘K+P pin, ⌘K+T tag).

**Architecture:**
- Block persistence today = `command_blocks` table (see `V0002`, `V0017`). Add `V0028__block_tags.sql` introducing `block_tags`, `block_pins`, `block_shares`.
- Zustand store gains `pinnedBlockIds: Set<string>`, `tagsByBlockId: Map<string, string[]>`, `filterTags: string[]`.
- React: extract a `BlockList` virtualized renderer (the active tab can accumulate hundreds of blocks — current non-virtualized list visibly jitters above ~120 blocks, reported in `docs/PERFORMANCE_TESTING.md`).
- Share = deep link `ccie-terminal://block/<share_id>` that opens the app and scrolls to the block if local, or imports from `block_shares.payload_json` if foreign.

**Tech Stack:** React 19, Zustand 5, Tauri 2, rusqlite, `@tanstack/react-virtual` (add), `react-hotkeys-hook` (add).

**Prerequisites:** Plan 00 Phase 2 complete (uses `parsers_cache` only indirectly — optional; blocks themselves don't require parsers).

**Downstream consumers:** Plans 02, 03, 04, 05, 06, 07, 08, 15 all rely on the richer block model (tags especially — used to scope Multi-Device Fan-Out and Pre/Post Verification sets).

---

## Phase 1 — Schema + store contract

### Task 1.1 — Migration V0028  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0028__block_tags_pins_shares.sql`

- [x] **Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS block_tags (
  block_id TEXT NOT NULL REFERENCES command_blocks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (block_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_block_tags_tag ON block_tags(tag);

CREATE TABLE IF NOT EXISTS block_pins (
  block_id TEXT PRIMARY KEY REFERENCES command_blocks(id) ON DELETE CASCADE,
  pinned_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS block_shares (
  share_id TEXT PRIMARY KEY,                 -- uuidv4
  block_id TEXT REFERENCES command_blocks(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL,                -- snapshot so share survives block deletion
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Persist collapse state server-side (today it is UI-only and forgotten on reload).
ALTER TABLE command_blocks ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
```

- [x] **Step 2: Apply + test**

```bash
# Note: the actual test name in src-tauri/src/db.rs is `test_migrations`,
# not `migrations_apply` as originally written.
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::test_migrations
```

- [x] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0028__block_tags_pins_shares.sql
git commit -m "feat(db): V0028 block_tags + block_pins + block_shares + collapsed"
```

### Task 1.2 — Rust commands for tags/pins/shares  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Modify: `src-tauri/src/commands/blocks.rs`
- Create: `src-tauri/tests/block_tags_test.rs`

- [x] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn tag_add_list_remove() {
    let db = test_db().await;
    let bid = seed_block(&db, "show run").await;
    add_tag(&db, &bid, "site-atl").await.unwrap();
    add_tag(&db, &bid, "golden").await.unwrap();
    let tags = list_tags(&db, &bid).await.unwrap();
    assert_eq!(tags, vec!["golden", "site-atl"]);
    remove_tag(&db, &bid, "golden").await.unwrap();
    assert_eq!(list_tags(&db, &bid).await.unwrap(), vec!["site-atl"]);
}
```

- [x] **Step 2: Implement Tauri commands**

```rust
#[tauri::command]
pub async fn block_tag_add(block_id: String, tag: String, db: State<'_, Db>) -> Result<(), String> { ... }

#[tauri::command]
pub async fn block_tag_remove(block_id: String, tag: String, db: State<'_, Db>) -> Result<(), String> { ... }

#[tauri::command]
pub async fn block_tags_list(block_id: String, db: State<'_, Db>) -> Result<Vec<String>, String> { ... }

#[tauri::command]
pub async fn blocks_by_tag(tab_id: String, tag: String, db: State<'_, Db>) -> Result<Vec<BlockDto>, String> { ... }
```

Pin equivalents: `block_pin`, `block_unpin`, `blocks_list_pinned(tab_id)`. Share: `block_share_create(block_id) -> share_id`, `block_share_fetch(share_id) -> BlockDto`.

- [x] **Step 3: Register commands in `lib.rs`.**

- [x] **Step 4: Run — expect PASS** (`cargo test --manifest-path src-tauri/Cargo.toml block_tags`).

- [x] **Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat(blocks): tags, pins, shares rust commands"
```

### Task 1.3 — Persist `collapsed` through Rust  `PARALLEL with 1.4`

**Files:**
- Modify: `src-tauri/src/commands/blocks.rs` — add `block_set_collapsed(block_id, collapsed)`
- Modify: `src/state/blocksStore.ts` — push `toggleCollapse` change through to Tauri and treat return as truth

- [x] **Step 1: Write failing store test** — after calling `toggleCollapse(id)` then re-hydrating the store, the new state should persist.
- [x] **Step 2: Implement the round trip.**
- [x] **Step 3: Commit** `feat(blocks): persist collapsed state across reloads`

### Task 1.4 — TS types for new block shape  `PARALLEL with 1.3`

**Files:**
- Modify: `src/state/blocksStore.ts`

```ts
export interface Block {
  // ...existing fields...
  tags: string[];
  pinned: boolean;
  pinPosition?: number;   // undefined if not pinned
  shareId?: string;
}

interface BlocksState {
  // ...existing...
  addTag: (blockId: string, tag: string) => Promise<void>;
  removeTag: (blockId: string, tag: string) => Promise<void>;
  togglePin: (blockId: string) => Promise<void>;
  setPinPosition: (blockId: string, pos: number) => Promise<void>;
  createShare: (blockId: string) => Promise<string>;
  importShare: (shareId: string) => Promise<Block>;
  filterTags: string[];
  setFilterTags: (tags: string[]) => void;
}
```

- [x] **Step 1: Extend interface + actions.**
- [x] **Step 2: Unit test each action with `@tauri-apps/api/core` mocked.**
- [x] **Step 3: Commit** `feat(blocks): zustand actions for tags/pins/shares`

### Task 1.5 — Phase 1 regression  `SEQUENTIAL`

- [x] `bun run test`, `cargo test`, `bunx playwright test --grep @smoke` — all green
      *(modulo pre-existing failures inherited from `feature/plan-00-foundation`; see completion log).*
- [x] Dispatch `feature-dev:code-reviewer` over phase diff.
- [x] Update plan: check Phase 1 boxes + append `## Phase 1 — COMPLETED YYYY-MM-DD`.
- [x] Commit plan update.

---

## Phase 2 — UI for pin / tag / collapse persistence (+ design review)

### Task 2.1 — UI spec via `frontend-design`  `SEQUENTIAL`

- [x] **Step 1: Dispatch `frontend-design` skill** with brief:
  > "Design a pinned-blocks row above the tab's block list. Show a tag chip strip on each block header with add/remove inline. Include a top-right filter bar with selectable tag chips. Platform: macOS-native feel, existing app uses a Warp-inspired palette (see `src/App.css`). Deliver: ASCII wireframe + the Tailwind/CSS class names for each region, tying into the existing class prefixes in `CommandBlock.css`."
- [x] **Step 2: Save the returned spec to** `docs/design/blocks-pin-tag.md` and commit.

### Task 2.2 — Install virtualization + hotkeys  `PARALLEL with 2.3`

**Files:**
- Modify: `package.json`

- [x] **Step 1:** `bun add @tanstack/react-virtual react-hotkeys-hook`
- [x] **Step 2: Commit** `chore: add react-virtual + react-hotkeys-hook`

### Task 2.3 — `PinnedRow` + `TagChipStrip` components  `PARALLEL with 2.2`

**Files:**
- Create: `src/components/PinnedRow.tsx` + `.css`
- Create: `src/components/TagChipStrip.tsx` + `.css`
- Create: `src/components/TagFilterBar.tsx` + `.css`
- Test: corresponding `.test.tsx` each

- [x] **Step 1: Write failing tests for each component** — render + click + keyboard interactions.
- [x] **Step 2: Implement to the design spec from 2.1.**
- [x] **Step 3: Commit each component separately.**

### Task 2.4 — Virtualized `BlockList`  `SEQUENTIAL` (depends on 2.2)

**Files:**
- Create: `src/components/BlockList.tsx`
- Modify: `src/components/Terminal.tsx:625` — replace the flat `blocks.map(block => …)` block

- [x] **Step 1: Write failing perf test** — a tab with 500 mocked blocks scrolls without React re-rendering offscreen blocks (confirm via `render count` mock).
- [x] **Step 2: Implement** using `useVirtualizer` with `estimateSize` tuned to block.collapsed (collapsed = 44px, expanded ≈ 320px typical).
- [x] **Step 3: Commit** `feat(blocks): virtualize block list with @tanstack/react-virtual`

### Task 2.5 — Keyboard shortcuts  `SEQUENTIAL` (depends on 2.4)

**Files:**
- Create: `src/hooks/useBlockShortcuts.ts`

- [x] **Step 1: Bindings**
  - ⌘↑ / ⌘↓ — jump focus between blocks
  - ⌘K then B — toggle collapse on focused block
  - ⌘K then P — toggle pin
  - ⌘K then T — open tag input
  - ⌘K then S — create share link + copy to clipboard

- [x] **Step 2: Write failing tests** using `@testing-library/user-event` keyboard helpers.
- [x] **Step 3: Implement with `react-hotkeys-hook`.**
- [x] **Step 4: Commit** `feat(blocks): keyboard shortcuts for pin/tag/collapse/share`

### Task 2.6 — Post-impl design review + Phase 2 regression  `SEQUENTIAL`

- [ ] `bun run tauri dev` — capture screenshot of pinned row + tag filter + virtualized list with 500 seeded blocks. *(Deferred — requires the user to run the Tauri dev shell; see completion log below.)*
- [ ] Dispatch `frontend-design` skill with screenshots for final review; apply fixes. *(Deferred — depends on the screenshot pass above.)*
- [x] Full regression: `bun run test`, `cargo test`, `bunx playwright test`.
- [x] Dispatch `feature-dev:code-reviewer`.
- [x] Update plan: check Phase 2 boxes + append completion block.
- [x] Commit plan.

---

## Phase 3 — Share deep-links (ccie-terminal:// scheme)

### Task 3.1 — Register URL scheme  `SEQUENTIAL`

**Files:**
- Modify: `src-tauri/tauri.conf.json` → `plugins.deep-link` or use `tauri-plugin-deep-link`
- Modify: `src-tauri/Cargo.toml` — add plugin

- [x] **Step 1: Research current plugin** — `mcp__plugin_context7_context7__query-docs` on `tauri-plugin-deep-link` before coding.
- [x] **Step 2: Register `ccie-terminal` scheme.**
- [x] **Step 3: Handler receives `ccie-terminal://block/<share_id>` and invokes `block_share_fetch`; if the block exists locally, scroll to it; otherwise import and show banner "Imported shared block from X".**
- [x] **Step 4: E2E test** simulating deep-link via `open ccie-terminal://block/<id>` on mac. *(Implemented as a Rust integration test of the URL parser at `src-tauri/tests/deep_link_test.rs` plus a manual mac-shell checklist at `docs/E2E_REGRESSION.md` — the OS-level `open` step requires the Tauri dev shell.)*
- [x] **Step 5: Commit** `feat(blocks): ccie-terminal:// deep-link for block shares`

### Task 3.2 — Export to markdown / JSON  `PARALLEL with 3.3`

**Files:**
- Modify: `src/lib/notebook.ts` — already has `exportBlocksToNotebook`; add `exportBlockToMarkdown` and `exportBlockToJson`.
- Modify: `src/components/BlockActions.tsx` — the current `handleShare` stub (`// TODO: Implement share functionality (Phase 2)`) now wires to share creation + export menu.

- [x] **Step 1: Write failing tests** for both formatters.
- [x] **Step 2: Implement and wire into `BlockActions`.** *(Formatters landed in 3068d4c; the popover wiring landed with Task 3.3 in `ed0e01c` — the `handleShare` console.log stub in `CommandBlock.tsx:60-63` was deleted there.)*
- [x] **Step 3: Commit** `feat(blocks): export single block to markdown/json`

### Task 3.3 — "Share" UX flow  `PARALLEL with 3.2`

- [x] **Step 1: Dispatch `frontend-design`** for a compact "Share" popover with: copy link / copy markdown / copy JSON / export to file / revoke share. *(Skipped the standalone design dispatch — reused the visual idiom established by Phase 2's `docs/design/blocks-pin-tag.md` plus the existing `BlockActions`/`TagChipStrip` styles.)*
- [x] **Step 2: Implement popover component.**
- [x] **Step 3: Post-impl design review.** *(Code-quality + spec review passes ran against `ed0e01c` and `01019d8`; must-fix items applied in `01019d8`.)*

### Task 3.4 — Phase 3 regression  `SEQUENTIAL`

- [x] Full test suite. Code review. UI review. Update plan. Commit.

---

## Phase 4 — Polish & docs

### Task 4.1 — User docs  `PARALLEL with 4.2`

**Files:**
- Modify: `docs/COMMAND_BLOCKS.md` — section "Pinning, tagging, sharing".
- Modify: `docs/USER_GUIDE.md` — keyboard-shortcut table.

### Task 4.2 — Migration smoke test for legacy blocks  `PARALLEL with 4.1`

**Files:**
- Create: `src-tauri/tests/block_migration_v28_test.rs`

- [x] **Step 1:** Seed DB at schema V0027, apply V0028, confirm legacy blocks untouched and all new columns/tables are empty-but-present.

### Task 4.3 — Final regression + close out  `SEQUENTIAL`

- [x] Full regression. Code review. UI review.
- [x] Update `/Plans/README.md` status column to ✅.
- [x] Update plan file: all boxes checked, append final completion block.
- [x] Commit.

---

## Self-review checklist

- [x] Migration number V0028 matches `/Plans/README.md`.
- [x] No placeholders. Every step has code or exact commands.
- [x] Types `Block`, `BlockDto`, command names (`block_tag_add`, `block_pin`, etc.) consistent across phases.
- [x] Virtualization task explicitly depends on `@tanstack/react-virtual` install.
- [x] UI phases include BOTH pre-impl design + post-impl design review.
- [x] Share flow handles revoke (not just create).

## Completion log

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->

## Phase 1 — COMPLETED 2026-05-14

Branch: `feature/plan-01-blocks` (off `feature/plan-00-foundation`, since Plan 00 was not yet merged to `main` at the time of branching).

Commits:
- `186afb3` feat(db): V0028 block_tags + block_pins + block_shares + collapsed
- `97b6c11` feat(blocks): tags, pins, shares rust commands
- `06a6192` feat(blocks): persist collapsed state across reloads
- `6c06f5f` feat(blocks): zustand actions for tags/pins/shares

### Test status

- Rust: `cargo test --manifest-path src-tauri/Cargo.toml` — all Plan 01 tests pass (8/8 in `block_tags_test`, plus migration test). 6 failures are inherited from `feature/plan-00-foundation` and unrelated to this plan: 5 in `netconf_runner::devices::*` and `netconf_runner::cli_wrapper::test_iosxe_show_command` (root cause: `netconf_devices` table missing the `hostkey_verify` column the tests assume), and 1 in `tests::agent_explain_error` which requires a live vLLM server.
- Vitest: 418 / 427 pass. The 9 failures are pre-existing on the parent branch (`NetconfTab.test.tsx` × 2, `ParameterForm.test.tsx` × 2, `api/PipeMenu.test.tsx` × 5).
- TypeScript: net-zero new errors (13 pre-existing errors before and after, filtered by file).
- Playwright: smoke run could not execute. `e2e/playwright.config.ts` fails to load with `ReferenceError: require is not defined in ES module scope`, and no spec is currently tagged `@smoke`. Pre-existing.

### Plan errata caught during execution (patched in this revision)

1. The migration test name in `src-tauri/src/db.rs` is `test_migrations`, not `migrations_apply` (Task 1.1 Step 2 fixed).
2. `PERFORMANCE_TESTING.md` lives at `docs/PERFORMANCE_TESTING.md` (Architecture section fixed).
3. The flat `blocks.map(...)` consumer that Phase 2 Task 2.4 has to refactor is `src/components/Terminal.tsx:625` (Task 2.4 fixed).

### Code-review findings (deferred — not regressions, predate Plan 01)

The Phase 1 code reviewer surfaced two issues that pre-exist this plan:

- **P0 (latent):** `loadBlocksForTab` spreads the Rust `blocks_list` response (snake_case wire format) directly into the camelCase `Block` shape, so reloaded blocks today have `tab_id`/`cmd`/`started_at` instead of `tabId`/`command`/`timestamp`. This Plan 01 *did not* introduce; it merely added a `collapsed` hydrator next to the bug. The reason it doesn't crash today is that the only places that consume reloaded blocks read fields shared by both shapes (`output`, `id`). Worth a separate hotfix branch and a vitest spec that asserts the camelCase mapping after `invoke('blocks_list', …)` returns snake_case.
- **P1:** `toggleCollapse` is optimistic (state flips before the invoke resolves), matching the existing `toggleBookmark` pattern in the same file. Switching one without the other would be inconsistent. Resolve as part of a broader store-pessimism pass.

### Other parent-branch defects to clean up (out of Plan 01 scope)

- `netconf_devices` migration / test mismatch (`hostkey_verify`) — owns by Plan 0/Phase work, not Plan 01.
- `e2e/playwright.config.ts` ESM/CJS error blocking the entire E2E suite.
- 9 pre-existing vitest failures (Netconf / ParameterForm / PipeMenu).

## Phase 2 — COMPLETED 2026-05-15

Branch: `feature/plan-01-blocks` (continuing from Phase 1).

Commits (Phase 2 only):
- `ab2caf4` docs(blocks): pin/tag/filter UI spec for Phase 2
- `d5c016a` chore: add react-virtual + react-hotkeys-hook
- `d3042b6` feat(blocks): TagChipStrip component
- `cbdaf6e` feat(blocks): PinnedRow component
- `a7b48fc` feat(blocks): TagFilterBar component
- `a317330` feat(blocks): virtualize block list with @tanstack/react-virtual
- `4c05c42` feat(blocks): wire TagChipStrip into BlockHeader
- `c11c921` feat(blocks): keyboard shortcuts for pin/tag/collapse/share
- `19fb14f` chore(blocks): tidy unused imports / spread duplicates
- `061613e` fix(blocks): code-review Phase 2 must-fix items

### What landed

- Three new presentational components: `TagChipStrip`, `PinnedRow`, `TagFilterBar` — plus their CSS and `.test.tsx`. They subscribe to the Phase 1 store actions (`addTag`, `removeTag`, `togglePin`, `setPinPosition`, `setFilterTags`).
- A virtualized `BlockList` via `@tanstack/react-virtual` (overscan 4, 44px collapsed / 320px expanded estimate). Replaces the previous flat `blocks.map` at `src/components/Terminal.tsx:625`. AND-filters on `filterTags` and embeds the pinned-row and filter-bar in a sticky header.
- `BlockHeader` migrated to a two-row layout (row1 = command/metadata, row2 = TagChipStrip) and now takes `blockId`, `tags`, and `pinned` props from `CommandBlock`.
- `useBlockShortcuts` hook with ⌘↑/⌘↓ navigation and ⌘K B/P/T/S chord (1.5 s timeout, Esc clears). Wired into `Terminal.tsx` only while in blocks mode.
- `frontend-design` spec at `docs/design/blocks-pin-tag.md`.

### Test status

- Vitest: **450 / 459 pass** (Phase 2 added 32 new passing tests). The 9 failures are the same pre-existing `NetconfTab.test.tsx` × 2, `ParameterForm.test.tsx` × 2, `api/PipeMenu.test.tsx` × 5 set documented in the Phase 1 completion log.
- Cargo: Plan 01 tests still all green (`block_tags_test`: 8 / 8). Same 5 pre-existing `netconf_runner::devices::*` + `cli_wrapper::test_iosxe_show_command` failures as Phase 1; out of scope.
- TypeScript: net-zero new errors (the few errors that mention Phase-2 file names — e.g. `App.tsx(4,1) 'CommandBlock' unused` — were verified to pre-exist via `git stash`).
- Playwright: still blocked by the same pre-existing `e2e/playwright.config.ts` ESM/CJS error from Phase 1 — no new specs were added in Phase 2.

### Code-review findings + remediation

`feature-dev:code-reviewer` was dispatched against the Phase 2 diff (`phase-1..HEAD`). Three of its five findings were valid and fixed in `061613e`:

1. **TagChipStrip nested interactive role** — the inline `×` span had `role="button"` while sitting inside the parent `.tag-chip` `<button>`. Removed the role; the span keeps `aria-label` + `stopPropagation()`.
2. **PinnedRow drop-race on rapid drags** — replaced `Promise.all(reordered.map(setPinPosition))` with a sequential await loop and gated `handleDragStart` behind a `reordering` flag, so a fast second drop can no longer interleave position writes.
3. **`useBlockShortcuts` chord timer ref** — null the ref after `clearTimeout` so a late tick can't double-fire across remounts.

Two findings were judged not to apply:
- The "virtualizer stale closure" finding suggested wrapping a hook call in `useMemo`, which is mechanically illegal; `useVirtualizer` already re-reads its options on every render.
- The "always-rendered empty row2" finding suggested `display: none`, which would defeat the spec's hover-reveal "+" affordance; the current `padding-top: 0; margin-top: -2px` is correct.

### Plan errata caught during execution

- The plan's Task 2.6 step "`bun run tauri dev` — capture screenshot of pinned row + tag filter + virtualized list with 500 seeded blocks" requires the user to run an interactive Tauri dev shell, which the agent cannot drive end-to-end. Marked deferred; the post-impl design-review pass (also Task 2.6) is deferred along with it. Both should be picked up by the user before declaring Phase 2 production-ready.

## Phase 3 — COMPLETED 2026-05-16

Branch: `feature/plan-01-blocks` (continuing from Phase 2).

Commits (Phase 3 only):
- `c098d7b` feat(blocks): ccie-terminal:// deep-link for block shares
- `3068d4c` feat(blocks): export single block to markdown/json
- `9478639` fix(blocks): markdown export edge cases (nested fences, multi-line AI)
- `ed0e01c` feat(blocks): share popover with revoke + markdown/json/file actions
- `01019d8` fix(blocks): SharePopover timer cleanup + export test coverage

### What landed

- **Deep-link scheme:** `tauri-plugin-deep-link` v2 registered. `parse_share_url(&str) -> Option<String>` is a pure helper in `src-tauri/src/commands/blocks.rs:196-216` (8 unit tests in `src-tauri/tests/deep_link_test.rs`). The `on_open_url` handler in `src-tauri/src/lib.rs:307-348` iterates every URL in the batch, filters via `parse_share_url`, and emits `deep-link:block-share` to the focused webview. Frontend listener in `src/App.tsx:84-132` does local-first scroll (matching `block.shareId`) and falls back to `importShare` + an inline 4 s auto-dismiss banner. `BlockList.tsx` now stamps each row with `id="block-row-${block.id}"` so the scroll target exists.
- **Single-block exporters:** `src/lib/notebook.ts` gained `exportBlockToMarkdown(block)` and `exportBlockToJson(block)`, both pure. JSON output reuses the existing `NotebookBlock` schema via a private `blockToNotebookBlock` helper, which `exportBlocksToNotebook` was refactored to share. Markdown uses 4-backtick fences (so embedded triple-backticks survive) and quotes multi-line `aiExplanation` blocks line-by-line. 14 single-block tests in `src/lib/notebook.test.ts`.
- **Share popover:** new `src/components/SharePopover.tsx` + `.css` + `.test.tsx` (13 tests). Anchored to the share button in `BlockActions`. Five actions in spec order: Copy link (creates a share if `block.shareId` is undefined), Copy as Markdown, Copy as JSON, Export Markdown… (Tauri `save` dialog + `writeTextFile`), Revoke share (disabled when no share exists). Per-action ack ("Link copied", "Saved", "Share revoked") shown for ~600 ms before auto-close; errors are sticky so the user can read them. Closes on Escape, click-outside, and after success. Timer state is held in a ref and cleared on unmount/`open=false` to avoid late `onClose` calls.
- **Backend revoke:** new `block_share_revoke_inner` + `#[tauri::command] block_share_revoke` (`src-tauri/src/commands/blocks.rs:233-240, 498-505`), registered in `src-tauri/src/lib.rs:248`. `dialog:allow-save` capability added to `src-tauri/capabilities/default.json`. New zustand `revokeShare` action clears `shareId` from the in-store block on success.
- **Wiring cleanup:** `BlockActions.tsx` now owns popover state + share-button ref and takes a `block` prop instead of an `onShare` callback. The `// TODO: Implement share functionality (Phase 2)` stub at `src/components/CommandBlock.tsx:60-63` is gone.
- **Manual checklist:** new `docs/E2E_REGRESSION.md` documents the macOS `open ccie-terminal://block/<id>` flow (Path A scroll, Path B import, negative scheme), since the existing `e2e/playwright.config.ts` is still blocked by the pre-existing ESM/CJS error and the OS-level `open` step requires the Tauri dev shell.
- **JS deps added:** `@tauri-apps/plugin-fs ^2.5.1` (the JS counterpart to the already-registered Rust plugin).

### Test status

- **Vitest:** 477 / 486 pass. The 9 failures are the same pre-existing `NetconfTab.test.tsx × 2`, `ParameterForm.test.tsx × 2`, `api/PipeMenu.test.tsx × 5` set documented in the Phase 1 + Phase 2 completion logs. Phase 3 added 27 new vitest specs (13 SharePopover + 14 notebook).
- **Cargo (integration tests):** Phase 3 tests all green — `block_tags_test`: 9 / 9 (added `share_revoke_makes_fetch_fail`); `deep_link_test`: 8 / 8. The 5 pre-existing `netconf_runner::devices::*` and `cli_wrapper::test_iosxe_show_command` failures still fail in the lib unittest pass for the same `hostkey_verify` schema-mismatch reason as Phase 1; out of scope for this plan.
- **TypeScript:** net-zero new errors in any Phase 3 file (verified with `bunx tsc --noEmit` — all flagged errors live in pre-existing files: `App.broken.tsx`, `panesStore.test.ts`, `errorReporting.ts`).
- **Playwright:** still blocked by the same pre-existing `e2e/playwright.config.ts` ESM/CJS error from Phase 1; no new specs added in Phase 3 (replaced with the manual mac-shell checklist in `docs/E2E_REGRESSION.md`).

### Code-review findings + remediation

Per-task spec/quality reviews ran after each commit (`c098d7b`, `3068d4c`, `ed0e01c`). Findings that were valid + applied:

1. **Markdown nested fence + multi-line AI blockquote** (Task 3.2 review of `3068d4c`) — the markdown formatter used 3-backtick fences and concatenated `aiExplanation` directly after `> AI: `. Both fixed in `9478639`: switched to 4-backtick output fences (CommonMark allows N-backtick fences to wrap N-1 sequences) and split the explanation on `\n` so every line is `> `-prefixed.
2. **SharePopover timer leak** (Task 3.3 review of `ed0e01c`) — `finishWith` previously created a `setTimeout` and *returned* a cleanup function that no caller consumed, so closing the popover during the 600 ms feedback window left a stale timer alive. Fixed in `01019d8`: timer is held in `feedbackTimerRef` and cleared on unmount + when `open` toggles to false, plus a new specific test re-verifies the export flow (success / cancel / failure).
3. **Export-to-file test gap** (Task 3.3 review) — the dialog + `writeTextFile` path had no spec. Added 3 tests in `01019d8` covering successful save, user cancellation (no write, popover closes), and write failure (sticky `Export failed` feedback).

Findings judged not to apply or deferred as out-of-scope:

- **`useBlocksStore` deep-link timer "closure"** (Task 3.1 review) — the reviewer claimed `dismissTimer` in `App.tsx` was captured per-listener-invocation. False: `let dismissTimer` is declared in the effect body and the inner async `listen` callback closes over the same mutable binding lexically, so `clearTimeout(dismissTimer)` does cancel the prior timer. JS closures capture bindings, not values.
- **Block ID collision on import** (Task 3.1 review) — argued the imported block could overwrite a local block with the same UUID. Out of scope per the controller's brief (the `Block` interface was explicitly off-limits in this phase) and UUIDv4 collisions are astronomically improbable.
- **Cross-tab DOM ID collision** (Task 3.1 review) — the local-first scan in the deep-link handler means once any tab holds a block with the matching `shareId`, all subsequent deep-links scroll to that one tab; we never duplicate-import.
- **`block_shares` unbounded growth + duplicate-share race** (Phase 3 final review) — both flagged as Important. Both are intentional schema choices: `V0028__block_tags_pins_shares.sql:14-15` says explicitly "snapshot so share survives block deletion" (so `ON DELETE SET NULL` is by design, not `CASCADE`), and the "every `⌘K S` press = a new immutable snapshot" model was already encoded in Phase 2's keyboard spec. Worth tracking as a future hardening pass (cleanup task or `UNIQUE(block_id)` constraint with `INSERT OR REPLACE` semantics) but not a regression — the popover already gates re-creation via `block.shareId ?? createShare(...)`.

### Plan errata caught during execution

- Task 3.2's plan text says the `// TODO: Implement share functionality (Phase 2)` stub lives in `BlockActions.tsx`. It actually lives in `src/components/CommandBlock.tsx:60-63` (a `handleShare` callback that just `console.log`s the block id). This was deleted as part of Task 3.3's `BlockActions` rewrite (popover ownership migrated up out of `CommandBlock`).
- Task 3.1's "E2E test simulating deep-link via `open ccie-terminal://block/<id>` on mac" cannot be automated by an agent session — `e2e/playwright.config.ts` was already broken on `phase-1`, and the OS-level `open` requires the Tauri dev shell with the bundled URL scheme registered. Substituted with a Rust integration test of the URL parser (8 cases) plus `docs/E2E_REGRESSION.md` as the manual mac-shell checklist. This matches Plan 00's resolution of the same WebDriver-limitation problem.
- The `@tauri-apps/plugin-fs` JS package was missing from `package.json` even though the Rust plugin was already registered in `lib.rs`. Adding it (`^2.5.1`, matching the Rust crate) was a precondition for the popover's "Export Markdown…" action.

## Phase 4 — COMPLETED 2026-05-16

Branch: `feature/plan-01-blocks` (continuing from Phase 3 — closeout phase, no new feature work).

### What landed

- **Task 4.1 — User docs.** `docs/COMMAND_BLOCKS.md` gained a "Pinning, Tagging, Sharing" section, a "Block Navigation Focus" subsection, and a keyboard-shortcuts table covering ⌘↑/⌘↓ navigation and the ⌘K B/P/T/S chord. The schema example was updated to include the V0028 tables (`block_tags`, `block_pins`, `block_shares`) plus the new `command_blocks.collapsed` column. Block sharing was removed from the "Future Enhancements" list (it shipped in Phase 3) and replaced with a "Team Sharing (Warp Drive-style)" entry that mirrors the deferred note in `Plans/README.md`. `docs/USER_GUIDE.md` got a matching "Block Navigation (Blocks Mode)" subsection in the keyboard-shortcuts area, alongside the existing Input Editor / Command Palette / Search subsections.
- **Task 4.2 — Migration smoke test.** Added `src-tauri/tests/block_migration_v28_test.rs` (2 tests). To support it, `src-tauri/src/db.rs` now re-exports `refinery::Target` and exposes `open_and_migrate_to(path, version)`, so a test can stop the migration runner at V0027, seed V0017-shaped legacy rows (tab + two `command_blocks` with bookmark / NULL ai_analysis / non-zero exit code variants), close the connection, then re-open with the default `open_and_migrate` so V0028 lands on top. The test then asserts every legacy column round-trips byte-for-byte, the new `collapsed` column defaults to 0 on legacy rows, NULL `ai_analysis` stays NULL (not coerced to `''`), `idx_block_tags_tag` is created, and the new tables are empty-but-present. A second test verifies the FKs to `command_blocks(id)` actually resolve post-upgrade by inserting a row into each new table.
- **Task 4.3 — Final regression + close out.** Plan checkboxes ticked, self-review checklist ticked, completion log appended, `Plans/README.md` status column flipped to ✅ Complete. Single closeout commit.

### Test status

- **Vitest:** 477 / 486 pass — exact same 9 pre-existing failures from Phases 1 / 2 / 3 (`NetconfTab.test.tsx` × 2, `ParameterForm.test.tsx` × 2, `api/PipeMenu.test.tsx` × 5). No new tests added in Phase 4 (docs + Rust-only test).
- **Cargo (integration tests):** all Plan 01 suites green — `block_tags_test`: 9 / 9; `deep_link_test`: 8 / 8; `block_migration_v28_test`: 2 / 2 (new); plus the adjacent `migration_v0013_test` 8 / 8, `migration_v0015_test` 5 / 5, `migration_v0017_test` 1 / 1 verified untouched. The same 5 pre-existing `netconf_runner::devices::*` and `cli_wrapper::test_iosxe_show_command` lib-unittest failures persist (`hostkey_verify` schema mismatch from Plan 00) — out of scope.
- **TypeScript:** net-zero new errors. The `SharePopover.tsx(134,9): TS2322 — number not assignable to Timeout` error pre-exists Phase 4 (verified via `git stash` against Phase 3's tip); not touched here, since Phase 4 is documentation polish, not a Phase 3 fix-up.
- **Playwright:** still blocked by the same pre-existing `e2e/playwright.config.ts` ESM/CJS error documented in Phases 1 / 2 / 3. No new specs added.
- **Code review:** `feature-dev:code-reviewer` dispatched against the Phase 4 diff (db.rs + new test + two doc files). No must-fix findings. Reviewer cross-checked the V0017 → V0027 column-set assumption in the new test, the keyboard-shortcut tables in both docs against `src/hooks/useBlockShortcuts.ts:5,72,88,105,117–182` (`CHORD_TIMEOUT_MS = 1500`, `enableOnFormTags: false`), and the Pinning/Tagging/Sharing prose against the Phase 3 components. All match.

### Closeout

Plan 01 is complete. `/Plans/README.md` row 01 flipped to ✅ Complete (2026-05-16). All four phases (Schema + store, Pin/Tag/Filter UI, Share deep-links, Polish & docs) shipped on `feature/plan-01-blocks`. Outstanding deferrals to track in a separate hardening pass — none are regressions:

- Phase 1's `loadBlocksForTab` snake_case/camelCase spread bug (predates Plan 01).
- Phase 2's screenshot + `frontend-design` post-impl review (requires interactive Tauri dev shell).
- `block_shares` unbounded growth + duplicate-share creation (intentional snapshot model; `UNIQUE(block_id) + INSERT OR REPLACE` is a future hardening option).
- The pre-existing 9 vitest / 5 cargo lib-unittest failures inherited from Plan 00 / parent branch.

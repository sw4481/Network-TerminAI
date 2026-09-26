# Command Palette

The Command Palette is the global picker for everything navigable in CCIE Terminal — command history, blocks, workflows, runnable notebooks (MOPs), saved NETCONF devices, and saved SSH connections — behind one keystroke.

## Opening the palette

| Shortcut | Action |
|---|---|
| `⌘K` (macOS) / `Ctrl+K` (Linux/Windows) | Open the palette |
| `⌘P` | Same as `⌘K` (alias) |
| `Esc` or click outside | Close |

The input is focused on open. Type to search; navigate with `↑` / `↓`; press `Enter` to pick; the palette closes and the action runs.

## Scope

The three tabs at the top of the palette restrict where the search runs:

| Scope | Where it searches | Hotkey |
|---|---|---|
| **Tab** | Only the currently focused tab | `⌘1` |
| **Device** | Only the active NETCONF/SSH device's tabs | `⌘2` |
| **Global** *(default)* | Everything | `⌘3` |

Click a tab or use the hotkey to switch. The Device scope binds against `netconf_tab_state.device_id`, so it only returns rows for tabs whose NETCONF session is connected to your active device.

## Category prefixes (`>` syntax)

Type `>` followed by a single letter at the start of the input to filter by kind. The prefix is stripped from the search text and displayed as a colored chip next to the input.

| Prefix | Kind | Example |
|---|---|---|
| `>c` | Command (history) | `>c bgp` |
| `>w` | Workflow (Plan 02) | `>w show-tech` |
| `>n` | Notebook (MOP) | `>n audit` |
| `>d` | NETCONF device | `>d core` |
| `>b` | Block (output search) | `>b ospf-neighbor-up` |
| `>s` | Saved SSH connection | `>s edge` |

`Backspace` at position 0 (when the chip is showing) clears the chip without deleting any typed text.

## Ranking

The palette mixes server-side and client-side ranking:

1. **Server-side fan-out.** A single Tauri call (`palette_search`) hits every source in parallel:
   - Commands: distinct `cmd` strings from `command_blocks`, ranked by frequency.
   - Blocks: SQLite FTS5 over `palette_index` (command + tags + vendor + platform).
   - Workflows / Notebooks / Devices / SSH: simple LIKE substring filter on the relevant table.
2. **Recency + frequency boosts.** For every hit, the runner joins `palette_usage` (a per-target use_count + last_used_at table). Each pick records a row via `palette_record_use`, and the boosts are:

   ```
   recency_boost   = exp(-age_seconds / 86_400)
   frequency_boost = log10(1 + use_count) * 0.5
   composite_score = base_score * (1 + recency_boost + frequency_boost)
   ```

   In English: a pick from minutes ago contributes a near-1.0 multiplicative bump that decays with a 1-day half-life; using something many times adds a smaller, log-scaled bonus on top. After two weeks both terms have shrunk well under 0.1.

3. **Client-side Fuse re-rank.** When the input is non-empty, the candidate list is re-ranked client-side with `fuse.js` weighted `title:0.7 / subtitle:0.2 / meta.tags:0.1` — this makes typo-tolerant fuzzy matching feel right without a second IPC call.

4. **Empty query → recent picks.** When you open the palette and type nothing, the list is sourced directly from `palette_usage` ordered by `last_used_at DESC`, hydrated back into hits per kind. Items whose underlying row has been deleted are silently dropped.

## Picking a row

Pressing `Enter` on a row (or clicking it):

1. Records the pick in `palette_usage` *before* dispatching the action so a thrown handler doesn't lose the recency row.
2. Dispatches a `CustomEvent` on `window`:

   | Kind | Event name | `detail` shape |
   |---|---|---|
   | command | `ccie:execute-command` | `{ command: string }` |
   | workflow | `ccie:run-workflow` | `{ workflowId: string }` |
   | notebook | `ccie:open-notebook` | `{ notebookId: string }` |
   | device | `ccie:open-device` | `{ deviceId: string }` |
   | block | `ccie:scroll-to-block` | `{ blockId: string, tabId?: string }` |
   | ssh | `ccie:open-ssh-connection` | `{ connectionId: string }` |

3. Closes the palette.

## Adding a new kind

To add an seventh kind (say, `parser` or `agent`):

1. **Rust types** — add the variant to `PaletteKind` in `src-tauri/src/palette/types.rs` and update `as_target_type()` to return the lowercase string.
2. **Source module** — create `src-tauri/src/palette/sources/<kind>.rs` matching the existing signature. Return `Ok(vec![])` if your backing table is missing so partially-migrated DBs don't break.
3. **Wire in** — add it to `sources/mod.rs`, the `for result in [...]` array in `search::run`, the `ALL_KINDS` constant, and the `parse_target_type` mapping in `recent.rs`.
4. **Hydrator** — add a `hydrate_<kind>` helper in `recent.rs` so the empty-query branch can hydrate it.
5. **Frontend** — add the variant to the `PaletteKind` union in `src/lib/palette.ts`, extend `iconForKind` / `labelForKind`, and add a handler to the dispatcher switch in `CommandPalette.tsx`. Include a `>` prefix letter in `parseCategoryPrefix`.
6. **Tests** — add a test in `palette_sources_misc_test.rs` verifying the empty-table fallback, and a row in `palette_search_test.rs::seed_full_fixture` so the global fan-out test still passes.

## Database

| Table | Migration | Purpose |
|---|---|---|
| `palette_index` | V0031 | FTS5 over command + tags + vendor + platform for every block. Kept in sync via triggers on `command_blocks` and `block_tags`. |
| `palette_usage` | V0031 | One row per `(target_type, target_id)`. UPSERT on every pick. Trimmed to top-5000 per type at app boot. |

## Troubleshooting

- **Blocks search returns nothing for tags.** Confirm `block_tags` has been migrated (V0028) and that the AFTER INSERT trigger on `block_tags` fired. The trigger refreshes the `tags` column in `palette_index`.
- **Empty query is empty.** Expected on a fresh install — `palette_usage` is empty. Pick a few items first.
- **Workflow/notebook results don't appear.** Check the corresponding migration ran (V0029 / V0030); if missing, the source returns `[]` instead of erroring.

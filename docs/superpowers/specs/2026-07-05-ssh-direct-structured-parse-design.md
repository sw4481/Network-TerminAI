# SSH-Direct Structured Parse — Design

> **Status:** Design approved 2026-07-05. Next: implementation plan via `writing-plans`.
> **Fixes:** the Structured/Diff view (`CommandBlock`'s `BlockTabStrip`, restored to the View menu via ⌘1/⌘2/⌘3 on 2026-07-02) is only reachable through Blocks mode's local OSC-133 terminal parsing — which does not work over SSH, since a remote device's CLI never emits shell-integration escape sequences. For a network engineer whose main workflow is SSHing into Cisco/network devices, there is today no path where a `show` command's output ever gets structured-parsed. This spec wires up an existing-but-unused backend code path (`structured_run_and_parse`) into a real UI trigger, so Structured/Diff becomes useful for the actual SSH workflow.

## Background

Investigation (2026-07-05) found:

- `src/lib/structured.ts:45-61`'s `runAndParseOverSsh` and its backend command `src-tauri/src/commands/structured.rs:54-83`'s `structured_run_and_parse` are fully implemented, registered (`lib.rs:497`), and tested (`structured.test.ts`) — but have **zero production callers**. The Rust doc comment on `structured_run_and_parse` states its own purpose plainly: "Block-completion only fires in Blocks mode, so a `show` command typed into an interactive SSH session never gets auto-parsed. This command SSHes to a saved connection, runs the command, and parses the full output directly."
- `structured_run_and_parse` does not read the terminal's live output — it opens a **separate** SSH exec via `ssh_exec::run_command` (the same `sshpass -e` primitive used by Change Verify and topology discovery, per `project_ssh_direct_pattern`) and runs the command fresh, then parses that output via `auto_parse::parse_and_store_adhoc` (`src-tauri/src/structured/auto_parse.rs:202-244`), which stores a synthetic `command_blocks` row (`block_source = 'ssh_adhoc'`, kept out of scrollback) and upserts `parsed_outputs`.
- `StructuredTab.tsx` and `StructuredDiff.tsx` are already fully generic — they need only `blockId`/`tabId`/`command`, with no dependency on a live PTY or real terminal block. They work unchanged for a synthetic `ssh_adhoc` block.
- Change Verify (`ChangeWindowPanel.tsx:80-150`) already has a working pattern for resolving a tab's SSH connection: it reads `getPasswordContext(tabId)` from `useSshPasswordStore` (host/user, auto-expires after 5 min, populated when a saved-connection SSH command is executed) and matches it against `ssh_list_connections` on `host` equality + lenient `user` check. This pattern is inlined in that component, not extracted into a shared helper.
- Device type (vendor/platform) is **never auto-detected** anywhere in this codebase — `setTabVendor` (`src/state/tabsStore.ts`) is only ever called from `ChangeWindowPanel.tsx`'s manual `<select>` dropdown. There is no standalone device-type selector elsewhere.
- No existing UI surface (context menu, command palette, menu bar) has any "run structured" trigger today — this spec adds the first one.

## Scope

- **Blocker found during planning (2026-07-05):** `Terminal.tsx`'s right-click context menu (`handleContextMenu` and all its items — Ask AI, Ask Agent, Ingest Topology, Copy, Paste) lives entirely inside `LegacyTerminal`, the same dead component Blocks mode was stuck in before the 2026-07-02 fix. Since `ENABLE_TERMINAL_REGISTRY` is on, right-click currently does nothing anywhere in the live app — not just for this new feature. Per operator decision, this plan first **ports the entire context menu into `Pane.tsx`** (same pattern as the Blocks-mode restoration: state/handlers/JSX moved one level up, selection read via a new `terminalRegistry.getSelection(terminalId)` export since `Pane.tsx` has no direct xterm reference), restoring all 5 existing items app-wide, and only then adds the new item alongside them.
- Add a **"Run as Structured..." context-menu item** to the now-restored (in `Pane.tsx`) right-click menu, alongside its existing items (Ask AI, Ask Agent, Ingest Topology, Copy, Paste).
- Add a new **`RunStructuredModal.tsx`** component that: prompts for the command to run (pre-filled from any selected terminal text), auto-resolves the tab's SSH connection + remembered device-type where possible, falls back to a small picker for whichever is missing, runs the command via the existing (currently dead) `runAndParseOverSsh`, and displays the result via the existing `StructuredTab`/`StructuredDiff` components.
- **Extract** the connection-resolution logic currently inlined in `ChangeWindowPanel.tsx` (lines ~128-150) into a shared helper (`src/lib/resolveTabConnection.ts`) so both `ChangeWindowPanel` and the new modal call the same logic instead of duplicating it.
- Persist a first-time device-type pick onto the tab via the existing `setTabVendor`, so subsequent runs on the same tab skip the picker.
- **Out of scope:** any backend/Rust changes (the backend path is already complete); a command-palette entry (context-menu only, per decision); a persistent history/drawer of past structured runs (closing the modal simply dismisses it — the underlying data already persists in `parsed_outputs`, so this can be added later without rework); auto-detecting vendor/platform from the SSH banner or prompt.

## Architecture

### Trigger & flow

1. User right-clicks in an active terminal tab (interactive SSH session or otherwise) and selects **"Run as Structured..."**. No precondition beyond being in an active tab — the modal itself handles a missing connection or device-type.
2. `RunStructuredModal` opens in an `input` state: a text field pre-filled with any selected terminal text (falls back to empty), where the user types/edits the exact command to run (e.g. `show ip interface brief`).
3. Before/as the modal opens, it resolves:
   - **Connection**: via the new `resolveTabConnection(tabId)` helper — reads `getPasswordContext(tabId)` from `useSshPasswordStore`, matches its `host`/`user` against `ssh_list_connections` (`host === ctx.host && (ctx.user == null || c.user == null || c.user === ctx.user)`, same logic as `ChangeWindowPanel.tsx:136-140`).
   - **Device type**: checks the tab's current vendor/platform via `useTabs` (set previously via `setTabVendor`, if this tab has been used with this feature — or with Change Verify — before).
   - **If both resolve:** no extra UI, straight to running once the command is confirmed.
   - **If either is missing:** the modal additionally shows the missing piece(s) inline — a saved-connection `<select>` (copying `ChangeWindowPanel`'s inline picker pattern) and/or a device-type `<select>`. On confirm, the device-type choice is persisted onto the tab via `setTabVendor` so future runs on this tab skip that step; the connection choice is NOT persisted (a tab's underlying SSH session doesn't change, so re-resolution via `resolveTabConnection` should naturally succeed next time).
4. On confirm, the modal transitions to `running`, calls `runAndParseOverSsh(tabId, connectionId, command, vendor, platform, password?)` — `password` sourced from `getPasswordContext` if available, else the existing `PasswordPromptModal` is shown first.
5. On success, the modal transitions to `result`, rendering `StructuredTab`/`StructuredDiff` unchanged, fed the synthetic `block_id` returned by the backend, with `tabId` = the real terminal tab id (so repeated runs of the same command on the same tab naturally accumulate diffable snapshot history via existing snapshot-diff logic — no new mechanism needed) and `command` = the command that was run.

### Result display & error handling

- **States:** `input` → `running` → `result` (Raw/Structured/Diff tabs) → `error`.
- **Result view** reuses `StructuredTab`/`StructuredDiff` verbatim — no changes to those components.
- **Closing the modal** simply dismisses it (per the chosen "popup overlay" pattern, not persistent) — since the result is stored in `parsed_outputs` under a real synthetic block, no data is lost; a future "recent runs" feature could read this back without any rework here.
- **Errors are surfaced inline in the modal, not swallowed:**
  - User cancels the connection/device-type picker → modal closes, no action taken.
  - SSH exec fails (timeout, auth failure, non-zero exit reflected in output) → show the raw error text in the modal's `error` state with a "Retry" action.
  - Parser fails (unsupported command/vendor combination) — per `parse_and_store_adhoc`'s existing "parse first, propagate errors" behavior — surface that specific error message. This is treated as useful signal ("this command isn't structured-parseable for this vendor/platform combination"), not a bug to hide.

### Wiring

- **Frontend only** — the backend path (`structured_run_and_parse`, `parse_and_store_adhoc`, `structured_get`) is already complete and requires no changes.
- `Terminal.tsx`: one new context-menu item, following the existing pattern for Ask AI / Ingest Topology / etc.
- New `src/components/RunStructuredModal.tsx`, rendered from `Terminal.tsx` alongside its other modals (`ParameterForm`, `NaturalLanguageInput`), owning the state machine described above.
- New `src/lib/resolveTabConnection.ts`: extracted from `ChangeWindowPanel.tsx`'s inline `useEffect` (~lines 128-150), used by both `ChangeWindowPanel` and `RunStructuredModal`. `ChangeWindowPanel` is updated to call the extracted helper instead of its inline copy — this is the one piece of cleanup directly serving this feature, not unrelated refactoring.
- No new Zustand store — reuses existing `useTabs`'s `setTabVendor`/vendor-platform fields and `useSshPasswordStore`'s `getPasswordContext`.

## Testing & Verification

- Unit tests for `resolveTabConnection` (extracted, testable in isolation from any component).
- Unit tests for `RunStructuredModal`'s state machine (`input` → `running` → `result`/`error` transitions), mocking `runAndParseOverSsh`.
- Existing `structured.test.ts` (already covers the TS wrapper) needs no changes.
- `ChangeWindowPanel.test.tsx` (if it exists) should be re-run after the extraction to confirm no behavior change from swapping inline logic for the shared helper.
- **Manual live verification against a real device** (per established project practice — don't claim success without proof): right-click in an active SSH tab, run a real `show` command via "Run as Structured...", confirm the Structured tab renders parsed data and the Raw tab shows the actual device output; run the same command a second time and confirm the Diff tab shows a meaningful (even if empty) comparison; test the error path against an intentionally bad command to confirm the parser-failure message surfaces correctly instead of a silent failure.

## Key Design Decisions

- **Context-menu trigger only**, no command-palette entry — matches the operator's explicit choice; the palette can be added later as a thin wrapper around the same modal if wanted.
- **Popup/modal overlay, not a persistent drawer** — keeps this a lightweight, ad-hoc "check one thing" tool rather than a new dashboard; the underlying data is durable regardless, so this choice doesn't block adding a history view later.
- **Auto-resolve the connection, but device-type is always manual on first use per tab** — because nothing in this codebase auto-detects vendor/platform today; inventing auto-detection here would be scope creep beyond what this spec needs to solve. Remembering the choice per-tab (via the already-existing `setTabVendor`) is the minimum needed to avoid repeated friction.
- **Extract, don't duplicate, the connection-matching logic** — `ChangeWindowPanel` and this new feature need the exact same host/user-matching behavior; duplicating it would create two subtly-divergent copies over time.
- **No backend changes** — the entire backend path was already built (apparently for this exact purpose) and is fully tested; this spec's only job is adding the missing caller.

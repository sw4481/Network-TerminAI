# Transit AI comparison, delivery contracts, and implementation record

> This file records the comparison, the implementation decisions for ranks 1–3, and the delivery record for ranks 5–9. Rank 4 and ranks 10+ remain unchanged. `Plans/README.md` is outside this document's update scope.

## Baseline and evidence boundaries

| Field | Value |
|---|---|
| Research date | 2026-08-18 |
| TerminAI baseline | `76b72a699e059b0cbcbe2afea8fdbaebf9967925` (`76b72a6`) |
| Competitor | Transit AI |
| Comparison basis | Public Transit documentation and the local TerminAI checkout at the commit above |
| Effort basis | One engineer working in this checkout, including focused automated tests and native validation |
| Scope of this artifact | Complete Transit capability inventory, TerminAI comparison, full effort-ranked backlog, and a decision-complete plan for ranks 1–3 |

### Status vocabulary

- **Have** — TerminAI already provides the material operator outcome, even if its implementation or naming differs.
- **Partial** — TerminAI has a related surface or reusable foundation, but not all of the Transit behavior.
- **Gap** — the material behavior is not present at this baseline.

The status is a product comparison, not a value judgment. TerminAI deliberately has deeper editor, automation, topology, notebook, workflow, and agent capabilities than Transit in several areas. Conversely, matching a Transit security claim requires the security property itself, not merely a similarly named UI.

### Official competitor sources

- [Transit feature inventory](https://transitai.app/docs/features/)
- [Transit security model](https://transitai.app/docs/security/)
- [Transit API sessions](https://transitai.app/docs/api-sessions/)
- [Transit connection imports](https://transitai.app/docs/how-tos/import-connections/)
- [Transit serial console](https://transitai.app/docs/how-tos/console-cable/)
- [Transit SFTP file transfer](https://transitai.app/docs/file-transfer/)
- [Transit packet capture](https://transitai.app/docs/packet-capture/)
- [Transit homepage](https://transitai.app/)
- [Transit FAQ](https://transitai.app/docs/faq/)
- [Transit local-model article](https://transitai.app/blog/why-the-ai-runs-local/)

These pages describe a closed-source commercial product, so the rows below record Transit product claims, not independent implementation verification.

### AI-ability count discrepancy

The detailed feature and security documentation is canonical for this comparison: both enumerate **six** fixed abilities — list sessions, read redacted output, propose a command, propose a read-only API call, query an open packet capture, and ask a clarifying question.

The official site was internally inconsistent during research. The live detailed pages and live homepage had moved to six, while search-indexed homepage copy still exposed four- and five-ability variants and still-published FAQ/blog passages described four. The comparison therefore treats six as the current product contract and records the older four/five wording only as stale official-site copy.

### Upstream xterm evidence

- TerminAI's browser runtime is the CDN-loaded `@xterm/xterm@5.5.0` in [`index.html`](../index.html), even though [`package.json`](../package.json) separately declares `@xterm/xterm ^6.0.0`. The browser bundle is the compatibility contract for ranks 1–2.
- TerminAI does not set `scrollback` in [`terminalAppearance.ts`](../src/lib/terminalAppearance.ts). The verified xterm 5.5 default is `1,000` rows: [xterm 5.5 `DEFAULT_OPTIONS`](https://raw.githubusercontent.com/xtermjs/xterm.js/5.5.0/src/common/services/OptionsService.ts).
- The matching official search bundle is `@xterm/addon-search@0.15.0`; its peer contract is `@xterm/xterm ^5.0.0`: [xterm 5.5 addon package](https://raw.githubusercontent.com/xtermjs/xterm.js/5.5.0/addons/addon-search/package.json).
- The separate SQLite scrollback ring is capped at 2 MiB per tab by [`session.rs`](../src-tauri/src/session.rs). It supports restoration and export but does not increase the live xterm viewport's 1,000-row search surface.

## Verified TerminAI baseline

TerminAI already has:

- terminal tabs, persistent xterms, nested pane layouts, and local shells;
- API/OpenAPI sessions, saved requests, request history, and reusable environments;
- workflows, command history, runnable notebooks, snapshots/diffs, and structured output;
- redacted session recording, in-app replay, and `.cast` export;
- remote-device packet capture with packet, protocol, stream, and hex views;
- local and cloud model providers, including Ollama and an OpenAI-compatible vLLM path;
- agent approvals, guardrail classification, cancellation, topology, and substantially deeper editor/automation surfaces.

Important implementation details:

- The active registry path implements macOS Cmd+C/V and Windows/Linux Ctrl+C/V in [`terminalRegistry.ts`](../src/lib/terminalRegistry.ts). Equivalent decisions are duplicated in the fallback [`usePty.ts`](../src/hooks/usePty.ts), the registry pane menu in [`Pane.tsx`](../src/components/Pane.tsx), and the legacy menu in [`Terminal.tsx`](../src/components/Terminal.tsx).
- Both terminal menus already expose selection-gated **Copy** and always-available **Paste**. There is no multiline-paste confirmation.
- [`terminalAppearance.ts`](../src/lib/terminalAppearance.ts) currently sets `rightClickSelectsWord: true`, so opening a context menu can replace a selection.
- Recording bytes pass through the built-in streaming [`Redactor`](../src-tauri/src/recording/redactor.rs) before [`CastWriter`](../src-tauri/src/recording/asciinema.rs) writes them. [`recording_export`](../src-tauri/src/commands/recording.rs) already copies the completed redacted cast to a user-selected `.cast` file.
- Full-buffer terminal search is absent. `BlockSearch` searches a completed command block only; SQLite FTS and persisted scrollback are not the live xterm buffer.

### Security track that must remain high priority

Security parity is **Partial** and must not be hidden by the effort order:

- Saved SSH passwords use reversible hard-coded XOR and can be returned to the frontend by [`commands/ssh.rs`](../src-tauri/src/commands/ssh.rs).
- Direct SSH automation explicitly sets `StrictHostKeyChecking=no` and `UserKnownHostsFile=/dev/null` in [`ssh_exec/mod.rs`](../src-tauri/src/ssh_exec/mod.rs); PCAP SCP uses the same bypass.
- [`ai_save_config`](../src-tauri/src/commands/mod.rs) stores provider API keys in SQLite and `ai_get_config` returns them to the UI.
- API environment values marked `is_secret` are stored as readable `.env` values. [`env_store.rs`](../src-tauri/src/api_runner/env_store.rs) explicitly defines the secret flag as display metadata, albeit with atomic writes and Unix mode 0600.
- TerminAI does have a separate encrypted vault and keyring-backed NETCONF credentials, but those do not repair the saved-SSH, AI-key, known-host, or API-environment paths above.

This security foundation ranks 14 by estimated implementation effort, but its product and risk priority is higher than rank 14.

## Complete Transit capability inventory and comparison

### Terminal and session capabilities

| Transit capability | Status | TerminAI at `76b72a6` |
|---|---:|---|
| Multi-session tabs | Have | Terminal tabs and persistent registry-backed xterms already exist. |
| Multiple sessions per device | Have | A saved SSH connection can be opened into additional terminal sessions; there is no single-session uniqueness gate. |
| Three connection gestures: context menu, double-click, focused Enter | Partial | TerminAI can connect from the saved-connections surface, but the complete three-gesture contract is not implemented. |
| Reconnect a dead SSH session in the same tab | Gap | Exit removes/disposes the current session; there is no Enter-to-reconnect ID swap preserving the pane slot. |
| Nested split tiling | Have | `panesStore`, `PaneContainer`, and the persistent terminal registry support nested right/down layouts. |
| Per-device syntax highlighting with alternate-screen bypass | Gap | ANSI rendering and alt-screen detection exist, but there is no per-device keyword highlighter. |
| Native quick Copy/Paste | Partial | Active-path shortcuts and both context menus exist, but behavior is duplicated and Linux Ctrl+Shift variants are missing. |
| Multiline-paste confirmation | Gap | Clipboard text is written directly to the PTY. |
| Per-host accent colors | Gap | App/terminal themes exist, but saved devices have no per-host accent field or rendering. |
| Device tags | Gap | Saved SSH inventory has no tag model. Command-block and RAG tags are different domains. |
| Device folders/hierarchy | Gap | Saved SSH inventory has no group/folder field or tree. |
| Search the full 32,000-row live scrollback | Partial | Completed command-block search and other search surfaces exist; the live xterm has no search addon and retains the xterm default 1,000 rows. |
| Redacted scrollback text export | Partial | Recordings are redacted and exportable as casts, but the bounded tab scrollback has no safe text export. |
| Optional age encryption for transcript export | Gap | No age recipient/encryption flow exists. |
| Timestamped session logging | Partial | Casts contain a UTC start time and event offsets, but there is no line-oriented timestamped text export or live external-file sink. |
| Capture command output and diff captures | Have | Snapshots, structured diffs, pre/post verification, and block exports already cover this outcome. |
| Command collections | Have | Workflows, templates, bundles, notebooks, and history provide richer reusable command collections. |
| Configurable command button bar | Partial | Reusable commands exist, but not as a per-session configurable button bar. |
| TOFU host-key pinning and changed-key approval | Gap | Direct automation disables host-key checking; no fingerprint pin/replace UX exists. |
| Strict cipher floor with per-device legacy opt-in | Gap | No TerminAI-owned cipher policy or remembered legacy exception exists. |
| Local OS shells | Have | Local PTYs and editor-integrated terminal sessions already exist. |
| USB serial console | Gap | No serial transport or cable inventory exists. |
| Serial Send Break | Gap | No serial control path exists. |
| Serial auto-reconnect | Gap | No serial lifecycle exists. |
| Dual-pane SFTP | Gap | FTP/TFTP server features are not an SSH-inventory-backed SFTP browser. |
| Local-interface PCAP capture | Gap | TerminAI captures on supported remote devices, not a local NIC through `tcpdump`/`pktmon`. |
| Local PCAP explorer/open-file flow | Partial | TerminAI has packet list, filters, protocol hierarchy, follow-stream, and hex views for its captured files, but no general local `.pcap`/`.pcapng`/`.pcap.gz` open flow. |
| Deterministic PCAP findings with one-click evidence | Partial | The sidecar provides packet summaries and filters, but not Transit's complete deterministic findings catalogue/evidence drawer. |

### AI and security capabilities

| Transit capability | Status | TerminAI at `76b72a6` |
|---|---:|---|
| Exactly six fixed investigation-only abilities | Gap | TerminAI intentionally exposes a broader, extensible shell/MCP/agent surface. A constrained profile does not exist. |
| Address open devices by user-facing name | Partial | Tabs and connections carry names, but the agent execution contract is primarily tab-ID scoped rather than a fixed name-to-session tool surface. |
| Per-vendor permit lists | Partial | Vendor/platform guardrail rules exist, but they classify both read and write commands by risk instead of enforcing a read-only permit list. |
| Mandatory explicit approval for every AI proposal | Partial | Approval UI and pending approvals exist, but tier-0 commands can auto-approve and the product is not investigation-only. |
| Redact device output before the model sees it | Partial | The recording boundary is redacted; all AI scrollback/tool-output paths do not share that Redactor boundary. |
| Bounded investigations | Partial | Cancellation flags and stop controls exist; no approximately 50-round/spend checkpoint contract exists. |
| Browser OAuth sign-in | Gap | TerminAI is local-first and has no Transit-style hosted identity flow. |
| Native-keyring, write-only SSH credentials | Partial | NETCONF and the separate vault use keyring/encrypted foundations, but saved SSH uses reversible XOR and exposes a decrypt command. |
| BYOK | Have | Provider keys can be configured for cloud providers, subject to the security debt recorded above. |
| Ollama and OpenAI-compatible local models | Have | Ollama and vLLM/OpenAI-compatible provider paths exist. |
| Product telemetry disabled by default | Partial | No product analytics/telemetry surface was found, but TerminAI does not yet publish or enforce a Transit-equivalent telemetry contract. |

### API and import capabilities

| Transit capability | Status | TerminAI at `76b72a6` |
|---|---:|---|
| API sessions in the same workspace | Have | `ApiTab` supports request construction and response inspection beside terminal tabs. |
| Saved requests and collections | Have | Saved requests, history, OpenAPI import, targets, environments, and a command palette already exist. |
| Postman collection import | Gap | OpenAPI import is not Postman collection import. |
| Bulk SSH import from SecureCRT, MTPuTTY, MobaXterm, OpenSSH config, and CSV | Gap | Saved SSH CRUD exists, but no transactional multi-format importer exists. |

### Commercial capabilities

| Transit capability | Status | TerminAI disposition |
|---|---:|---|
| Team invites | Gap | Hosted-service concern; outside the local-desktop roadmap. |
| Member tiers | Gap | Hosted-service concern; outside the local-desktop roadmap. |
| Seat management | Gap | Hosted-service concern; outside the local-desktop roadmap. |
| Per-member overage controls | Gap | Hosted-service concern; outside the local-desktop roadmap. |
| Usage metering | Gap | Hosted-service concern; outside the local-desktop roadmap. |
| Subscription billing | Gap | Hosted-service concern; outside the local-desktop roadmap. |

Browser OAuth and all team/billing infrastructure remain outside the local-desktop roadmap unless TerminAI deliberately adopts a hosted commercial service.

## Complete effort-ranked backlog

These are implementation-effort estimates, easiest to hardest, for one engineer against the baseline checkout. They are not product-priority scores.

| Rank | Capability | Estimate | Notes |
|---:|---|---:|---|
| 1 | Full 32,000-row xterm scrollback search | 2–4 days | Live xterm buffer; no SQLite FTS substitution. |
| 2 | Consistent native clipboard behavior plus multiline-paste confirmation | 2–4 days | Consolidates four duplicated paths and locks the OS matrix. |
| 3 | Redacted scrollback export plus timestamped recording-to-text export | 3–5 days | Uses the existing bounded scrollback and already-redacted casts. |
| 4 | Optional age-encrypted transcript export | 3–5 days | Recipient UX, binary/dependency choice, and failure handling. |
| 5 | Configurable command button bar | 3–6 days | Reuse workflow/template foundations. |
| 6 | Device tags, folders, and host accent colors | 4–7 days | Inventory/schema/sidebar work. |
| 7 | Per-device syntax highlighting with alternate-screen bypass | 1–2 weeks | Stateful terminal-output transform and preference model. |
| 8 | SSH reconnect-in-place | 1–2 weeks | PTY lifecycle, registry identity, tab/pane preservation, and failure UX. |
| 9 | Postman collection import | 1–2 weeks | Schema mapping, auth/environment handling, review, and import tests. |
| 10 | Bulk SSH inventory import | 2–3 weeks | Five parsers, credential mapping, hierarchy, review, and transactional write. |
| 11 | USB serial, Send Break, and auto-reconnect | 2–4 weeks | Cross-platform device discovery and transport lifecycle. |
| 12 | Local-interface PCAP capture | 3–5 weeks | OS tools, privilege UX, lifecycle limits, and file registration. |
| 13 | Dual-pane SFTP | 4–7 weeks | Local/remote filesystem operations, queueing, progress, cancellation, drag/drop. |
| 14 | Credential/keyring, TOFU, and cipher-policy foundation | 5–8 weeks | Security priority is higher than this effort rank. |
| 15 | Deterministic PCAP findings | 6–10 weeks | Protocol analysis, bounded evidence queries, and stable finding rules. |
| 16 | Optional investigation-only agent profile | 6–10 weeks | Fixed tools, name addressing, read-only policy, redaction boundary, and bounded runs. |

## Ranks 1–3 delivery contract

Implement ranks 1, 2, and 3 sequentially. They overlap in `terminalRegistry.ts`, `usePty.ts`, `Pane.tsx`, `Terminal.tsx`, and their tests, so parallel edits would create avoidable conflicts.

Cross-rank constraints:

- Preserve the active registry path and the retained fallback path.
- Preserve `sidecar/.venv` and app data.
- Add no preference, database migration, or settings schema for ranks 1–3.
- Do not add live transcript sinks, age encryption, user-defined redaction patterns, or a new recording lifecycle.
- Do not update `Plans/README.md` as part of these ranks unless separately requested.
- Preserve unrelated worktree changes, including the existing deletions of `API_KEY_MITIGATION.md` and `onepager.md`.

## Rank 1 — full 32,000-row live scrollback search

### Outcome

The focused terminal can search its live 32,000-row xterm buffer. Cmd+F on macOS and Ctrl+F on Windows/Linux opens the existing search presentation; literal, case-insensitive results are highlighted and navigable without consulting SQLite.

### Runtime and dependency decision

Keep the current CDN runtime model:

1. Add `<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-search@0.15.0/lib/addon-search.js"></script>` to [`index.html`](../index.html), after the current xterm 5.5 addon scripts.
2. Do not add `@xterm/addon-search` to `package.json` in this rank. The running constructors come from CDN globals, and mixing the declared xterm 6 package with a bundled addon would create two runtime families.
3. Add `SearchAddon` to the global `Window` declaration in [`usePty.ts`](../src/hooks/usePty.ts). Resolve both the UMD namespace and direct-constructor shapes, as the current Fit/WebLinks/Clipboard loading code does.

### Shared terminal options

Edit [`terminalAppearance.ts`](../src/lib/terminalAppearance.ts):

- Add `scrollback: number` to `MutableXtermOptions`.
- Return `scrollback: 32000` from `createTerminalOptions`.
- Keep the value fixed; do not add a user setting or persistence change.
- Extend the existing appearance/options tests and the xterm 5.5 fixture so replacing `xterm.options` cannot accidentally reset the buffer to 1,000.

The 2 MiB SQLite ring remains unchanged. Rank 1 searches the live xterm buffer; persistence limits are a separate concern.

### One addon per terminal

#### Persistent registry path

Edit [`terminalRegistry.ts`](../src/lib/terminalRegistry.ts):

- Add `searchAddon` to `TerminalEntry`.
- Instantiate one `SearchAddon` in `getOrCreate`, load it into that entry's xterm, and never share it across registry entries.
- Expose narrow accessors for the UI: find next, find previous, subscribe to result changes, clear decorations, and focus the owning xterm. Do not expose the registry map.
- Dispose the search-result subscription with the search UI and dispose the addon with the owning terminal. `terminalRegistry.dispose` remains the terminal lifetime boundary; detach/reattach must retain search capability with the xterm.

#### Retained fallback path

Edit [`usePty.ts`](../src/hooks/usePty.ts):

- Instantiate and load one search addon beside Fit, WebLinks, and Clipboard for every fallback xterm.
- Add the addon operations to `PtyHandle` or a narrow search handle returned with it.
- Dispose the addon/subscription during the existing hook cleanup.

Fail startup consistently with the existing addon gate if the search constructor is absent. Do not silently provide a 32,000-row terminal with a dead search shortcut.

### Search presentation and state

Reuse [`BlockSearch.tsx`](../src/components/BlockSearch.tsx) and [`BlockSearch.css`](../src/components/BlockSearch.css):

- Add an optional configurable input label/placeholder while retaining the current command-block default.
- Terminal search uses `Search terminal scrollback…`; command-block search continues to use `Search in output…`.
- Keep the existing counter, previous/next buttons, Enter, Shift+Enter, and Escape behavior.

Add one small shared controller hook, `src/hooks/useTerminalBufferSearch.ts`, used by both terminal paths. It owns only presentation state:

- `open`, `query`, `resultIndex`, and `resultCount`;
- subscription to the addon's `onDidChangeResults`;
- literal `findNext`/`findPrevious` calls with `caseSensitive: false`, `regex: false`, and `wholeWord: false`;
- match and active-match decorations so all matches are visible;
- close behavior that clears the query and decorations, removes the result subscription, and restores xterm focus.

An empty query clears decorations and reports zero results. Result indexes from the addon are normalized to the zero-based `currentMatch` contract already used by `BlockSearch`.

### Shortcut scoping

- In the registry path, [`Pane.tsx`](../src/components/Pane.tsx) opens search only when that pane is the focused pane and the keyboard event originated inside its terminal surface.
- In the fallback path, [`Terminal.tsx`](../src/components/Terminal.tsx) opens search only when the event target is inside that terminal's wrapper.
- Cmd+F is accepted only on macOS; Ctrl+F is accepted only on Windows/Linux.
- Prevent the browser/WebView find UI only after the event is proven to belong to the focused terminal.
- Search input keystrokes must not reach the PTY.
- Enter moves forward, Shift+Enter moves backward, and Escape closes, clears decorations, and returns keyboard focus to the same xterm.

Do not route this feature through SQLite FTS, `tab_scrollback`, command blocks, or restored session snapshots.

### Rank 1 focused tests

- [`terminalRegistry.test.ts`](../src/lib/terminalRegistry.test.ts): one addon per entry, no sharing, retain on detach, dispose with terminal, and result accessor routing.
- [`usePty.test.tsx`](../src/hooks/usePty.test.tsx): fallback addon creation, load, result subscription, and cleanup.
- New `src/hooks/useTerminalBufferSearch.test.tsx`: literal/case-insensitive options, result-count updates, next/previous direction, empty-query clearing, and close/focus behavior.
- [`Pane.test.tsx`](../src/components/Pane.test.tsx): only the focused terminal reacts to Cmd/Ctrl+F.
- [`BlockSearch.test.tsx`](../src/components/BlockSearch.test.tsx): configurable terminal label without regressing command-block defaults.

### Rank 1 acceptance

- A terminal that has emitted more than 1,000 rows can find a match older than row 1,000.
- Two split panes keep independent queries, result counts, and active highlights.
- Switching tabs or detaching/reattaching a pane does not create another addon or lose the 32,000-row buffer.
- Search never queries persisted scrollback and never writes a schema row.

## Rank 2 — clipboard normalization and paste safety

### Outcome

Every terminal entry point uses one clipboard policy. The OS shortcut matrix is stable, right-click behavior is unchanged except for selection safety, and every multiline paste requires a native confirmation that reveals only counts.

### Central helper

Add `src/lib/terminalClipboard.ts` and make it the only place that decides terminal copy/paste behavior. Export:

- a pure platform normalizer returning `macos`, `windows`, or `linux`;
- a pure shortcut classifier returning `copy`, `paste`, `pass-through`, or `swallow`;
- `copyTerminalSelection(selection)`;
- `pasteClipboardToTerminal(write)`, where `write` is the caller-supplied PTY writer for the resolved backend ID.

The helper may read/write `navigator.clipboard`, but it must not import the terminal registry or a React store. Platform and clipboard/dialog functions remain injectable in tests.

Use the helper from all four paths:

1. the active custom-key handler in [`terminalRegistry.ts`](../src/lib/terminalRegistry.ts);
2. the fallback custom-key handler in [`usePty.ts`](../src/hooks/usePty.ts);
3. the registry context menu in [`Pane.tsx`](../src/components/Pane.tsx);
4. the legacy context menu in [`Terminal.tsx`](../src/components/Terminal.tsx).

Remove the duplicate clipboard reads, writes, modifier decisions, and direct PTY writes from those files.

### Locked shortcut matrix

| Platform | Copy | Paste | No-selection Ctrl+C |
|---|---|---|---|
| macOS | Cmd+C | Cmd+V | Ctrl+C remains PTY input; Cmd+C with no selection is swallowed |
| Windows | Ctrl+C | Ctrl+V | Pass through to PTY as SIGINT |
| Linux | Ctrl+C and Ctrl+Shift+C | Ctrl+V and Ctrl+Shift+V | Pass through to PTY as SIGINT |

Additional rules:

- Ignore copy/paste classification when Alt is held or when an unexpected Meta modifier is present.
- Normalize `event.key` to lowercase so shifted Linux chords work.
- Copy handles the event only when a non-empty xterm selection exists.
- Paste handles the event once the platform chord matches, even if the clipboard is empty; an empty clipboard performs no PTY write.
- Return the correct boolean to xterm: handled actions are swallowed, and `pass-through` reaches `onData`.

### Context-menu behavior

- Keep **Copy** visible only when a selection exists.
- Keep **Paste** visible at all times.
- Preserve all richer pane actions, including Ask AI, Ask agent, topology ingestion, and structured execution.
- In [`terminalAppearance.ts`](../src/lib/terminalAppearance.ts), set `rightClickSelectsWord: false` so opening the menu never replaces the user's existing selection.
- Do not add auto-copy-on-selection or middle-click paste.

### Multiline confirmation

`pasteClipboardToTerminal` must:

1. Read the clipboard once.
2. Treat text containing either CR or LF as multiline.
3. Normalize CRLF as one delimiter for the displayed line count; lone CR and lone LF each delimit a line.
4. Count characters as Unicode code points with `Array.from(text).length`.
5. For multiline text, call the native `ask` dialog from `@tauri-apps/plugin-dialog` with a warning title and a message shaped only as: `Paste N lines (M characters) into this terminal?`
6. Never put clipboard text, a prefix, a preview, a command, or device content into the dialog or logs.
7. Write the original clipboard string unchanged only after confirmation.
8. On Cancel, make no PTY write and return a cancelled result.

Single-line text remains immediate. Do not add a preference, “remember my choice,” bracketed-paste rewrite, schema field, or telemetry event.

### Rank 2 focused tests

- New `src/lib/terminalClipboard.test.ts`: the complete macOS/Windows/Linux matrix, case normalization, modifier exclusions, no-selection SIGINT pass-through, empty clipboard, single-line immediate paste, CR/LF/CRLF detection, Unicode counts, confirmation, cancellation, dialog failure, and write failure.
- [`terminalRegistry.test.ts`](../src/lib/terminalRegistry.test.ts) and [`usePty.test.tsx`](../src/hooks/usePty.test.tsx): both custom-key handlers delegate and honor the helper's handled/pass-through result.
- [`Pane.test.tsx`](../src/components/Pane.test.tsx): selection-gated Copy, always-present Paste, richer actions retained, confirmed write uses the resolved backend PTY ID, and Cancel writes nothing.
- Add focused legacy-menu coverage beside [`Terminal.tsx`](../src/components/Terminal.tsx) if none exists; do not leave the fallback behavior untested.
- Terminal appearance tests: `rightClickSelectsWord` is false for new and live-updated terminals.

### Rank 2 acceptance

- On macOS, Cmd+C/V works in the focused xterm and Ctrl+C still reaches the shell.
- On Linux, both Ctrl and Ctrl+Shift clipboard chords work.
- On Windows/Linux, Ctrl+C without a selection still interrupts a running process.
- Opening either terminal menu does not alter the current selection.
- Cancelling a multiline paste produces zero PTY writes and exposes no clipboard content.

## Rank 3 — safe text exports

### Outcome

TerminAI gains two explicit Tauri commands and TypeScript wrappers:

    terminal_export_scrollback(tabId, targetPath) -> void
    recording_export_text(recordingId, targetPath) -> void

The first exports the existing bounded scrollback as redacted plain text. The second converts a completed, already-redacted asciinema v2 recording into UTC-timestamped logical lines.

### Shared Rust text-export module

Add `src-tauri/src/transcript_export.rs` and expose it from [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs). Keep the module pure except for command-level file reads/writes. It owns:

- built-in Redactor application for raw scrollback;
- a stateful ANSI/control-sequence stripper that handles sequences split across input chunks;
- CRLF/lone-CR/lone-LF logical-line reconstruction;
- asciinema v2 header/event parsing;
- UTC RFC3339 millisecond formatting.

Do not add a second recording writer. Do not add user redaction patterns. Build the full output in memory and parse it successfully before opening/truncating the selected target, so a malformed cast cannot leave a misleading partial export.

The ANSI/control scanner must remove CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC, single-character escape sequences, backspace, NUL, and other non-printing C0/DEL bytes. Preserve horizontal tabs and preserve CR/LF until the line reconstructor consumes them.

### `terminal_export_scrollback`

Add the command beside the existing `tab_scrollback` command in [`commands/mod.rs`](../src-tauri/src/commands/mod.rs), then register it in [`lib.rs`](../src-tauri/src/lib.rs).

Command behavior:

1. Validate `tab_id` with the existing tab-ID validator.
2. Read [`session::read_scrollback`](../src-tauri/src/session.rs); do not read the xterm DOM or SQLite FTS.
3. Run the entire byte stream through `Redactor::new(&[])`, the same built-in pattern set used by recordings.
4. Lossy-decode any remaining invalid UTF-8, strip ANSI/control sequences, and normalize line endings to LF.
5. Write UTF-8 text to the selected `target_path`.
6. Propagate validation, redaction, read, and write errors to the caller. Never return success after a failed write.

This exports the existing bounded 2 MiB backend ring. It does not promise a byte-for-byte dump of the 32,000-row live xterm buffer.

### `recording_export_text`

Add the command to [`commands/recording.rs`](../src-tauri/src/commands/recording.rs), register it in [`lib.rs`](../src-tauri/src/lib.rs), and reuse `transcript_export`.

Command behavior:

1. Resolve the recording by ID; missing ID returns `recording not found`.
2. Require `ended_at` to be non-null. An active recording returns a clear `recording is still active` error.
3. Read the existing cast path. Do not call the Redactor again: cast output was redacted before disk write, and reprocessing would create a second, divergent security boundary.
4. Require a valid asciinema v2 header with a usable Unix `timestamp`.
5. Parse subsequent JSON event lines in file order. Use output-channel (`o`) events and ignore other valid channels; malformed JSON, invalid event shapes, non-finite/negative offsets, or an invalid header fail the export.
6. Feed event text through the stateful ANSI/control scanner and logical-line reconstructor so escape and CRLF sequences can span event chunks.
7. Prefix each flushed logical line with the absolute UTC timestamp of the event that began that line:

       [2026-08-18T19:42:17.318Z] show ip interface brief

8. Calculate the timestamp as header Unix seconds plus the event offset, rounded to the nearest millisecond.
9. For a non-empty line, the first visible character establishes its event timestamp. For an empty line, its delimiter event establishes the timestamp. A CR held across chunks retains the CR event's time.
10. Treat CRLF as one line ending and lone CR or LF as a line ending.
11. Flush a final unterminated non-empty line at EOF. Flush a pending lone CR as a line ending; do not invent an extra empty line after a terminal newline.
12. Write the fully generated UTF-8 result only after parsing succeeds.

This is a recording-to-text export, not Transit's live timestamped file logger. A live external-file sink remains outside rank 3.

### TypeScript wrappers

- Add `terminalExportScrollback(tabId, targetPath)` to [`src/lib/tauri.ts`](../src/lib/tauri.ts), invoking `terminal_export_scrollback`.
- Add `recording.exportText(recordingId, targetPath)` to [`src/lib/recording.ts`](../src/lib/recording.ts), invoking `recording_export_text`.
- Keep the existing `recording.export` cast wrapper unchanged for compatibility.

### Terminal UI

Add **Export redacted scrollback…** to both terminal menus:

- [`Pane.tsx`](../src/components/Pane.tsx) uses the resolved backend PTY ID, not the stable layout/registry ID. If no backend ID is ready, disable the action rather than exporting the wrong tab.
- [`Terminal.tsx`](../src/components/Terminal.tsx) uses `handle.tabId` in the fallback path.
- Open the existing native save dialog with a `.txt` filter and a stable default filename.
- A cancelled save dialog returns without invoking Tauri.
- Close the menu after a selection is made.
- On command failure, show a native error message through `@tauri-apps/plugin-dialog`; do not show a success message first or claim that a file was written.

Keep Copy, Paste, Ask AI/agent, topology, and structured actions intact.

### Recordings UI

Edit [`RecordingsTab.tsx`](../src/components/recording/RecordingsTab.tsx) and its CSS:

- Rename the current ambiguous **Export** button to **Cast** without changing its `.cast` behavior.
- Add a separate **Text** button beside it.
- Both buttons remain disabled for active recordings.
- Text opens a `.txt` save dialog, returns silently on Cancel, calls `recording.exportText`, and displays a native error on failure.
- Do not delete, rename, replace, or regenerate the source cast.

### Rank 3 focused Rust tests

Add `src-tauri/tests/transcript_export_test.rs` for the pure module and command helpers:

- built-in scrollback redaction removes known secret patterns before output;
- ANSI/OSC/DCS/control removal, including sequences split across event chunks;
- valid header plus event offsets produce UTC RFC3339 timestamps with milliseconds;
- multiple event chunks join into one logical line;
- one event can finish one line and begin another with distinct line-start timestamps;
- CRLF within one event and across two events;
- lone CR and lone LF;
- blank lines;
- final unterminated line;
- final pending CR;
- valid non-output channels are ignored;
- malformed/missing/non-v2 headers and malformed events fail;
- negative/non-finite event offsets fail;
- missing recording fails;
- active recording fails;
- parse failure does not overwrite the target;
- write errors propagate.

Retain the existing recording supervisor, Redactor, asciinema writer, session-ring, and cast-export tests.

### Rank 3 focused frontend tests

- [`Pane.test.tsx`](../src/components/Pane.test.tsx): action visibility, resolved PTY ID, save-dialog cancellation, invocation arguments, failure dialog, and existing menu actions retained.
- Legacy terminal tests: fallback PTY ID, cancellation, invocation, and failure.
- New `src/components/recording/RecordingsTab.test.tsx`: Cast/Text separation, completed-only enablement, both dialog filters/defaults, cancellation as a no-op, correct wrappers, and surfaced failures.
- Wrapper tests or invoke-mock assertions for exact command names and camelCase argument objects.

### Rank 3 acceptance

- Exported scrollback contains no tested built-in secret and no terminal escape/control sequences.
- A completed cast produces deterministic timestamped text across arbitrary event chunk boundaries.
- An active or malformed recording cannot produce a claimed-success export.
- Cancelling either save dialog invokes no backend command and creates no file.
- Existing `.cast` export and replay continue to work unchanged.

## Verification for ranks 1–3 implementation

### Focused automated suites

Run the focused frontend tests while excluding worktrees:

    bunx vitest run \
      src/lib/terminalRegistry.test.ts \
      src/hooks/usePty.test.tsx \
      src/hooks/useTerminalBufferSearch.test.tsx \
      src/lib/terminalClipboard.test.ts \
      src/components/BlockSearch.test.tsx \
      src/components/Pane.test.tsx \
      src/components/TerminalSlot.test.tsx \
      src/components/recording/RecordingsTab.test.tsx \
      --exclude '**/.worktrees/**'

Run the focused Rust suites:

    cargo test --manifest-path src-tauri/Cargo.toml \
      --test transcript_export_test \
      --test recording_supervisor_test \
      --test session_test

Then run the repository-level gates:

    bun run test
    bun run build:relaxed
    git diff --check

If the implementation changes shared Rust module visibility or command registration beyond the focused tests, also run:

    cargo test --manifest-path src-tauri/Cargo.toml

### Native manual checks on macOS

Launch only through:

    ./run.sh

Verify:

1. Generate more than 1,000 terminal rows, search for an old unique marker, navigate forward/backward, and close with Escape.
2. Split the tab and prove search state and focus are independent per pane.
3. Verify right-click Copy/Paste, Cmd+C/V, and Ctrl+C interrupt behavior.
4. Cancel a multiline paste and confirm no bytes reach the shell; approve a harmless multiline paste and confirm the original bytes arrive.
5. Export scrollback containing ANSI color and a known test-secret shape; inspect the text file for clean text and redaction.
6. Record output whose line is split across cast events, stop it, export Text, and inspect timestamps/line reconstruction.
7. Export the same recording as Cast and replay it to prove existing behavior is intact.
8. Force or mock an unwritable target and verify the UI reports failure without a success claim.

Windows and Linux behavior is unit-tested in this delivery but remains explicitly **unverified on those operating systems** until the same shortcuts and paste flow are exercised there.

### Sidecar release invariant

Although ranks 1–3 are primarily terminal/export changes, the final native validation must satisfy the repository invariant:

- `target/debug/TerminAI` is running.
- Its child is `sidecar/.venv/bin/python -m ccie_sidecar`.
- The sidecar warmup ping succeeds.
- `sidecar_status.last_seen` advances through fresh heartbeat timestamps.
- The footer chip leaves `starting` and displays the sidecar version.

Do not report ranks 1–3 complete until the focused tests, repository gates, native checks, and sidecar invariant all pass. A Windows/Linux acceptance gate remains open and must be labeled unverified rather than silently passed.

## Explicit non-goals

- No live transcript file writer.
- No age encryption in ranks 1–3.
- No user-defined redaction regex UI.
- No clipboard-content preview.
- No auto-copy selection or middle-click paste.
- No new terminal, API, or recording settings.
- No database migration.
- No replacement of the existing recording format or writer.
- No SQLite/FTS implementation of live xterm search.
- No browser OAuth, team, seat, usage, overage, or billing infrastructure.

## Ranks 5–9 delivery contract and implementation record

| Field | Value |
|---|---|
| Delivery date | 2026-08-19 |
| Implementation baseline | `777b316508344505d5fd917eafbc2e6265f2d576` (`777b316`) on `main` |
| Delivered ranks | 5, 6, 7, 8, and 9 |
| Deliberately untouched | Rank 4, ranks 10+, `Plans/README.md`, `sidecar/.venv`, and application data |
| Unrelated worktree state | The existing deletions of `API_KEY_MITIGATION.md` and `onepager.md` remain unmodified |

The ranks were implemented sequentially. Shared terminal and SSH behavior retains both the registry path and the legacy fallback path. Passwords are excluded from frontend connection state, Postman previews and results contain no credential values, and no release or rank-4/rank-10+ change is part of this delivery. Repository publication occurs only after the recorded gates pass.

### Rank 5 — global configurable workflow bar

Delivered contract:

- One ordered global setting is persisted in `app_flags` as `ccie_global_command_bar_v1`. The Rust boundary rejects malformed JSON, unsupported schema versions, duplicate IDs, and missing workflows; stale deleted IDs are omitted during hydration and disappear on the next save.
- A single compact, horizontally scrollable bar renders above the active terminal workspace only. The existing workflow picker supplies pins, and the bar provides unpin plus keyboard-accessible ordering controls.
- Dispatch resolves the focused stable pane through `terminalRegistry.ptyTabIdFor`, retains the backend-ID fallback, applies connected-device vendor/platform compatibility, and leaves mismatches visible but disabled.
- The global bar and existing runner share one sequential workflow-to-terminal dispatcher. Parameterized workflows still use the existing form, multi-step order is preserved, and completion is recorded only after every PTY write succeeds.

### Rank 6 — organized SSH inventory and live connection metadata

Delivered contract:

- Migration `V0084__ssh_inventory_organization.sql` adds the root folder, nested `ssh_folders`, and optional folder/tags/accent/vendor/platform metadata with legacy-safe defaults.
- Rust commands enforce eight folder levels, trimmed 64-character case-insensitive sibling uniqueness, cycle rejection, collision-safe reparenting on delete, normalized tag limits, fixed theme-safe accent keys, and the shared vendor contract.
- SSH TypeScript data and invocations are centralized. Existing callers retain optional request fields, while the saved-connections UI now provides a folder tree, searchable device list, tag filters, accent markers, and metadata editing without adding a permanent sidebar.
- The in-memory terminal connection store is keyed by stable terminal and PTY IDs and carries only safe connection/display metadata plus lifecycle state. The accepting terminal handler, not the sender, owns state updates. Accent rendering is limited to inventory, connected-device, and focused-pane UI.

### Rank 7 — presentation-only per-device syntax highlighting

Delivered contract:

- Migration `V0085__ssh_syntax_profiles.sql` keeps migrated devices disabled with `auto`; new devices default to enabled `auto`, with off/auto/Cisco/Junos/Arista/generic choices.
- Built-in ordered, case-insensitive literal profiles decorate xterm buffer ranges after completed writes. They never rewrite PTY bytes or inject ANSI, so recordings, exports, command capture, parsers, and AI input retain raw output.
- Only touched lines are rescanned, prior line markers are disposed before replacement, per-line matches are capped, and alternate-screen enter/exit suspends and resumes highlighting on registry and fallback paths.
- Missing decoration APIs fail open to raw terminal output. Editing saved device metadata updates linked live sessions without restarting PTYs.

### Rank 8 — manual SSH reconnect in the same terminal

Delivered contract:

- The xterm, pane, stable terminal ID, and backend PTY ID are retained. Reconnect regenerates and reinjects the saved SSH command into the existing local shell PTY.
- Saved SSH command lifecycle events authoritatively drive connecting, connected, disconnected, reconnecting, and error states. Output matching remains diagnostic only.
- A disconnected pane shows the device, known exit status, **Reconnect**, and **Use local shell**. Unmodified Enter is intercepted only for the focused disconnected terminal surface, never for search, forms, Blocks mode, or another pane.
- Reconnect permits one attempt, reloads the latest saved record by ID, reuses the existing transient password-resolution path, marks the connection used, and writes to the same PTY. Deleted connections remain recoverable through the local-shell action; there is no retry loop or background reconnect.

### Rank 9 — safe Postman Collection v2.1 import

Delivered contract:

- Migration `V0086__postman_collections.sql` adds collection/folder/display/auth metadata while preserving native saved-request behavior.
- A pure Rust parser powers preview and fingerprint-confirmed commit. It validates v2.1 input, applies the 10 MiB/2,000-request/20-folder-level and environment limits before writes, returns value-free summaries, and fully normalizes an import before starting persistence.
- Nested folders, inherited supported auth, supported HTTP methods, string/structured URLs, enabled headers/query/path variables, raw JSON/text, and URL-encoded forms map into grouped requests. Unsupported methods, scripts, examples, executable code, multipart/binary/GraphQL bodies, and unsupported auth strategies are skipped with warnings.
- Collection, URL, and extracted credential values move into a new collision-free environment. Secret variables, auth-derived values, and credential-like keys receive secret metadata; request rows keep `${env:KEY}` references instead of credential literals.
- Environment artifacts and the SQLite collection/request transaction are coordinated with rollback cleanup. Preview/commit re-read the read-only source and reject fingerprint changes. The Saved Requests drawer provides a native JSON chooser, safe preview, explicit confirmation, grouped display, imported-environment restore, and environment-prefix URL validation.

## Ranks 5–9 verification record

### Automated gates

The following gates passed against the delivered worktree:

- Focused frontend coverage for workflow dispatch/bar behavior, SSH inventory/store/reconnect, syntax highlighting, and Postman wrappers/UI.
- Focused Rust coverage for workflow settings, SSH organization, migrations V0084–V0086, Postman parsing/transactions, and initial plus periodic sidecar heartbeats.
- `bun run test`: 267 files and 2,052 tests passed.
- `bun run build:relaxed`: production frontend build and TypeScript checks passed; only existing Vite chunk/dynamic-import warnings were emitted.
- `cargo test --manifest-path src-tauri/Cargo.toml`: the library reported 479 passed and 6 ignored, with all integration and documentation suites passing.
- `git diff --check`: passed.

### Native macOS gate

The app was launched through `./run.sh`, which selected the existing `sidecar/.venv` under `CCIE_FORCE_VENV=1`.

Verified live evidence:

- `target/debug/TerminAI` remained running with a child `python -m ccie_sidecar` process from the project virtual environment.
- The native log recorded `sidecar warmup: ping succeeded`.
- A WAL-aware read-only query showed `sidecar_status.last_seen` advance from `1787172249` to `1787172309`, with version `0.0.1` and the live child PID.
- The native footer visibly left `starting` and displayed `Sidecar: v0.0.1`.
- The terminal workspace visibly rendered the single global **+ Workflow** bar.

The feature-specific logic is covered by focused automated tests, but representative live Cisco/Junos/Arista devices, an intentional SSH disconnect, and a user-selected Postman collection were not exercised against production fixtures during this delivery. Those operator-data-dependent interactions, plus Windows/Linux manual acceptance, remain explicitly unverified rather than being treated as silently passed.

### Delivery status

Ranks 5–9 are implemented and pass the focused and repository-wide automated gates plus the native macOS startup/sidecar invariant. Fixture-dependent operator acceptance and Windows/Linux manual acceptance remain open. This record accompanies the explicitly requested `main` commit and `origin` push; no release was performed.

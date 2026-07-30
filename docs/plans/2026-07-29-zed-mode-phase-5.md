# Zed Mode Phase 5: Python Debugging with DAP

**Date:** 2026-07-29
**Status:** Implemented; automated/native health validation complete; operator feature validation pending
**Parent design:** `Plans/ZED.md`
**Depends on:** Phase 2 shared editor buffers/windows and Phase 4 process supervision/navigation

## Goal

Add breakpoint debugging for user-authored Python files opened in the TerminAI
editor while Zed Mode is enabled. Monaco remains the editor. TerminAI acts as a
Debug Adapter Protocol (DAP) client and launches `debugpy` as a supervised child
process.

The phase is complete when an operator can:

1. Set and clear source breakpoints from Monaco's glyph margin.
2. Start the current Python file with the workspace as its working directory.
3. Continue, pause, step over, step into, step out, restart, and stop.
4. See the active source line, threads, call stack, scopes, variables, watches,
   and program output.
5. Select a stack frame and have TerminAI open/reveal the matching source file.
6. See breakpoint and stopped-line state in split panes and detached editor
   windows.
7. Turn Zed Mode off without leaving a hidden debug adapter or debuggee running.

## Current Repository Findings

- Phase 4's `LspManager` already establishes the expected process-management
  conventions: canonical workspace identities, piped stdio, `kill_on_drop`,
  bounded requests, structured Tauri commands, and focused Rust integration
  tests.
- DAP uses the same `Content-Length` framing as LSP, but DAP events are
  asynchronous. A DAP reader must run continuously and correlate responses by
  `request_seq`; it cannot reuse the LSP request loop directly.
- `EditorTab` already owns the focused pane, file-save path, workspace root,
  cross-file reveal function, bottom-panel pattern, and keyboard shortcut
  boundary needed by the debugger.
- `MonacoEditor` already enables the glyph margin in Zed Mode and is mounted in
  both attached and detached editor panes.
- Phase 2's detached webviews do not share JavaScript memory. Cross-window
  breakpoints and debug events therefore need a Rust/Tauri authority rather than
  a frontend-only store.
- The development interpreter selected by `./run.sh` is
  `sidecar/.venv/bin/python`. `debugpy` is not currently installed, and
  `run.sh` only reinstalls the editable sidecar when `ccie_sidecar` itself is
  missing.

## Scope

### Included

- Python launch debugging through `debugpy`.
- One active debug session per editor tab.
- Backend-owned source breakpoint registry keyed by editor tab and canonical
  file path.
- DAP initialize/launch/configuration handshake.
- Requests for threads, stack traces, scopes, variables, evaluate, continue,
  pause, next, step in, step out, terminate/disconnect, and restart-by-relaunch.
- Events for initialized, output, process, thread, stopped, continued,
  breakpoint, exited, and terminated.
- Automatic target-interpreter selection:
  1. explicit interpreter supplied by the frontend;
  2. `<workspace>/.venv`;
  3. `<workspace>/venv`;
  4. active `VIRTUAL_ENV`;
  5. `python3`/`python` on `PATH`.
- `internalConsole` launch with redirected stdout/stderr.
- Monaco breakpoint and active-line decorations in attached, split, and detached
  views.
- Zed-only debugger toolbar, resizable debug panel, keyboard controls, variables,
  watches, call stack, and output console.
- Source navigation when a stack frame is selected.
- Focused unit/integration tests, complete frontend/Rust suites, production
  frontend build, and live Tauri/sidecar health validation.

### Not Included

- Debugging TerminAI itself.
- Attach-to-process or remote-debug sessions.
- Languages other than Python.
- An interactive stdin terminal for the debuggee.
- Conditional breakpoints, logpoints, function/data breakpoints, exception
  configuration UI, or hit counts.
- Editing variable values or a full debug REPL.
- Persisting launch configurations, watches, or breakpoints across a full app
  restart.
- Multiprocess child-session UI. `subProcess` is disabled for this phase.

## Backend Design

### Adapter and target interpreters

TerminAI launches the adapter with the same packaged/development Python used by
the sidecar:

```text
<sidecar-python> -m debugpy.adapter
```

The debuggee may use a different workspace interpreter. The selected interpreter
is sent in the debugpy launch request's `python` array. The adapter dependency is
declared in `sidecar/pyproject.toml` and included in the existing
`pip install .` packaged-Python build. The repository's current `uv.lock`
predates several existing sidecar dependency changes and is not used by either
`run.sh` or the packaging script, so Phase 5 does not rewrite it incidentally.

`run.sh` must verify both `ccie_sidecar` and `debugpy` imports before deciding
that the venv is current.

### Session identity

```rust
struct DapSessionKey {
    session_id: String, // backend-generated UUID
    tab_id: String,
}

struct DapSessionInfo {
    session_id: String,
    tab_id: String,
    workspace_root: String,
    program: String,
    interpreter: String,
    adapter_name: String,
}
```

The manager rejects a second start for a tab with a live session. Restart stops
the old session completely before launching a new adapter. Closing the editor
tab or leaving Zed Mode stops the session and clears transient breakpoint state.

### Protocol transport

Each adapter owns:

- a `Child` guarded for status/termination;
- a serialized stdin writer;
- a continuous stdout reader task;
- an atomic outgoing sequence;
- `request_seq -> oneshot sender` response correlation;
- a bounded request timeout;
- an event sink that emits serializable envelopes to all Tauri webviews;
- a termination flag that makes cleanup idempotent.

DAP messages use:

```json
{
  "seq": 1,
  "type": "request",
  "command": "threads",
  "arguments": {}
}
```

Responses are matched by `request_seq`. Events are forwarded as
`dap://event`. Unsupported adapter-to-client requests receive an explicit failed
response so the adapter never waits indefinitely.

### Launch handshake

The session startup sequence is:

1. Spawn `debugpy.adapter`.
2. Send `initialize` with native paths and one-based lines/columns.
3. Send `launch` without blocking on its response.
4. Wait for the adapter's `initialized` event.
5. Send the complete breakpoint set for every registered source.
6. Send `setExceptionBreakpoints` with no filters.
7. Send `configurationDone`.
8. Await the outstanding launch response.
9. Forward subsequent process/output/stopped/continued/exited/terminated events.

The launch request uses:

```json
{
  "name": "TerminAI: Current Python File",
  "type": "python",
  "request": "launch",
  "program": "/absolute/workspace/script.py",
  "python": ["/absolute/interpreter"],
  "cwd": "/absolute/workspace",
  "args": [],
  "env": {},
  "console": "internalConsole",
  "redirectOutput": true,
  "justMyCode": true,
  "stopOnEntry": false,
  "subProcess": false
}
```

### Validation and containment

- The workspace must canonicalize to an existing directory.
- The launch program must canonicalize to a `.py` file inside the workspace.
- Breakpoint sources must canonicalize to files inside the same workspace.
- Explicit interpreters must be existing files; automatic lookup never invokes a
  shell.
- Argument strings are passed as an array, not shell-expanded.
- Environment keys reject empty/control/`=` characters and values reject NUL.
- Tab IDs use the existing tab validation boundary.
- Session IDs are backend-generated and must match the tab that owns the
  request.

### Breakpoint authority

`DapManager` stores requested breakpoints by `(tab_id, canonical_file_path)`.
Setting a breakpoint replaces the complete list for that source, matching DAP
semantics. If the tab has an active session, the manager immediately sends
`setBreakpoints` and stores the adapter's verified/relocated response.

Every change emits `dap://breakpoints-changed` so split and detached webviews
render the same state. A newly mounted editor queries the current list before it
installs decorations.

### Tauri command surface

- `dap_check_available(workspace_root)`
- `dap_resolve_interpreter(workspace_root, explicit?)`
- `dap_start(tab_id, workspace_root, program, interpreter?, args, env,
  stop_on_entry, just_my_code)`
- `dap_restart(session_id)`
- `dap_stop(session_id)`
- `dap_clear_tab(tab_id)`
- `dap_session_for_tab(tab_id)`
- `dap_breakpoints_get(tab_id, workspace_root, file_path)`
- `dap_breakpoints_set(tab_id, workspace_root, file_path, lines)`
- `dap_threads(session_id)`
- `dap_stack_trace(session_id, thread_id)`
- `dap_scopes(session_id, frame_id)`
- `dap_variables(session_id, variables_reference)`
- `dap_evaluate(session_id, expression, frame_id?)`
- `dap_continue(session_id, thread_id)`
- `dap_pause(session_id, thread_id)`
- `dap_next(session_id, thread_id)`
- `dap_step_in(session_id, thread_id)`
- `dap_step_out(session_id, thread_id)`

No unrestricted generic DAP request command is exposed to the webview.

## Frontend Design

### Typed bridge and controller

`src/lib/tauri.ts` defines the DAP request/response/event types and typed invoke
wrappers.

`useDebugSession(tabId)`:

- listens for `dap://event` before any launch;
- filters by tab/session;
- owns `idle | starting | running | paused | stopped | error`;
- appends bounded output;
- on `stopped`, fetches threads -> selected stack -> scopes -> variables and
  refreshes watches;
- clears frame/scopes/variable references on `continued`;
- exposes launch, restart, stop, continue, pause, step, frame selection, watch,
  and refresh actions;
- ignores stale async responses from a replaced/restarted session.

### Monaco integration

`installDebugDecorations` is mounted only when all are true:

- Zed Mode;
- Python model;
- file-backed buffer;
- tab ID and workspace root are present.

It:

- loads backend breakpoints for the file;
- toggles the clicked one-based line on left-click in the glyph margin;
- listens for cross-window breakpoint changes;
- renders requested, verified, and rejected breakpoint variants;
- listens for stopped/continued/terminated events;
- fetches the top stack frame after a stop and highlights the matching current
  file line;
- disposes listeners/decorations with the Monaco model owner.

### Debug toolbar and keyboard controls

The editor toolbar adds a Zed-only debug control group for Python files:

- Start / Continue (`F5`)
- Pause
- Step Over (`F10`)
- Step Into (`F11`)
- Step Out (`Shift+F11`)
- Restart (`Cmd/Ctrl+Shift+F5`)
- Stop (`Shift+F5`)
- Toggle Breakpoint at cursor (`F9`)
- Toggle debug panel

Launch saves a dirty current file first so the debuggee runs the visible source.
Switching to classic Monaco stops an active session.

### Debug panel

A resizable bottom panel follows the existing editor terminal-panel layout and
contains:

- status plus program/interpreter summary;
- threads and call stack;
- scopes/variables with lazy expansion for child references;
- watches with add/remove and paused-state evaluation;
- bounded stdout/stderr/console output;
- empty, loading, terminated, and error states.

Selecting a stack frame asks `EditorTab` to open/reveal the frame source in the
focused attached pane. Detached windows hand navigation back to the source
window using the existing Phase 4 route.

## Implementation Sequence

1. Add `debugpy`; make `run.sh` dependency freshness check include it.
2. Add Rust DAP framing, response correlation, event forwarding, reverse-request
   failure handling, and process cleanup.
3. Add interpreter resolution, path/environment validation, session manager,
   breakpoint registry, and the debugpy launch handshake.
4. Add the restricted Tauri DAP commands, `AppState` manager, invoke
   registration, and tab-close cleanup.
5. Add typed frontend bridge functions and event contracts.
6. Add Monaco breakpoint/stopped-line decorations and cross-window sync.
7. Add the debug-session hook and paused-state request waterfall.
8. Add the debug panel, controls, watches, call-stack navigation, and CSS.
9. Integrate controls into attached and detached editor views, including
   save-before-launch and Zed-mode cleanup.
10. Run focused tests continuously, then the complete acceptance gates.
11. Launch with `./run.sh`, verify the sidecar invariant, and leave the
    interactive feature matrix to the operator.

## Test Plan

### Rust unit tests

- Framing round-trip uses byte length and accepts case-insensitive
  `Content-Length`.
- Response correlation completes the matching pending request while events are
  delivered independently.
- Failed DAP responses preserve adapter error messages.
- Unknown reverse requests receive a failed response.
- Workspace/program/breakpoint containment rejects outside paths and non-Python
  launch files.
- Interpreter lookup follows explicit -> `.venv` -> `venv` -> environment ->
  `PATH` priority.
- Environment validation rejects unsafe keys/NUL values.
- Breakpoint replacement sorts/deduplicates lines and stores verified adapter
  responses.
- Session manager rejects duplicate tab sessions and stale/foreign session IDs.
- Stop/disconnect is idempotent and reaps the adapter/debuggee.

### Rust adapter integration

A deterministic fake adapter validates:

- initialize -> launch -> initialized -> setBreakpoints ->
  setExceptionBreakpoints -> configurationDone order;
- launch is allowed to respond only after `configurationDone`;
- async output/stopped/continued/terminated events reach the sink;
- threads/stack/scopes/variables/evaluate and step-control requests preserve
  arguments.

A real-debugpy test, run when the sidecar interpreter is available, launches a
temporary two-file Python fixture, hits a source breakpoint, reads locals,
continues to exit, and confirms no adapter/debuggee is left behind.

### Frontend unit/component tests

- Every bridge wrapper uses the correct command and camelCase payload.
- Debug controller handles start, stopped-state waterfall, continued reference
  invalidation, output bounding, stale-session events, and termination.
- Breakpoint decoration builder distinguishes requested/verified/rejected.
- Glyph click replaces the complete source breakpoint list and ignores wrong
  models/non-left clicks.
- Cross-window breakpoint events refresh decorations.
- Stopped-line decoration appears only for a matching source and clears on
  continue/termination.
- Debug panel renders controls, stack/scopes/variables, lazy children, watches,
  output, empty/error states, and frame selection.
- EditorTab gates debugger UI to Zed + Python, saves before launch, routes
  keyboard commands, reveals selected frames, and stops on mode switch/unmount.
- Detached editor renders shared breakpoint/stopped-line state without exposing
  a second independent session controller.

### Repository acceptance gates

```bash
bun run test -- --dir src
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
bun run build:relaxed
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

### Live startup and sidecar invariant

Launch only with `./run.sh`, then verify:

1. `target/debug/TerminAI` is running.
2. Its child is `sidecar/.venv/bin/python -m ccie_sidecar`.
3. Sidecar warmup ping succeeds.
4. `sidecar_status.last_seen` advances.
5. The footer leaves `starting` and shows the sidecar version.
6. No debugpy adapter exists before a debug launch.

### Operator interactive matrix

1. Enable Zed Mode and open a two-file Python workspace.
2. Set, remove, and re-add breakpoints from the gutter.
3. Start the focused file and confirm stdout appears.
4. Hit a breakpoint and confirm the active line, stack, scopes, and locals.
5. Add a watch and expand a structured variable.
6. Step over, into, and out; then continue.
7. Pause a running loop and resume it.
8. Select a frame in the other source file and confirm open/reveal.
9. Confirm split panes share breakpoint/active-line state.
10. Detach a pane and confirm breakpoint/active-line synchronization.
11. Restart, then stop; confirm no Python debuggee/debugpy adapter remains.
12. Switch to classic Monaco and confirm debugger UI disappears and any active
    session stops.

## Completion Evidence

Implementation completed on 2026-07-29:

- Focused DAP/frontend coverage: 5 test files, 21 tests passed, covering typed
  invokes, the session controller, output bounding, breakpoint/current-line
  decorations, panel controls/watches/lazy variables/resizing, and detached
  editor behavior.
- Full frontend suite: 231 files and 1,716 tests passed.
- Focused Rust DAP suite: 8 tests passed. The deterministic fake adapter proved
  initialize/launch/configuration ordering, deferred launch response,
  breakpoint replacement, reverse-request rejection, async events, request
  argument routing, duplicate rejection, startup cancellation, and idempotent
  cleanup.
- The real-debugpy Rust test launched a temporary Python fixture through
  `sidecar/.venv`, hit line 2, read the `router` local, continued to
  `terminated`, observed no spurious adapter error, and removed the session.
- Full Rust library suite: 401 tests passed and 6 intentionally ignored.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `bun run build:relaxed`: passed (2,094 modules transformed). Existing Vite
  dynamic-import and chunk-size warnings remain unchanged.
- `rustfmt --edition 2021 --check` passed for the two new Rust DAP files, and
  `git diff --check` passed. The repository-wide `cargo fmt -- --check` remains
  red on the pre-existing, broad Rust formatting baseline; Phase 5 did not
  rewrite unrelated files.
- Live `./run.sh` validation:
  - `target/debug/TerminAI` ran as PID 38906.
  - Its direct `python -m ccie_sidecar` child ran as PID 39303 and loaded native
    modules from `sidecar/.venv/lib/python3.12/site-packages`.
  - The app log recorded `sidecar warmup: ping succeeded`.
  - `sidecar_status.last_seen` advanced from `1785375213` to `1785375363`;
    the second sample was 12 seconds old and reported version `0.0.1`.
  - A live window capture showed the footer in its green
    `Sidecar: v0.0.1` state, not `starting`.
  - No `debugpy.adapter` process existed before an operator debug launch.

The twelve-step operator interactive matrix above is intentionally still
pending; the operator asked to perform those feature interactions from the app
started with `./run.sh`.

### Operator follow-up fixes

After Steps 7 and 10 passed, operator feedback exposed two defects and one
missing editor workflow:

- Opened and debug-frame source files had no visible tab strip, forcing repeated
  selection through the explorer.
- Closing split panes could run LSP cleanup after Monaco disposed its model,
  throwing `Model is disposed!`.
- New editor workspaces defaulted the explorer to the home directory instead of
  allowing an explicit workspace folder selection.

The follow-up implementation adds closable open-file tabs backed by each
workspace's buffer list, an unsaved-change confirmation before dirty tabs close,
a native directory-only `Select Workspace Folder` picker, explorer state reset
when the root changes, and model-disposal-safe LSP teardown.

Follow-up validation on 2026-07-29:

- Focused regressions: 5 files and 21 tests passed.
- Full frontend suite: 233 files and 1,723 tests passed.
- Full Rust library suite: 402 tests passed and 6 intentionally ignored.
- `bun run build:relaxed`: passed with 2,096 modules transformed.
- Live `./run.sh`: native folder picker rendered, three file tabs remained
  available, the explorer showed only the selected folder's files, and four
  split-open/close cycles completed without an error overlay.
- `target/debug/TerminAI` and its direct `python -m ccie_sidecar` child remained
  running; warmup had succeeded, heartbeat data stayed fresh, and the footer
  remained green at `Sidecar: v0.0.1`.

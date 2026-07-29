# Guardrail Hook Points

This document inventories every code path that writes data to a remote
device, and the paths that deliberately do **not** invoke the classifier.

## Intercepted (network device → classify before send)

| Path | Function | Mechanism | Notes |
|------|----------|-----------|-------|
| `commands/mod.rs::netconf_send_rpc` | Tauri command, called from frontend | Frontend pre-classifies CLI-wrapped RPCs via `guardrail_classify` and presents the appropriate modal. Pure `<get>`/`<get-config>` RPCs short-circuit on the frontend and skip the classify call. | The classify step is frontend-driven — `BlastRadiusHost` mounts the modal, awaits resolution, then calls `netconf_send_rpc`. |
| `fanout/worker_live.rs::SshWorker::run` | Per-device SSH exec | Frontend pre-classifies each command in the run plan before invoking `fanout_run_start`. Tier ≥ 1 commands are gated client-side; Tier 0 sends straight through. | Plan 07 fan-out uses one classify call per (device, command) pair. |
| Server-side audit | `guardrails::hook::classify_and_gate` | Available to any Rust caller that wants to record an audit row + a Tier 0 auto-approve. The CLI-wrapper case in `netconf_send_rpc` defers to the frontend, so this helper is currently used only by tests and by Phase 5's LLM second-opinion path. | — |

## NOT intercepted (scope guard — local shell only)

| Path | Function | Reason | Test |
|------|----------|--------|------|
| `pty.rs::PtyHandle::write` | Local PTY write | Local shell tabs (`bash`/`zsh`) are user-driven shell environments. The user typing `rm -rf /tmp/foo` is not a remote-device command. | `tests/pty_guardrail_bypass_test.rs` |
| `pty_runner.rs::AppStatePtyExecutor::run_command` | Notebook / change-verify PTY exec | Same — runs local shell commands on behalf of MOPs. The MOP author is the gating mechanism. | Same Rust test asserts the file does not import `crate::guardrails`. |

**Scope-guard invariant:** No file in `src-tauri/src/pty.rs`, `src-tauri/src/pty_runner.rs`, or any local-shell wiring imports `crate::guardrails`. The Rust regression test in `tests/pty_guardrail_bypass_test.rs` enforces this by parsing the file contents at test time.

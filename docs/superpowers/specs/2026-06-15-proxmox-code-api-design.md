# Proxmox Code-API MCP — Design

**Date:** 2026-06-15
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with Claude

## Goal

Make Proxmox VE control available to **every** agent in CCIE Terminal with **zero user
setup**, exposing the LLM to **exactly one tool**, following Anthropic's
["Code execution with MCP"](https://www.anthropic.com/engineering/code-execution-with-mcp)
pattern: present the MCP server's capabilities as a *code API* the model calls inside a
single sandboxed code-execution tool, rather than as dozens of separate tool schemas.

We pull the proven Proxmox logic from
[ProxmoxMCP-Plus](https://github.com/RekklesNA/ProxmoxMCP-Plus) (MIT licensed) and rewrite
it as an in-process Python module, dropping its FastMCP/stdio server layer.

## Non-Goals

- Not shipping ProxmoxMCP-Plus as a standalone stdio MCP process wired through the Rust
  MCP bridge (that bridge is a stub today; finishing it is out of scope).
- Not adding a second LLM-visible tool. The model continues to see only
  `execute_python_code`.
- Not adding a large system-prompt block. The prompt addition is ~3 lines.
- No OpenAPI bridge, no Docker, no job-persistence SQLite (ProxmoxMCP-Plus extras we don't
  need).

## Background: how the codebase works today

- **One tool to the LLM.** Sandbox-capable agents (DeepAgents `*-code` modes) get a single
  `execute_python_code` tool. The sandbox globals are built in
  `sidecar/src/ccie_sidecar/agents/code_exec.py::_build_sandbox_globals`.
- **Helper-injection precedent.** `drawio_helper.install_drawio(globals_dict, emit=...)`
  registers `drawio` as **both** a sandbox global and an importable module. We mirror this
  exactly with `install_proxmox`.
- **Vault secrets** already flow into the sandbox as a `secrets` dict (same path Meraki
  uses for its API key).
- **Mutation gating precedent.** The IaC agent gates `terraform apply` via a separate
  gated `iac_apply` StructuredTool registered in LangGraph `interrupt_on`, and blocks the
  ungated path with `iac_subprocess_guard`.
- **Reverse-RPC channel.** `sidecar/src/ccie_sidecar/mcp_tools.py::_reverse_call` already
  performs synchronous request/response over NDJSON stdio to the Rust backend
  (`mcp_invoke` / `mcp_list_tools`). The Rust handler (`src-tauri/src/mcp/bridge.rs`) is a
  stub today.
- **ProxmoxMCP-Plus** is a clean `proxmox_mcp` package on top of `proxmoxer`, with **42
  tools** and an existing `high_risk_operations` list. Each tool's logic lives in
  `tools/{node,vm,containers,snapshots,backup,iso,storage,cluster,jobs}.py`.

## Architecture

### One tool, code API

The LLM sees only `execute_python_code`. Inside it, agents use a pre-injected `proxmox`
object:

```python
import proxmox
vms = proxmox.get_vms()                       # returns a list[dict], filtered in-sandbox
running = [v for v in vms if v["status"] == "running"]
print(len(running))
```

Bulky Proxmox responses are filtered/transformed in the sandbox before anything returns to
the model — the article's core token-saving benefit.

### New package: `sidecar/src/ccie_sidecar/proxmox_api/`

Vendored + adapted from ProxmoxMCP-Plus. We keep the **tool logic** and drop the server
layer.

```
proxmox_api/
  __init__.py          # exports install_proxmox + ProxmoxAPI facade
  client.py            # ProxmoxManager equiv: builds proxmoxer.ProxmoxAPI from vault dict
  facade.py            # The `proxmox` object: one method per capability, typed, documented
  catalog.py           # CAPABILITIES registry: name, group, signature, detailed docstring,
                       #   risk level (read|high_risk). Drives help()/search() + gating.
  ops/                 # Vendored logic, refactored to return plain dicts (not MCP Content)
    node.py  vm.py  containers.py  snapshots.py  backup.py  iso.py  storage.py  cluster.py
  helper.py            # install_proxmox(globals_dict, secrets, emit) — mirrors install_drawio
```

`install_proxmox`:
1. Reads connection details from the `secrets` dict (vault entry `proxmox`).
2. Lazily builds a `ProxmoxManager` (no connection test at construction — matches upstream;
   fails gracefully on first real call if creds are wrong).
3. Registers the `proxmox` facade as a sandbox global **and** importable module (so both
   `proxmox.get_vms()` and `import proxmox` work, exactly like drawio).
4. Wires the `emit` callback + reverse-RPC approval into the facade for gating.

Wired into `_build_sandbox_globals` unconditionally for all sandbox agents (like drawio),
guarded by `try/except ImportError` so a missing dep never breaks the sandbox.

### Progressive disclosure (one tool, tiny prompt)

The 42 capabilities are **not** dumped into the prompt. The `proxmox` object is
self-documenting via `catalog.py`:

- `proxmox.help()` → compact grouped list of capability names + one-line summaries.
- `proxmox.help("snapshot")` / `proxmox.search("rollback")` → full signature + **detailed
  disambiguating docstring** for matching capabilities only.

**Disambiguation requirement (explicit user ask):** functions that are easy to confuse get
sharply-worded docstrings stating what they do AND do not do, e.g.:
- `stop_vm` ("hard power-off, equivalent to pulling the plug") vs `shutdown_vm` ("graceful
  ACPI shutdown, OS shuts down cleanly").
- `delete_snapshot` ("removes a snapshot, VM unchanged") vs `rollback_snapshot`
  ("REVERTS the VM disk/state to a snapshot — destructive, data since the snapshot is
  lost").
- `delete_vm` vs `delete_container`, `stop_container` vs `delete_container`.

**System-prompt addition (~3 lines), added only for sandbox agents:**
> A `proxmox` module is available in your Python sandbox for managing Proxmox VE. Call
> `proxmox.help()` to list capabilities and `proxmox.help("<topic>")` for detailed
> signatures before calling. High-risk operations pause for human approval automatically.

### Capability set (from ProxmoxMCP-Plus, 42 tools)

- **Read:** `get_nodes`, `get_node_status`, `get_vms`, `get_vm_config`, `get_storage`,
  `get_cluster_status`, `get_containers`, `get_container_config`, `get_container_ip`,
  `list_snapshots`, `list_backups`, `list_isos`, `list_templates`, `list_jobs`, `get_job`,
  `poll_job`.
- **Low/med mutation (execute immediately):** `start_vm`, `shutdown_vm`, `start_container`,
  `stop_container`, `restart_container`, `create_snapshot`, `create_backup`,
  `download_iso`, `create_vm`, `create_container`, `clone_vm`, `update_container_resources`,
  `execute_vm_command`, `execute_container_command`, `cancel_job`, `retry_job`,
  `update_container_ssh_keys`, `reset_vm`, `stop_vm`.
- **High-risk (approval-gated):** `delete_vm`, `delete_container`, `delete_snapshot`,
  `rollback_snapshot`, `restore_backup`, `delete_backup`, `delete_iso`. (Matches upstream
  `CommandPolicyConfig.high_risk_operations` + the destructive reverts.)

`execute_vm_command` / `execute_container_command` run real shell on guests; treat as
high-risk too (approval-gated) given the user's "don't modify anything existing" rule —
the agent must opt into them deliberately.

## Credentials & zero-config

**Decision:** store connection details on the Settings page in the **app config DB**, the
same way the LLM API key is stored — **not** the vault.

**Why not the vault** (investigated during planning): the vault is encrypted with
lock/unlock semantics and the sidecar cannot read it directly — Rust only injects secrets
into agents that explicitly attach a tool with a `vault-entry` (the Meraki/pyATS path). That
breaks the "all agents, zero-config" goal (unattached agents get nothing; locked vault =
silent failure). The LLM API key already lives in plaintext in `sessions.db.ai_config`, read
directly by the sidecar via `get_saved_config()`. Proxmox connection details fit that exact
bar and path.

- The **code** is always bundled — nothing to install.
- **Storage:** new `proxmox_config` single-row table in `sessions.db` (migration `V0051`):
  `host, port, user, token_name, token_value, password, verify_ssl`. Mirrors `ai_config`
  (`V0009`).
- **Rust commands** `proxmox_save_config` / `proxmox_get_config` (mirror
  `ai_save_config`/`ai_get_config` in `src-tauri/src/commands/mod.rs`), bound in
  `src/lib/tauri.ts` as `proxmoxSaveConfig`/`proxmoxGetConfig`.
- A **Settings → Proxmox tab** in `src/windows/Settings.tsx` (new `ProxmoxSettingsTab`,
  modeled on `src/components/settings/PyatsSettingsTab.tsx`) edits these, with a "Test
  connection" button.
- **Sidecar** reads it directly via a new `get_proxmox_config()` helper that mirrors
  `agent.py::get_saved_config()` (same `sessions.db` path resolution). `install_proxmox`
  calls this — so the API is available to **every** sandbox agent regardless of persona,
  with no per-agent attachment.
- **Seed** the lab box so it works out-of-the-box for the developer: `192.168.2.38`, `root`,
  password `Iwiwaf77` (token fields optional; password auth confirmed working against the
  live 3-node "ShaunsCluster"). Seeding is done via the Settings panel / a one-time
  INSERT, **not** committed to the repo or baked into the binary.
- Env var fallback `PROXMOX_*` supported but secondary.

## Mutation approval (HITL) — `confirm=True` + agent guidance (v1)

**Decision (v1):** gate high-risk ops with an explicit `confirm=True` argument plus strong
agent guidance. No modal in v1. A real approval modal is a documented follow-up.

**Why not the "reuse existing modal" approaches** (investigated during planning, both
blocked):

1. **Reverse-RPC (`mcp_tools._reverse_call`) is non-functional.** It writes a request to
   the sidecar's *stdout* and reads the reply from *stdin*, but the sidecar's main server
   loop already owns stdin and the Rust supervisor (`src-tauri/src/bridge.rs`) routes
   stdout lines by request `id` with no handler that answers a reverse request.
   `McpBridge.handle_invoke` exists but is never called. Using it would require real Rust +
   protocol work — out of scope.
2. **IaC `interrupt_on` gate needs a separate tool.** It fires only for distinct
   StructuredTools (e.g. `iac_apply`) and resumes via a `react_resume` RPC. Our Proxmox
   calls run *inside* `execute_python_code`; the graph never interrupts, and `exec()` can't
   pause mid-run and resume with state. Making it work needs a 2nd LLM-visible tool —
   breaks the one-tool rule.

**v1 mechanism:**
- High-risk facade methods (`delete_vm`, `delete_container`, `delete_snapshot`,
  `rollback_snapshot`, `restore_backup`, `delete_backup`, `delete_iso`,
  `execute_vm_command`, `execute_container_command`) refuse unless called with
  `confirm=True`. Without it they return
  `{"ok": false, "needs_confirm": true, "reason": "...destructive... pass confirm=True"}`.
- The `proxmox` agent persona and the ~3-line sandbox prompt instruct the model to show the
  user the exact operation + args and obtain explicit go-ahead before passing `confirm=True`.
- A `proxmox_guard` is **not** needed for v1 (there is no ungated apply path to block — the
  confirm check lives inside each method). The guard is deferred with the modal.

This keeps the **one-tool** surface intact, ships now, and is honest about being weaker than
a modal. **Follow-up plan:** build a real approval modal once a working reverse/interrupt
channel exists.

## Dedicated `proxmox` agent persona

`bundled-agents/proxmox/AGENT.md`:
- `execution-mode: deepagents-code`
- Persona tuned for Proxmox VE day-2 ops (VMs, LXC, snapshots, backups, ISOs, cluster
  health), instructed to use `proxmox.help()` first and to confirm destructive intent with
  the user before high-risk calls.
- Listed alongside `meraki` / `pyats` bundled agents.

The `proxmox` API remains importable from **all** sandbox agents regardless of persona.

## Error handling

- `client.py` builds the API lazily; connection failures surface as a clear,
  agent-readable error string on first call ("Proxmox not configured / unreachable: …"),
  not a sandbox crash.
- Each facade method wraps `proxmoxer` exceptions into `{"ok": false, "error": "..."}`-style
  dicts (consistent with the Meraki client's `result.get("ok")` convention) so agents get
  structured failures, never raw tracebacks.
- Approval denial → method returns `{"ok": false, "denied": true, "reason": "..."}`.
- Log lines sanitized (`_log_safe`) as upstream does — no secrets/CRLF in logs.

## Testing

Live target: `192.168.2.38`, user `root`, password `Iwiwaf77`. **Do not modify anything
that already exists on that server.**

1. **Unit / mocked** (`sidecar/tests/proxmox/`): every facade method against a mocked
   `proxmoxer.ProxmoxAPI`. Cover read methods, every mutation method, the approval-gate
   (approved + denied), `help()`/`search()` output, and the guard blocking ungated
   high-risk calls.
2. **Catalog tests:** assert every registered capability has a non-empty disambiguating
   docstring and a valid risk level; assert confusable pairs (stop/shutdown,
   delete/rollback snapshot) have docstrings that explicitly contrast each other.
3. **Live read-only** (opt-in marker, real box): `get_nodes`, `get_vms`, `get_storage`,
   `get_cluster_status`, `list_snapshots`, `list_isos` — assert real data shape comes back.
   These never write.
4. **Live mutation lifecycle** (opt-in marker, real box): pick a **high, unused VMID**
   (verified free via `get_vms`, fail the test if occupied — guard against touching
   anything existing), then:
   `create_vm` → `start_vm` → `create_snapshot` → `stop_vm` → `delete_snapshot` →
   `delete_vm`. Asserts the full mutation + gating path against reality while leaving the
   server exactly as found. Cleanup runs in a `finally` even on assertion failure.
5. **install_proxmox integration:** assert `proxmox` is present as both a global and an
   importable module in a built sandbox, and absent-dep degrades gracefully.

## Dependencies

- Add `proxmoxer>=2.0` to `sidecar/pyproject.toml`. (`requests` already present.)
- No Node, no Docker, no FastMCP.

## Licensing

ProxmoxMCP-Plus is MIT. We vendor adapted source; retain attribution
(`proxmox_api/__init__.py` header noting derivation + upstream URL + MIT notice).

## Risks & mitigations

- **Confusable calls** → enforced disambiguating docstrings + catalog test (above).
- **No working approval modal in v1** → high-risk methods require explicit `confirm=True`
  + agent guidance (documented above). Real modal is a named follow-up plan, not silent.
- **Live test accidentally touching prod** → unused-VMID guard + `finally` cleanup +
  read-only default; mutation tests are opt-in via pytest marker/env flag.
- **Secrets in repo** → seed the lab box at runtime via the Settings panel / one-time
  INSERT, not committed; lab creds documented in spec only, not baked into the binary. Same
  plaintext-config-DB bar as the existing LLM API key.

## Build sequence (high-level — detailed plan follows in writing-plans)

1. Vendor + adapt `proxmox_api/ops/*` to return plain dicts; add `proxmoxer` dep.
2. `catalog.py` (capabilities + risk + disambiguating docstrings) and `facade.py`.
3. `helper.py::install_proxmox`; wire into `_build_sandbox_globals`; ~3-line prompt addition.
4. High-risk gating via `confirm=True` inside each high-risk method (v1).
5. Settings → Proxmox vault panel; seed lab box.
6. `bundled-agents/proxmox/AGENT.md`.
7. Tests: unit/mocked, catalog, live read-only, live mutation lifecycle.

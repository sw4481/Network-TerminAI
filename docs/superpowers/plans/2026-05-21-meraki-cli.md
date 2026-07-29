# Meraki CLI + ReACT Agent Integration — Implementation Plan

**Design:** [docs/superpowers/specs/2026-05-21-meraki-cli-design.md](../specs/2026-05-21-meraki-cli-design.md)  
**Date:** 2026-05-21  
**Status:** Ready for execution  
**Migration:** V0044  

---

## Overview

This plan implements a full-coverage Meraki Dashboard API CLI (`terminai-meraki`) that:

1. **Wraps ~600 Meraki Dashboard endpoints** via Cisco's official `meraki` SDK
2. **Is pip-installable** and usable in any Python project (`meraki-cli` console script)
3. **Integrates with TerminAI's agent system** via a ReACT loop with auto-resolution, disambiguation, and BlastRadius gating
4. **Provides a tool catalog** for AI agents with structured JSON schema and blast-radius annotations

The package lives at `meraki_cli/` (peer to `sidecar/`) and is consumed in-process by the sidecar for zero-overhead agent tool calls. The console script exists for portability and testing, not for the hot path.

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│ TerminAI (Tauri)                                            │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │  Agent UI    │◀──▶│  agent_bridge → sidecar          │   │
│  │ (AgentPanel) │    │  (existing JSON-RPC over stdio)  │   │
│  └──────────────┘    └────────────┬─────────────────────┘   │
│         ▲                         │                         │
│         │ ToolApprovalModal       │                         │
│         │ + BlastRadius           ▼                         │
│  ┌──────┴───────┐    ┌──────────────────────────────────┐   │
│  │  Vault       │    │  Sidecar (Python)                │   │
│  │ (Plan 14)    │───▶│  ┌────────────────────────────┐  │   │
│  └──────────────┘    │  │ ReACT agent loop (new)     │  │   │
│                      │  │  ├─ tool catalog (loaded)  │  │   │
│                      │  │  ├─ disambiguator          │  │   │
│                      │  │  └─ blast-radius gate      │  │   │
│                      │  └────────┬───────────────────┘  │   │
│                      │           │ in-process import    │   │
│                      │           ▼                      │   │
│                      │  ┌────────────────────────────┐  │   │
│                      │  │ terminai-meraki (new pkg)  │  │   │
│                      │  │  ├─ MerakiClient           │  │   │
│                      │  │  ├─ ToolCatalog generator  │  │   │
│                      │  │  └─ CLI entry point        │  │   │
│                      │  └────────────┬───────────────┘  │   │
│                      └───────────────┼──────────────────┘   │
└──────────────────────────────────────┼──────────────────────┘
                                       ▼
                              official `meraki` SDK
                                       ▼
                              dashboard.meraki.com
```

**Key invariants:**

- Sidecar imports `terminai-meraki` as a library (no subprocess).
- `ApiTab` Meraki support is untouched; the two paths share the Vault but are otherwise independent.
- No new Rust crate; Rust gets one new Tauri command (`agent_react_run`).
- V0044 migration adds `react_session_state`, `react_pending_resumes`, `meraki_tool_calls`.

---

## Phase Breakdown

### Phase 1: CLI Core (meraki-cli package skeleton)

**Goal:** Standalone `terminai-meraki` package with `MerakiClient`, credential resolver, output renderers, and console entry point.

**Scope:**

- Package structure at `meraki_cli/`
- `MerakiClient` wrapper around `meraki.DashboardAPI`
- Credential resolver (Vault first, env fallback)
- Output renderers (JSON/table/yaml)
- Console script entry point (`meraki-cli`)
- Unit tests for core components

**Out of scope:** Tool catalog, agent loop, Tauri integration.

**Tasks:**

1. **Package skeleton**
   - Create `meraki_cli/pyproject.toml` with `name = "terminai-meraki"`, entry point `meraki-cli = terminai_meraki.cli.main:app`
   - Pin `meraki>=1.50.0` as dependency
   - Add Typer/Click for CLI framework
   - Create `meraki_cli/README.md` with quickstart

2. **MerakiClient wrapper**
   - Implement `meraki_cli/src/terminai_meraki/client.py`
   - `MerakiClient` class wrapping `meraki.DashboardAPI`
   - Factory methods: `.from_vault(entry_name)`, `.from_env()`, `.from_token(token)`
   - `call(resource, action, **kwargs)` method returning typed envelope:
     ```python
     {"ok": true,  "data": <...>, "meta": {"endpoint": {...}, "blast_radius": "low"}}
     {"ok": false, "error": {"code": "...", "message": "...", "hint": "..."}}
     ```
   - Error handling: wrap SDK exceptions into envelope format

3. **Credentials resolver**
   - Implement `meraki_cli/src/terminai_meraki/credentials.py`
   - `resolve_api_key(vault_entry, env_var)` function:
     - Try explicit flag (handled by caller)
     - Try Vault (via Tauri command bridge if sidecar context available)
     - Try env var (default `MERAKI_API_KEY`)
     - Hard error with hint if all fail
   - Add `sidecar_context` detection: check for `CCIE_SIDECAR_CONTEXT` env var set by sidecar
   - Mock-friendly for standalone testing

4. **Output renderers**
   - Implement `meraki_cli/src/terminai_meraki/output.py`
   - `render_json(envelope)` — passthrough
   - `render_table(envelope)` — use `rich.table` for human-friendly output
   - `render_yaml(envelope)` — use `PyYAML`
   - Handle list responses (table with columns) vs single objects

5. **Error envelope structure**
   - Implement `meraki_cli/src/terminai_meraki/errors.py`
   - `CCIEError` base class
   - `AuthError`, `NotFoundError`, `RateLimitError`, `NetworkError`, `ValidationError` subclasses
   - `to_envelope(exc)` converter

6. **Console entry point**
   - Implement `meraki_cli/src/terminai_meraki/cli/main.py`
   - Typer app with global flags:
     - `--format json|table|yaml` (default: json)
     - `--api-key TOKEN`
     - `--vault-entry NAME`
     - `--org-id ID` (for auto-resolve context)
     - `--profile NAME` (future: multi-profile support)
     - `--dry-run`
     - `--verbose`
   - Dynamic subcommand registration from SDK inspection (Phase 2 will flesh this out)
   - For Phase 1: hardcode `organizations list` as proof-of-concept command

7. **Unit tests**
   - `meraki_cli/tests/conftest.py` — session-scoped fixtures
   - `meraki_cli/tests/test_client.py` — test envelope format, error handling, factory methods
   - `meraki_cli/tests/test_credentials.py` — mock vault/env paths
   - `meraki_cli/tests/test_output.py` — test renderers with sample data
   - `meraki_cli/tests/test_errors.py` — test error envelope conversion

8. **Sidecar path dependency**
   - Add `terminai-meraki @ file://${PROJECT_ROOT}/meraki_cli` to `sidecar/pyproject.toml`
   - Verify dev edits propagate without reinstall

**Acceptance:**

- `meraki-cli organizations list --api-key <token>` works from terminal against live Meraki tenant
- Outputs valid JSON by default
- `--format table` renders human-friendly output
- Missing API key produces clear error with hint
- All unit tests pass

**Commit message:**
```
feat(meraki): Phase 1 — CLI core package skeleton

- terminai-meraki package at meraki_cli/
- MerakiClient wrapper with envelope format
- Credential resolver (Vault first, env fallback)
- Output renderers (JSON/table/yaml)
- Console entry point with proof-of-concept `organizations list`
- Unit tests for core components

Sidecar path dependency configured for immediate dev edits.
```

---

### Phase 2: Tool Catalog & Blast-Radius Classifier

**Goal:** Generate JSON tool catalog from SDK introspection; classify all endpoints by blast radius.

**Scope:**

- SDK introspection to generate tool catalog
- Blast-radius classifier (table-driven)
- `meraki-cli tools dump` command
- Full CLI surface with dynamic subcommand registration
- Unit tests for catalog generation and classifier

**Out of scope:** Agent loop integration.

**Tasks:**

1. **SDK introspection engine**
   - Implement `meraki_cli/src/terminai_meraki/catalog.py`
   - `generate_catalog()` function:
     - Use `inspect` to enumerate all methods on `meraki.DashboardAPI`
     - Parse method signatures to extract required/optional args
     - Extract docstrings (Cisco generates from OpenAPI spec)
     - Map method names to resource groups (e.g., `getOrganizationNetworks` → `organizations.list-networks`)
     - Generate JSON schema for each tool's arguments
   - Return `ToolCatalog` object (list of `ToolSpec`)

2. **ToolSpec data model**
   - Define `ToolSpec` dataclass:
     ```python
     @dataclass
     class ToolSpec:
         name: str                    # "meraki.networks.list-clients"
         description: str
         resource: str                # "networks"
         action: str                  # "list-clients"
         endpoint: dict               # {"method": "GET", "path": "/networks/{id}/clients"}
         args: dict                   # JSON schema
         required: list[str]
         blast_radius: str            # "low"|"medium"|"high"|"destructive"
         destructive: bool
     ```

3. **Blast-radius classifier**
   - Implement `meraki_cli/src/terminai_meraki/blast_radius.py`
   - `classify(method, path) -> Tier` function
   - Table-driven rules:
     | Pattern | Tier |
     |---|---|
     | `GET *` | `low` |
     | `POST */action-batches` | computed per inner action |
     | `POST */claim`, `*/bind`, `*/release` | `high` |
     | `PUT */*/settings`, `*/*/policy`, `*/*/firewall/*` | `high` |
     | `PUT *` (other) | `medium` |
     | `POST *` (other) | `medium` |
     | `DELETE */organizations/*`, `*/networks/*` | `destructive` |
     | `DELETE *` (sub-resources) | `high` |
   - Per-endpoint override table for Cisco-specific knowledge (e.g., `POST */ping` → `low`)

4. **Action naming mapper**
   - Helper in `catalog.py`: `method_name_to_action(method_name, resource) -> str`
   - Strip resource prefix, kebab-case the verb, drop resource noun if duplicate
   - Examples:
     - `getOrganizationNetworks` → `list-networks`
     - `getNetworkClients` → `list-clients`
     - `updateNetworkSsid` → `update-ssid`

5. **Tool catalog dump command**
   - Implement `meraki_cli/src/terminai_meraki/cli/tools_cmd.py`
   - `meraki-cli tools dump [--output FILE]` command
   - Serialize `ToolCatalog` to JSON array
   - Default output: stdout (for testing)
   - Optional `--output ~/.terminai/meraki-tools.json` (for agent consumption)
   - Add `meraki-cli tools list` for human-readable summary

6. **Dynamic CLI subcommand registration**
   - Refactor `meraki_cli/src/terminai_meraki/cli/main.py`
   - At import time, call `generate_catalog()` once (cache result)
   - Register Typer subcommands dynamically from catalog
   - CLI surface: `meraki-cli <resource> <action> [args] [flags]`
   - Map CLI flags to SDK method kwargs (kebab-case → snake_case)
   - Global `--params JSON` flag for complex nested bodies

7. **Unit tests**
   - `meraki_cli/tests/test_catalog.py`:
     - Test catalog generation produces ~600 tools
     - Test action naming mapper with known examples
     - Test JSON schema generation for sample methods
   - `meraki_cli/tests/test_blast_radius.py`:
     - Table-driven tests for all classifier rules
     - Test override table
     - Test destructive flag derivation

8. **Integration test (no live API)**
   - `meraki_cli/tests/test_cli_integration.py`:
     - Use `typer.testing.CliRunner` to invoke commands
     - Mock `meraki.DashboardAPI` responses
     - Test `organizations list`, `networks list-clients`, etc.
     - Verify envelope format in output

**Acceptance:**

- `meraki-cli tools dump` produces valid JSON catalog with ~600 entries
- Each entry has correct `blast_radius` annotation
- `meraki-cli networks list-clients --network-id N_123` works (mocked SDK)
- Unit tests cover all classifier rows
- Catalog regeneration is deterministic (same SDK version → same catalog)

**Commit message:**
```
feat(meraki): Phase 2 — Tool catalog & blast-radius classifier

- SDK introspection generates ~600-tool catalog
- Blast-radius classifier (table-driven with per-endpoint overrides)
- meraki-cli tools dump command
- Dynamic CLI subcommand registration from catalog
- Unit tests for catalog generation and classifier

Phase 1+2 gives standalone CLI usable outside TerminAI.
```

---

### Phase 3: ReACT Loop in Sidecar (Basic Execution)

**Goal:** Wire `attached-tools` frontmatter to a ReACT loop in the sidecar; basic tool execution without disambiguation or approval gating.

**Scope:**

- `attached-tools` frontmatter in agent definitions
- Rust changes: parse new frontmatter, add `agent_react_run` Tauri command
- Sidecar ReACT loop: load catalog, execute tool calls, stream events
- Basic event streaming to AgentPanel

**Out of scope:** Disambiguation, approval gating, auto-resolve.

**Tasks:**

1. **Rust: AttachedTool type**
   - In `src-tauri/src/agents/types.rs`:
     - Add `AttachedTool` struct:
       ```rust
       #[derive(Debug, Clone, Deserialize)]
       pub struct AttachedTool {
           pub id: String,
           pub catalog: String,  // path to JSON catalog
           pub default_blast_radius_allowed: String,  // "low"|"medium"|"high"
           pub vault_entry: String,
       }
       ```
     - Add `attached_tools: Vec<AttachedTool>` field to `AgentDefinition`

2. **Rust: Frontmatter parser**
   - In `src-tauri/src/agents/loader.rs`:
     - Parse `attached-tools:` YAML array in agent frontmatter
     - Deserialize into `Vec<AttachedTool>`
     - Validate: catalog file must exist, blast-radius must be valid tier

3. **Rust: agent_react_run Tauri command**
   - In `src-tauri/src/commands/ai.rs`:
     - New command:
       ```rust
       #[tauri::command]
       pub async fn agent_react_run(
           agent_id: String,
           message: String,
           state: State<'_, AppState>,
       ) -> Result<(), String> {
           // Delegate to sidecar.agent.react via JSON-RPC bridge
       }
       ```
     - Stream events back via `emit` (reuse existing `agent-event` channel)

4. **Sidecar: ReACT loop skeleton**
   - Implement `sidecar/src/ccie_sidecar/agents/react.py`
   - `react_loop(agent_def, user_msg, ctx, on_event)` async function
   - Load tool catalog from `agent_def.attached_tools[0].catalog`
   - Convert catalog to LLM tool format (Claude tool-use schema)
   - Basic ReACT loop:
     ```python
     for step in range(MAX_STEPS):  # MAX_STEPS = 12
         resp = await llm.stream(messages=history, tools=tools_for_llm)
         if resp.stop_reason == "end_turn":
             on_event({"type": "final", "content": resp.text})
             return
         for tool_call in resp.tool_calls:
             result = execute_tool(tool_call)
             history.append(observation(tool_call.id, result))
             on_event({"type": "tool_result", "name": tool_call.name, "result": result})
     ```
   - No auto-resolve, no disambiguation, no approval gating yet

5. **Sidecar: Tool execution**
   - In `react.py`: `execute_tool(tool_call) -> envelope`
   - Parse `tool_call.name` to extract resource + action
   - Import `terminai_meraki.MerakiClient`
   - Call `client.call(resource, action, **tool_call.input)`
   - Return envelope (success or error)

6. **Sidecar: Event streaming**
   - Define event types:
     ```python
     {"type": "thought_start", "step": int}
     {"type": "tool_call", "name": str, "args": dict, "blast_radius": str}
     {"type": "tool_result", "name": str, "ok": bool, "data": any, "meta": dict}
     {"type": "final", "content": str}
     {"type": "error", "message": str, "hint": str}
     ```
   - Stream via `on_event` callback (bridge to Rust)

7. **Frontend: Basic ReACT event rendering**
   - In `src/components/AgentPanel.tsx`:
     - Listen for new event types on `agent-event` channel
     - Render `thought_start` as "Thinking…" pill
     - Render `tool_call` as collapsible card with args
     - Render `tool_result` inside the tool-call card
     - Render `final` as normal assistant message

8. **Test agent definition**
   - Create `~/.ccie-terminal/agents/meraki-readonly-expert/agent.md`:
     ```yaml
     ---
     name: meraki-readonly-expert
     description: Cisco Meraki dashboard read-only expert
     system-prompt: |
       You are a Meraki dashboard expert with read-only access.
       Use the meraki tool to answer questions about orgs, networks, devices, and clients.
     attached-tools:
       - id: meraki
         catalog: ~/.terminai/meraki-tools.json
         default-blast-radius-allowed: low
         vault-entry: meraki_default
     allowed-commands: []
     ---
     ```

9. **Integration test**
   - In `sidecar/tests/test_react_loop.py`:
     - Mock LLM responses (tool_use + end_turn)
     - Mock `MerakiClient.call()` to return sample data
     - Assert event stream structure
     - Assert loop terminates on `end_turn`
     - Assert MAX_STEPS cap

**Acceptance:**

- Agent definition with `attached-tools` parses successfully
- Agent can be invoked from AgentPanel
- User message "list my organizations" triggers tool call to `meraki.organizations.list`
- Tool result appears in AgentPanel
- LLM synthesizes final response
- All events stream correctly

**Commit message:**
```
feat(meraki): Phase 3 — ReACT loop in sidecar (basic execution)

- attached-tools frontmatter in agent definitions
- Rust: AttachedTool type, frontmatter parser, agent_react_run command
- Sidecar: ReACT loop skeleton with tool execution
- Event streaming to AgentPanel
- Test agent: meraki-readonly-expert

No disambiguation or approval gating yet (Phases 4-5).
```

---

### Phase 4: Disambiguation + Auto-Resolve

**Goal:** Auto-resolve missing params from context; pause for user input when ambiguous.

**Scope:**

- `react_session_state` table (V0044 partial migration)
- Auto-resolve registry for common params (`org_id`, `network_id`, `serial`)
- Disambiguation logic: call helper tools, emit `user_question` event
- `react_pending_resumes` table for paused loops
- Frontend: inline picker UI for disambiguation
- `react_resume` Tauri command

**Out of scope:** Blast-radius gating (Phase 5).

**Tasks:**

1. **V0044 migration (part 1: state tables)**
   - Create `src-tauri/migrations/V0044__meraki_react_tables.sql`:
     ```sql
     CREATE TABLE react_session_state (
         session_id      TEXT PRIMARY KEY,
         last_org_id     TEXT,
         last_network_id TEXT,
         last_serial     TEXT,
         updated_at      INTEGER NOT NULL
     );

     CREATE TABLE react_pending_resumes (
         pending_id      TEXT PRIMARY KEY,
         conversation_id TEXT NOT NULL,
         agent_id        TEXT NOT NULL,
         question        TEXT NOT NULL,  -- JSON: {param, prompt, options}
         loop_state      BLOB NOT NULL,  -- pickled history + ctx
         created_at      INTEGER NOT NULL,
         expires_at      INTEGER NOT NULL  -- 30 min default
     );
     ```
   - Run migration in dev build

2. **Sidecar: Context builder**
   - In `react.py`: `build_context(agent_def, conversation_id) -> ReACTContext`
   - Load from `react_session_state` by `session_id = f"{agent_id}:{conversation_id}"`
   - Populate `ReACTContext` dataclass:
     ```python
     @dataclass
     class ReACTContext:
         org_id: str | None
         network_id: str | None
         serial: str | None
         last_tool_results: list[dict]  # from conversation history
         active_block_context: dict  # from last command output
         user_answers: dict  # populated during disambiguation
     ```

3. **Sidecar: Auto-resolve registry**
   - In `react.py`: `autoresolve_args(tool_call_input, tool_spec, ctx) -> dict`
   - Registry of (param_name → resolver_fn):
     ```python
     RESOLVERS = {
         "organization_id": resolve_org_id,
         "network_id": resolve_network_id,
         "serial": resolve_serial,
     }
     ```
   - Each resolver tries in order:
     1. User-provided value (already in `tool_call_input`)
     2. Last-used value from `ctx` (e.g., `ctx.network_id`)
     3. Conversation history (search `last_tool_results` for matching key)
     4. Active block context (parse last command output)
     5. Return None (fall through to disambiguation)

4. **Sidecar: Disambiguation logic**
   - In `react.py`: `disambiguate(tool_spec, missing_params, ctx, on_event) -> Resolved | Pending`
   - For `network_id`:
     - First resolve `org_id` (recurse if needed)
     - Call `meraki.organizations.list-networks(organization_id=org_id)` under the hood
     - If len(networks) == 1: return `Resolved(network_id=networks[0]["id"])`
     - If len(networks) > 1: emit `user_question` event and return `Pending()`
   - For `org_id`:
     - Call `meraki.organizations.list()`
     - If len(orgs) == 1: return `Resolved(org_id=orgs[0]["id"])`
     - If len(orgs) > 1: emit `user_question` event
   - For `serial`:
     - Resolve `network_id` first
     - Call `meraki.networks.list-devices(network_id=network_id)`
     - Same picker logic

5. **Sidecar: user_question event**
   - Event schema:
     ```json
     {
       "type": "user_question",
       "pending_id": "uuid",
       "param": "network_id",
       "prompt": "Which network in organization O_123?",
       "options": [
         {"id": "N_456", "label": "HQ-Office"},
         {"id": "N_789", "label": "Remote-Branch"}
       ]
     }
     ```
   - Serialize loop state (history + ctx) to `react_pending_resumes` table
   - Set `expires_at = now + 30 minutes`

6. **Rust: react_resume Tauri command**
   - In `src-tauri/src/commands/ai.rs`:
     ```rust
     #[tauri::command]
     pub async fn react_resume(
         pending_id: String,
         answer: serde_json::Value,  // {"network_id": "N_456"}
         state: State<'_, AppState>,
     ) -> Result<(), String> {
         // Delegate to sidecar.agent.react_resume
     }
     ```

7. **Sidecar: react_resume handler**
   - In `react.py`: `react_resume(pending_id, answer) -> ()`
   - Load `loop_state` from `react_pending_resumes` by `pending_id`
   - Deserialize pickled history + ctx
   - Merge `answer` into `ctx.user_answers`
   - Retry `disambiguate()` → should now resolve
   - Resume ReACT loop from where it paused
   - Delete `react_pending_resumes` row on successful resume

8. **Frontend: Inline picker UI**
   - Create `src/components/ReACTQuestionPicker.tsx`:
     - Render when `user_question` event received
     - Display `prompt` and `options` as clickable list
     - On click: call `react_resume(pending_id, {[param]: selected_id})`
   - Integrate into `AgentPanel.tsx` event handler

9. **Sidecar: Update session state**
   - At end of successful tool call, if param was `org_id`, `network_id`, or `serial`:
     - Upsert `react_session_state` with new value
     - Update `updated_at` timestamp

10. **Integration test**
    - In `sidecar/tests/test_react_disambiguation.py`:
      - Mock LLM tool call missing `network_id`
      - Mock `meraki.organizations.list-networks` returning 3 networks
      - Assert `user_question` event emitted
      - Simulate `react_resume` with answer
      - Assert loop continues and tool executes successfully

**Acceptance:**

- User asks "list clients on the office network" (no explicit network_id)
- Agent auto-resolves `org_id` from last-used
- Agent calls `list-networks` under the hood, finds 3 networks
- Inline picker appears in AgentPanel with 3 options
- User clicks "HQ-Office"
- Agent resumes, calls `list-clients` with resolved `network_id`
- Session state updated with last-used `network_id`

**Commit message:**
```
feat(meraki): Phase 4 — Disambiguation + auto-resolve

- V0044 migration part 1: react_session_state, react_pending_resumes
- Context builder: last-used params, conversation history, active block
- Auto-resolve registry for org_id, network_id, serial
- Disambiguation: emit user_question event, pause loop
- Frontend: inline picker UI (ReACTQuestionPicker)
- react_resume command to continue paused loops
- Session state updates after successful calls

"List clients on office network" now works without explicit IDs.
```

---

### Phase 5: Blast-Radius Gating + Audit Log

**Goal:** Gate write operations by blast radius; wire to existing `ToolApprovalModal`; log all tool calls.

**Scope:**

- Blast-radius check before tool execution
- `tool_approval_request` event wired to `ToolApprovalModal`
- `meraki_tool_calls` audit table (V0044 completion)
- Approval status tracked per call
- Integration tests for approval flows

**Out of scope:** Multi-tenant per-agent (v2).

**Tasks:**

1. **V0044 migration (part 2: audit log)**
   - Extend `src-tauri/migrations/V0044__meraki_react_tables.sql`:
     ```sql
     CREATE TABLE meraki_tool_calls (
         id               INTEGER PRIMARY KEY AUTOINCREMENT,
         conversation_id  TEXT,
         agent_id         TEXT,
         tool_name        TEXT NOT NULL,
         method           TEXT NOT NULL,
         path             TEXT NOT NULL,  -- templated, e.g. /networks/{id}/clients
         args_json        TEXT NOT NULL,
         blast_radius     TEXT NOT NULL,
         approval_status  TEXT,  -- null|approved|denied|auto
         response_status  INTEGER,
         response_summary TEXT,  -- first 1KB, redacted
         error_code       TEXT,
         duration_ms      INTEGER NOT NULL,
         created_at       INTEGER NOT NULL
     );

     CREATE INDEX idx_meraki_tool_calls_conv  ON meraki_tool_calls(conversation_id);
     CREATE INDEX idx_meraki_tool_calls_agent ON meraki_tool_calls(agent_id, created_at);
     ```
   - Run migration

2. **Sidecar: Blast-radius gate**
   - In `react.py`, before `execute_tool()`:
     ```python
     tier = tool_spec.blast_radius
     allowed = is_tier_allowed(tier, agent_def.default_blast_radius_allowed)
     if not allowed:
         approval = await request_approval(tool_spec, args, tier, on_event)
         if not approval.granted:
             log_tool_call(..., approval_status="denied")
             history.append(observation(tool_call.id, error="user denied"))
             continue
         approval_status = approval.mode  # "approved" | "approved_session"
     else:
         approval_status = "auto"
     ```
   - Tier ordering: `low < medium < high < destructive`

3. **Sidecar: request_approval**
   - In `react.py`: `request_approval(tool_spec, args, tier, on_event) -> Approval | Pending`
   - Emit `tool_approval_request` event:
     ```json
     {
       "type": "tool_approval_request",
       "pending_id": "uuid",
       "tool_name": "meraki.networks.update-ssid",
       "description": "Update SSID on network N_456 (\"Office-Wifi\")",
       "endpoint": {"method": "PUT", "path": "/networks/N_456/wireless/ssids/0"},
       "args": {...},
       "blast_radius": "high"
     }
     ```
   - Serialize loop state to `react_pending_resumes` (reuse Phase 4 table)
   - Wait for `react_resume` with approval answer

4. **Frontend: Wire to ToolApprovalModal**
   - In `AgentPanel.tsx`:
     - On `tool_approval_request` event, open existing `ToolApprovalModal`
     - Pass `tool_name`, `description`, `endpoint`, `args`, `blast_radius` as props
     - Modal already has "Approve once" / "Approve all this session" / "Deny" buttons (from MCP tool approval)
     - On user choice: call `react_resume(pending_id, {granted: bool, mode: str})`

5. **Sidecar: Log all tool calls**
   - In `react.py`, after `execute_tool()`:
     ```python
     log_tool_call(
         conversation_id=conversation_id,
         agent_id=agent_def.id,
         tool_name=tool_spec.name,
         method=tool_spec.endpoint["method"],
         path=tool_spec.endpoint["path"],
         args_json=json.dumps(args),
         blast_radius=tool_spec.blast_radius,
         approval_status=approval_status,
         response_status=result.get("status"),
         response_summary=truncate(result.get("data"), 1024),
         error_code=result.get("error", {}).get("code"),
         duration_ms=duration,
         created_at=now(),
     )
     ```
   - `response_summary`: first 1KB of JSON response, redact sensitive fields (api_key, secrets)

6. **Rust: Query audit log**
   - New Tauri command in `src-tauri/src/commands/ai.rs`:
     ```rust
     #[tauri::command]
     pub async fn get_meraki_tool_calls(
         conversation_id: Option<String>,
         agent_id: Option<String>,
         limit: Option<u32>,
         state: State<'_, AppState>,
     ) -> Result<Vec<MerakiToolCall>, String> {
         // Query meraki_tool_calls table
     }
     ```

7. **Frontend: Audit log viewer (optional)**
   - Create `src/components/MerakiAuditDrawer.tsx` (similar to `AgentSourcesDrawer`)
   - List all tool calls with expandable details
   - Filter by agent, conversation, blast-radius
   - Badge for approval status (auto / approved / denied)
   - Keyboard shortcut: `⌘⇧M` (Meraki audit)

8. **Integration tests**
   - In `sidecar/tests/test_react_approval.py`:
     - Mock LLM tool call for `networks.update-ssid` (blast_radius = "high")
     - Agent `default_blast_radius_allowed = "low"`
     - Assert `tool_approval_request` event emitted
     - Simulate `react_resume` with `granted=True`
     - Assert tool executes
     - Assert audit log entry has `approval_status="approved"`
   - Test denial path:
     - Simulate `granted=False`
     - Assert tool does NOT execute
     - Assert audit log entry has `approval_status="denied"`

**Acceptance:**

- Agent attempts to update an SSID (high blast-radius)
- `default_blast_radius_allowed = "low"` → triggers approval modal
- User clicks "Approve once"
- Tool executes successfully
- Audit log shows entry with `approval_status="approved"`
- User clicks "Deny" on next high-tier call
- Tool does NOT execute
- Audit log shows entry with `approval_status="denied"`

**Commit message:**
```
feat(meraki): Phase 5 — Blast-radius gating + audit log

- V0044 migration part 2: meraki_tool_calls audit table
- Blast-radius gate before tool execution
- tool_approval_request event wired to existing ToolApprovalModal
- All tool calls logged with approval status
- MerakiAuditDrawer for audit log viewing (⌘⇧M)
- Integration tests for approval/denial flows

Phases 1-5 deliver full ReACT agent with safety gates.
```

---

### Phase 6: Live-Tenant Test Suite + Documentation

**Goal:** Real-tenant integration tests; comprehensive docs; agent template.

**Scope:**

- Pytest markers (`live_read`, `live_write`)
- Sandbox guard for write tests
- Test fixtures for real API
- `MERAKI_CLI.md` full reference
- Agent template in `USER_GUIDE.md`
- Cleanup and polish

**Out of scope:** Action batches, webhooks, multi-tenant UI (v2).

**Tasks:**

1. **Test fixtures for live API**
   - Extend `meraki_cli/tests/conftest.py`:
     ```python
     @pytest.fixture(scope="session")
     def meraki_client():
         api_key = os.getenv("MERAKI_API_KEY")
         if not api_key:
             pytest.skip("MERAKI_API_KEY not set")
         return MerakiClient.from_token(api_key)

     @pytest.fixture(scope="session")
     def sandbox_org_id():
         org_id = os.getenv("TERMINAI_TEST_ORG_ID")
         if not org_id:
             pytest.fail("TERMINAI_TEST_ORG_ID required for live tests")
         return org_id

     @pytest.fixture(scope="session")
     def sandbox_network_id():
         net_id = os.getenv("TERMINAI_TEST_NETWORK_ID")
         if not net_id:
             pytest.fail("TERMINAI_TEST_NETWORK_ID required for live tests")
         return net_id

     @pytest.fixture(autouse=True, scope="session")
     def sandbox_guard(meraki_client, sandbox_network_id):
         """Verify sandbox network name before ANY live_write test."""
         networks = meraki_client.call("organizations", "list-networks", organization_id=...)
         net = next(n for n in networks["data"] if n["id"] == sandbox_network_id)
         assert net["name"].startswith("TerminAI-CLI-Test"), \
             f"Sandbox network name must start with 'TerminAI-CLI-Test', got '{net['name']}'"
     ```

2. **Live read tests**
   - In `meraki_cli/tests/test_reads_live.py`:
     ```python
     @pytest.mark.live_read
     def test_list_organizations(meraki_client):
         result = meraki_client.call("organizations", "list")
         assert result["ok"]
         assert len(result["data"]) > 0

     @pytest.mark.live_read
     def test_list_networks(meraki_client, sandbox_org_id):
         result = meraki_client.call("organizations", "list-networks", organization_id=sandbox_org_id)
         assert result["ok"]
         assert isinstance(result["data"], list)

     @pytest.mark.live_read
     def test_get_network_clients(meraki_client, sandbox_network_id):
         result = meraki_client.call("networks", "list-clients", network_id=sandbox_network_id, timespan=86400)
         assert result["ok"]
         assert isinstance(result["data"], list)
     ```

3. **Live write tests**
   - In `meraki_cli/tests/test_writes_sandbox.py`:
     ```python
     @pytest.mark.live_write
     def test_update_network_name(meraki_client, sandbox_network_id):
         # Read current name
         original = meraki_client.call("networks", "get", network_id=sandbox_network_id)
         original_name = original["data"]["name"]
         
         try:
             # Update to temp name
             result = meraki_client.call("networks", "update", 
                                        network_id=sandbox_network_id, 
                                        name=f"{original_name}-Test")
             assert result["ok"]
             
             # Verify update
             updated = meraki_client.call("networks", "get", network_id=sandbox_network_id)
             assert updated["data"]["name"] == f"{original_name}-Test"
         finally:
             # Restore original
             meraki_client.call("networks", "update", 
                               network_id=sandbox_network_id, 
                               name=original_name)

     @pytest.mark.live_write
     def test_create_delete_admin(meraki_client, sandbox_org_id):
         # Test admin lifecycle (create → verify → delete)
         pass  # Similar pattern with try/finally cleanup
     ```

4. **Pytest configuration**
   - In `meraki_cli/pytest.ini`:
     ```ini
     [pytest]
     markers =
         live_read: requires MERAKI_API_KEY, reads from real tenant
         live_write: requires MERAKI_API_KEY + TERMINAI_TEST_{ORG,NETWORK}_ID, writes to sandbox
     ```
   - Add GitHub Actions workflow `.github/workflows/meraki-tests.yml`:
     - Default: `pytest -m "not live_read and not live_write"` (no secrets)
     - Nightly: `pytest -m live_read` (with secrets)
     - Manual trigger: `pytest -m live_write` (with secrets)

5. **ReACT loop E2E test**
   - In `sidecar/tests/test_react_e2e.py`:
     - Mock LLM responses at the API level (not the bridge)
     - Use real `MerakiClient` against sandbox
     - Test full flow: user question → disambiguation → approval → execution
     - Assert audit log entry
     - Assert session state update

6. **MERAKI_CLI.md documentation**
   - Create `docs/MERAKI_CLI.md`:
     - Quickstart: install, set API key, list orgs
     - CLI reference: auto-generated table of all commands
     - Examples:
       - List organizations
       - List clients on a network
       - Update SSID settings
       - Claim a device
     - ReACT agent walkthrough:
       - Create agent definition
       - Set vault entry
       - Example conversation with disambiguation
       - Approval flow example
     - Troubleshooting: common errors and hints

7. **Agent template**
   - In `docs/USER_GUIDE.md`, add section "Building a Meraki Agent":
     ```markdown
     ## Building a Meraki Agent

     TerminAI ships with `terminai-meraki`, a full-coverage CLI for the Meraki Dashboard API. You can create custom agents that use it:

     1. Set your Meraki API key in the Vault (Settings → Vault → Add Entry):
        - Name: `meraki_default`
        - Type: `api_key`
        - Value: your Dashboard API key

     2. Create an agent definition at `~/.ccie-terminal/agents/my-meraki-expert/agent.md`:

     ```yaml
     ---
     name: my-meraki-expert
     description: Custom Meraki expert
     system-prompt: |
       You are a Meraki expert. Use the meraki tool to answer questions.
       Always confirm before making changes.
     attached-tools:
       - id: meraki
         catalog: ~/.terminai/meraki-tools.json
         default-blast-radius-allowed: low  # auto-call reads, gate writes
         vault-entry: meraki_default
     allowed-commands: []
     ---
     ```

     3. Restart TerminAI. Your agent will appear in the Agents menu.

     **Blast-radius tiers:**
     - `low`: reads only (auto-approved)
     - `medium`: minor writes (requires approval)
     - `high`: impactful writes (requires approval)
     - `destructive`: deletes orgs/networks (requires approval)
     ```

8. **meraki_cli/README.md polish**
   - Expand with:
     - Installation instructions
     - CLI quickstart
     - Python API quickstart
     - TerminAI integration overview
     - Link to full docs

9. **Catalog regeneration on startup**
   - In `sidecar/src/ccie_sidecar/__init__.py`:
     - On startup, check if `~/.terminai/meraki-tools.json` exists
     - If absent or stale (version mismatch), run:
       ```python
       from terminai_meraki.catalog import generate_catalog
       catalog = generate_catalog()
       with open(Path.home() / ".terminai" / "meraki-tools.json", "w") as f:
           json.dump([t.to_dict() for t in catalog.tools], f, indent=2)
       ```
     - Stamp with package version in comment

10. **Error message polish**
    - Review all error hints in `meraki_cli/src/terminai_meraki/errors.py`
    - Ensure every error has actionable hint
    - Examples:
      - `AuthError`: "Rotate your API key in the Vault or set MERAKI_API_KEY env var"
      - `NotFoundError`: "Network N_123 not found. List networks with: meraki-cli networks list"
      - `RateLimitError`: "API rate limit hit. The SDK will retry with backoff."

**Acceptance:**

- `pytest -m live_read` passes against real tenant (nightly CI)
- `pytest -m live_write` passes against sandbox network (manual trigger)
- Sandbox guard prevents accidental writes to real networks
- `MERAKI_CLI.md` is comprehensive and has working examples
- Agent template in `USER_GUIDE.md` is copy-paste ready
- Catalog regenerates on app startup if stale

**Commit message:**
```
feat(meraki): Phase 6 — Live-tenant test suite + documentation

- Pytest markers: live_read, live_write
- Sandbox guard for write tests (verifies network name)
- Test fixtures for real Meraki API
- Full MERAKI_CLI.md reference with examples
- Agent template in USER_GUIDE.md
- Catalog auto-regeneration on startup
- Error message polish with actionable hints

All 6 phases complete. terminai-meraki is production-ready.
```

---

## Migration Details

**V0044** (split across Phases 4-5):

```sql
-- Phase 4: Session state and pending resumes
CREATE TABLE react_session_state (
    session_id      TEXT PRIMARY KEY,
    last_org_id     TEXT,
    last_network_id TEXT,
    last_serial     TEXT,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE react_pending_resumes (
    pending_id      TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    question        TEXT NOT NULL,  -- JSON: {param, prompt, options}
    loop_state      BLOB NOT NULL,  -- pickled history + ctx
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL  -- 30 min default
);

-- Phase 5: Audit log
CREATE TABLE meraki_tool_calls (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT,
    agent_id         TEXT,
    tool_name        TEXT NOT NULL,
    method           TEXT NOT NULL,
    path             TEXT NOT NULL,  -- templated, e.g. /networks/{id}/clients
    args_json        TEXT NOT NULL,
    blast_radius     TEXT NOT NULL,
    approval_status  TEXT,  -- null|approved|denied|auto
    response_status  INTEGER,
    response_summary TEXT,  -- first 1KB, redacted
    error_code       TEXT,
    duration_ms      INTEGER NOT NULL,
    created_at       INTEGER NOT NULL
);

CREATE INDEX idx_meraki_tool_calls_conv  ON meraki_tool_calls(conversation_id);
CREATE INDEX idx_meraki_tool_calls_agent ON meraki_tool_calls(agent_id, created_at);
```

**Rollback:** All tables can be dropped independently. No foreign keys to existing tables.

---

## Testing Strategy

| Phase | Tests |
|---|---|
| 1 | Unit: client, credentials, output, errors. No live API. |
| 2 | Unit: catalog generation, blast-radius classifier, CLI integration (mocked). |
| 3 | Integration: ReACT loop with mocked LLM + mocked MerakiClient. |
| 4 | Integration: disambiguation flow with mocked LLM + real MerakiClient (sandbox). |
| 5 | Integration: approval flows with mocked LLM + real MerakiClient (sandbox). |
| 6 | Live: `live_read` (nightly CI), `live_write` (manual trigger), E2E Playwright. |

**CI:**
- Default: `pytest -m "not live_read and not live_write"` (fast, no secrets)
- Nightly: add `pytest -m live_read` (reads from real tenant)
- Manual: `pytest -m live_write` (writes to sandbox)

**Vitest:**
- Phase 3: `AgentPanel` event rendering (new event types)
- Phase 4: `ReACTQuestionPicker` component
- Phase 5: `MerakiAuditDrawer` component
- Phase 6: E2E Playwright spec (stubbed sidecar responses)

---

## Dependencies

**New packages:**
- `meraki>=1.50.0` (official Cisco SDK)
- `typer` or `click` (CLI framework)
- `rich` (table output)
- `PyYAML` (YAML output)

**Existing infrastructure:**
- Vault (Plan 14) for API keys
- `ToolApprovalModal` (existing MCP tool approval)
- `AgentPanel` (existing agent UI)
- Agent loader (existing frontmatter parser)

**No breaking changes:** All new code; existing agents and ApiTab untouched.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Catalog generation is slow at startup | Cache catalog JSON, regenerate only on version mismatch |
| LLM hallucinates tool names | Catalog lookup returns clear error with list of valid tools |
| User abandons disambiguation picker | `react_pending_resumes` expires after 30 min; UI offers "resume?" |
| Sidecar crashes mid-loop | Supervisor restarts; pending row survives for resume |
| Write test hits real network | Sandbox guard checks network name; CI env vars carefully managed |
| Blast-radius classifier misses an endpoint | Per-endpoint override table; audit log catches anomalies |

---

## Out of Scope (v2)

- **Action batches** — Cisco's bulk API has different semantics; v2.
- **Webhook handling** — Inbound alerts/scanning are a separate feature; v2.
- **Multi-tenant per agent** — Schema supports it; UI for binding agents to specific vault entries ships in v2.
- **Catalyst Center / ISE / SNA** — Same architecture scales; each is its own spec.
- **Streaming long lists** — Pagination handled by SDK; UI streaming for paginated results in v2.

---

## Success Criteria

**Technical:**
- ✅ `meraki-cli organizations list` works from terminal
- ✅ `meraki-cli tools dump` produces ~600-tool catalog
- ✅ Agent with `attached-tools` executes tool calls
- ✅ Disambiguation pauses loop, resumes after user input
- ✅ High-tier calls trigger approval modal
- ✅ All tool calls logged in audit table
- ✅ Live read tests pass in nightly CI
- ✅ Live write tests pass in manual trigger

**User-facing:**
- ✅ "List my orgs" works in AgentPanel
- ✅ "List clients on office network" triggers picker, resumes
- ✅ "Update SSID" triggers approval modal
- ✅ Audit log shows all tool calls with approval status
- ✅ Agent template in docs is copy-paste ready

---

## Execution Notes

- **Commit granularity:** One commit per phase, merge to main after acceptance.
- **Feature flag:** None needed; agents opt-in via `attached-tools` frontmatter.
- **Backwards compatibility:** Existing agents without `attached-tools` work unchanged.
- **Documentation priority:** Phase 6 docs ship with the code, not after.

---

## Next Steps

1. Create feature branch `feature/meraki-cli`
2. Execute Phase 1 (CLI core)
3. Test standalone: `meraki-cli organizations list --api-key <token>`
4. Merge Phase 1 to main
5. Repeat for Phases 2-6

**Ready for execution.** Design approved 2026-05-21.

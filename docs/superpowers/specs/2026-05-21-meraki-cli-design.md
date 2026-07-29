# Meraki CLI + ReACT Agent Integration — Design

**Date:** 2026-05-21
**Author:** brainstormed via superpowers:brainstorming
**Status:** Approved, awaiting implementation plan

---

## 1. Problem

TerminAI has rich AI-agent infrastructure (loader, MCP bridge, Skills, Vault, BlastRadius, ToolApprovalModal) and a generic OpenAPI-driven `ApiTab` that already supports Meraki, Catalyst Center, ISE, and SNA. What it lacks is a deep, agent-native interface to the Meraki Dashboard API.

The goal is a full-coverage **CRUD** Meraki tool that:

1. Wraps every Meraki Dashboard endpoint (~600).
2. Is usable from TerminAI's AI agents through a structured, in-process tool catalog (no MCP, no shell parsing).
3. Is **also** usable as a standalone tool in unrelated Python projects — `pip install terminai-meraki` outside TerminAI must be a first-class workflow.
4. Drives a ReACT loop with auto-resolution of contextual params, disambiguation when needed (the canonical "list connected clients → which network?" example), and BlastRadius-tiered approval for writes.

This spec is **Meraki-specific.** The architecture generalizes to other vendor CLIs (Catalyst Center, ISE), but those are out of scope here.

## 2. Architecture

The product is two artifacts in one repo folder:

1. **`terminai-meraki`** — pip-installable Python package living at `meraki_cli/` (new top-level dir, peer of `sidecar/`). Wraps Cisco's official `meraki` PyPI SDK. Exposes:
   - **Importable Python API** — `from terminai_meraki import MerakiClient, ToolCatalog`. The sidecar imports it directly, no subprocess.
   - **Console script** — `meraki-cli` entry point usable in any project.
   - **Tool catalog dump** — `meraki-cli tools dump` emits a JSON catalog (name, description, JSON-schema args, blast-radius tag) for agent consumption.

2. **Agent runtime glue** — minimal additions in the sidecar (Python) and `src-tauri/src/agents/` (Rust) so a TerminAI agent with `attached-tools: [meraki]` in its frontmatter gets a ReACT loop wired to the catalog, with disambiguation + BlastRadius gating.

### Boundary diagram

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

### Key choices

- **Sidecar imports `terminai-meraki` as a library** — no subprocess overhead per tool call. The console script exists for portability, not for the hot agent path.
- **`ApiTab` Meraki support is untouched.** The two paths share the API key via the Vault but are otherwise independent.
- **No new Rust crate.** Rust just gets one new Tauri command (`agent_react_run`) that streams ReACT events to the AgentPanel.

## 3. The CLI Package (`terminai-meraki`)

### Layout

```
meraki_cli/
├── pyproject.toml              # name = "terminai-meraki", entry: meraki-cli
├── README.md
├── src/terminai_meraki/
│   ├── __init__.py             # exports MerakiClient, ToolCatalog
│   ├── client.py               # MerakiClient — thin wrapper around meraki.DashboardAPI
│   ├── catalog.py              # introspects SDK → ToolCatalog
│   ├── blast_radius.py         # method+path → low|medium|high|destructive
│   ├── credentials.py          # Vault first, env fallback resolver
│   ├── output.py               # JSON|table|yaml renderers
│   ├── errors.py               # structured error envelope
│   └── cli/
│       ├── __init__.py
│       ├── main.py             # Typer/Click root — dynamic subcommand registration
│       ├── tools_cmd.py        # `meraki-cli tools dump|list`
│       └── version_cmd.py
└── tests/
    ├── conftest.py
    ├── test_reads_live.py
    ├── test_writes_sandbox.py
    ├── test_catalog.py
    └── test_blast_radius.py
```

### CLI surface

The CLI mirrors the SDK's resource → action grouping. The official SDK exposes ~30 resource modules (`organizations`, `networks`, `devices`, `wireless`, `switch`, `appliance`, `camera`, `cellularGateway`, `sensor`, `sm`, `licensing`, `insight`, `administered`, etc.), each with methods like `getOrganizationNetworks(organizationId)`. We reflect them into:

```
meraki-cli <resource> <action> [args] [flags]

Examples:
  meraki-cli organizations list
  meraki-cli networks get --network-id N_123
  meraki-cli networks list-clients --network-id N_123 --timespan 86400
  meraki-cli devices claim --network-id N_123 --serials Q2XX-XXXX-XXXX
  meraki-cli tools dump --output ~/.terminai/meraki-tools.json
```

**Action naming rule.** SDK method `getOrganizationNetworks` → `organizations list-networks`: strip the resource prefix, kebab-case the verb, drop the resource noun if it duplicates the group. Generated at import time from `inspect`-ing the SDK; ~600 commands appear without a code-gen build step.

**Args & flags.**
- Required positional args become `--kebab-case` flags inferred from the SDK method signature.
- Optional kwargs map to `--flag value`. Booleans become `--flag/--no-flag`.
- A `--params` JSON blob accepts arbitrary nested params for endpoints with complex bodies.
- Global flags: `--format json|table|yaml`, `--api-key TOKEN`, `--vault-entry NAME`, `--org-id ID`, `--profile NAME`, `--dry-run`, `--verbose`.

### MerakiClient (the importable surface)

```python
from terminai_meraki import MerakiClient

client = MerakiClient.from_vault("meraki_default")  # or .from_env() / .from_token(...)
orgs = client.call("organizations", "list")
nets = client.call("organizations", "list-networks", organization_id="O_123")
```

`call()` returns a typed envelope:

```json
{"ok": true,  "data": <...>, "meta": {"endpoint": {...}, "blast_radius": "low"}}
{"ok": false, "error": {"code": "...", "message": "...", "hint": "..."}}
```

The Python API and the console script return the **same envelope** — the CLI just JSON-serializes it to stdout. Output format is JSON by default; `--format table|yaml` for humans.

### Tool catalog (`meraki-cli tools dump`)

JSON array, one entry per command:

```json
{
  "name": "meraki.networks.list-clients",
  "description": "List clients connected to a Meraki network…",
  "endpoint": {"method": "GET", "path": "/networks/{networkId}/clients"},
  "args": {
    "type": "object",
    "required": ["network_id"],
    "properties": {
      "network_id": {"type": "string", "description": "Meraki network ID, e.g. N_123…"},
      "timespan":   {"type": "number", "default": 86400, "description": "Window in seconds"}
    }
  },
  "blast_radius": "low",
  "destructive": false
}
```

Descriptions come from the SDK's docstrings (Cisco generates them from the OpenAPI spec — full sentences, parameter docs, all there). One pass produces the entire catalog.

### Blast-radius classifier

Table-driven `classify(method, path) -> Tier`:

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

Per-endpoint overrides allowed for Cisco-specific knowledge (e.g. `POST */ping` is actually `low`).

### Credentials resolver

```python
def resolve_api_key(vault_entry: str | None, env_var: str = "MERAKI_API_KEY") -> str:
    # 1. Explicit --api-key flag (handled by caller)
    # 2. Vault entry by name (via Tauri command bridge if running inside the sidecar)
    # 3. Env var
    # 4. Hard error with hint to set one of the above
```

When running **inside the sidecar**, vault lookup goes through the existing Tauri command bridge. When running **standalone**, the vault path is unavailable and the resolver skips straight to env. This keeps the package usable in arbitrary environments without dragging in TerminAI infrastructure.

## 4. ReACT Agent Integration

### Agent definition

A new optional frontmatter key `attached-tools` is added to the agent loader:

```yaml
---
name: meraki-expert
description: Cisco Meraki dashboard expert
system-prompt: |
  You are a Meraki dashboard expert. Use the meraki tool to answer
  questions about orgs, networks, devices, clients, and configs.
  Always confirm before making changes.
attached-tools:
  - id: meraki
    catalog: ~/.terminai/meraki-tools.json
    default-blast-radius-allowed: low   # auto-call reads, gate writes
    vault-entry: meraki_default
allowed-commands: []
---
(playbook body)
```

**Why a new key rather than reusing `attached-mcp-servers`:** these aren't MCP servers; the catalog is local JSON. Wedging them into the MCP path would defeat the whole point of moving off MCP for this. `attached-tools` is generic — future CLIs (Catalyst Center, ISE) plug in with the same shape.

**Rust changes (small).**
- `agents/types.rs`: add `attached_tools: Vec<AttachedTool>` field with `AttachedTool { id, catalog, default_blast_radius_allowed, vault_entry }`.
- `agents/loader.rs`: parse the new frontmatter section.
- One new Tauri command `agent_react_run` in `commands/ai.rs` that delegates to a new sidecar method `agent.react`.

Existing `attached-skills`, `attached-mcp-servers`, `allowed-commands` keep working unchanged.

### The ReACT loop (sidecar)

Lives in `sidecar/src/ccie_sidecar/agents/react.py` (new file). One pass per LLM turn:

```
Thought → Action (tool_call) → Observation → … → Final
```

```python
async def react_loop(agent_def, user_msg, ctx, on_event):
    catalog = load_catalog(agent_def.attached_tools)
    tools_for_llm = catalog_to_llm_tools(catalog)
    history = [{"role":"user","content":user_msg}]

    for step in range(MAX_STEPS):                             # default 12
        on_event({"type":"thought_start", "step":step})
        resp = await llm.stream(
            messages=history,
            tools=tools_for_llm,
            on_token=lambda t: on_event({"type":"token","data":t}),
        )

        if resp.stop_reason == "end_turn":
            on_event({"type":"final","content":resp.text})
            return

        for tc in resp.tool_calls:
            tool = catalog.find(tc.name)

            # 1) Auto-resolve missing required args from context
            args = autoresolve_args(tc.input, tool, ctx)

            # 2) Disambiguate if still missing required
            missing = [k for k in tool.required if k not in args]
            if missing:
                clarification = await disambiguate(tool, missing, ctx, on_event)
                if clarification.kind == "user_question_pending":
                    return  # loop pauses; UI submits answer to resume
                args.update(clarification.values)

            # 3) Blast-radius gate
            tier = tool.blast_radius
            if not allowed(tier, agent_def):
                approval = await request_approval(tool, args, tier, on_event)
                if not approval.granted:
                    history.append(observation(tc.id, error="user denied"))
                    continue

            # 4) Execute
            result = meraki_client.call(tool.resource, tool.action, **args)
            history.append(observation(tc.id, result=result))
            on_event({"type":"tool_result","name":tc.name,"result":result})

        history.append(resp.message)  # assistant turn with tool_calls
```

### Step (1): auto-resolve

`ctx` is built once per ReACT call:

| Source | Example |
|---|---|
| Active tab's last block | last command output → may contain a serial, MAC, IP |
| Last-used `org_id` / `network_id` | stored per-session in `react_session_state` |
| Active vault default org | from agent frontmatter |
| Conversation history | previous tool results in this same loop |

A small registry of (param_name → resolver) functions. `network_id` resolver: prefer last-used → look in conversation tool-results → look in active block context. If exactly one candidate, use it. If zero or many, fall through to disambiguate.

### Step (2): disambiguate

When auto-resolve fails on `network_id`, the resolver doesn't give up — it calls a *helper* tool the LLM never sees:

```python
async def disambiguate(tool, missing, ctx):
    if "network_id" in missing:
        org_id = ctx.org_id or await disambiguate(... "org_id" ...)
        nets = meraki_client.call("organizations", "list-networks",
                                  organization_id=org_id)
        if len(nets.data) == 1:
            return Resolved(network_id=nets.data[0]["id"])
        on_event({
            "type": "user_question",
            "param": "network_id",
            "prompt": f"Which network in {org_id}?",
            "options": [{"id": n["id"], "label": n["name"]} for n in nets.data],
        })
        return Pending()
```

The frontend's `AgentPanel` already streams events from `agent_chat_stream`. We add one new event type `user_question` rendered as an inline picker (existing `DevicePickerDialog` is the pattern). User's choice fires a `react_resume` Tauri command → sidecar resumes the same loop with the answer injected into `ctx.user_answers`.

### Step (3): blast-radius gate

`allowed(tier, agent_def)` returns true if `tier ≤ default_blast_radius_allowed` under the explicit ordering `low < medium < high < destructive`. If false, an event of type `tool_approval_request` flows up and the frontend's existing `ToolApprovalModal` (currently used for MCP tool approvals) renders it:

```
[ HIGH ] Update SSID on network N_456 ("Office-Wifi")
Endpoint: PUT /networks/N_456/wireless/ssids/0
Args:
  ssid_name: "Office-Wifi-Guest"
  enabled: true
[Approve once] [Approve all this session] [Deny]
```

Approval result resolves the same `react_resume`-style flow. **No new modal component.**

### Step (4): execute

`MerakiClient.call(...)` runs in-process — synchronous SDK call inside an executor (Cisco's SDK isn't async). 429s are handled by the SDK itself. Result is wrapped in the standard envelope and appended as a tool-result message.

### Streaming events to the UI

| Event | Payload | UI treatment |
|---|---|---|
| `thought_start` | `{step}` | "Thinking…" pill |
| `tool_call` | `{name, args, blast_radius}` | collapsible tool-call card |
| `tool_result` | `{name, ok, data, meta}` | result inside the card |
| `user_question` | `{param, prompt, options[]}` | inline picker |
| `tool_approval_request` | `{tool, args, tier}` | existing ToolApprovalModal |
| `final` | `{content}` | normal assistant message |

Additive to the existing `token` / `done` / `error` events. No backwards-incompatible changes.

### Loop limits

- `MAX_STEPS = 12` per user turn.
- 5 calls of the same tool per loop.
- 90-second wall-clock per loop.
- On any cap hit: `error` event with hint; conversation history preserved.

## 5. Data Flow, State, and Storage

### What persists

| Data | Persisted? | Where | Why |
|---|---|---|---|
| API key | yes | Vault (entry name set per agent, default `meraki_default`) | Existing Plan 14 vault; reused unchanged |
| Tool catalog JSON | yes (regeneratable) | `~/.terminai/meraki-tools.json` | Built on package install; loaded by agent loop |
| Agent definition | yes | `~/.ccie-terminal/agents/<name>/agent.md` | Existing path; new `attached-tools` key |
| ReACT session state | yes | `react_session_state` (V0044) | Survives restarts, remembers last org/network |
| In-flight ReACT loop | yes | `react_pending_resumes` (V0044) | Lets paused loops resume across reloads |
| Conversation history | yes | extends existing `agent_conversations` table | Same table, new `react_metadata` JSON column |
| Tool-call audit log | yes | `meraki_tool_calls` (V0044) | Every call by an agent — endpoint, args, result-summary, blast tier, approval status, timestamp |
| HTTP response bodies | **no** | (in-process only) | Too large; only the envelope summary lives in audit log |
| Cached SDK client | per-process | sidecar memory | One client per (api_key, base_url) |

### V0044 migration

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
    question        TEXT NOT NULL,             -- JSON: {param, prompt, options}
    loop_state      BLOB NOT NULL,             -- pickled history + ctx
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL           -- 30 min default
);

CREATE TABLE meraki_tool_calls (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT,
    agent_id         TEXT,
    tool_name        TEXT NOT NULL,
    method           TEXT NOT NULL,
    path             TEXT NOT NULL,            -- templated, e.g. /networks/{id}/clients
    args_json        TEXT NOT NULL,
    blast_radius     TEXT NOT NULL,
    approval_status  TEXT,                     -- null|approved|denied|auto
    response_status  INTEGER,
    response_summary TEXT,                     -- first 1KB, redacted
    error_code       TEXT,
    duration_ms      INTEGER NOT NULL,
    created_at       INTEGER NOT NULL
);

CREATE INDEX idx_meraki_tool_calls_conv  ON meraki_tool_calls(conversation_id);
CREATE INDEX idx_meraki_tool_calls_agent ON meraki_tool_calls(agent_id, created_at);
```

V0044 is the next free migration (V0042/V0043 used by Plan 15).

### End-to-end flow: "list connected clients on the office network"

```
1.  User types in AgentPanel: "what clients are on the office network?"
2.  Tauri → agent_react_run(agent_id="meraki-expert", message=…)
3.  Sidecar.agent.react opens conversation, builds ctx from
    react_session_state (last_org_id present, last_network_id absent)
4.  LLM turn 1 → tool_call: meraki.networks.list-clients (no network_id)
5.  autoresolve: no network_id in ctx → disambiguate
6.  disambiguate: org_id present, calls meraki.organizations.list-networks
    under the hood (audited as a "low" auto-resolve call)
7.  14 networks returned → emit user_question event with options[]
8.  AgentPanel renders inline picker, user clicks "HQ-Office"
9.  Frontend → react_resume(pending_id, answer={network_id:"N_456"})
10. Sidecar resumes loop, appends answer to ctx, retries tool_call
11. Tool catalog says blast_radius=low → no approval gate
12. MerakiClient.call("networks","list-clients", network_id="N_456",
                     timespan=86400)
13. Result envelope appended to history; tool_result event streamed
14. LLM turn 2 → "There are 23 clients on HQ-Office, mostly Apple devices…"
15. final event; conversation persisted; react_session_state.last_network_id
    updated to N_456 for next turn
16. meraki_tool_calls gets two rows (the disambiguation call + the actual call)
```

### Failure modes

| Failure | Behavior |
|---|---|
| API key missing in vault & env | `error` event, hint "Set the vault entry referenced by the agent (default name `meraki_default`) or env `MERAKI_API_KEY`". No call attempted. |
| 401 / 403 from Meraki | Envelope `{ok:false, error:{code:"auth", hint:"rotate key"}}`. LLM surfaces verbatim. |
| 429 rate limit | SDK auto-retries with backoff. If exhausted, returned as error. |
| Network timeout | 30s default per call. Returned as error. |
| LLM hallucinates a non-existent tool name | Catalog lookup fails → `{ok:false, error:{code:"unknown_tool", hint:"valid: …"}}`. LLM corrects. |
| User abandons a `user_question` | `react_pending_resumes` row expires after 30 min; cleared on next message. |
| Loop hits MAX_STEPS=12 | `error` event "Agent ran out of steps". Conversation preserved. |
| Sidecar crashes mid-loop | Existing supervisor restarts. Pending row stays; AgentPanel can offer "resume?". |

### Configuration touch points

- `meraki_cli/pyproject.toml`: pin `meraki>=1.50.0`; entry point `meraki-cli = terminai_meraki.cli.main:app`.
- `sidecar/pyproject.toml`: add `terminai-meraki @ file://${PROJECT_ROOT}/meraki_cli` (path dep so dev edits are immediate).
- `~/.terminai/meraki-tools.json` regenerated on app start if absent or stale.

## 6. Testing

**Real-tenant for reads, scratch network for writes.**

```
meraki_cli/tests/
├── conftest.py                # session-scoped fixtures
├── test_catalog.py            # pure unit
├── test_blast_radius.py       # pure unit, table-driven
├── test_credentials.py        # vault + env resolver, mocked
├── test_output.py             # JSON/table/yaml renderers
├── test_reads_live.py         # @pytest.mark.live_read
├── test_writes_sandbox.py     # @pytest.mark.live_write
└── test_react_loop.py         # sidecar integration, mocked LLM
```

**conftest.py** sets up:

- `meraki_client` fixture — uses `MERAKI_API_KEY` from env, errors clearly if absent.
- `sandbox_org_id` and `sandbox_network_id` fixtures — read from env vars `TERMINAI_TEST_ORG_ID` / `TERMINAI_TEST_NETWORK_ID`. CI fails fast if not set.
- `sandbox_guard` autouse fixture for `live_write` tests — asserts the network name starts with `TerminAI-CLI-Test` before any test runs. Belt-and-suspenders so a misconfigured env var never lets writes hit a real network.
- Cleanup hook: every `live_write` test wraps mutations in try/finally that reverts state.

**Pytest markers and runs:**

```
pytest -m "not live_read and not live_write"  # default, no secrets, runs in CI
pytest -m live_read                            # nightly CI
pytest -m live_write                           # manual trigger
```

**One-time setup:**
1. Create a network in the real org named exactly `TerminAI-CLI-Test`.
2. Set `TERMINAI_TEST_ORG_ID` and `TERMINAI_TEST_NETWORK_ID` in `.env.test`.
3. Sandbox-guard fixture verifies the name match every run.

**ReACT loop tests** mock the LLM but use the real `MerakiClient` against the sandbox. Catches integration bugs without burning LLM tokens in CI.

**Frontend tests:**
- `AgentPanel` gains tests for new event types (`user_question`, `tool_call`, `tool_result`, `tool_approval_request`).
- New `MerakiToolCallCard.tsx` with vitest tests for collapsed/expanded states.
- E2E: one Playwright spec exercising a stubbed ReACT loop end-to-end (sidecar replies mocked at the bridge level).

## 7. Build & Release

**Within TerminAI:**
- `meraki_cli/` is a path dependency of `sidecar/`. Sidecar's existing build (`sidecar/scripts/build.sh`) installs it via pip into the bundled venv.
- Tauri build picks up the sidecar dir untouched.
- Catalog generation: cargo build postscript or sidecar startup runs `meraki-cli tools dump > ~/.terminai/meraki-tools.json` if the file is absent or stale. Stamped with the package version so an upgrade auto-regenerates.

**As a standalone package:**
- `meraki_cli/pyproject.toml` is publishable as-is. `pip install terminai-meraki` outside TerminAI gives you `meraki-cli` on PATH and the `from terminai_meraki import MerakiClient` API. Vault path unavailable → cleanly falls through to env.
- v1 published to internal PyPI; public PyPI later if/when desired.
- Versioning independent of TerminAI.

## 8. Documentation

- `meraki_cli/README.md` — quickstart (install, set API key, list orgs).
- `docs/MERAKI_CLI.md` — full command reference (auto-generated from catalog), examples, ReACT walkthrough.
- `docs/superpowers/specs/2026-05-21-meraki-cli-design.md` — this design.
- New section in `docs/USER_GUIDE.md` for "Building a Meraki agent" with a copy-paste agent template.

## 9. Roll-out (Phase Plan)

Six-phase implementation, each phase merges to main on its own.

| Phase | Scope | Acceptance |
|---|---|---|
| 1. CLI core | Package skeleton, `MerakiClient`, credential resolver, output renderers, console entry point. No catalog, no agent loop yet. | `meraki-cli organizations list` works against live tenant from terminal. |
| 2. Tool catalog & blast-radius | Introspect SDK, generate JSON catalog, classifier table. | `meraki-cli tools dump` produces valid JSON; unit tests cover all classifier rows. |
| 3. ReACT loop in sidecar | New `agents/react.py`, `attached-tools` frontmatter, basic execution path (no disambiguation, no approval). | A `meraki-readonly-expert` agent answers "list my orgs" via the AgentPanel. |
| 4. Disambiguation + auto-resolve | `react_session_state`, `react_pending_resumes`, `user_question` event, inline picker UI. | "List clients on office network" pauses, shows picker, resumes after click. |
| 5. Blast-radius gating + audit log | Wire `tool_approval_request` to `ToolApprovalModal`, add `meraki_tool_calls` table. V0044 migration. | A write call triggers approval modal; audit table populates. |
| 6. Live-tenant test suite + docs | `live_read` / `live_write` markers, sandbox guard, `MERAKI_CLI.md`, agent template. | Nightly CI runs reads green; manual write run is reproducible. |

## 10. Out of Scope (YAGNI)

- **Action batches.** Cisco's bulk-action API adds whole new call semantics. v2.
- **Webhook handling.** Inbound webhooks (alerts, scanning) are a separate feature. v2.
- **Multi-tenant per agent.** Schema supports per-agent vault entries; the UI for binding agents to specific creds beyond a single default ships in v2.
- **Catalyst Center / ISE / SNA versions.** Same architecture scales to them, but each is its own spec.
- **Streaming long lists.** Pagination handled by the SDK; UI streaming for paginated results is out of v1.

## 11. Open Questions

None at design approval. Implementation plan (next, via `superpowers:writing-plans`) will turn each phase row into a concrete task breakdown.

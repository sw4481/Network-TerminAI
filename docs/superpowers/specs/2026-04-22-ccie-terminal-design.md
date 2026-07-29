# CCIE Terminal — Design Spec

**Status:** Approved 2026-04-22
**Author conversation:** `/Users/shaunwhi/.claude/plans/i-want-you-to-refactored-cocke.md`

---

## Context

The user — a computer-networking expert focused on switches/routers/wireless/servers — wants a **CCIE-focused, Warp-like terminal** with deeply integrated AI. The goal is a single desktop application that replaces a normal terminal for day-to-day network work and augments it with:

- **Conversational, agentic AI** with per-tab history, able to read scrollback, run commands (with approval), and use tools.
- **Pluggable LLM providers** (OpenAI, Anthropic, Google, vLLM, Ollama) configured through a Settings page, with API keys persisted to a `.env` file.
- **User-authored "skills"** (Claude-Code-style filesystem skills) with a UI for creation and AI-assisted authoring, backed by local helper scripts.
- **MCP server integration** (stdio + HTTP/SSE) with paste-JSON import and per-tool approval.
- **Multi-tab sessions** with persistent scrollback, persistent AI chat history, and full-text search.

The app is greenfield — no existing code. Target platforms: macOS, Linux, Windows.

---

## Architecture

Three-tier desktop application:

```
┌─────────────────────────────────────────────────────┐
│ Frontend (React + TypeScript, Tauri webview)        │
│  • xterm.js per tab, command-block overlay           │
│  • Side-panel agent chat                             │
│  • Settings windows (Profiles / MCP / Skills)        │
│  • "Create Skill" wizard                             │
└─────────────────────────────────────────────────────┘
                ↕ Tauri invoke + events
┌─────────────────────────────────────────────────────┐
│ Core (Rust, Tauri v2)                               │
│  • PTY manager  (portable-pty: Unix + ConPTY)       │
│  • Session store (SQLite + FTS5)                    │
│  • Config: .env + config.toml watcher               │
│  • Agent bridge (spawns & drives Python sidecar)    │
│  • MCP router + approval policy engine              │
└─────────────────────────────────────────────────────┘
                ↕ NDJSON over stdio (JSON-RPC-ish)
┌─────────────────────────────────────────────────────┐
│ Agent sidecar (bundled Python, python-build-standalone)│
│  • LangGraph / DeepAgents (library only, not its TUI)│
│  • Provider adapters: anthropic/openai/google/       │
│    ollama/vllm (via LangChain chat models)           │
│  • Skill loader & executor                           │
│  • MCP client adapter (reverse-calls Rust for exec)  │
└─────────────────────────────────────────────────────┘
```

### Foundational decisions

- **Stack:** Tauri v2 (Rust) + React/TypeScript + xterm.js. Python AI runtime bundled as a Tauri sidecar binary using `python-build-standalone` (maintained by Astral).
- **Rust owns MCP**, not Python. Tool calls flow through the stdio bridge; Rust enforces approval and executes.
- **Python is stateless.** Conversation state persists in SQLite; sidecar can crash/restart cleanly.
- **One Python sidecar, many sessions.** Routing is by `session_id`.
- **Config:** `~/.config/ccie-terminal/` (XDG-style). Skills at `~/.ccie-terminal/skills/`.
- **Model profiles, not per-feature models.** Named profiles ("fast", "smart", "local") selectable per-tab.

---

## Feature scope (V1)

**Included:**
- Multi-tab terminal (xterm.js + portable-pty) with Warp-style command blocks (OSC 133 + prompt-regex fallback).
- Side-panel agent chat per tab, streaming, with tool-use approval UI.
- `#` natural-language → command (inserts into prompt buffer; never auto-runs).
- "✨ Fix this" button on failed command blocks.
- Settings: Profiles (5 providers), MCP Servers, Skills, General.
- API keys stored in `~/.config/ccie-terminal/.env` (chmod 600).
- Skills system: filesystem layout, SKILL.md frontmatter, global + per-skill scripts, hot reload, `/skill-name` manual invoke, auto-trigger by `when-to-use`, Create Skill wizard with AI-assisted authoring.
- MCP: stdio + HTTP/SSE transports, paste-JSON import, per-tool approval.
- Persistence: tabs + scrollback + AI history restored on relaunch; full-text search; named/saved sessions.
- Platforms: macOS, Linux, Windows.

**Deferred to V2:**
- Inline ghost-text autocomplete.
- Skill sharing / import / registry.
- Cross-tab workspaces or cross-tab agent.
- WinPTY fallback for pre-ConPTY Windows.

---

## Components

### Frontend (React, `src/`)

| Component | Purpose |
|---|---|
| `TabBar` | Add/close/reorder tabs; per-tab connection state |
| `Terminal` | xterm.js instance + command-block overlay |
| `CommandBlock` | Parsed command+output pair; "✨ Explain/Fix", copy, collapse |
| `AgentPanel` | Collapsible chat; token streaming; inline tool approvals |
| `SettingsWindow` | Separate Tauri window; Profiles / MCP / Skills / General |
| `SkillWizard` | Guided form + "Generate with AI" preview-then-save |
| `ToolApprovalModal` | Approve / Deny / "Always allow for server" |

### Rust core (`src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `pty.rs` | `portable-pty` wrapper; one `PtySession` per tab |
| `session.rs` | SQLite-backed session store |
| `config.rs` | Load `.env` + `config.toml`; fs watch |
| `mcp.rs` | stdio + HTTP/SSE MCP clients; approval policy |
| `agent_bridge.rs` | Spawn Python sidecar; NDJSON multiplex |
| `command_parser.rs` | OSC 133 primary, prompt-regex fallback |

### Python sidecar (`sidecar/`)

| Module | Responsibility |
|---|---|
| `server.py` | NDJSON stdio loop; method dispatch |
| `agent.py` | DeepAgents graph per `session_id`; stream events |
| `providers/` | Adapters for anthropic/openai/google/ollama/vllm |
| `skills.py` | Scan skills dir, parse frontmatter |
| `skill_author.py` | Generates SKILL.md + scripts from NL spec |

---

## Data model & protocols

### SQLite (`~/.config/ccie-terminal/sessions.db`)

```
tabs                id, title, shell_cmd, cwd, profile_id, created_at, closed_at
saved_sessions      id, name UNIQUE, tab_snapshot_json, created_at
command_blocks      id, tab_id, cmd, output BLOB, exit_code, started_at, ended_at, ai_interactions_json
ai_messages         id, tab_id, role, content, tokens_in, tokens_out, provider, model, created_at
tool_calls          id, tab_id, server, tool, args_json, result_json, approved_by, created_at
mcp_servers         id, name, transport, command_json, env_json, enabled
approval_policies   server_name, tool_name, policy, scope
```

FTS5 on `command_blocks(cmd, output)` and `ai_messages(content)`.

### Config files

- `~/.config/ccie-terminal/.env` (chmod 600) — secrets only.
- `~/.config/ccie-terminal/config.toml` — non-secret settings + model profiles.

### NDJSON protocol

Requests (Rust → Python): `chat.stream`, `nl_to_command`, `explain_error`, `author_skill`, `reload_skills`.
Responses (Python → Rust): `token`, `tool_call`, `tool_result`, `done`, `error`.
Reverse requests (Python → Rust): `mcp_invoke` → responds with `mcp_result`.

### Skill format

```yaml
---
name: bgp-troubleshoot
description: Diagnose BGP peering and convergence issues on Cisco IOS/IOS-XE
when-to-use: User asks about BGP problems, peer states, missing routes, or convergence
scripts:
  - check_bgp.sh
  - parse_adj_rib.py
allowed-commands: ["show bgp", "show ip bgp"]
---

# playbook body the agent reads
```

---

## Security

1. **LLM output never auto-executes.** `#` NL→command inserts into prompt buffer; agent-requested shell commands go through MCP approval.
2. **Tool approval:** `read → auto`, `write → confirm`, `dangerous → confirm + typed "yes" on first use per server`. "Always allow" is per-tool, opt-in.
3. **Secret hygiene:** API keys live only in Rust. Scrollback sent to LLMs scrubbed for key shapes.
4. **Tauri capability allowlist:** default-deny; explicit commands only.
5. **Sidecar integrity:** signed in CI; Rust verifies expected hash on spawn.

## Error handling

| Failure | Behavior |
|---|---|
| PTY dies | "disconnected" banner + Reconnect |
| Python sidecar crashes | Restart, replay ~20 messages |
| LLM 401/403 | "key invalid — open settings" |
| LLM rate-limited | Exponential backoff with visible cancel |
| MCP server won't start | Red in settings with stderr tail |
| Skill script non-zero | Stderr returned to agent as tool result |
| `.env` unreadable | "no providers configured" state |
| SQLite corrupt | In-memory start; offer to quarantine |

## Signing

- **macOS:** CI signs each nested `.dylib`/`.so` inside python-build-standalone before Tauri bundles. Hardened runtime + `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`.
- **Windows:** EV cert signing for SmartScreen.
- **Linux:** AppImage + optional `.sig`.

---

## Build phases

| Phase | Goal |
|---|---|
| 0 | Scaffolding: Tauri v2 + React; CI matrix; signing stubs; SQLite migrations infra |
| 1 | Terminal foundation: portable-pty, multi-tab, command blocks, persistence |
| 2 | Python sidecar bridge: python-build-standalone, NDJSON, Anthropic, side-panel chat, profiles |
| 3 | AI interactions: `#` NL→command, "Fix this", remaining 4 providers |
| 4 | MCP: stdio + HTTP/SSE, approval engine, Settings > MCP, tool-use round-trip |
| 5 | Skills: FS layout, loader, hot reload, wizard, AI authoring, `/name`, auto-trigger |
| 6 | Persistence polish: FTS5 search, named sessions, restore on launch |
| 7 | Hardening & release: signing, notarization, UAT |

---

## Verification (UAT)

1. Multi-tab isolation of AI history.
2. `#` NL→command inserts but doesn't auto-run.
3. "Fix this" on failed command proposes corrected command.
4. Skill authoring via wizard creates SKILL.md + scripts; auto-invoked by agent.
5. MCP approval blocks dangerous write by default.
6. Persistence: tabs/scrollback/chat restored after restart.
7. Provider coverage: each of 5 providers streams.
8. Signing: Gatekeeper/SmartScreen launches without warning.

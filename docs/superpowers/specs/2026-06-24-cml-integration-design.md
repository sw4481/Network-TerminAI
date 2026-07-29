# CML (Cisco Modeling Labs) Agent + MCP Server — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Author:** brainstorming session

## Goal

Add a Cisco Modeling Labs (CML) integration to CCIE Terminal that mirrors the
existing **ISE** and **Stealthwatch** "single-tool model" integrations exactly:

- One MCP server exposing a single `cml_api_call(method, path, body, query_params)` tool.
- One bundled agent (`cml`) that uses the tool via `execution-mode: react-code`.
- A Settings pane to enter CML credentials (host / username / password / verify SSL).
- Config persisted in a singleton SQLite table; saving auto-registers the MCP server.

Target server: CML **2.10** at `https://192.168.2.200` (login `admin` / `Iwiwaf77`).
API base: `https://<host>/api/v0`. 148 endpoints, single base URL.

## Key decisions

- **Agent scope:** Full control, **no gating**. The single tool allows all methods
  (GET/POST/PUT/PATCH/DELETE). Every call classifies blast radius as `low`, so
  mutations (lab start/stop/wipe/delete) are auto-approved with no modal. The
  blast-radius mechanism stays wired in but never trips.
- **TLS verify default:** **OFF** (`verifySsl` defaults to `false`) because the CML
  server uses a self-signed certificate. User can enable it in Settings.
- **Auth model:** Bearer JWT (see below) — the one behavioral deviation from the
  ISE/Stealthwatch template.

## Architecture

Identical layering to ISE/Stealthwatch. The **only** difference is authentication.

| Integration | Auth |
|---|---|
| ISE | HTTP Basic, per request |
| Stealthwatch | Session-cookie login, persistent `requests.Session` |
| **CML** | **Bearer JWT**: `POST /api/v0/authenticate {username, password}` → JWT string; send `Authorization: Bearer <jwt>` on every call |

`CmlClient`:
- Lazily authenticates on first call, caches the JWT on a persistent `requests.Session`.
- **Transparently re-authenticates once on a 401** (CML tokens expire), then retries
  the original request. If re-auth also fails, returns the error.
- No multi-surface/port inference (unlike ISE's ERS/OpenAPI/MnT). CML is one base URL.
- Returns the standard shape: `{status_code, data, error, blast_radius}`.

The single tool description embeds a curated endpoint catalog. `/labs` dominates the
surface (55 of 148 paths). Representative endpoints to document in the catalog:

```
POST /authenticate            -> JWT (auth; handled internally, agent rarely calls)
GET  /authok                  -> token sanity check
GET  /labs                    -> list lab IDs ; POST /labs creates a lab
GET  /labs/{id}               -> lab detail ; DELETE removes ; PATCH updates
GET  /labs/{id}/state         -> lab state
GET  /labs/{id}/topology      -> full topology (nodes + links + interfaces)
GET  /labs/{id}/nodes         -> nodes ; POST adds a node
PUT  /labs/{id}/start | /stop | /wipe   -> lifecycle (mutations, auto-approved)
GET  /nodes                   -> all running nodes across labs
GET  /node_definitions        -> available node types
GET  /image_definitions       -> available images
GET  /system_information , /system_health , /system_stats
GET  /users , /groups
```

## Components

### New files

| Layer | File |
|---|---|
| Client lib | `sidecar/src/ccie_sidecar/cml.py` — `CmlClient` (JWT auth + re-auth-on-401), `_blast_radius()` (always `low`), `install_cml()` |
| Config reader | `sidecar/src/ccie_sidecar/cml_config.py` — `get_cml_config()` (sessions.db → `CML_*` env fallback) |
| MCP server | `sidecar/src/ccie_sidecar/mcp_servers/cml_mcp.py` — single `cml_api_call` tool over JSON-RPC stdio |
| Agent | `bundled-agents/cml/AGENT.md` |
| Tool catalog | `bundled-agents/cml/tools.json` |
| Migration | `src-tauri/migrations/V0057__cml_config.sql` (singleton table, `id=1` CHECK) |
| Tests | `sidecar/tests/test_cml.py` (token caching, re-auth-on-401, blast radius) |

### Edits to existing files

- `src-tauri/src/commands/mod.rs` — `CmlConfig` struct (`#[serde(rename_all = "camelCase")]`),
  `cml_get_config` / `cml_save_config` / `cml_test_connection`, `enable_cml_mcp_server()`.
- `src-tauri/src/lib.rs` — register the 3 commands in the invoke handler.
- `src/lib/tauri.ts` — `CmlConfig`, `CmlTestResult`, 3 invoke wrappers.
- `src/windows/Settings.tsx` — import `CmlSettingsTab`, add `"cml"` to `TabType`, tab button, render block.
- `sidecar/src/ccie_sidecar/agents/code_exec.py` — `if cli_package == "cml": install_cml(...)`.
- `sidecar/src/ccie_sidecar/agents/sandbox_index.py` — `build_discovery_hint("cml")`.

### Settings UI

`src/components/settings/CmlSettingsTab.tsx` — fields **host, username, password,
verifySsl (default false)**. "Save" → `cmlSaveConfig(cfg)`; "Test Connection" →
`cmlTestConnection(cfg)`. Status div for ok/err/info. Same shape as `IseSettingsTab`.

## Data model

```sql
-- V0057__cml_config.sql
CREATE TABLE IF NOT EXISTS cml_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 0   -- default OFF (self-signed cert)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cml_config_singleton ON cml_config(id);
```

MCP registration row (written by `enable_cml_mcp_server` on save):
- `mcp_servers` id `cml-mcp`, name `Cisco Modeling Labs`, transport `stdio`.
- `command_json`: `{cmd: <python>, args: [<repo>/sidecar/src/ccie_sidecar/mcp_servers/cml_mcp.py]}`.
- `env_json`: `CML_HOST`, `CML_USERNAME`, `CML_PASSWORD`, `CML_VERIFY_SSL`.

## Save → register → agent-can-use chain

1. User clicks **Save** in `CmlSettingsTab` → `cmlSaveConfig(cfg)` Tauri command.
2. Rust `INSERT OR REPLACE INTO cml_config (id=1, ...)`.
3. Rust calls `enable_cml_mcp_server()` → `INSERT OR REPLACE INTO mcp_servers` (id `cml-mcp`, env vars).
4. On agent run, Rust spawns the stdio MCP subprocess with `CML_*` env vars.
5. `cml_mcp.py` reads env → builds `CmlClient` → authenticates once → serves `cml_api_call`.
6. Code-exec sandbox path: `get_cml_config()` reads sessions.db (or `CML_*` env) → `install_cml()` injects `cml_api_call` into globals.

## Error handling

- **Auth failure:** `test_connection` POSTs `/authenticate`; distinguishes
  "Authentication failed (401)" from connection/TLS errors in the returned message.
- **Mid-session 401:** `CmlClient.call()` re-authenticates once and retries; if that
  fails, returns `{status_code: 401, error: ...}`.
- **TLS:** `verify_ssl=False` default; suppress urllib3 `InsecureRequestWarning`
  (same as ISE/Stealthwatch clients).

## Testing

- pytest `sidecar/tests/test_cml.py`: token caching, re-auth-on-401 retry, blast-radius
  always-low, request shaping. Mirror the ISE test file structure.
- Live smoke test: `cml_test_connection` against `192.168.2.200` must succeed before
  claiming done (per "verify before claiming done"). Confirm a real `GET /labs` returns.
- Follow whatever vitest coverage `IseSettingsTab` had for the settings component.

## Out of scope (YAGNI)

- No dedicated CML topology visualizer (the existing Topology tab / agent reasoning
  over `GET /labs/{id}/topology` covers inspection).
- No port/multi-surface inference (CML is a single base URL).
- No PDF/zip export, no scheduling.

## Migration number

CML uses **V0057** (ISE used V0056). Next free after this is **V0058**.

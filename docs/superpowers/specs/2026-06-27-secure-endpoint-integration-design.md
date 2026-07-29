# Cisco Secure Endpoint MCP Integration — Design

**Date:** 2026-06-27
**Status:** Approved for planning
**Pattern:** Single-tool MCP, mirroring ISE / FMC / Stealthwatch

## Goal

Add a Cisco Secure Endpoint (AMP for Endpoints) integration following the
established single-tool MCP pattern: one `secure_endpoint_api_call` tool exposing
the full REST API, a Settings tab, a dedicated `secure-endpoint` agent, and
network-architect access. The tool description is the LLM's primary guidance and
must make it unambiguous what to call and how to format calls.

## API Background

Secure Endpoint has two API generations:

- **v1 (classic AMP):** HTTP Basic auth with `client_id` as username and
  `api_key` as password. Single regional host. Paths under `/v1/...`. Response
  envelope `{version, metadata, data}` — rows under `data`; paging via
  `limit`/`offset` (limit max 500); `metadata.results.total` is the full count.
- **v3 (XDR/Secure Cloud):** OAuth2 client-credentials — exchange
  `client_id:client_secret` for a bearer token at the regional `visibility.*`
  host, re-auth on 401. Paths under `/v3/organizations/{org}/...`.

**Decision:** Implement v1 fully now (proven Basic-auth pattern, identical to
ISE). Structure the client with a pluggable auth strategy so a `v3_oauth` mode
can be added via a config toggle. v3 path is wired but flagged in code as
unverified-against-hardware.

**Regional hosts:**
- `nam` → `api.amp.cisco.com`
- `eu` → `api.eu.amp.cisco.com`
- `apjc` → `api.apjc.amp.cisco.com`

(v3 token host: matching `visibility.*.amp.cisco.com`.)

## Architecture & File Layout

### New files
| File | Purpose |
|---|---|
| `sidecar/src/ccie_sidecar/secure_endpoint.py` | `SecureEndpointClient`, `_blast_radius`, `install_secure_endpoint`, `test_connection` |
| `sidecar/src/ccie_sidecar/secure_endpoint_config.py` | `get_secure_endpoint_config()` — reads singleton from sessions.db |
| `sidecar/src/ccie_sidecar/mcp_servers/secure_endpoint_mcp.py` | JSON-RPC server, single `secure_endpoint_api_call` tool |
| `src-tauri/migrations/V0066__secure_endpoint_config.sql` | Singleton config table |
| `src/components/settings/SecureEndpointSettingsTab.tsx` | Settings form |
| `bundled-agents/secure-endpoint/AGENT.md` | New agent definition |
| `bundled-agents/secure-endpoint/tools.json` | Tool catalog |

### Modified files
| File | Change |
|---|---|
| `src-tauri/src/commands/mod.rs` | `secure_endpoint_get_config`, `secure_endpoint_save_config`, `secure_endpoint_test_connection` + `enable_secure_endpoint_mcp_server` helper |
| `src-tauri/src/lib.rs` | Register the 3 new commands in the invoke handler (if commands are listed there) |
| `src/windows/Settings.tsx` | Add `"secure_endpoint"` to activeTab union, menu item, render `<SecureEndpointSettingsTab />` |
| `bundled-agents/network-architect/AGENT.md` | Attach `secure-endpoint-mcp` + tool; add usage prompt section |

### The single tool
`secure_endpoint_api_call(method, path, body=None, query_params=None)`
- Returns `{status_code, data, error, blast_radius}`.
- No `base` param (single host), unlike ISE's three surfaces.
- Host + auth resolved from config; agent supplies only method + path (+ body/query).

### Auth strategy (v3-ready)
`SecureEndpointClient` reads `auth_mode` from config (`v1_basic` default):
- `v1_basic`: `session.auth = (client_id, api_key)` — identical to ISE.
- `v3_oauth`: client-credentials token exchange against regional visibility host,
  inject `Bearer` token, re-auth on 401. Wired but unverified vs hardware.

## Config Schema

`V0066__secure_endpoint_config.sql` — singleton:
```sql
CREATE TABLE IF NOT EXISTS secure_endpoint_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    region      TEXT    NOT NULL DEFAULT 'nam',       -- nam | eu | apjc
    auth_mode   TEXT    NOT NULL DEFAULT 'v1_basic',  -- v1_basic | v3_oauth
    client_id   TEXT    NOT NULL DEFAULT '',
    api_key     TEXT    NOT NULL DEFAULT '',          -- v1: api_key | v3: client_secret
    verify_ssl  INTEGER NOT NULL DEFAULT 1
);
```

**Env vars injected by Rust transport:** `SECURE_ENDPOINT_REGION`,
`SECURE_ENDPOINT_AUTH_MODE`, `SECURE_ENDPOINT_CLIENT_ID`,
`SECURE_ENDPOINT_API_KEY`, `SECURE_ENDPOINT_VERIFY_SSL`.

**Settings tab fields:** Region (dropdown), Auth Mode (dropdown), Client ID,
API Key / Client Secret (password; label switches with auth mode), Verify SSL
(checkbox, **default true** — public Cisco-signed hosts, unlike ISE/FMC), Save,
Test Connection.

## Blast Radius

Reported as metadata on every response; **never blocks** (no approval gate per
operator decision). Classified by HTTP method only:
| Tier | Operations |
|---|---|
| `low` | All GET |
| `medium` | POST / PUT / PATCH (including isolation) |
| `destructive` | DELETE |

Agent `default-blast-radius-allowed: destructive` so nothing gates. Isolation
endpoints are freely callable.

## Tool Description / API Catalog

Embedded in `get_tool_description()` (the LLM's primary guidance). Covers:
computers (list/detail/trajectory/activity), isolation (GET/PUT/DELETE), events,
event_types, groups, policies, computer→group move (`PATCH /v1/computers/{guid}`
with `{group_guid}`), vulnerabilities, file_lists, version. Documents the
`{version, metadata, data}` envelope, `limit`/`offset` paging (max 500),
`metadata.results.total`, GUID semantics (connector_guid vs group_guid/
policy_guid), ISO-8601 UTC dates, and a note that v3 paths differ.

`test_connection` → `GET /v1/version` (cheap, authed, no side effects).

## Agents

### New `secure-endpoint` agent
- `name: secure-endpoint`, `execution-mode: react-code`, `engine: legacy`
- `attached-tools: [{id: secure-endpoint, catalog: tools.json, default-blast-radius-allowed: destructive}]`
- System prompt: Cisco Secure Endpoint (AMP) expert; manages endpoint detection,
  isolation, groups, policies, events, vulnerabilities, file lists via the single
  `secure_endpoint_api_call` tool. Includes call signature, envelope/paging rules,
  and worked examples (list computers → isolate by guid → check status).
- `tools.json` describing the one tool (same shape as `ise/tools.json`).

### network-architect changes
- Add `secure-endpoint-mcp` to `attached-mcp-servers`.
- Add `secure-endpoint` tool to `attached-tools`.
- Add prompt section telling it *when* (endpoint security posture, malware
  detections, host isolation/quarantine, EDR telemetry — NOT network config or
  firewall rules) and *how* (call signature; start with `GET /v1/computers` to
  find connector_guid, then act).

## MCP Registration

On `secure_endpoint_save_config`: write config row, then call
`enable_secure_endpoint_mcp_server` which upserts an `mcp_servers` row with
`id='secure-endpoint-mcp'`, `name='Cisco Secure Endpoint'`, `transport='stdio'`,
`command_json` = python + `secure_endpoint_mcp.py` path, `env_json` = the
`SECURE_ENDPOINT_*` vars, `enabled=1`. Identical to `enable_ise_mcp_server`.

## Testing

- Python: unit tests for region→host resolution, blast-radius classification,
  envelope/paging passthrough, and `v1_basic` auth header construction. Mock
  `requests` (no live calls in CI).
- `test_connection` returns structured `{ok, message}` matching ISE.
- v3 path: minimal smoke test of token-exchange URL construction only (no live
  hardware); explicitly marked unverified.

## Out of Scope / Deferred

- Live verification of v3 OAuth against real XDR tenant.
- Webhook/streaming event ingestion.
- Vault envelope storage (credentials stored plaintext in DB, matching ISE/FMC).
```


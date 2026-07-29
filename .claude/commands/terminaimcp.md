---
description: Generate a complete vendor MCP integration (sidecar client + MCP server + bundled agent + Settings tab + Rust commands) from an API doc URL, wired into network-architect
argument-hint: <api-doc-url> [vendor_id="foo"] [display="Foo"] [auth="oauth2|basic-token|bearer-jwt|basic-xauth|token-header"]
---

You are generating a new vendor integration for the CCIE Terminal, cloning the
**exact** pattern used by the existing single-tool integrations (Cisco XDR, ISE,
Stealthwatch, Secure Endpoint, CML, Catalyst Center). Every one of these follows
one house pattern: a single `<vendor>_api_call(method, path, body, query_params)`
helper, path-prefix host routing where relevant, a `{status_code, data, error,
blast_radius}` envelope, credentials in `sessions.db` (NOT the encrypted vault),
and auto-discovery by the network-architect orchestrator.

Input (API documentation URL + optional hints): **$ARGUMENTS**

Follow these phases. Do NOT skip the two approval gates.

---

## Phase 0 — Reference the canonical template

Before doing anything, read the cisco-xdr integration as the gold-standard
template. Every file you generate is a vendor-substituted clone of these:

- `sidecar/src/ccie_sidecar/cisco_xdr.py` — Client + `install_<vendor>` + `test_connection` + `<VENDOR>_CAPABILITIES_DOC`
- `sidecar/src/ccie_sidecar/cisco_xdr_config.py` — `get_<vendor>_config()` (reads sessions.db, env fallback)
- `sidecar/src/ccie_sidecar/mcp_servers/cisco_xdr_mcp.py` — JSON-RPC MCP server
- `bundled-agents/cisco-xdr/AGENT.md` + `bundled-agents/cisco-xdr/tools.json`
- `src-tauri/migrations/V0067__cisco_xdr_config.sql`
- Rust block in `src-tauri/src/commands/mod.rs` (search `Cisco XDR Configuration`)

Also read these to know exactly where to insert edits:
- `sidecar/src/ccie_sidecar/server.py` (search `cisco_xdr.test_connection`)
- `sidecar/src/ccie_sidecar/agents/react_code.py` — the `_build_client_section` branch (search `cli_package == "cisco_xdr"`). NOTE: this file holds ONLY the client-section text.
- `sidecar/src/ccie_sidecar/agents/code_exec.py` — the install DISPATCH (search `install_cisco_xdr`). `_build_sandbox_globals` lives HERE, not in react_code.py. This is a known trap — the two edits are in DIFFERENT files.
- `sidecar/src/ccie_sidecar/agents/sandbox_index.py` (search `cli_package == "cisco_xdr"`) — the deepagents/heartbeat discovery-hint path. A SECOND client-hint site; the architect + heartbeat use it, so keep it in sync with react_code.py.
- `sidecar/src/ccie_sidecar/agents/architect_subagents.py` (search `VENDOR_SPECS` AND `_cfg`)
- `src-tauri/src/lib.rs` (search `cisco_xdr_get_config`)
- `src/windows/Settings.tsx` (search `cisco_xdr`)
- `src/lib/tauri.ts` (search `CiscoXdrConfig`)
- `src/components/AgentPanel.tsx` (search `PREPACKAGED_AGENT_IDS`) — the dropdown "Prepackaged" vs "User Agents" split.
- `bundled-agents/network-architect/AGENT.md` (description + "HOW YOU WORK" platform list + routing matrix — THREE places)

## Phase 1 — Fetch & analyze the doc

WebFetch the URL. Extract and note:
- **Base host(s)** and any regional scheme (single host, or path-prefix→host families like XDR).
- **Auth model** — map to the closest existing client:
  - `basic-token` — POST credentials → session token header (ISE pattern)
  - `oauth2` — OAuth2 client_credentials → Bearer, re-mint on 401 (Cisco XDR pattern)
  - `bearer-jwt` — username/password → JWT Bearer, re-auth on 401 (CML pattern)
  - `basic-xauth` — Basic auth → `X-Auth-Token` header, multiple API bases (Catalyst Center pattern)
  - `token-header` — STATIC API token sent verbatim on every request, no login
    exchange, no re-auth (Juniper Mist: `Authorization: Token <api_token>`). The
    simplest client — no `_ensure_bearer`, just a `_headers()` that sets the token.
- **Credential field names** (e.g. client_id/client_password, username/password, api_token/api_key).
- **A catalog of the most useful endpoints** (verb + path + one-line purpose). This becomes `<VENDOR>_CAPABILITIES_DOC`.

**GROUND THE CATALOG IN AN AUTHORITATIVE SPEC — do NOT write it from general
knowledge.** Marketing/overview doc pages are often JS-rendered and thin. Find
the machine-readable source and read the ACTUAL query params/enums/defaults:
- Look for an OpenAPI/Swagger spec, or a maintained SDK (e.g. a `*_python`
  client on GitHub) whose function signatures encode every param + default.
- For EACH endpoint you document, capture the silent-default TRAPS that cause an
  agent to under-report and confidently give a wrong answer. These bit us hard:
  - **Pagination:** does the list endpoint default to a `limit` (e.g. 100) and a
    `page`? If so, DOCUMENT IT and tell the agent "if a page returns exactly the
    limit, there is probably more — raise limit or page through."
  - **Type/status filters with a HIDING default:** e.g. an inventory endpoint that
    defaults to one device type and silently omits the rest. Document the exact
    enum values, and NEVER invent one (a made-up `type=all` is a real bug we
    shipped — verify enums against the spec).
  - **config vs live-stats split:** which endpoint returns claimed/assigned
    objects (incl. disconnected) vs live telemetry (only connected)? State it.
- If you cannot find an authoritative spec, SAY SO in the approval spec and mark
  the catalog "best-effort, unverified" rather than implying certainty.

## Phase 2 — Interview (only the unknowns) + approval gate

Determine from `$ARGUMENTS` hints first; ask ONLY what's missing:
1. **vendor_id** — snake_case (e.g. `secure_endpoint`). This is the single source
   of truth: it's the `cli_package` dispatch key, the config table name, the env
   var prefix, and the `attached-tools[].id`. Dir name for `bundled-agents/` uses
   hyphens (`secure-endpoint`); everything in Python/Rust/SQL uses underscores.
   **This underscore↔hyphen rule is a known footgun — get it right.**
2. **display** — human name for the Settings tab + agent description.
3. **auth model** + credential fields (confirm your inference from Phase 1).
4. **host/region scheme**.
5. **Next free migration number.** Run:
   `ls src-tauri/migrations/ | sort | tail -3`
   and use the next `V00XX`.

**Idempotency guard:** if `sidecar/src/ccie_sidecar/<vendor_id>_config.py` already
exists, STOP and tell the user the integration already exists — do not clobber.

Present a compact integration spec (vendor_id, display, auth model, credential
fields, host scheme, migration number, endpoint catalog summary) and **wait for
the user to approve** before writing files.

## Phase 3 — Generate all touchpoints

Create/edit these, substituting the vendor everywhere. Match the template's
docstrings, error strings, and comment style — this codebase is consistent on
purpose.

**New files (sidecar):**
1. `sidecar/src/ccie_sidecar/<vendor_id>.py`
   - `<Vendor>Client` class with `call()` returning the standard envelope, auth
     matching the chosen model, re-auth-on-401 where applicable.
   - `<VENDOR_ID_UPPER>_CAPABILITIES_DOC` string — the single source of truth for
     the endpoint catalog, consumed by BOTH the MCP tool description AND
     `react_code._build_client_section`, so they can never drift.
   - `install_<vendor_id>(globals_dict, emit=None)` — binds `<vendor_id>_api_call`
     into the sandbox globals + registers a `<vendor_id>_api` module in sys.modules.
   - `test_connection(config)` → `{ok, message}`.
   - `_blast_radius(method, path)` — GET=low, DELETE=destructive, else medium.
2. `sidecar/src/ccie_sidecar/<vendor_id>_config.py`
   - `get_<vendor_id>_config()` — reads `sessions.db.<vendor_id>_config` (id=1),
     falls back to `<VENDOR_ID_UPPER>_*` env vars. Copy the `_db_path()` helper verbatim.
3. `sidecar/src/ccie_sidecar/mcp_servers/<vendor_id>_mcp.py`
   - JSON-RPC MCP server exposing the single `<vendor_id>_api_call` tool; imports
     `<Vendor>Client` + `CAPABILITIES_DOC` from the shared module so it can't drift.

**Sidecar edits:**
4. `server.py` — add `elif method == "<vendor_id>.test_connection":` branch.
5. `agents/react_code.py` — add `if cli_package == "<vendor_id>":` branch in
   `_build_client_section` (import the CAPABILITIES_DOC). This is the client-section
   TEXT ONLY.
6. `agents/code_exec.py` — add `if cli_package == "<vendor_id>":` in
   `_build_sandbox_globals` that calls `install_<vendor_id>(globals_dict, emit=emit)`.
   **This is a SEPARATE file from step 5 — the install dispatch is NOT in
   react_code.py. Missing this = the helper never binds and the agent "calls into
   the void."**
7. `agents/sandbox_index.py` — add a `if cli_package == "<vendor_id>":` discovery
   hint (the deepagents/heartbeat path uses this instead of react_code's section).
   Keep it consistent with step 5.
8. `agents/architect_subagents.py` — TWO edits:
   (a) add a `VENDOR_SPECS` entry:
   `{"id": "<vendor_id>", "display": "...", "when": "...", "configured": lambda: _cfg("ccie_sidecar.<vendor_id>_config", "get_<vendor_id>_config")}`.
   (b) **CHECK `_cfg`'s credential-key allow-list.** `_cfg` returns True only if the
   config dict has one of a hardcoded set of keys (host/token/client_id/api_token/
   api_key). If your vendor's credential key is NOT already in that `bool(cfg.get(...))`
   list, ADD IT — otherwise network-architect sees the vendor as "not configured"
   even when it is, and refuses to bind the helper. (This exact bug hid Mist's
   `api_token`.)
   Together these are all network-architect needs — it auto-discovers any
   configured vendor and binds the helper inline.

**Bundled agent (dir name: hyphens only if multi-word, e.g. `secure-endpoint`;
single-word ids like `mist` are the same in both places):**
9. `bundled-agents/<vendor-dir>/AGENT.md` — frontmatter (name, description,
   system-prompt, `execution-mode: react-code`, `engine: deepagents`,
   `attached-tools` with `id: <vendor_id>` [underscore!] and `catalog: tools.json`)
   + a short body. **`engine: deepagents` is REQUIRED — the default is `legacy`,
   and all prepackaged agents run on deepagents. Omitting it silently regresses
   the new agent to the legacy engine.**
   The system-prompt should carry the SAME silent-default warnings (pagination,
   hiding type/status defaults) you put in the CAPABILITIES_DOC.
10. `bundled-agents/<vendor-dir>/tools.json` — single tool entry describing
    `<vendor_id>_api_call` (method/path/body/query_params), embedding the endpoint
    catalog in the description. Keep it byte-consistent with CAPABILITIES_DOC.
11. Edit `bundled-agents/network-architect/AGENT.md` — add the vendor in THREE
    places: the frontmatter `description` platform list, the "HOW YOU WORK"
    pre-bound platform list, AND the routing matrix (`-> <vendor_id>-specialist`).

**Migration:**
12. `src-tauri/migrations/V00XX__<vendor_id>_config.sql` — singleton `id=1` table
    with the credential columns + `verify_ssl INTEGER DEFAULT 1`, plus the unique
    singleton index. Copy the XDR migration shape.

**Rust:**
13. `src-tauri/src/commands/mod.rs` — add a `<Vendor>Config` struct
    (`#[serde(rename_all = "camelCase")]`), `<vendor_id>_get_config`,
    `enable_<vendor_id>_mcp_server` (registers the MCP server row with env creds),
    `<vendor_id>_save_config`, `<Vendor>TestResult`, `<vendor_id>_test_connection`.
    Register the MCP server id as `<vendor-dir>-mcp` and name as the display string.
14. `src-tauri/src/lib.rs` — add the three commands to the `invoke_handler!` list.

**Frontend:**
15. `src/components/settings/<Vendor>SettingsTab.tsx` — clone
    `CiscoXdrSettingsTab.tsx`; reuse `./IseSettingsTab.css` (do NOT create a new CSS
    file unless the fields differ materially). Wire the credential fields.
16. `src/lib/tauri.ts` — add `<Vendor>Config` type, `<Vendor>TestResult` type, and
    the three `invoke` wrappers (`<vendorCamel>GetConfig/SaveConfig/TestConnection`).
17. `src/windows/Settings.tsx` — import the tab, add `"<vendor_id>"` to the
    `activeTab` union type, add the sidebar button, and add the
    `{activeTab === "<vendor_id>" && <...Tab />}` panel.
18. `src/components/AgentPanel.tsx` — add the bundled agent's DIR id (e.g. `mist`,
    `secure-endpoint`) to the `PREPACKAGED_AGENT_IDS` set. Miss this and the agent
    shows under "User Agents" instead of "Prepackaged" in the dropdown.

## Phase 4 — Verify (do not claim done without proof)

Per the project's verify-before-claiming-done rule. Import checks are NOT enough —
we shipped bugs that passed imports but crashed at runtime (`sys.exit` killing the
sidecar) or silently mis-detected config (`_cfg`). DRIVE THE REAL PATHS:

1. `cd src-tauri && cargo build` — must compile clean. Fix errors.
2. Python import sanity: `python -c "from ccie_sidecar.<vendor_id> import <Vendor>Client, install_<vendor_id>, test_connection, <VENDOR_ID_UPPER>_CAPABILITIES_DOC"`.
3. **Sandbox bind check:** `_build_sandbox_globals("<vendor_id>", {}, emit=...)` must
   contain `<vendor_id>_api_call`. If not, step 6 (install dispatch) is wrong.
4. **network-architect discovery check:** with a config row present (or a dummy
   one), `configured_vendor_ids()` MUST include `<vendor_id>`, and the merged
   architect sandbox MUST bind `<vendor_id>_api_call`. If it doesn't, the `_cfg`
   credential-key allow-list is missing your key (Phase 3 step 8b).
5. **Client-section check:** `_build_client_section("<vendor_id>", ...)` returns text
   containing `<vendor_id>_api_call` and the display name.
6. `client-section`/tools.json/CAPABILITIES_DOC agree (no drift). `json.load` tools.json.
7. TypeScript: `Settings.tsx` / `tauri.ts` typecheck (`bun run tsc --noEmit`) — filter
   for YOUR files; the repo has pre-existing unrelated TS errors in tests.
8. If you have a real/dummy token, exercise the exact code an agent would run
   through `_execute_code_with_timeout` (self → list) and confirm the PROCESS
   SURVIVES and returns a normal result (not a crash). Do NOT write a dummy token
   over an existing real one — read first, insert only if absent.

Report results honestly. If something can't be verified without live credentials
or an app restart, say so explicitly and list exactly what the user must do:
apply the migration (auto-applies on next app launch), rebuild, restart the app,
then enter credentials in **Settings → <display>** and click **Test Connection**.
Note that the sidecar loads Python at agent-build time, so prompt/logic changes
require a sidecar RESTART to take effect.

## Output

End with a concise summary: the vendor_id, migration number used (and next free
one), every file created/edited, verification results, and the manual steps left
(credentials + restart). Note that network-architect will pick the vendor up
automatically once credentials are saved — no further wiring needed.

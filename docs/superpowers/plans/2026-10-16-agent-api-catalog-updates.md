# Agent API Catalog Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, or superpowers:subagent-driven-development if explicitly selected, to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a proposal, not approval to implement or commit.

**Goal:** Put a separate **Update APIs** button inside **each product page under Settings → Cisco**. Clicking it fetches and extends **only that product's** API catalog; it never starts a global or cross-product update.

**Architecture:** One Python `ApiCatalogUpdater` fetches official API reference material, extracts endpoint data, validates it and adds records to the effective installed catalog. Existing `CatalogIndex` discovery and generic HTTP callers consume those additions. One shared Settings control uses the existing Tauri/sidecar bridge; there is no new agent framework, per-endpoint Python code, SDK installation or database.

**Tech Stack:** Existing Python 3.12+, requests, PyYAML, jsonschema, BeautifulSoup/lxml and saved-provider LangChain factory; standard-library threading, hashing and atomic file replacement; React/TypeScript, Tauri/Rust, pytest and Vitest.

**Spec:** The clarified conversation requirements, recorded below. There is no separate approved design document. Approval of this proposal is required before implementation.

**Complexity:** Medium. The UI is small; factual extraction, usable request schemas and preservation of catalog restrictions are the substantive work.

## Requirements

- Every product page under the **Cisco** heading in Settings has its own **Update APIs** button; not just ISE, Stealthwatch and Splunk.
- A click fetches published information for that selected product and adds operations only to that product's existing scope. It must not fetch, change or start update jobs for other products.
- No global Update APIs button, cross-product refresh, or automatic update of all Cisco products is included.
- This is not an application update, RAG-only refresh or a replacement tool architecture.
- Support structured specifications and published reference documents; downloadable OpenAPI is not a user prerequisite.
- Preserve existing entries, user customizations, prompts, credentials, restrictions and last-known-good catalog data.
- Refreshing documentation must not execute newly discovered vendor operations.
- Report additions, unsupported operations, incomplete coverage and failures honestly.

## Global Constraints

- “be surgical and minimalistic” and “ground ALL findings in fact based on graphify code base...do NOT guess”.
- “Always use object oriented programming”: use one updater class, not a new hierarchy/framework.
- Consult `Plans/Mistakes.MD` before execution; record new mistakes with issue, RCA and fix.
- Preserve unrelated changes, especially the existing `react.py` and ledger edits, `.playwright-mcp/` and `AGENTS.md`.
- No new dependencies or migrations are planned. No commit, push, release, live tenant call or security-setting change without separate authorization.
- Never replace bundled definitions, `AGENT.md`, saved connection data or user customizations to refresh coverage.
- Fetched documents and model responses are untrusted data, never executable code or privileged instructions.
- Context7 documentation tools were unavailable during discovery. Official vendor pages were inspected instead; do not claim Context7 research or universal source-format coverage.

## Verified Grounding / Patterns to Mirror

Graphify was refreshed on 2026-10-16: 45,487 nodes, 141,012 edges, 1,751 communities. It reported zero-node files, unsupported SQL extraction and missing node metadata. Use it for navigation, not a completeness guarantee. These findings were checked against source:

| Concern | Source | Consequence |
|---|---|---|
| Original tool model | `bundled-agents/{ise,stealthwatch,splunk}/tools.json` | Each has one generic caller with curated endpoint documentation. No original automated spec-generation pipeline was found for these three. |
| Generic HTTP | `sidecar/src/ccie_sidecar/ise.py:140` | `IseClient.call(method, path, body, query_params, base)` transports compatible new paths without implementing individual methods. |
| Endpoint records | `sidecar/src/ccie_sidecar/agents/catalog_grounding.py:286` | Explicit endpoint records and older prose catalogs already coexist. |
| Input detail | `sidecar/src/ccie_sidecar/agents/catalog_grounding.py:203` | Current parameter summaries discard nested schemas and descriptions; paths alone do not enable correct new calls. |
| Permission checks | `sidecar/src/ccie_sidecar/agents/catalog_grounding.py:670` | Calls need discovered matching records. Imported records must not override forbidden matches. |
| Effective loading | `sidecar/src/ccie_sidecar/agents/catalog_grounding.py:1019` | User catalogs take precedence, Architect aggregates them, and explicit/inlined catalogs may override disk fallback. |
| No overlay merge | `sidecar/src/ccie_sidecar/agents/catalog_grounding.py:85` | Same-ID catalogs are deduplicated, not merged. Do not invent a same-ID overlay. |
| Installed data | `src-tauri/src/agents/loader.rs:223` | Bundled initialization preserves existing installed copies. Changing bundled JSON alone cannot implement runtime refresh. |
| Atomic pattern | `src-tauri/src/agents/loader.rs:174` | Mirror temporary-file-plus-rename, adding conflict/backup checks. |
| Existing spec import | `src-tauri/src/api_runner/openapi.rs:27` | API-runner output omits body schemas and some references; leave that separate feature unchanged. |
| Model factory | `sidecar/src/ccie_sidecar/providers/langchain_factory.py:55`; `agents/iac_codegen_tools.py:106` | Reuse saved provider configuration and `build_chat_model`; mirror injected-callable tests, not an IaC dependency. |
| Serial sidecar | `sidecar/src/ccie_sidecar/server.py:1688` | Slow refresh work needs a worker thread; start/status RPCs remain short. No scheduling rewrite. |
| Errors / Settings | `src-tauri/src/commands/mod.rs:6577`; `src/components/settings/IseSettingsTab.tsx:37` | Mirror bridge `Result<_, String>` and caught inline status. Never print worker diagnostics to NDJSON stdout. |
| Tests / packaging | `sidecar/tests/agents/test_catalog_grounding.py:36` | Reuse pytest `tmp_path`/monkeypatch and relocated Windows/macOS/Linux cases. |

## Product Scope — User Clarification

The user's clarification is authoritative: **a separate Update APIs button on each product page under Settings → Cisco, updating only that product**. Shared backend/component code is an implementation detail, not a shared update action. Non-Cisco groups are outside this delivery.

Verified in this checkout, `src/windows/Settings.tsx:540–556` currently uses a mixed **Network Platforms** group. During implementation, place its existing Cisco product entries under a **Cisco** heading; retain pyATS, Topolograph, Proxmox, generic gNMI and Juniper Mist outside that subsection. Do not rename the entire mixed group or invent new product pages. The source-verified page-to-catalog mapping is:

| Cisco product page | Sole update target |
|---|---|
| Stealthwatch | `stealthwatch` |
| ISE | `ise` |
| CML | `cml` |
| Catalyst Center | `catalyst_center` |
| Splunk | `splunk` |
| ACI | `aci` |
| FMC | `fmc` |
| ThousandEyes | `thousandeyes` |
| Meraki | `meraki` |
| Secure Endpoint | `secure_endpoint` |
| Cisco XDR | `cisco_xdr` |

All eleven pages are required, not three examples with the remainder deferred. If the actual implementation checkout has a different Cisco group, reconcile its source-defined membership before editing; do not assume this mapping proves a newer/different build's UI. There is no separate Cisco Workflows Settings page in this checkout, so Meraki must not silently update the separate `cisco_workflows` catalog.

Implementation recommendations:
- Append to the selected product's effective installed catalog, retaining its envelope and existing entries; no database or second catalog store.
- Parse structured specs deterministically. Use the saved AI provider only when extracting human-readable reference material.
- Additions activate on **new agent runs**, including Architect consuming that product's catalog; other product catalogs remain untouched.
- Published coverage is not proof that an older installed product supports the operation. Retain documented version requirements and distinguish live verification.
- Verify source coverage for every scoped product. Do not silently omit a button because source extraction is harder; surface a specific failure. Any unsupported product is an explicit delivery gap requiring user agreement, not an implicit scope reduction.

A new authentication flow, unsupported content type or transport still requires integration code; catalog refresh cannot manufacture it. Non-HTTP integrations must not receive arbitrary HTTP records.

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `sidecar/src/ccie_sidecar/agents/api_catalog_update.py` | One updater class: collect, extract, validate, merge, publish; one background job at a time. |
| Create | `sidecar/src/ccie_sidecar/agents/api_catalog_sources.json` | Verified official source roots/origins and existing-client constraints, not endpoint enumeration. |
| Modify | `sidecar/src/ccie_sidecar/agents/catalog_grounding.py` | Retain imported provenance/input detail; extend existing bounded detail lookup; reuse target resolution. |
| Modify | `sidecar/src/ccie_sidecar/agents/deepagents_tools.py` | Shared discovery guidance for input detail only; preserve existing tool surface. |
| Modify | `sidecar/src/ccie_sidecar/server.py` | Singleton updater and two start/status handlers. |
| Create | `src-tauri/src/commands/agent_catalog.rs` | Typed bridge forwarding, target validation and post-publication loader refresh. |
| Modify | `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src/lib/tauri.ts` | Declare/register commands and typed frontend wrappers. |
| Create | `src/components/settings/ApiCatalogUpdateControl.tsx` | Shared accessible button, polling, counts, warnings and errors; existing Settings styles. |
| Modify | `src/windows/Settings.tsx` | Separate the existing Cisco product entries from the mixed Network Platforms group under a Cisco heading; preserve routes and non-Cisco entries. |
| Modify | Existing Settings components for all eleven products in Product Scope | Mount one product-bound control per page with its sole mapped catalog ID. |
| Tests | `sidecar/tests/agents/test_api_catalog_update.py`, existing grounding/server tests; `src/components/settings/ApiCatalogUpdateControl.test.tsx`, existing vendor tests; Rust module tests | Full persistence-to-discovery and Settings journeys. |

No unrelated client refactor, API-runner importer change or `VENDOR_SPECS` reordering is planned.

## Contracts

### Source registry and additions

Registry entries are keyed by existing catalog ID and contain `roots`, `allowed_origins`, `path_prefixes`, `methods`, `body_content_types`. Populate them from verified documentation and actual client behavior. Roots follow published current-reference links, not a hardcoded historical version or shipped list of endpoints.

Keep old catalog records unchanged. Add explicit records with existing `name`, `description`, `endpoint.method`, `endpoint.path`, `args`, `required` fields plus:

- `api_update`: `source_url`, `source_sha256`, `retrieved_at` (UTC ISO 8601), optional `documented_version`, `source_pointer` (parsed reference or supporting text location).
- `api_details`: `parameters` (name, location, required status, schema), `request_body` (content type and schema), `components` (only reachable local schema definitions).

Identity: `(catalog_id, uppercase_method, canonical_path_template)`, independent of operation name and placeholder label. Preserve case-sensitive literal path segments and significant trailing slashes. Existing wildcard-method records and forbidden/template matches participate in conflict checks. Renaming an operation or `{id}` is not an addition.

Retain full validated inputs on disk. Preserve compact search defaults; extend existing `CatalogIndex.describe(name_or_path, catalog_id=None)` with optional keyword-only `method` and `schema_pointer`. It returns selected input detail in bounded pieces, with explicit truncation and local continuation pointers if needed. Pointers address validated retained data, never a URL. Keep current discovery/authorization behavior. No second discovery system or per-endpoint model tool.

### Jobs and bridge

`ApiCatalogUpdater.start(agent_id: str) -> dict` starts a bounded worker or returns the current same-agent job. A different vendor gets explicit busy status, not an invisible queue. `status(agent_id: str, job_id: str | None = None) -> dict` returns the latest same-agent result when no ID is supplied, otherwise that exact job or a clear unknown/expired error. No previous result returns `idle`. Keep the latest result per registered vendor in memory; no durable job framework.

RPCs: `agent.catalog_update_start`, `agent.catalog_update_status`.
Tauri commands: `agent_catalog_update_start`, `agent_catalog_update_status`.
TypeScript wrappers: `agentCatalogUpdateStart(agentId)`, `agentCatalogUpdateStatus(agentId, jobId?)`.

Result fields: `agent_id`, `catalog_id`, `job_id`, `state`, `phase`, `added`, `already_known`, `skipped`, `warnings`, `source_urls`, `checked_at`, `error`. States: `idle`, `running`, `completed`, `failed`, `busy`. `job_id` and `checked_at` may be null before a job exists. Running phases: `fetching`, `extracting`, `validating`, `saving`. Counts are operations, not tools/pages. Completion with coverage warnings is not universal API currency.

The frontend supplies only the selected product's mapped agent ID/job ID, never a URL, catalog path, credential, replacement content or `all`/wildcard target. Restrict the update API to the Product Scope mapping and derive its sole catalog through current frontmatter/loader rules; never iterate Architect's aggregate catalogs to perform an update. Reject traversal, symlink escape, mismatched product/catalog targets and attachments outside the managed user-agent root, leaving custom external targets untouched with an explanation.

**Isolation invariant:** a job may fetch only its selected product's approved references and write only its own catalog and updater-managed backup. No other product's catalog, source status, last-checked timestamp or job state changes. Architect subsequently using the selected product's additions is consumption, not an update of other products. Tests must snapshot every non-target catalog before the job and assert byte-for-byte equality afterward, for both success and failure.

## Review Focus

1. Fetched/model data attempts to change destination/authentication or override a prohibition → reject without expanding authority.
2. Repeated updates, renamed placeholders and customized catalogs → no duplicates or lost data.
3. Large/nested/referenced inputs → bounded access to enough schema to construct the actual call, not just find its path.
4. Source/model/write failure, deadline or concurrent edit → preserve the original on failed publication; never report false success.
5. Real Settings click followed by standalone/Architect consumption → cover actual loaders and bridge, not just isolated parser tests.

## Task 1: Prove the Catalog Extension Seam and Sources

**Files:** existing grounding/runtime tests, new updater tests and source registry.
**Consumes:** current clients/catalogs; **produces:** source-backed registry and executable integration expectations.

- [ ] Write failing fixture tests adding a synthetic explicit operation with nested input schema to copies of ISE, Stealthwatch and Splunk catalogs. Assert original callers remain bound and standalone/Architect loaders see the addition. Cover explicit/inlined precedence and saved legacy execution modes so mixed endpoint records are never incorrectly passed as function-tool definitions.
- [ ] Run cases, retain actual failures and separate preexisting issues. Do not overwrite the user's `react.py` changes.
- [ ] Verify official current-reference/specification roots for each product in Product Scope; record product-specific allowed origins and actual client path/base/method/content-type limits. Keep representative sanitized fixtures for every scoped product. Do not expand the registry to unrelated HTTP integrations, invent direct spec URLs or arbitrary web-search adapters, or leave a scoped product's source as a TODO.
- [ ] Starting evidence: `https://developer.cisco.com/docs/identity-services-engine/v1/`, `https://developer.cisco.com/docs/stealthwatch/enterprise/`, and Splunk's official REST reference. Previously inspected Splunk 9.3 is historical evidence, not the chosen latest version. Resolve current links. Login pages, empty client-rendered pages and unavailable specs are failures/incomplete coverage, never empty catalogs.
- [ ] Implement only shared projection/loading changes demonstrated necessary by these tests; preserve tool definitions for modes needing them while exposing endpoint additions through existing catalog paths.
- [ ] Verify all fixture journeys pass and each enabled source has evidence. Record unsupported sources honestly rather than silently omitting requested vendors.

## Task 2: Fetch and Extract Published API Data

**Files:** updater, registry and updater tests.
**Interface:** constructor-injected fetch/model callables; internal `collect_candidates(agent_id: str) -> dict` returns candidates, provenance and coverage warnings without writing.

- [ ] Write failing tests for JSON/YAML specs, local references, HTML reference/nested required inputs, missing model, unavailable/wrong-product/login content, malformed responses, prompt injection and off-origin redirects.
- [ ] Implement HTTPS fetch with normal TLS verification; follow only approved official reference/specification links and revalidate redirects. Reject credential-bearing URLs and private/link-local/loopback destinations. Never attach vendor credentials or inherit netrc authentication. Preserve normal proxy/CA support. Spec `servers` values cannot change caller destinations.
- [ ] Fixed proposed bounds: 30 seconds per fetch, 256 documents, 64 MiB decoded source data, 600-second job deadline, 20 model extraction calls. Enforce the deadline at network/model boundaries; expired work must never publish later. Reaching limits produces explicit incomplete-coverage warnings, not silently truncated success. Bound schema traversal and discovery output too.
- [ ] Parse structured specs deterministically with existing JSON/PyYAML support. Resolve bounded local/approved fetched references; reject unsafe/cyclic references. Do not invoke a model for machine-readable operations/schemas.
- [ ] Extract reference text with existing dependencies and `rag.extract.extract_text` where applicable. For human-readable documents only, use saved `get_saved_config()` plus `build_chat_model()` and injected-callable tests. Bound chunks; extract a closed data contract. Give no execution tools, vendor credentials, agent prompt or filesystem write capability to the extraction model.
- [ ] Require supporting method/path evidence and input-schema evidence in fetched material. Reject unsupported fields/fabricated URLs; JSON-schema validity alone does not establish factual accuracy. Do not claim prose extraction has deterministic-spec accuracy.
- [ ] Retain downloads only in bounded memory or fresh isolated temporary directories, never execute them or change into them. Standalone Python probes reading downloads use `-I`.
- [ ] Run extraction tests: all pass with mocked fetch/model and zero vendor execution calls. Partial scans retain explicit warnings.

## Task 3: Validate, Add and Persist Without Losing Data

**Files:** updater, grounding, updater/grounding tests.
**Consumes:** candidates/effective target; **produces:** validated publication and exact counts.

- [ ] Write failing tests for repeats, renamed operations/placeholders, wildcard methods, deny/allow collisions, invalid paths/methods, unsupported auth/content types, list/object envelopes, custom entries, write failures, changed hashes and escaped targets.
- [ ] Validate candidates with installed jsonschema and the current-client constraints. Reject absolute/wildcard/ambiguous paths, new authentication/transport instructions, unsupported payloads and arbitrary tools/code/prompts/policies. Existing explicitly supported base routes remain usable.
- [ ] Reuse `CatalogIndex` record extraction/template matching rather than a parallel parser. Skip already covered operations. Never append a positive record overlapping an existing forbidden match; add a focused shared guard fix only if tests demonstrate a bypass. No deletion, deprecation cleanup or existing-endpoint rewrite.
- [ ] Retain full `api_details` and provenance; implement the bounded existing-`describe` extension, exact method selection and local schema pointers. Test required fields beyond the first bounded response remain retrievable. Change shared discovery guidance only where necessary.
- [ ] Validate the prospective effective catalog. Hold the updater publication lock, re-read the attachment/target hash and abort on detected concurrent edits. Do not claim this hash check is universal filesystem compare-and-swap against noncooperating editors.
- [ ] Preserve the envelope and every old entry. Keep one updater-managed last-known-good backup; write backup/new data via same-directory temporary files, flush and atomically replace using Windows/POSIX-safe standard-library semantics. A pre-publication failure leaves the original unchanged. Never overwrite an unrelated backup-path occupant; clean only updater-owned temporary files.
- [ ] Run tests: repeat adds zero, old/custom data survives, forbidden calls remain blocked after discovery, failure leaves a readable original and a fresh effective loader sees additions.

## Task 4: Wire Background Jobs and Bridge

**Files:** updater, server, Rust command/declaration/registration, TypeScript wrappers; server/Rust tests.
**Consumes/produces:** Contracts above.

- [ ] Write failing tests for invalid IDs, derived catalog IDs, start/status transitions, same-agent duplicate starts, other-agent busy, expired IDs, missing targets, worker exceptions and status while extraction deliberately waits.
- [ ] Use one daemon worker and a job-state lock; never hold that lock across fetch/model work. This prevents the updater itself blocking the serial request loop, not existing long agent turns occupying it.
- [ ] Add/ register the two short RPC/command wrappers with current error patterns. Log only sanitized phase/count/error information, never config/prompts/credentials and never worker progress to NDJSON stdout.
- [ ] Validate effective target server-side. After atomic publication, refresh application-side metadata with the existing loader and ensure next-run explicit/inlined catalog construction reads updated data. Report reload failure separately; do not pretend disk publication was rolled back.
- [ ] Verify actual registration/dispatch and fresh standalone/Architect direct/delegated consumption, including legacy/inlined regressions. Keep an existing index unchanged and prove a newly created one sees the addition.
- [ ] Run focused Python/Rust tests and bridge type checking: fast status during worker waits, correct errors and zero vendor endpoint execution during refresh.

## Task 5: Mount Shared Settings Control and Verify the Journey

**Files:** shared control/test, matching vendor Settings/tests, short user-guide update.
**Consumes:** bridge contracts; **produces:** reachable Settings behavior.

- [ ] Write failing component tests for start, running/disabled, counters/no changes, skipped/incomplete coverage, source/model/write failures, busy, unmount/remount and sidecar restart. Parameterize real mounts across all eleven Product Scope pages and assert the exact single product ID sent; no wildcard/global invocation or calls for other products.
- [ ] Mount one **Update APIs** button below each product's existing connection actions; leave Save/Test Connection unchanged. Use native buttons, accessible status regions and product-labelled results. Poll once per second only while that product's job runs; clean timers, avoid overlapping requests and stop on terminal/expired states. Reopening recovers only that product's job/result.
- [ ] In `src/windows/Settings.tsx`, place the source-verified Cisco product entries under **Cisco**, preserving existing tab IDs/routes and leaving non-Cisco entries outside. Add a group-to-control coverage assertion proving every Cisco product page has its own button. No global update button, shortcut or App overlay.
- [ ] Add backend isolation regressions for every scoped product: source requests belong to that product; all non-target catalog files remain byte-for-byte unchanged on success/failure; other product statuses remain unchanged. A shared publication worker is not permission to sweep all products.
- [ ] Completion example: `ISE: added 12 API operations. 48 already known; 3 skipped. Available to new agent runs.` Zero additions: `No new ISE operations found in the checked sources`, not `All Cisco APIs are up to date`. Show product-specific coverage warnings and unsupported reasons.
- [ ] Browser-test navigation through **Settings → Cisco → each product** on a running Vite app with mocked bridge. Check every button's exact target, layout, keyboard, progress/errors, switching pages without cross-product status leakage, and console output. Label mocked-browser evidence separately from native/live-device verification.
- [ ] With separate operator authorization, test a real public-document refresh, then fresh standalone and Architect discovery and one agreed read-only added operation on an appropriate product. No mutation merely to demonstrate coverage. Record unavailable native/live checks explicitly.
- [ ] Document location, model use/cost, new-run activation, errors/limits and managed backup. Refresh Graphify after changes and save durable verification evidence to the second brain.

## Verification Commands / Gates

Use existing frozen dependencies and discovered directories; no new installation is implied. Preserve RED evidence and label baseline/environment failures.

```bash
# From sidecar/: focused and full suites.
uv run --frozen python -m pytest tests/agents/test_api_catalog_update.py tests/agents/test_catalog_grounding.py tests/test_server.py -q
uv run --frozen python -m pytest -q

# From repository root: focused, full frontend, build.
bunx vitest run src/components/settings/ApiCatalogUpdateControl.test.tsx src/components/settings/IseSettingsTab.test.tsx src/components/settings/StealthwatchSettingsTab.test.tsx --exclude '**/.worktrees/**'
bun run test -- --exclude '**/.worktrees/**'
bun run build

# From src-tauri/: colocated new command tests, then compile.
cargo test agent_catalog
cargo check
```

Inventory changed filenames before execution. Add the Splunk mount test to an existing test file if present, otherwise use the shared integration suite. Native build prerequisites may block local Cargo verification: report that, not zero-tests success. Full Python/server checks are mandatory: the ledger records a vendor change breaking an unchanged downstream expectation.

## Acceptance

- [ ] Every product under **Settings → Cisco** has its own working **Update APIs** button; all eleven source-verified product pages are covered, not just ISE/Stealthwatch/Splunk.
- [ ] Each button updates only its mapped product. Every non-target catalog is byte-for-byte unchanged; other product jobs/statuses/timestamps are untouched. No global action is offered.
- [ ] A fetched addition persists and is discoverable with usable inputs by new standalone and Architect runs using existing callers.
- [ ] Repeat is idempotent; old/custom entries, restrictions and prompts survive.
- [ ] Source/model data cannot grant new destination/authentication/execution privilege or bypass approvals.
- [ ] Refresh makes no vendor execution calls; unsupported/incomplete coverage is visible.
- [ ] Failed/expired publication preserves the original; reload failure is distinguished from publication failure.
- [ ] Automated tests pass or exact baseline/environment failures are documented. Browser, native-app, public-source and real-device evidence are labeled separately.
- [ ] Implementation waits for plan approval; Git publication requires separate authorization.

## Deliberately Excluded

Global update-all scheduler, SDK/dependency upgrades, browser/crawler platform, per-endpoint code generation, new engines, live-turn hot reload, rewriting existing operations, new transport/authentication adapters and API-runner refactoring. Add only for a concrete separately approved requirement.

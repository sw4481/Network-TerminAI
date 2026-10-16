# Cisco Workflows — TDD evidence

Date: 2026-10-16. Status: implementation, local verification, targeted review and scoped graph refresh complete. Gate 2 approved by the user for a local feature commit, upstream-main integration, merge and normal push. Results below describe pre-integration verification; integration verification follows separately.

## Plan and acceptance

Gate 1: “yes go ahead with the plan - be methodical - surgical”. Source plan: Obsidian `wiki/sessions/2026-10-16/012626-cisco-workflows-minimal-integration-plan-awaiting-gate-1.md`, subsequently approved. The user explicitly requires complete runnable workflow construction and approved execution, not only listing or empty definitions.

Sources: [Cisco API usage](https://documentation.meraki.com/Platform_Management/Workflows/Workflows/API_Usage), [linked OAS 3.0.1 / API 1.0.0](https://documentation.meraki.com/@api/deki/files/36507/oas.json?revision=1).

User journeys:
1. Configure the existing Meraki key and explicit organization; select the prebundled agent.
2. Discover actual schemas, create a workflow with actions/inputs/dependencies or documented JSON import, inspect runtime inputs, approve a start, and inspect the returned execution instance/results.
3. Do the same through Network Architect directly or its delegated specialist.
4. Review exact mutation arguments and pinned organization, approve/deny using pointer or keyboard, and never resume another paused request or a changed organization.
5. Discover bundled assets in packaged installations without the source repository.

No new dependency, migration, credential store, designer, multipart-start support or polling service. Dashboard org remains optional; Workflows requires an explicitly saved org.

## RED → GREEN

| Slice | Executed RED | GREEN |
|---|---|---|
| Client | Exit 2, one collection ImportError for missing `ccie_sidecar.cisco_workflows`; zero tests executed. Checkout import provenance verified. This is missing-module evidence, not runtime RED. | 75 client + 15 existing adjacent tests = 90 pass, three worker runs and independent rerun. |
| Bundled catalog | 19 failed because assets were absent; then 19 passed. Adding native search brought it to 20. | Final 23 pass, three runs. |
| Authoring schemas | 2 failed, 18 passed: prompt/native search lacked referenced `schema_definitions`. | Same 20 pass after fix; later read cases bring total to 23. |
| Packaged discovery | Cargo exit 101, four E0599 errors: new tests referenced missing `initialize_bundled_agents_from`; zero tests ran. Intended compile-time RED. | 22 pass, one existing ignored; three worker runs and independent run. |
| Stream/org/keyboard | Review exposed missing real stream/UI handoff, org TOCTOU and modal focus management despite graph-only tests passing. Dedicated regressions added. | Pre-final-ID-repair Python snapshot: 257 pass, six skips. Final coordinator frontend: 2,322 pass. |
| Concurrent approvals / malformed preview / DELETE | Independent synthetic probes reproduced shared-default-ID request substitution, an orphaned incomplete approval, and DELETE understated as high. | Real two-turn regression denies B then approves only A; isolation/preview regressions pass three consecutive runs. Backend focused 121 pass, adjacent 126 pass/six skip; security and Python re-review report no outstanding findings. |

No checkpoint commits were created: the explicit Gate 2 overrides the generic TDD checkpoint recommendation. No staging/commit/push is authorized by Gate 1.

## Guarantees and test targets

| Guarantee | Test file | Type / result |
|---|---|---|
| Fixed HTTPS origin/org, explicit Bearer auth, TLS verification, netrc cannot override, environment proxy/CA retained | `sidecar/tests/test_cisco_workflows.py` | Mocked HTTP; 75 pass. |
| Read helper refuses writes; all six documented POST reads stay reads; arbitrary JSON/arrays preserved | Same client suite | Unit/mocked HTTP; included in 75. |
| No redirects/retries, 204 success, preserved HTTP errors and saved-key redaction | Same client suite | Unit/mocked HTTP; included in 75. |
| Native discovery returns real operation/request schemas and referenced definitions | `sidecar/tests/agents/test_cisco_workflows_catalog.py` | Integration; 23 pass. |
| Product-specific routing, explicit key+org gating, actual helper installation | `sidecar/tests/agents/test_architect_cisco_workflows.py` | Integration; included in combined snapshot. |
| Synthetic create → action authoring → JSON import → start → instance results | `sidecar/tests/agents/test_cisco_workflows_runtime.py::test_real_catalog_graph_builds_actions_imports_runs_and_inspects` | Real graph/mocked HTTP; passed, not live tenant proof. |
| Root/delegated real stream pauses before HTTP, retains exact args/org and resumes the correct turn after decision | `sidecar/tests/agents/test_cisco_workflows_runtime.py` | Graph/stream; pass, including two simultaneously paused standalone turns. |
| Org A → B while waiting blocks mutation before HTTP; denial/edit/multi-action fail closed | Same runtime suite | Verified; org repair independently checked by security review. |
| Prepackaged visibility and existing Meraki save semantics | `src/components/AgentPanel.test.tsx`, `src/components/settings/MerakiSettingsTab.test.tsx` | Component; pass. |
| Dedicated exact-arguments/org review; missing preview fails closed; DELETE tier displayed | `src/components/AgentPanel.test.tsx` | Component/IPC; pass. |
| Deny initial focus, Tab/Shift+Tab containment, Escape denial, stable focus after a later backend final event | `src/components/WorkflowsApprovalModal.test.tsx`, `src/components/AgentPanel.test.tsx` | Keyboard/component; 26 affected cases pass on three runs; final targeted React review clear and browser 10/10 on three runs. |

Focus RED cases reproduced body focus with a disabled opener and Stop becoming disabled Send. The first fallback passed component tests but failed real browser timing: cleanup restored still-enabled Stop before the later final event. Added sequential Deny → later final-event RED plus an enabled-opener/ignored-stable-target RED. The final fix always returns focus to the explicit stable AgentPanel chat toggle, so later Send/Stop changes cannot strand focus. No timer, observer or focus framework was added.

Packaged discovery guarantee: Unix/Windows roots, companion files, preserved customizations and dev precedence — `src-tauri/src/agents/loader.rs` native filesystem tests: **22 pass, one existing ignored**.

## Commands and results

Executed from the repository root with existing dependencies:

```sh
PYTHONPATH="$PWD/sidecar/src" ./sidecar/.venv/bin/python -m pytest -q \
  sidecar/tests/test_cisco_workflows.py sidecar/tests/test_meraki.py sidecar/tests/test_api_errors.py
# 90 passed; three final worker runs, independently verified.

./sidecar/.venv/bin/python -m pytest -q sidecar/tests/agents/test_cisco_workflows_catalog.py --tb=short
# 23 passed, three final worker runs.

cargo test --manifest-path src-tauri/Cargo.toml --lib agents::loader::tests --locked --offline
# Independent coordinator run: 22 passed; 1 pre-existing ignored; 612 filtered.

bun run test -- src/components/AgentPanel.test.tsx src/components/settings/MerakiSettingsTab.test.tsx --exclude '**/.worktrees/**'
# Initial coordinator slice: 13 passed, structural-color/theme-contrast guards pass.

bun run test -- --exclude '**/.worktrees/**'
bun run build:relaxed
# Final coordinator frontend: 2,322 passed in 306 files; build:relaxed passed.
# Nonfatal logs: existing jsdom navigation / Monaco sourcemap warnings,
# and Vite mixed-import / large-chunk warnings. No dependency changes made.

./node_modules/.bin/tsc --noEmit --project tsconfig.build.json
# Also exercised by successful build:relaxed (tsc followed by Vite).

bun run build
# Final stable-tier rerun: exit 2, 69 diagnostics across 27 source files.
# All 27 are verified unchanged from HEAD; no Workflows/AgentPanel diagnostic remains.
# An earlier mid-edit run's temporary required-tier errors were repaired, not dismissed.
```

Coordinator independently ran 12 focused/adjacent Python files under `env -i`, synthetic HOME/APPDATA/XDG_CONFIG_HOME, source PYTHONPATH and source-import assertions: **262 passed, six skipped, one LangChain beta warning** after final backend repairs. Includes four Workflows files, Meraki/API errors, DeepAgents stream/HITL, IaC interrupt/runtime, Architect routing and catalog grounding. Final log: `bnihzsy4t.output` in this session's temporary task directory. The earlier 257-pass run preceded the five final regression cases.

## Coverage and limits

Coordinator stdlib `trace`, positive executable lines only, rerun after final backend repairs:
- Client: **118/119 = 99.16%**, missing line 86.
- Mutation tool: **57/59 = 96.61%**, missing lines 41, 48.

Synthetic compiler line zero excluded. These are the two new Python modules' line coverage, not branch, overall repository or frontend coverage. No coverage dependency installed. The actual coverage invocation used `env -i PATH="$PATH" HOME="$CHECK_HOME" APPDATA="$CHECK_HOME/AppData/Roaming" XDG_CONFIG_HOME="$CHECK_HOME/.config" TMPDIR="${TMPDIR:-/tmp}" PYTHONPATH="$PWD/sidecar/src" ./sidecar/.venv/bin/python -`, where `CHECK_HOME` was a fresh `mktemp` directory. Its stdin harness wrapped `pytest.main(['-q', *tests])` in `trace.Trace(count=True, trace=False, ignoredirs=[sys.base_prefix, sys.prefix]).runfunc`, asserted each measured module originated inside this checkout's `sidecar/src`, and intersected observed lines with positive `trace._find_executable_linenos` results. The final JSON is `/tmp/ccie-workflows-verified.LbZLTs/new-module-line-coverage.json` (temporary artifact).

Actual Vite-served components in desktop Chrome, synthetic IPC, external requests blocked: initial setup passed three times, zero console errors, no horizontal overflow at 1280×800. Existing Settings clips at 390px; no unrelated responsive redesign. After the sequential-focus fix, **all ten approval scenarios passed on each of three final runs** (30/30), with zero console errors/external attempts. Actual paused synthetic backend POST/DELETE events drove exact org/argument and HIGH/DESTRUCTIVE review. Approve, deny, Escape, Tab trapping, missing/invalid preview rejection and existing IaC/Zabbix routing passed. The formerly failing late-final-event case now leaves focus on the enabled chat toggle even though Send is disabled. Coordinator read `run-final-2.json` and `run-final-3.json` and visually inspected POST/DELETE screenshots in `/private/tmp/cisco-workflows-approval-browser.T1yEA3/`. The task-owned Vite server was stopped; no source was edited by the browser worker.

**Trust boundary:** installed helper is read-only and supported mutation tool paths require operator review. Existing `execute_python_code` remains full-trust Python with host imports/access. This is not hostile-code containment or a guarantee against arbitrary Python making raw HTTP. General/security reviewers recognize that existing engine limitation; no fake importable security sentinel was added.

No live Cisco tenant was contacted, workflow created or started. Synthetic tests prove plumbing/payload preservation, not entitlements, live action compatibility or real execution. Packaged-path tests are not a fresh installed/native app smoke. No version bump/release. Gate 2 was subsequently approved for commit, integration and normal push.

## Final graph and handoff

The 20-file AST-only graph refresh was published and verified: **45,524 nodes / 140,625 edges**. All 20 source hashes matched before/after publication. Exact preservation checks cover 44,189 unrelated nodes, 137,113 unrelated edges, 560 semantic nodes/hyperedges/community metadata and 1,911 unrelated manifest rows. No full scan, semantic extraction, reclustering, pruning or forced shrink bypass. Existing label/analysis/report artifacts were preserved; they were not regenerated as a new visualization/report.

Provenance and original backups: `graphify-out/scoped-refresh-2026-10-16-cisco-workflows/provenance.json` and `before/`. Raw normalization warnings are retained: 113 unresolved endpoints, 197 exact duplicate edges, 480 undirected endpoint collapses and 1,120 pre-existing missing-field issues. Export has zero dangling endpoints and four existing self-loops; this is not a claim of lossless raw extraction.

At pre-integration acceptance, protected `react.py` and `AGENTS.md` hashes matched their starting values; prior ledger edits remained preserved. Whitespace checks passed, the index was empty in the original local feature checkout. The user subsequently authorized `feat(agents): add Cisco Workflows authoring and approved execution`, updating main with upstream PRs, merging the feature and a normal push. Pre-existing user changes and unrelated ledger hunks remain excluded.

## Public-main integration — 2026-10-16

The original feature was committed locally before integration. Public base: `97f91a9fa4c953c05573c13d71f1d02e0e0042f4` (PRs #10 and #11). These histories have no common ancestor. Original branches were backed up; main was re-anchored without replaying private history because its settings-only change is already subsumed publicly. Only 24 feature source/test/evidence paths were replayed. The private ledger, unrelated user edits and separate unmerged release commits remain local.

After a rejected dependency-reuse attempt (no tests executed), `bun install --frozen-lockfile` installed the public dependencies. Actual frontend verification passed **2,339 tests / 308 files**, `bun run build:relaxed` and `bun run build`. Public build scripts both use the production tsconfig; the private strict-build failure above is historical, not a failed public build. Existing nonfatal sourcemap/navigation/chunk warnings remain.

Integrated Python RED: **271 collected; 260 passed, five failed, six skipped**. HTTP catalog matches publicly expose helper/path, not the private baseline's name field; schema enrichment required a compatibility adaptation despite a conflict-free patch application. RED log: `/private/tmp/terminai-workflows-verify.J5bYkY/python-verification.log`. Six skips require the optional Meraki SDK absent from the reused interpreter. The minimal repair matches schema-bearing HTTP records by helper/method/path while leaving non-HTTP and schema-less matches unchanged; the public catalog API is unchanged. Independent GREEN verification collected **272 cases: 266 passed, six unchanged skips, one beta warning**. JUnit case identities prove all 271 RED cases remain plus exactly one new regression; all five previous failures pass. Fresh env-i configuration, no private editable-source fallback, 96 integrated-sidecar module origins, 206 unchanged source/test hashes and zero network attempts were verified. GREEN log: `/private/tmp/terminai-workflows-green.Ue7l4S/python-verification.log`; original RED evidence remains unchanged. Targeted Python review found no findings and independently passed the 31 repaired-file tests.

The two Rust conflict resolutions preserve public `initialize_bundled_agents_from(&Path)` and `should_use_bundled_python()` and add packaged discovery through a separate private helper. Actual loader verification passed **23 tests, one pre-existing ignored**; the public debug-Python regression passed **one test**; upstream `issue_5_test` passed **both fake-executor pager tests**. Changed-file rustfmt and whitespace checks passed; targeted Rust re-review found no verified finding. A separate initial Rust attempt lacked cmake in its isolated PATH and executed zero tests; only the successful established-environment runs count here. No fresh installed/native app smoke was performed.

Public-checkout browser verification passed **ten approval scenarios on each of two runs (20/20)**, including actual integrated-sidecar synthetic POST/DELETE events, exact arguments/org, DESTRUCTIVE display, malformed-preview rejection, existing IaC/Zabbix routing and late-final-event focus. Every scenario recorded zero console errors, external attempts and non-public filesystem requests. Coordinator parsed both logs and verified all five source fingerprints. The first wrapper failed after the scenarios because zsh reserves `status`; the corrected `run_code` wrapper completed the identical rerun successfully. Logs/screenshots: `/private/tmp/cisco-workflows-approval-browser.T1yEA3/public-integration-20261016/`. The task-owned Vite listener was stopped.

The full graph counts above describe the original local checkout, not a full public-repository extraction. A separate public-integration AST snapshot extracted exactly **20 changed code files**, producing **1,448 nodes / 3,608 exported edges**, with all 20 source hashes verified. Provenance/query evidence is retained locally under `graphify-out/scoped-refresh-2026-10-16-cisco-workflows/public-integration/`; 12 original graph artifacts remain byte-identical. Raw warnings include 176 unresolved endpoints, 204 exact duplicates, 500 same-endpoint collapses and one self-loop; export has no dangling endpoints or self-loops. This scoped audit does not claim complete out-of-scope/dynamic contracts, full public graph coverage, semantic extraction or reclustering.

## Post-merge Python CI correction — 2026-10-16

Hosted run `38921769659` failed its Python job; all other jobs passed. Full frozen-lock local reproduction found one stale expectation: `test_architect_keyword_defaults_lists_all_vendors` omitted the newly registered `cisco_workflows` ID. The identical test passed on previous public main `97f91a9`. RED: **1 failed, 1,320 passed, 56 skipped**. The one-line correction adds the ID between `splunk` and `meraki`, preserving the explicit order assertion; no production code, dependency or CI workflow changes.

GREEN: isolated `uv sync --frozen --extra dev` succeeded; `uv run --frozen --extra dev pytest -v` passed **1,321 tests, 56 skipped, 59 warnings**. The focused regression also passed. Verification used uv 0.8.19, Python 3.12.0, fresh configuration paths and public-only source imports on macOS; hosted CI uses Ubuntu 22.04. Existing RED logs remain unchanged; GREEN log: `/private/tmp/terminai-ci-python-repro.maFAl6/pytest-green-full.log`. Static Python review found no issues; its separate unfrozen-environment test attempt could not collect because `google.genai` was absent and is not counted as verification. The completed failed run cannot be cancelled; publishing this correction triggers a fresh CI run against the corrected commit, not a retry of the old SHA.

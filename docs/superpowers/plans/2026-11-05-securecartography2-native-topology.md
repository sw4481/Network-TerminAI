# Native Topology and Discovery Integration Plan

**Date:** 2026-11-05  
**Historical planning status (subsequent authorizations and execution records below supersede this):** Phase 0/1 and Phase 2 implementation/local verification are recorded in §9–10. The subsequent instruction “go for next” authorized Phase 3; its offline import/JSON/Draw.io implementation and verification are recorded in §11. Phase 3 is not fully accepted: PNG, native WKWebView file/geometry checks, and compatible-editor acceptance remain open. Earlier native restart/device gates remain open. The subsequent instruction “go for next phase” authorizes Phase 4 implementation and synthetic/local verification. Phases 5–6, dependency installation, device access, native app restart, commit, push, and release remain unauthorized.  
**Goal:** Bring useful map-editing, interchange, and discovery capabilities demonstrated by SecureCartography2 into TerminAI's existing **Neighbors** workspace, without embedding the upstream application or replacing our renderer.

## 1. Confirmed direction and proposed defaults

### Confirmed by the user

- Include native map improvements, saved arrangements, neighborhood focus, clearer device/link presentation, SC2 JSON import, editable Draw.io export, and completion of existing device-opening actions.
- Include worthwhile discovery improvements where the source comparison establishes a capability gap. Discovery is **not automatically deferred** out of this plan.
- Independently author native functionality. Do not copy/bundle GPL-covered upstream implementation or its icon collection without explicit licensing clearance.
- Enhance **Neighbors**; retain **Topolograph** and **Spanning Tree** as separate views.
- Viewing, arranging, saving, importing, and exporting must work without SC2 installed/running and without a new external service.
- Finish the proposal without another interview round. Recommendations below are not additional user approvals.

### Proposed defaults

- Import into a **new named graph**, never silently merge into Global.
- Automatic command-block/raw-text ingestion remains Global-only. New manual collection explicitly selects its destination graph.
- Preserve current application-wide graph-selection semantics; independent graph selection in every topology tab is not added implicitly.
- Keep physical-neighbor observations separate from logical routing adjacency. Missing evidence remains unknown.
- First recursive release follows only unambiguously matched **saved SSH connections** in the operator-approved eligible set. Unsaved neighbors remain visible as **not dialed**. Arbitrary address crawling and credential probing are excluded.
- SNMP is a gated stage **inside this plan**, not an assumed existing capability or a dependency of offline map work.
- Export defaults to the complete currently filtered graph, including off-screen nodes, with an explicit full-graph alternative. It never silently exports only the viewport.
- Preserve supported imported inventory fields; do not silently ingest arbitrary large metadata, raw configuration, credential names, or unrelated full-device records.

## 2. Source-backed comparison

### Is their discovery better?

**It is materially richer in capabilities. It is not yet proven more accurate, faster, or more reliable on our devices.** This comparison concerns the Neighbors path, not every collection feature in the application.

| Capability | Existing Neighbors path | Inspected SC2 path | Decision |
|---|---|---|---|
| Targets | Selected saved SSH connections | Seeds followed breadth-first through neighbors | Add bounded native recursion, saved targets first |
| Scheduling | Frontend serial loop | Concurrent work within each depth, semaphore limit | Rust-owned bounded scheduling |
| Transport | SSH command output | SNMP-first with SSH fallback | Include a gated native SNMP stage |
| Outcomes | Errors can be logged while command returns success | Crawl/device progress and failure accounting | Fix our outcome contract before increasing scale |
| Identity | Source display name can differ from neighbor management-IP identity | Hostname/sysName/address alias registration and deduplication | Improve exact matching, without assuming globally stable identity |
| Routing | Existing parsers; automated collection sends CDP/LLDP only | Interface-address and established-peer enrichment | Add evidence-aware enrichment, not invented physical cables |
| Stop | No topology-run cancellation contract | Cancels pending async work; running SSH threads finish by timeout | Define stronger native cleanup semantics |

### Local evidence and consequences

| Source | Verified finding | Consequence |
|---|---|---|
| `src/state/topologyStore.ts:162-193` | Serial scans and hardcoded `cisco/iosxe` | Use saved vendor/platform; replace frontend orchestration |
| `src-tauri/src/commands/ssh.rs:20-37` | Connections already contain host/vendor/platform | Do not add another device inventory |
| `src-tauri/src/commands/topology.rs:239-305` | Sequential CDP/LLDP; execution/parser/ingest errors logged; final `Ok` | Explicit supported-empty, partial, failed, and completed outcomes |
| `src-tauri/src/topology/mod.rs:77-85` | Added counters mean processed rows | Do not call them newly discovered devices/links |
| `src-tauri/src/topology/ingest.rs:55-86` | Global-only ingestion | Add explicit-graph entry point; retain Global wrapper |
| `src-tauri/migrations/V0040__topology_graphs_and_neighbor_cache.sql:11-32` | Node key includes kind; edge endpoints do not; edge PK omits protocol | Resolve render identity and preserve protocol evidence |
| `src-tauri/src/topology/graph.rs:109-147` | Canonical reverse tuples; duplicate endpoints replace protocol | Retain port-pair canonicalization without overwriting CDP with LLDP |
| `src/components/topology/TopologyTab.tsx:61-112,236-262,406-416` | Node-based layout, no durable drag positions | Keep React Flow; add graph-scoped coordinates |
| `src/components/topology/TopologyTab.tsx:284-317` | Device-opening and PNG callbacks are stubs | Wire actual existing application services |
| `src/lib/topology.ts:203-234` | Saved-neighbor resolution exists | Reuse it and the unknown-neighbor save flow |
| `src/lib/export.ts:37-73` | Native text save already handles WKWebView | Reuse native dialog/fs, not browser download anchors alone |
| `package.json:36-38` | React Flow and html2canvas already installed | Prove installed capture behavior before adding packages |
| `sidecar/src/ccie_sidecar/agents/drawio_helper.py`, `src/state/diagramStore.ts` | Draw.io URL/event plumbing and saved diagrams exist | Do not duplicate them; topology-to-XML conversion is still missing |
| `src-tauri/src/fanout/executor.rs:96-124` | Native run handles/cancellation/semaphore pattern exists | Reuse the pattern, not the Fan-Out product/model |
| `sidecar/src/ccie_sidecar/server.py:1748-1760` | Persistent sidecar processes requests synchronously | Concurrent callers do not establish concurrent parsing |
| `sidecar/src/ccie_sidecar/stp_worker.py:263-362` | Independently terminable bounded STP processes | Isolation precedent, not a drop-in neighbor collector |
| `src-tauri/src/ssh_exec/mod.rs:128-142,174-203` | Host verification disabled; timeout lacks explicit child kill/reap | Broader discovery cannot assume trust/cleanup already solved |

### Pinned upstream evidence

Repository: `https://github.com/scottpeterman/securecartography2`  
Revision: `c676a294f92aed89981ca30135d4f0ba9a67dcc1`  
Local read-only checkout: `/tmp/securecartography2-review.o1buts/upstream`

- `sc2/scng/discovery/engine.py:1719-1753,1831-2003`: per-device deadline, BFS/concurrency, cancellation, accounting, deduplication.
- `sc2/ui/main_window.py:647-662`: UI forwards depth, exclusions, concurrency, timeout, DNS, jump/hosts, full collection, and routing options.
- `sc2/scng/discovery/engine.py:2445-2462,2549-2564`: map nodes contain `node_details`/`peers`; port-pair `connections` can have an aligned **`protocols` array**. Older maps can omit it. Never assume all imports are LLDP.
- `sc2/scng/discovery/engine.py:2378-2380`: active `has_reverse_claim` immediately returns `True`. Do not describe generated links as bidirectionally verified.
- `sc2/scng/discovery/routing.py:719-883`: address/interface association with ambiguity refusal; IPv4/shared-interface/multihop limitations.
- `sc2/scng/discovery/snmp/collectors/lldp.py:162-214`: LLDP local-port numbering differs from IF-MIB ifIndex.
- `sc2/ui/widgets/map_viewer_dialog.py:1397-1441`: saved layout is a separate positions/preferences sidecar, not guaranteed in map JSON.
- `sc2/ui/widgets/topology_viewer.html:668-727,858-949,1086-1260`: additive preview merge, placeholders/status, pair-level visual grouping, existing-library layout choices.
- `pyproject.toml:11-12`: GPL-3.0-only. Qt-independent code is not automatically exempt. Selected path is format interoperability and independent implementation.

No device run or benchmark was performed. README screenshots, synthetic scale examples, and static code do not establish measured superiority.

## 3. Architecture decision

| Approach | Trade-off | Verdict |
|---|---|---|
| Import/export only | Smallest change, leaves discovery and false-success gaps | Insufficient |
| Embed/bundle SC2 engine or viewer | Second application, credential/transport ownership, GPL and packaging burden | Reject |
| Staged native extension | Reuses renderer/storage/saved connections; adds only missing behavior | **Recommended** |

### Boundaries

- Keep existing React components and React Flow. No Cytoscape replacement, embedded Qt bridge, map server, or generic graph framework.
- Existing Rust topology modules own persistent graph data. New `src-tauri/src/topology/interchange.rs` provides a small `TopologyImporter` for authoritative bounded validation and transactional imports.
- New `src/lib/topologyExport.ts` provides a focused `TopologyExporter` for native JSON and editable Draw.io XML using normalized graph data and measured positions. Reuse existing save plumbing and native/browser XML facilities; do not copy upstream exporters.
- New `src-tauri/src/topology/discovery.rs` provides `TopologyDiscoveryService`, owning queue, run ID, caps, cancellation, and sanitized outcomes. Tauri commands are thin; frontend no longer drives one collection RPC per device.
- Use ordinary Rust structs/impls and focused TypeScript classes for new substantive behavior, preserving existing Zustand/component idioms. No speculative hierarchies or wholesale object-oriented rewrite.
- Never hold the DB mutex over network waits. Accepted capture persistence is short and transactional.
- Do not put long SNMP collection in the persistent Python request loop. Phase 6 must prove a bounded independent worker or an appropriate native alternative.

## 4. Data contracts before richer UI

### Identity, isolation, and asynchronous ownership

- Preserve existing graph IDs and legacy rows. Imports use graph-local keys based on actual file keys, not labels guessed to identify saved devices.
- New saved-device collection retains connection ID as provenance and uses the saved host as reference where unambiguous; display name remains a label.
- Render one deterministic node per graph/reference. Explicitly handle legacy multiple-kind rows and expose conflicting metadata rather than generating duplicate React Flow IDs or silently inventing identity.
- Do not merge hosts/IPs merely because short names, model strings, or inferred roles match. Ambiguous aliases remain separate with warnings. No incidental deletion/rekeying of historic nodes.
- Key positions by the same graph/reference as the rendered node. Test this projection before storing coordinates.
- Every asynchronous load/save is bound to graph identity and request ownership. Late Global refresh/import/layout responses cannot overwrite a newly selected graph.

### Protocol and evidence fidelity

- Include protocol in the edge key; preserve endpoint-tuple canonicalization and distinct parallel port pairs. Migrate surviving old rows unchanged. Already overwritten historic protocol evidence cannot be reconstructed.
- Add `eigrp` and `unknown` to import/persisted/frontend protocols while preserving `isis`. Update filters/styles/readers/tests together.
- Distinguish imported claims, native L2 observations, and routing adjacency. Preserve unsupported raw protocol names in bounded import provenance and report unsupported normalization; never substitute LLDP.
- Protocol N belongs to connection N. Missing array means unknown. Reject malformed/misaligned supplied arrays with an actionable report rather than shifting associations.
- Canonical endpoint order does not establish physical or reverse verification. Any directional-confirmation display requires actual observer/timestamp evidence. Imported/migrated data remains unverified by this application.
- Supported empty collection differs from unsupported parsing, connection failure, and stale data. Partial/failed captures never automatically delete previously observed links.

### Persistence

- Add durable graph-scoped layout rows, finite coordinate validation, and graph-cascade cleanup. localStorage is not the store for user-created arrangements.
- Add protocol-key/provenance changes and bounded graph/node metadata needed for source/freshness; no unlimited raw metadata blobs.
- Preserve legacy Global ingestion/commands where possible. Add explicit graph/run fields to new paths rather than globally changing unrelated collectors.
- Migration inventory includes V0094-V0096, including untracked work. **Do not reserve or guess V0097.** Allocate free versions immediately before implementation; use the real `src-tauri/src/db.rs` migration runner.
- Test populated legacy upgrades, empty databases, rollback on import failure, and cascades. Destructive downgrade is not the default rollback.

## 5. Phases and verification gates

### Phase 0 — Affected baseline and contract tests

- [x] Read current `Plans/Mistakes.MD`; pin affected working-tree files and ownership. Preserve unrelated changes in App, lib.rs, SSH execution, ingestion, and tests.
- [x] Establish affected frontend/Rust/Python baselines before calling later failures regressions: 104 frontend, 17 Rust, and 14 Python topology tests passed.
- [x] Freeze eight synthetic SC2 cases in `sidecar/tests/fixtures/sc2_native_topology_phase0_cases.json`, with a dedicated integrity regression. These are future interchange examples, not an implemented importer.
- [x] Inspect installed React Flow handlers/types and existing file/cancellation seams. Context7 remains configured but fails OAuth `invalid_target`. No export or executor code was changed; native PNG/SVG fidelity and process cleanup remain Phase 3/4 release gates, not completed checks.
- [x] Check shared SSH callers/process-tree behavior and saved-platform support without changing the executor. Manual collection is limited to saved Cisco IOS/IOS-XE profiles and existing password authentication; key-only discovery remains unsupported.

**Gate:** baseline recorded; genuine RED tests established missing outcome, transaction, ownership, layout, and review-regression behavior. No device access performed.

### Phase 1 — Graph ownership, honest collection, durable layout

**Changed seams:** `src-tauri/src/topology/{mod,graph,ingest}.rs`, `src-tauri/src/commands/topology.rs`, parser bridge and opt-in sidecar neighbor handler, `src/lib/topology.ts`, `src/state/topologyStore.ts`, `TopologyTab.tsx`, `TopologyToolbar.tsx`, `DeviceDiscoveryModal.tsx`, two `CommandBlock.tsx` selectors, and two `src-tauri/src/lib.rs` registrations. V0097 was verified free immediately before allocation and adds `topology_node_positions`.

- [x] Expose existing graph list/select/create in Neighbors. New manual collection accepts explicit graph; automatic ingestion stays Global-only. Inline panels use a separate Global snapshot, not the selected workspace graph.
- [x] Add explicit-graph ingestion with a compatible Global wrapper. Transactionally persist accepted cache/source/node/edge writes; failed captures retain earlier evidence.
- [x] Report execution/parser/ingest outcomes: completed, partial, failed, and unsupported capture status. Supported zero neighbors is valid; junk/unsupported parsing is not empty success. Counters are processed rows, not new entities.
- [x] Implement deterministic graph/reference projection with conflict warnings, saved-profile manual collection, and graph/request ownership guards. Exact saved hosts mapped to different SSH ports are rejected before credentials/transport; no alias-merging system was added.
- [x] Persist finite drag-stop coordinates with atomic SQLite batches. Per-graph failed positions/errors survive switching; new nodes avoid occupied fallback slots without moving retained/saved nodes or changing the original initial arrangement.
- [x] Preserve viewport on refresh/filtering. Arrange saves all nodes deliberately; Reset clears stored positions. Ordered writes and mutation versions guard late responses. Discovery modal has initial focus, Tab containment, Escape, and focus return.

**Verified gate portions:** isolated graph writes, populated migration/SQLite close-reopen, outcome variants, race regressions, and real Chromium drag/filter/refresh/switch/reload/viewport/error/Arrange/Reset/create/modal keyboard checks. Browser IPC is synthetic and does not prove native Tauri persistence.

**Open acceptance:** native app restart retention and authorized real-device collection were not performed; the running app/dev server was not restarted. Phase 1 must not be advertised as native/device accepted until those checks pass.

### Phase 2 — Native map usability and working device actions

**Existing files:** `TopologyTab.tsx`, `TopologyToolbar.tsx`, `TopologyInspector.tsx`, `NeighborNode.tsx`, `NeighborEdge.tsx`, `topologyTheme.ts`, topology CSS; `src/App.tsx` only for existing opener callbacks.

- [x] Wire SSH/NETCONF to actual existing application openers and saved-neighbor resolver. Pass callbacks into topology; no new session/tab system. Retain unknown-neighbor save and overwrite safeguards. Native device acceptance remains open.
- [x] Reuse inline one-hop focus semantics, with an exit-focus action. Hidden nodes remain in saved data; peer-to-peer links not incident to the anchor are excluded.
- [x] Add explicit connectivity-based arrangement handling disconnected components; retain the simple arrangement. No new layout dependency.
- [x] Use independently authored generic saved-profile/discovered shapes and text hints with existing theme tokens, without inferring equipment roles or copying upstream assets.
- [x] Render distinct available port/protocol observations separately, with compact selected labels and full details in tooltip/inspector/table. The existing database protocol-key limitation remains; overwritten historical evidence cannot be recovered.
- [x] Distinguish L2 observations and routing adjacency with text/dash patterns; show capture times and unverified reachability. Retain keyboard activation and focus return. Routing identity placeholders are not described as recorded ports.
- [ ] Imported/stale/not-dialed states require the later provenance/freshness/discovery contracts. Phase 2 does not invent those states from the current model.
- [x] Verify the existing Topology chooser in TabBar and App mount wire new actions; retain Topolograph/STP modes. Synthetic browser/component tests cover their reachability; no new native menu or native acceptance is claimed.

**Gate:** browser checks cover keyboard/focus, parallel links, and disconnected maps. Native checks prove real saved-device opening without duplicate PTYs. Logging or invoking a mock is insufficient.

### Phase 3 — Offline import and editable exports

**New:** `src-tauri/src/topology/interchange.rs`, `src/lib/topologyExport.ts`, focused tests.  
**Existing:** topology model/command/store/toolbar; `src/lib/export.ts` only for a narrow binary-save sibling if PNG needs it.

- [x] Validate the inspected SC2 **map** shape with bounded nodes/links/strings. Reject full `device.json`, archives/directories, executable URLs, and unsupported shapes clearly; do not pretend they are maps.
- [x] Preserve actual node keys, port pairs, protocol associations, and supported inventory. Create placeholders for missing peers; unknown/undiscovered is not failed.
- [x] Preview counts/warnings, then atomically create a named graph. Validation failure/cancellation before commit leaves no partial graph. Import never causes network access; committing is explicitly non-cancellable until its atomic result returns.
- [x] Add versioned native JSON for declared graph data/evidence/positions. Promise that representation's round-trip, not byte-for-byte SC2 metadata preservation.
- [x] Generate editable uncompressed Draw.io XML from current positions and measured node bounds. Escape labels/ports; preserve parallel links; use native shapes, not flattened images/remote icons. Compatible-editor acceptance is still open.
- [x] Wire `.drawio` through the existing native text-save helper, with truthful cancellation receipts. Native WKWebView end-to-end acceptance is still open. No external transmission or diagram-history dependency was added.
- [x] Implement complete-scope PNG from renderer-measured nodes/handles/fonts and exact edge curves, including labels, parallel links, signed self-loops and off-screen filtered bounds. Enforce 16,384px / 32 Mi-pixel / 10 MiB ceilings and use native binary save APIs with truthful cancellation. Chromium pixel/path checks passed under a matching data-image CSP; **native WKWebView/dialog/filesystem acceptance remains open**.
- [x] Derive geometry from our renderer. Use readiness/internal measured bounds in an isolated uncontrolled measurement flow, not copied Cytoscape conversion or arbitrary timers.

**Proposed initial ceilings:** 10 MiB import, 2,000 nodes, 10,000 port-pair records, bounded strings/metadata and PNG pixel area. These are product limits to benchmark/adjust, not measured capacity claims.

**Gate:** fixtures retain parallel ports, reversed observations, CDP/LLDP on a pair, EIGRP, absent protocols, and placeholders. Invalid imports leave DB unchanged. Open `.drawio` in a compatible editor and confirm independently editable nodes/links and arrangement. Native offline PNG verifies links/labels/full-filtered export. Cancelled save is not a saved file.

### Phase 4 — Bounded recursive SSH discovery

**New:** `src-tauri/src/topology/discovery.rs` / `TopologyDiscoveryService`, discovery-specific `discovery_transport.rs`, and focused tests.  
**Existing:** `src-tauri/src/commands/{mod,topology}.rs`, `src-tauri/src/lib.rs`, `app_lifecycle.rs`, `src/lib/topology.ts`, `topologyStore.ts`, `DeviceDiscoveryModal.tsx`, toolbar/report UI. Shared SSH/parser/ingestion APIs remain unchanged.

The checked items below mean implementation plus local/synthetic evidence, **not native/device acceptance or release approval**; see §12.

- [x] Add thin start/status/cancel commands. One app-owned active run initially; another start reports that run rather than replacing it. Bind results to run and graph IDs.
- [x] Snapshot eligible saved IDs/platform/vendor and transport fields atomically. Resolve secrets through existing password handling; temporary overrides never enter logs, graph data, exports, or vault notes.
- [x] BFS queue with visited IDs/exact normalized hosts; follow only uniquely matched eligible saved neighbors. Unmatched, ambiguous, or missing-address targets are visible as not dialed. Advertised names do not substitute for missing management addresses.
- [x] Default to selected seeds only. Explicit recursion allows one hop, four concurrent devices, fifty attempted devices, ninety seconds/device, fifteen minutes/run, thirty seconds/command. These are product ceilings, not measured capacity. Failed attempts consume budgets; cycles deduplicate before dialing.
- [x] Use saved-platform command/parser support verified by fixtures. Initial collection supports Cisco IOS/IOS-XE password profiles; unsupported platforms are explicit outcomes. Expand vendors only with fixture and authorized lab proof.
- [x] Preserve shared executor API; add discovery-specific cancellable direct OpenSSH execution with an environment-only static askpass helper. No sshpass descendant/session boundary is introduced. Controlled local process tests cover cancellation, timeout, future drop, normal-parent-exit descendants, shutdown, failed-signal ownership retention and reaping. Actual network SSH acceptance remains open.
- [ ] **Trust release gate:** discovery now sets strict OpenSSH known-host verification and disables ambient config/proxies/agent/key fallback; unknown/mismatched keys produce sanitized visible transport failure. No enrollment UI or global SSH change. Flags/validation are tested, but actual known/unknown/changed-host-key authentication against an authorized lab remains unverified.
- [x] Stop admissions, cancel/reap owned transport, prevent post-cancel writes, retain committed partial observations. Cancellation is not rollback. A queued synchronous parser request may settle later; its stale result cannot ingest and the shared sidecar is not killed.
- [x] Network waits remain in Rust. One parser admission permit stays owned until the real request settles. Synthetic contention tests measure cancelled-request head-of-line admission wait; status reports admission and submission/reply wait. Production Python handler time and shared-sidecar queue latency are not independently measured or isolated.
- [x] Wire discovery shutdown before STP/shared-sidecar cleanup; fresh service has no running job. Runs are memory-only, with no restart resumption. Lifecycle/unit evidence is local; actual native shutdown/restart remains an acceptance gate.

**Gate:** synthetic tests prove cap/depth/cycle/identity/platform/outcome boundaries. Controlled child-process tests prove cleanup and no late writes. Then verify an authorized small lab, unreachable target, and Stop. No speed/reliability claim before measurements.

### Phase 5 — Routing-aware evidence and freshness

**Existing:** topology models/ingest/discovery, `sidecar/src/ccie_sidecar/topology/neighbors.py`, normalizer tests, edge rendering/inspector.

- [x] Use supported BGP/OSPF/IS-IS parsing. At the original Phase 5 delivery, collection was opt-in (off by default), limited to three fixed commands, and never supplied recursive dial targets. EIGRP was import-only at that point; the separately authorized 2026-11-08 follow-up below adds its collector.
- [x] Collect one optional `show ip interface` snapshot for routing-enabled SSH discovery and parse installed Genie IPv4/prefix ownership. Associate established, supported default-VRF IPv4 peers only with one unique eligible same-subnet address owner. Duplicate/overlapping owners, local-self/network/broadcast peers, loopback/tunnel/null interfaces (including abbreviations), conflicting reported interfaces and missing/unsupported evidence remain unknown. Preserve logical identities, multiple peers/shared interfaces and all L2 edges. This is explicitly **same-subnet support, not direct-session or physical-attachment proof**; raw fixtures are synthetic, not device acceptance.
- [x] Never turn multihop BGP, loopback peer IPs, or router IDs into physical cables. Evidence-aware established/supported-scope peers use source/context-scoped logical identifiers, never management targets. Idle/INIT/unsupported scopes remain observations without logical adjacency edges.
- [x] Preserve full advertised L2 aliases, conflicting records, collector source, routing context and capture times separately from canonical graph edges. Routing state/prefix-count changes replace the latest state for the same full identity; this is not an unbounded state-event log. Distinct aliases/ports/scopes remain historical. Native v1 exports intentionally exclude local collection receipts, with an explicit UI note and rejection of receipts on import.
- [x] Failed/partial refresh leaves historical links visible, not deleted/currently verified. Incomplete/failed/unsupported attempts do not refresh old observation/edge times; successful empty captures mark prior observations historical. UUID graph/source/protocol attempt ownership protects both collectors against superseded commits/status writes. No replacement/deletion policy is enabled. Receipt limits fail closed (2 MiB/receipt, 16 MiB/graph, 2,000 input records and 10,000 retained identities); no silent historical pruning.

**Gate:** fixtures cover directly connected peers, multihop, duplicate address owners, multiple peers/interface, VRFs, missing evidence, and existing L2. Unsupported address-family/VRF cases stay unknown; no fabricated physical edges.

### Phase 6 — Native SNMP, gated but in scope

**Reason:** SC2 demonstrates useful SNMP and LLDP-port capabilities absent from the original Neighbors implementation. The spike established the already installed/locked **PySNMP 7.1.22** APIs and license. It is now declared directly and unconditionally, with existing frozen hashes and its BSD-2-Clause license included; no dependency was installed or upgraded. This does not establish OS release support.

**Execution status — 2026-11-06:** collector, credential form/reference handoff, discovery UI/admission, source-aware receipts, raw OID/ASN.1 decoding and supervised worker are **implemented and locally verified**. The earlier offline-subset execution record below is historical. Context7 connectivity, built native release artifacts and authorized device accuracy remain unaccepted; Windows discovery is explicitly unsupported.

- [x] Verify installed dependency APIs/license, existing vault seam, wheel contents/frozen hashed export and controlled worker cancellation. Directly pin existing PySNMP 7.1.22; do not install SC2 wholesale.
- [ ] Restore Context7 documentation connection (`invalid_target`) and verify supported OS release bundles/native lifecycle. Local wheel/hash checks are not cross-platform release acceptance.
- [x] Offer explicit `ssh`, `snmp_v3` or `snmp_v2c` modes. v3 is SHA-256/AES-128 authPriv; v2c requires explicit choice and an unencrypted-traffic warning. No default communities, credential spraying, SET operations, unattended subnet scans or automatic fallback.
- [x] Reuse encrypted vault `snmp_community` rows with a versioned JSON profile and nonsecret format/version metadata. Vault form defaults to v3. Discovery lists matching metadata from unlocked envelopes and sends only the selected secret ID; native code reads that one value. Legacy plain communities are not silently reinterpreted. No second vault or reveal-to-JavaScript collection path.
- [x] Run a separate isolated Python worker with stdin-only credentials, bounded input/output/table/cell/byte/call counts and a native 85-second hard deadline within the 90-second device budget. Controlled processes verify cancel, timeout, future drop, shutdown and kill/reap. Network collection never runs on the persistent sidecar loop; release resolves only bundled Python.
- [x] Independently decode numeric CDP/LLDP/IF-MIB OIDs and ASN.1 values, preserving ordered management-address/index pairs and unique port mappings. LLDP localPortNum is not ifIndex; ambiguous/non-ifName mappings remain safe unresolved provenance, not graph links. No upstream implementation copied.
- [x] Reuse Phase 4 saved-host eligibility, recursion/caps and outcomes with no fallback. V0100 preserves existing receipts/attempt tokens and separates CLI/SNMP source-command ownership. Failed/partial captures retain timestamped historical provenance under atomic storage limits; they cannot refresh old canonical observations.

**Gate:** synthetic MIB fixtures cover index mismatch, missing tables, permission failures, timeouts, and ambiguous parallel ports. Authorized device comparison proves whether SNMP adds correct devices/ports without false links or leaked secrets. Unmet documentation/packaging/credential gates are reported as **blocked**, never complete or silently omitted.

## 6. Acceptance matrix

| Area | Minimum evidence |
|---|---|
| Existing behavior | Affected baselines and unchanged Topolograph/STP journeys |
| Migration | Populated upgrade, protocols/data retained, cascades, no version collision |
| Ownership | Import/manual isolation; stale load/import/layout response races |
| Layout | Drag/filter/refresh/reopen/restart; new-node fallback; disconnected layout; visible save failure |
| Interchange | Current/legacy map, alignment, parallel ports, hostile labels, limits, rollback, declared native round-trip |
| Export | Real editable Draw.io; native PNG links/labels/off-screen nodes; no automatic external request |
| Open actions | Real SSH/NETCONF path, unknown-neighbor flow, no duplicate terminal process |
| Discovery | Caps/cycles/platform; all-failed/empty/partial; Stop/process cleanup/no late writes |
| Routing/SNMP | Evidence/port accuracy; ambiguity/unsupported states; no logical-to-physical fabrication |
| Accessibility | Keyboard/focus, narrow layout, existing theme-token/contrast checks |
| Comparison | Correct unique devices, port precision, false links, connection count, elapsed time, cleanup, sidecar responsiveness on identical authorized scope |

Test entry points identified during the proposal (execution results are recorded below; native/device journeys have not been run):

- Frontend: topology `TopologyTab`, `InlineTopologyPanel`, `TopologyIntegrationWorkspace`, and `StpWorkspace` tests; `src/lib/topology*.test.ts`; `src/state/topologyStore.test.ts`.
- Rust: `topology_ingest_test`, `topology_graph_crud_test`, `topology_migration_test`; new owned discovery/interchange/cleanup regressions.
- Python: `sidecar/tests/topology/test_neighbors.py`, `test_routing_neighbors.py`, `test_neighbors_ndjson.py`; owned transport fixtures if Phase 6 proceeds.
- E2E: `e2e/tests/topology-inline.spec.ts`, `topology-click-to-ssh.spec.ts`; native layout/import/export/discovery journeys.

Use actual current test configuration and exclude unrelated worktree/scratch trees. Report failures/skips. Mock callbacks, typechecks, screenshots, graph extraction, or request acknowledgements alone do not establish end-to-end completion.

## 7. Rollout and rollback

1. Ship foundation/usability/offline interchange independently after their gates. Discovery remains in this overall plan without blocking offline work.
2. Retain legacy entry points/Global behavior while introducing native runs.
3. Release recursion only after trust/cleanup/bounds/lab gates. Advertise routing/SNMP per verified platform, not universal multi-vendor support.
4. Preserve backups/imports. Disabling UI/runs must leave existing graphs readable. Do not casually drop tables or revert migrated data.
5. Before commit/release, inspect scoped diff/ownership, run affected and broader gates, refresh scoped Graphify, and obtain separate execution/publication authorization. Do not stage the pre-existing dirty tree.

## 8. Provenance and limitations

- Local base: `d80d6889615c7034574fcbc67057457099a91784`. Findings use the inspected **working tree**, not an assertion it equals HEAD.
- Historical initial scoped Graphify: 29 files, 386 nodes, 857 edges. Initial source pins were rechecked unchanged at research time; implementation intentionally changes a scoped subset afterward.
- Historical discovery-evidence refresh added eight pinned files: **719 nodes, 1,546 edges, 32 structural communities**, no reported extraction failures, unchanged before/after hashes at that stage. Post-implementation pins and counts are recorded separately, without rewriting historical manifests.
- Evidence: `graphify-out/securecartography2-review-20261105-sik42r54/{graph.json,source-manifest.json,discovery-evidence-manifest.json}`. Original manifest is historical; additional manifest pins refresh sources.
- AST can contain dangling external references and collapse same-endpoint relationships. Graph navigation is not behavioral proof; direct source establishes claims.
- Context7 is configured but failed to connect with OAuth `invalid_target`; no current-documentation success claimed. Superpowers was unavailable among listed callable skills; feature-dev and applicable planning/Graphify guidance were used.
- The research/proposal stage changed no application code and ran no suites or devices. Authorized Phase 0/1 execution subsequently changed scoped application/test files and ran the checks recorded below. No upstream code was executed, package installed, device accessed, native app restarted, or Git staging/commit/push performed. Native export fidelity, real-device accuracy, and native restart acceptance remain open.

## 9. Phase 0/1 execution record — 2026-11-05

### Contracts implemented

- `GraphSnapshot.positions` contains graph/reference coordinates; frontend keeps it optional for older mocks/fixtures. `topology_save_layout(graphId, positions)` and `topology_reset_layout(graphId)` are registered through the existing Tauri command surface.
- V0097 adds finite `x`/`y` rows keyed by `(graph_id, device_ref)`, with graph-delete cascade and explicit Clear/Reset cleanup. Populated V0096 upgrade, rollback, duplicate legacy kinds, cross-graph isolation, and SQLite close/reopen are covered.
- `topology_discover_device` accepts optional `graph_id`; omitted means Global. Legacy vendor/platform arguments remain accepted, but manual loading uses saved host/name/vendor/platform. DNS host references are not invented management IPs.
- Manual summary statuses are `completed`, `partial`, or `failed`; individual CDP/LLDP captures report `completed`, `failed`, or `unsupported`, record counts, and sanitized errors. Existing added counters still mean processed records.
- `topology.neighbors` keeps its default response and existing normalizers. The new opt-in `include_status: true` seam distinguishes unsupported/junk from supported zero-neighbor output; narrowly matching command echoes are permitted. No global parser adapter rewrite.
- The shared SSH executor, automatic command bodies, renderer/library, dependencies, native app lifecycle, Topolograph/STP, and device-opening/PNG stubs were not expanded.

### Verification evidence

- Independent Rust/Python/React/TypeScript/code review findings were addressed and the final scoped deltas accepted. Test-only unused-parameter names were subsequently corrected without behavioral changes.
- Rust: **36 passed**, across `topology_foundation_phase1_test` (19), `topology_graph_crud_test` (6), `topology_ingest_test` (7), and `topology_migration_test` (4). Existing unrelated `retry_retained_sidecars` dead-code warning remains.
- Python: **36 passed** under a fresh empty `HOME`, covering topology, dispatcher, and parse NDJSON. Use that isolation for subprocess startup; broader server tests otherwise inherited configured integration startup. The earlier wider run had 65 passed/2 skipped plus an unrelated vendor-list assertion failure and was stopped after unwanted bridge auto-start.
- Browser: final fresh Chromium run passed real React Flow drag/save, refresh/filter viewport retention, graph switch/reload, visible failed-save retention across switches, deliberate Arrange/Reset, graph creation, visible node labels, and discovery initial focus/Tab/Shift-Tab/Escape/return. Real component and browser; synthetic in-memory backend, not a native database/device test.
- Production `tsconfig.build.json`, Vite build, structural color guard, and three-theme contrast guard passed. Vite retains existing mixed-import/chunk-size warnings; browser/test logs retain existing Monaco sourcemap/navigation notices.
- Root strict `tsconfig.json` still reports **71 diagnostics outside owned topology/theme paths**, with zero owned diagnostics after correcting the two new test parameter names. No compiler/lint settings were relaxed. Broad Clippy/formatting failures are outside the scoped changes.
- Earlier live-tree frontend run: **315 files / 2,567 tests passed**. After four additional cache tests, the parallel run had **2,570 passed / 1 failed**: unchanged ArrayTableView's 10,000ms timing check measured 10,181.71ms during concurrent verification. Final complete rerun with `--maxWorkers=2`: **315 files / 2,571 tests passed**, exit 0, 529.46s. No ArrayTableView source/test/threshold or test configuration changed. Log: `/tmp/ccie-topology-phase01.8K2yDu/frontend-final-two-workers.log`.
- Final owned Graphify refresh: **51 source pins, 875 nodes, 1,884 edges, 48 structural communities**; zero pin mismatches and the canonical project graph hash unchanged. Twenty scoped code/test sources were re-extracted, with no extraction failures. Raw refresh-chunk dangling references exclude preserved context and are not whole-graph health evidence; see the owned `GRAPH_REPORT.md` and `phase01-implementation-manifest.json`.

Reproducible local commands (scratch/worktree exclusions are deliberate):

```sh
cargo test --manifest-path src-tauri/Cargo.toml \
  --test topology_graph_crud_test --test topology_ingest_test \
  --test topology_migration_test --test topology_foundation_phase1_test

TEST_HOME=$(mktemp -d /tmp/topology-python-home.XXXXXX)
HOME="$TEST_HOME" sidecar/.venv/bin/python -m pytest -c sidecar/pyproject.toml \
  sidecar/tests/topology sidecar/tests/parsers/test_dispatcher.py \
  sidecar/tests/test_parse_ndjson.py -q

node_modules/.bin/vitest run --maxWorkers=2 \
  --exclude '**/.superpowers/**' --exclude '**/.worktrees/**' \
  --exclude '**/.claude/worktrees/**'
node_modules/.bin/tsc --noEmit -p tsconfig.build.json
node scripts/check-structural-colors.mjs
node scripts/check-theme-contrast.mjs
```

### Explicit limits and remaining acceptance

- Saved profiles are authoritative at **manual load/source write**. Manual neighbor/self observations cannot overwrite an existing saved node. Legacy **automatic Global** ingestion intentionally retains its old metadata-replacement behavior, so a later automatic observation can still overwrite manual metadata in Global. This is not a universal all-writers authority guarantee.
- Manual discovery remains serial, Cisco IOS/IOS-XE, and password-based. Different SSH ports on an identical saved host are rejected rather than merged. No recursion, SNMP, new alias model, protocol-key migration, or transport/trust/cancellation expansion is implemented.
- The existing edge primary key still omits protocol; full protocol-evidence fidelity belongs to the later schema/interchange work. Historical overwritten observations cannot be reconstructed.
- Native restart persistence, native visual/export fidelity, and live-device outcomes remain unverified. Browser assertions use a fresh Chromium context and synthetic IPC, with external requests blocked and unknown commands denied; they are not a native Tauri/device test.
- Context7 remains a configured connection failure (`invalid_target`); installed APIs/types were the fallback. ESLint is not installed; root strict TypeScript, all-project Clippy with warnings denied, and broad formatting had unrelated existing failures and were not relaxed.

### Evidence ownership

- Parent verification and browser harness: `/tmp/ccie-topology-phase01.8K2yDu/`.
- Backend before-images/diffs/RED-GREEN evidence: `/tmp/topology-backend-phase01-20261105/`, including `round2/`.
- Frontend original dirty before-images and scoped deltas: `/var/folders/9g/wq8jzzxx40n7zdntcl67t8x00000gn/T/ccie-topology-frontend-dx4mbmrh/`.
- These scratch paths are local evidence, not durable packaging or a committed baseline. Owned Graphify manifests pin the implementation sources; historical research manifests remain intact.

## 10. Phase 2 execution record — 2026-11-06

### Implemented scope

- `TopologyOpeners` coordinates the existing App terminal seed and NETCONF tab path. Known nodes use the saved `device_ref`, not an advertised management IP. Saved host matches must be unique. Discovered nodes use the existing inventory resolver and unchanged unknown-neighbor save/overwrite flow. No new session framework, inventory, credential store, backend command, migration, or dependency.
- SSH seeds one registry entry and dispatches the existing targeted `ssh-connect` event only at PTY readiness. Failed/disposed spawns do not register a tab/layout/slot or fall back to a second terminal; the exact failed launch entry is disposed. The existing Windows managed path is retained. Missing saved passwords use existing interactive behavior. These guarantees have source/component regression evidence, not live authentication proof.
- NETCONF opens the saved profile in a disconnected, prefilled tab; the operator still presses Connect. An explicit NETCONF action never falls through an SSH-priority generic resolver. Password values are runtime state only, not graph data or logs.
- An in-flight opener remains guarded across graph/mode/selection changes until it settles. Separate request ownership suppresses stale modal/error results. Open failures are visible; ordinary saved-profile launch errors use sanitized messages.
- `TopologyMap` supplies deterministic BFS component arrangement, anchor-only one-hop focus, collision-safe edge identities, parallel offsets, and truthful evidence/port/time labels. Arrangement is deliberate and persists all projected nodes, including filtered/disconnected nodes. Focus/exit leaves saved data, coordinates, and viewport intact; Fit view remains an explicit control.
- The full map uses neutral theme tokens, generic saved-profile/discovered shapes and text, compact selected port labels, full SVG titles, inspector capture details, and an accessible link table. Routing `peer:*` identity placeholders display as logical peers with no recorded port. No physical/reverse verification, equipment role, live reachability, imported provenance, or stale threshold is inferred.
- Existing Topology chooser/App mount and Topolograph/STP modes remain. Inline node/edge defaults and unknown-neighbor overwrite guards are preserved. The narrow workspace hides its obscuring minimap while retaining zoom/Fit controls. Initial/manual Fit has additional padding for the measured curved-link fixture; this is not a general collision-free layout promise.

### Verification and review

- Genuine RED regressions preceded fixes for pending-open admission, saved-host dispatch, anchor-only focus, spawn registration/cleanup, routing port labels, and compact selected labels. Browser geometry also genuinely failed on curved links outside Fit bounds before padding was added.
- Final full frontend suite: **320 files / 2,628 tests passed**, exit 0. Production `tsconfig.build.json` and Vite build passed. Structural-color and three-theme contrast guards passed: 42 semantic pairs, 903 discovered rule-level usages, zero unsupported. Existing Monaco sourcemap/jsdom navigation and Vite chunk warnings remain.
- Root strict TypeScript remains **71 diagnostics**, with no new owned diagnostics. Its three App diagnostics are pre-existing in the dirty before-image. No compiler/test settings or unrelated baseline errors were changed. The TypeScript-specific reviewer stopped at that project-wide gate and did not grant acceptance; code and React reviewers accepted the scoped fixes, including compact labels and narrow minimap behavior.
- Fresh Chromium with synthetic IPC passed distinct parallel SVG paths/port text, keyboard activation/initial focus/focus return, one-hop coordinates and viewport retention, explicit SSH/NETCONF callback references, graph-switch cleanup, disconnected arrangement, link-table evidence, narrow overflow checks, and retained mode reachability. Final Fit measurements contain all four synthetic nodes and the narrow fixture's curved links. Geometry is awaited using stable measured bounds, not a fixed sleep.
- Screenshots were inspected in actual `slate-grey` and `terminai-dark` themes. Narrow DOM measurement found one topology root and one heading (1,415px document at a 1,000px viewport), not duplicate rendered workspaces. Earlier full-page captures were not accepted as duplication proof. Browser/device inventories and credentials were synthetic; unknown IPC/external requests were blocked.
- Final scoped Graphify: **61 source pins, 952 nodes, 2,004 edges, 44 structural communities**, 13 re-extracted code/test sources plus two CSS hash pins, no reported extraction failures, and unchanged before/after source hashes. Canonical project graph remained unchanged. AST/merge relationships and community counts are structural navigation, can vary with resolution context, and are not runtime proof. Historical manifests remain intact.

### Open gates and boundaries

- **Native acceptance remains open:** controlled restart/persistence from Phase 1, real saved SSH/NETCONF profile opening/authentication, no duplicate native PTY, and authorized device collection. The running native application/dev server was not restarted or duplicated. Mocked registry/backend/browser receipts do not satisfy these gates.
- Imported/stale/not-dialed presentation awaits later data contracts. The database edge key still omits protocol; distinct available records are drawn, but previously overwritten evidence cannot be recovered. Existing automatic Global metadata replacement is unchanged.
- No Phase 3 import/export, recursive discovery, SNMP, trust/transport/cancellation expansion, package installation, Git staging/commit/push, or release was performed. PNG remains the pre-existing stub; this phase does not claim export completion.
- Context7 failed its configured OAuth connection (`invalid_target`); installed package source/types were used. No up-to-date external documentation success is claimed.

Evidence: `/tmp/ccie-topology-phase2-3gmj5d6l/` contains dirty before-images, RED/GREEN logs, `phase2-owned.diff`, browser harness/screenshots/report, and final checks. Final results use `frontend-final-geometry.log`, `build-final-geometry.log`, `browser-final-geometry.log`, and `strict-accepted.log`. These scratch files are local verification evidence, not a committed baseline. Durable source pins are in the owned `phase2-implementation-manifest.json`.

## 11. Phase 3 execution record — 2026-11-06

### Implemented scope

- Bounded offline SC2 map and version-1 `terminai-topology` JSON preview/import. Inputs are content, never executable paths/URLs. Preview does not write or contact devices; explicit import reparses and atomically creates an independent named UUID graph. It does not merge Global, select the result, or alter saved profiles. Cancellation is supported before commit; once committing, the UI waits for the atomic result rather than promising rollback-on-cancel.
- Enforced ceilings: 10 MiB input, 2,000 node rows including placeholders, 10,000 raw connections including reversed/duplicate claims, bounded strings, 32 nesting levels, 16 KiB nested SC2 metadata per node, 2 MiB retained provenance. These are product ceilings, not measured performance capacity. Duplicate JSON keys, malformed/misaligned supplied protocols, malformed port pairs, and unsupported inventory/format shapes are rejected.
- Exact SC2 keys and port-pair/protocol associations are preserved. Reverse claims deduplicate per protocol; absent protocols remain unknown. EIGRP is imported routing evidence, not a new collector. Missing capture times remain zero/unknown; native observation upsert's zero-as-now behavior is unchanged. Missing peers become placeholders, not failed devices. Only declared supported inventory fields are retained; unknown raw protocol names are bounded provenance.
- V0098 rebuilds the edge key to include protocol, retains surviving legacy observations verbatim, and adds a separate cascading graph-origin receipt table. Previously overwritten evidence cannot be reconstructed. Provenance describes graph origin only; later native observations may coexist. Clear removes the receipt. Native round-trip preserves declared graph metadata/times, original node-kind rows, edge orientation/protocol/capture times, positions, and supplied receipt; new graph ID/name intentionally differ.
- Neighbors now mounts Import JSON and complete-filtered/full-graph JSON/Draw.io controls. Default export ignores viewport and one-hop focus, but honors filters. Export freezes the action-time snapshot; filtered provenance excludes omitted links. No external diagram URL, renderer replacement, dependency, or binary-save framework was added.
- JSON retains the versioned declared representation. Draw.io uses uncompressed editable vertices/edges, escaped plain text, stable identities, original positions and measured renderer bounds, and distinct parallel/self-loop paths. A temporary offscreen instance of the existing renderer uses uncontrolled nodes so measured dimension updates can settle; readiness and internal bounds replace arbitrary sleeps. Save reuses `downloadFile`; false means cancelled, not saved. The measurement stage is removed afterward.
- PNG is **not implemented/accepted**. The installed capture path does not establish full SVG curves/labels/offscreen/WKWebView fidelity; the old silent stub now shows an explicit limitation and JSON/Draw.io alternatives.

### Verification and review

- Affected Rust: **56/56 passed** (20 interchange plus 36 baseline). Cases include frozen SC2 examples, native round-trip/reopen, populated legacy migration, late import failure rollback, late migration failure after edge rebuild restoring old schema/history/data, protocol fidelity, ceilings, placeholders and cascades. The existing old-schema foundation fixture now seeds with old-schema SQL rather than invoking a writer requiring the new key.
- Final complete frontend: **323 files / 2,661 tests passed**. Production TypeScript/Vite build passed. Structural-color and theme contrast guards passed: three themes, 42 semantic pairs, 905 discovered rule-level usages, zero unsupported. Existing Monaco sourcemap/jsdom navigation and Vite chunk warnings remain. Root strict remains **71 pre-existing diagnostics**, none in reviewed topology files; no settings or unrelated errors were changed.
- Genuine RED tests/browser failures preceded fixes for focused-scope data loss, excluded-link provenance, self-loop route collisions, nonfinite derived geometry/timestamps, duplicate JSON keys, SC2 envelope ambiguity, and the controlled measurement stall. React and TypeScript follow-up reviews accepted the corrected scope; the integrated review's provenance finding was fixed. A separate Rust reviewer stopped before inspecting the diff because project-wide `cargo clippy -- -D warnings` failed on pre-existing unused `retry_retained_sidecars` in `bridge.rs`; that reviewer did not grant acceptance. Cargo check passed.
- Full synthetic Chromium verified versioned JSON/filtered/full scope, mocked native text-save IPC cancellation, full Draw.io including filter-hidden nodes, measured unzoomed geometry/current positions, escaped Unicode labels, parallel paths, unchanged displayed map, offline preview/explicit import without selection changes, modal focus/Escape, narrow overflow/gutters, and actual slate/dark theme screenshots (inspected). Unknown IPC and external requests were blocked; no real DB/device/credentials used.
- Retained runnable regression: `node scripts/tests/topology_interchange.browser.mjs`. It passed with actual renderer measurement of offscreen nodes at x=4000 and a second save cancelled without another write. It starts/closes its own strict-port1438 server/browser, not the existing native app/1420 server. The full synthetic harness remains scratch evidence, not native acceptance.
- Scoped Graphify refreshed **70 source pins, 1,071 nodes, 2,302 edges, 54 communities**: 19 code/test extraction inputs and three hash-only pins, no failed sources or unexpected historical-source drift, stable extraction hashes, unchanged canonical graph. Historical manifests are retained. AST navigation and community counts do not prove runtime behavior.

### Open gates and boundaries

- Phase 3 is **not fully accepted**: actual WKWebView import/file-picker/save/cancellation/geometry, compatible Draw.io editor opening/editability/arrangement, and complete native PNG remain open. Synthetic IPC/XML parsing does not substitute for those checks. Earlier native restart/authentication/no-duplicate-PTY/device gates also remain open.
- Existing native app/dev server were preserved. No Phase4+ discovery/SNMP, device access, dependency installation, staging/commit/push/merge/release, external publication, or shared transport/trust expansion. Context7 remained configured but its OAuth connection failed (`invalid_target`); installed APIs/source were used, not claimed as successful external documentation retrieval.

Evidence: `/var/folders/9g/wq8jzzxx40n7zdntcl67t8x00000gn/T/ccie-topology-phase3-t5q0gfzy/` holds before-images/hashes, RED/GREEN/backend review logs, `frontend-final.log`, `build-final.log`, `browser-uncontrolled.log`, `browser-report.json`, screenshots, and `graph-final.log`. The retained regression's passing output is `browser-regression.log`; its exported XML is in the separate temporary directory printed there. Durable source hashes are in `phase3-implementation-manifest.json`.

## 12. Phase 4 execution record — 2026-11-06

### Implemented scope

- `TopologyDiscoveryService` owns one in-memory run; thin registered start/status/cancel commands expose sanitized reports. Starting during an active run returns its report. Graph/run authority is checked at ingestion, with Stop linearized against commits. Completed means settled, not that every device succeeded. Cancellation retains committed observations.
- Atomic saved-profile snapshots include metadata, host, port, username and existing password handling. Temporary overrides are request-local and zeroized on Rust drop; frontend clears inputs on close and never stores request passwords in Zustand. No saved profile is edited. Initial support is Cisco IOS/IOS-XE password profiles on Unix; Windows collection explicitly reports unsupported.
- Seeds-only is default; one-hop BFS requires explicit eligible saved IDs. Four-device concurrency, fifty-attempt budget including failures, ninety seconds/device, fifteen minutes/run and thirty seconds/command are enforced. Exact normalized IP/DNS references are used without hostname-shortening or DNS identity resolution. Duplicate saved hosts remain conservative ambiguity failures because graph identity is host-keyed. Missing management addresses, unknown saved hosts, ineligible and ambiguous neighbors are not dialed. Report size/output are bounded.
- Discovery-specific `/usr/bin/ssh` uses strict known-host checks and disables ambient SSH config, proxy/jump, agent/key probing, forwarding and multiplexing. Password is passed through an environment-only static private askpass helper, never command arguments or helper contents. The shared executor remains untouched. Sanitized failure does not expose raw SSH stderr; no automatic host enrollment is added.
- An owned supervisor handles process-group signaling, output bounds, direct-child reaping and helper lifetime even when the request future is dropped. Failed signaling retains ownership for shutdown retry and reports failure, not false drain. Darwin zombie-only EPERM handling uses a bounded fail-closed metadata proof. This is local child-process evidence, not device/SSH-daemon acceptance.
- A single parser permit remains held through actual shared-sidecar request completion, including after caller cancellation/deadline. Late replies cannot ingest. A new run can wait behind the cancelled parser rather than piling up parser submissions. Reported admission and submission/reply waits are not isolated Python execution time. No shared-sidecar concurrency rewrite or parser cancellation/restart was introduced.
- Existing discovery modal now submits destination, seeds, explicit one-hop eligible profiles and temporary overrides. The workspace recovers native run status on remount, polls without overlapping requests, exposes Stop and bounded per-device/capture/not-dialed detail, and preserves graph selection. App shutdown attempts discovery cleanup before STP and the shared sidecar. No new dependencies or migration.

### Verification and review

- Final Rust discovery scheduler/transport: **22/22 passed**. Public discovery/foundation/interchange integrations: **41/41 passed** (2 + 19 + 20). Lifecycle: **9/9 passed**. These 72 affected checks include synthetic cycles/depth/caps, identity/scope/unsupported/empty/partial outcomes, frozen profile revisions, expired run/parser deadlines, retained partial writes, stale parser rejection, admission contention, actual local child/descendant cleanup, shutdown and injected signal failures.
- Final canonical frontend: **324 files / 2,673 tests passed**, exit 0. Focused migrated topology/theme checks: **46/46 passed**. Explicit exclusions prevent archived `.superpowers` and worktree copies from becoming suites. Earlier broad/canonical failures and fixes are retained in the evidence and Mistakes ledger rather than counted as acceptance.
- Production `tsconfig.build.json`/Vite build passed without changing compiler settings. Structural-color and theme contrast guards passed: three themes, 42 semantic pairs, 906 usages, zero unsupported. Existing Vite mixed-import/chunk-size warnings, Monaco sourcemap/jsdom navigation notices, and unused `retry_retained_sidecars` Rust warning remain. No new claim about the earlier root-strict diagnostics or project-wide Clippy is made.
- Retained `node scripts/tests/topology_discovery.browser.mjs` passed real React/store/React Flow interactions with synthetic IPC: default seeds, explicit one-hop scope/destination, password validation, narrow modal, bounded expanded report, graph-selection preservation, remount recovery and Stop. It owns strict port1439 and closes its server/browser. Desktop/narrow screenshots were inspected. This does not drive the native app, native DB, SSH daemon or devices.
- Rust/React/TypeScript review findings were addressed. Genuine RED tests preceded store races, missing-address follow-up and failed-signal ownership fixes; browser measurement caught content-box overflow. Final TypeScript recheck closed its prior graph-refresh retry finding. Existing Phase 1 tests were migrated to native run contracts while retaining layout/focus/partial-result coverage; neutral report CSS replaces obsolete success-toast source expectations.
- Owned Graphify: **79 source pins, 1,236 nodes, 2,736 edges, 62 structural communities**, sixteen code/test extraction sources and four hash-only inputs, no failed sources, stable before/after hashes and unchanged canonical project graph. Historical manifests retained. AST navigation is not runtime or coverage proof.

### Open gates and boundaries

- **Phase 4 is implemented and locally verified, not fully accepted or release-approved.** Authorized small-lab checks must still exercise known/unknown/changed host keys, real Cisco password authentication and CDP/LLDP collection, an unreachable target, Stop, native app shutdown/restart and sidecar responsiveness. Do not weaken verification to make lab login work. No speed/accuracy/reliability superiority over SC2 is claimed.
- Actual production parser/head-of-line latency remains unmeasured; synthetic contention and combined submission/reply timing cannot isolate Python handler versus shared queue time. Non-macOS behavior has not been exercised. Earlier native SSH/NETCONF/no-duplicate-PTY acceptance, compatible Draw.io editor/WKWebView acceptance and PNG remain open.
- Existing native app and port1420 dev server were preserved. No device access, dependency installation, Phase5 routing/freshness, Phase6 SNMP, staging/commit/push/merge/release, external publication or canonical-graph replacement occurred. Context7 remained configured but failed OAuth connection (`invalid_target`); installed source/SDK/APIs were used instead.
- Before-image audit confirms shared `ssh_exec/mod.rs`, parser bridge, topology ingestion, terminal `session.rs` and modal CSS unchanged by Phase 4. Branch remains `feat/shared-editor-toolbar` at `d80d6889615c7034574fcbc67057457099a91784`; unrelated dirty work was not staged.

Reproduce final local checks:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib topology::discovery -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --test topology_discovery_phase4_test \
  --test topology_foundation_phase1_test --test topology_interchange_test
cargo test --manifest-path src-tauri/Cargo.toml --lib app_lifecycle::tests
bunx vitest run --exclude '**/.worktrees/**' --exclude '**/.superpowers/**' \
  --exclude '**/graphify-out/**' --maxWorkers=4
bun run build:relaxed
node scripts/check-structural-colors.mjs
node scripts/check-theme-contrast.mjs
node scripts/tests/topology_discovery.browser.mjs
```

Evidence: `/var/folders/9g/wq8jzzxx40n7zdntcl67t8x00000gn/T/ccie-topology-phase4-kzbe19ob/` retains 21 before-image pins, scoped audit diffs, RED/GREEN logs, `backend-final.log`, `lifecycle.log`, `frontend-final.log`, `frontend-migrated.log`, `build-acceptance.log`, `browser-final.log` and `graph-refresh.log`. Browser screenshots/verification are in the separate `ccie-topology-discovery-fo6FDT` directory printed in that browser log. Durable source pins are in the owned `phase4-implementation-manifest.json`; scratch paths are local evidence, not a committed baseline.

## Phase 5 execution — 2026-11-06 (local evidence subset; physical association gate OPEN)

### Implemented

- Optional routing checkbox defaults/reset to off. Native discovery admits only `show ip bgp summary`, `show ip ospf neighbor`, and `show isis neighbors` in addition to existing L2 commands. Bounds, strict SSH trust, owned-process cleanup and actual-parser semaphore ownership remain unchanged. Routing records never admit recursive targets.
- Evidence-aware normalization retains actual state, established flag, peer-address role, VRF/AF/instance/level and unsupported scope; no peer address is promoted to management IP. Default legacy normalizer shape/semantics remain compatible. Full advertised L2 names survive evidence collection.
- New **V0099** graph/source/protocol receipts persist source command, attempt/outcome and last-seen observations. Atomic owned ingest protects cache, source metadata, graph and receipt with a UUID attempt token. Older compatibility/native replies cannot overwrite newer results. Incomplete/failed/unsupported refreshes preserve historical data; successful empty captures do not delete old links or refresh their timestamps.
- Stable evidence identity retains latest routing state rather than every prefix-count change. Distinct aliases/ports/scopes stay historical. Explicit storage limits fail closed without silent pruning. The inspector separates collected evidence from canonical graph edges and never calls endpoint sorting collection direction. Logical `routing:` identifiers cannot launch SSH/NETCONF or saved-profile creation.
- Local receipts intentionally do not round-trip through native v1 JSON/Draw.io. The workspace explains that limit; native v1 import rejects nonempty collection receipts rather than dropping them. No interchange version or graph-edge schema extension was invented.

### Verification

- **96 affected Rust tests passed:** 26 service/transport unit tests plus 70 across evidence, foundation, ingestion, interchange, discovery, graph CRUD and migration integration targets. Includes sustained 1,200-peer state churn, atomic limit rejection/recovery, reopened receipt persistence, superseded capture/cache/status writes, a newer compatibility capture while native parsing waits, failed/unsupported/invalid outcomes, Stop/late parser handling, and routing command allowlist/injection rejection. The state-identity regression genuinely failed before correction; an earlier compile-only unwrap error is not behavioral RED.
- **71 affected Python tests passed, zero skips**, including 40 new parameterized evidence cases, existing L2/routing compatibility, installed parser raw fixtures, status and Phase 0 fixtures. Raw BGP fixture is IPv6 Idle; raw OSPF shows five FULL peers with shared interfaces/router-ID versus address distinctions; IS-IS preserves literal default tag `"null"` and UP/INIT states. Synthetic IPv4/VRF cases are not claims of device capture.
- **328 canonical frontend files / 2,685 tests passed** with explicit archived/worktree/Graphify exclusions and maxWorkers=4. Focused Phase 5 checks passed 167 tests. Production `build:relaxed`, structural-color guard and theme contrast guard passed. Existing Monaco sourcemap/jsdom navigation, Vite mixed-import/chunk warnings and Rust unused `retry_retained_sidecars` warning remain; no project-wide strict-root TypeScript/Clippy acceptance is claimed.
- Retained synthetic browser script passed on its owned port1439: opt-in/reset, password reset, source/history/state/scope, peer-address role, export note, report bounds, remount recovery and Stop. Desktop inspector measured 286×502 with functioning internal scrolling. At 390×844, inspector width366 has no horizontal overflow; twelve observations expand to4278px and final observations/actions remain reachable by page scrolling. **Narrow inspector is not viewport-height bounded.** Actual viewport screenshots were inspected; the repeated-content narrow full-page capture is not visual acceptance evidence and its cause is unproven.
- Independent Python/React/TypeScript scoped reviews found no findings. Rust review initially blocked receipt retention/ownership/outcomes; those were fixed, tested, and re-reviewed with no remaining findings in reviewed paths. Owned Graphify source hashes/counts are recorded in `graphify-out/securecartography2-review-20261105-sik42r54/phase5-implementation-manifest.json`; canonical graph and historical manifests are preserved. AST navigation is not runtime proof.

### Open acceptance gates

**Phase 5 is not fully complete.** Physical interface association still requires raw local address/prefix ownership and parser fixtures; direct/multihop inference, duplicate-owner resolution and physical mapping were deliberately not guessed. Reported routing interfaces alone are insufficient. Unsupported AF/VRF scopes remain unconfirmed. The Phase 4 small-lab/trust/native lifecycle gates and earlier native connection/Draw.io/PNG gates remain open.

No live device access, dependency installation, native app/dev-server restart, Phase 6 work, staging/commit/push/merge/release or external publication was authorized/performed. Existing running dev server was preserved; the pre-existing native background task later exited on its own. Context7 remained configured but failed connection (`invalid_target`); installed code/types/fixtures were used, not an invented current-documentation claim.

Reproduce the Rust and frontend checks:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib topology::discovery -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --test topology_evidence_phase5_test \
  --test topology_foundation_phase1_test --test topology_ingest_test \
  --test topology_interchange_test --test topology_discovery_phase4_test \
  --test topology_graph_crud_test --test topology_migration_test -- --test-threads=1
bunx vitest run --exclude '**/.worktrees/**' --exclude '**/.superpowers/**' \
  --exclude '**/graphify-out/**' --maxWorkers=4
bun run build:relaxed
bun run check:structural-colors
bun run check:theme-contrast
node scripts/tests/topology_discovery.browser.mjs
```

Evidence: Phase 5 scratch directory is `/var/folders/9g/wq8jzzxx40n7zdntcl67t8x00000gn/T/ccie-topology-phase5-jheok3kw/` (61 before-image pins and scoped audit). Final Rust logs are `/tmp/ccie-phase5-rust-service-final.log` and `/tmp/ccie-phase5-rust-integration-final.log`; frontend/build/guard logs use `/tmp/ccie-phase5-frontend-full.log`, `/tmp/ccie-phase5-build-final.log`, `/tmp/ccie-phase5-colors-final.log`, `/tmp/ccie-phase5-contrast-final.log`. Python output is retained in the parser agent's test tool result (no standalone file). Browser evidence is `/var/folders/9g/wq8jzzxx40n7zdntcl67t8x00000gn/T/ccie-topology-discovery-a3Y2FF/verification.json` and `evidence-desktop.png`, `evidence-narrow-top.png`, `evidence-narrow-many-bottom.png`. Scratch/tool outputs are local verification, not a committed baseline.

## Phase 6 execution — 2026-11-06 (historical offline subset; superseded by completion record below)

### Source-backed spike

- **Installed dependency verified, no install/upgrade:** the local Python 3.12 environment has PySNMP 7.1.22, pyasn1 0.6.0 and cryptography 48.0.0. `sidecar/uv.lock:946-960,2993-3003` locks PySNMP transitively through Genie SDK; `sidecar/pyproject.toml:20-24` excludes pyATS on Windows. Installed metadata/license and [7.1.22 release metadata](https://pypi.org/pypi/pysnmp/7.1.22/json) identify Python >=3.10, a platform-independent wheel, pyasn1 dependency and BSD-2-Clause license. Binary notice requirements still apply. A universal wheel/classifier is **not** macOS/Linux/Windows release acceptance. No direct dependency or lock change was made.
- **Documentation gate still blocked:** Context7 remains configured but fails connection with `invalid_target`; its tools cannot be called. Published [PySNMP docs](https://docs.lextudio.com/pysnmp/) were consulted, but the current 7.1 docs are not pinned to installed 7.1.22. Exact signatures, walk implementation, authentication fields, engine cleanup and AES implementation were inspected in installed source. No API or upgrade was selected from memory. No callable Superpowers skill was listed; the already loaded Feature Development and Graphify guidance was used without plugin setup changes.
- **Actual app secret seam verified, not extended:** `src-tauri/src/commands/mod.rs:474-483` constructs `VaultState` with `DbKeyringStore`, not the OS keychain. `VaultStore::add_secret/read_secret` encrypt/decrypt under the unlocked envelope key (`src-tauri/src/vault/envelope.rs:266-300,364-389`). Existing `snmp_community` kind is constrained by V0041, Rust VALID_KINDS, TypeScript SecretKind and Add Secret selector. The current form accepts one value; no SNMPv3 auth/privacy profile exists. Metadata is returned in DTOs and must never hold auth/privacy secrets. No real secret data or runtime vault was read; no second store or reveal-to-JavaScript collection path was added.
- **Worker/native integration gate still open:** existing `DiscoveryProcesses` is an SSH-specific Unix process supervisor, not a verified cross-platform SNMP worker. DiscoveryRequest has no SNMP credential references. CaptureEvidence recognizes five fixed CLI commands and owns receipts per graph/source/protocol. SNMP must not masquerade as a CLI capture or replace a newer SSH receipt. No persistent-sidecar network handler, fallback loop, subprocess worker, receipt/schema migration or UI control was added.
- **Installed API probe:** a scratch script replaces the bulk network operation before invoking the installed generator. SHA-256/AES-128 synthetic local round-trip passed; cancellation of the mocked await ran explicit `close_dispatcher()` in finally. With `maxRows=2,maxCalls=2`, the patched bulk responses yielded **three varbind cells in two calls**, consistent with the inspected batch counter: a future worker must enforce independent cell, byte and deadline bounds. This is not socket cancellation, worker kill/reap, auth-to-device, sidecar responsiveness or native lifecycle proof. AES emitted an existing cryptography warning that CFB moves/removal occurs in 49.0.0; no warning was hidden or dependency changed.

### Offline implementation and verification

- `sidecar/src/ccie_sidecar/topology/snmp_neighbors.py` independently consumes explicitly completed decoded table projections. `interfaces` is an IF-MIB ifTable/ifXTable join by ifIndex; local/remote LLDP and CDP indexes retain their MIB names. Definitions were checked against Cisco's published [LLDP-MIB](https://raw.githubusercontent.com/cisco/cisco-mibs/main/v2/LLDP-MIB.my) and [CISCO-CDP-MIB](https://raw.githubusercontent.com/cisco/cisco-mibs/main/v2/CISCO-CDP-MIB.my) on 2026-11-06 (mutable main-branch references, not pinned package/runtime proof). It reuses the existing NeighborRecord dataclass; **only the new offline tests import it**. No upstream implementation code was copied or executed.
- LLDP local port number is never treated as ifIndex. Typed ifName/ifAlias or exact unique ifDescr evidence resolves the local interface; competing descriptions, duplicate names, missing ports and unknown mappings remain observations without canonical links. CDP cache ifIndex must exist in the interface table; unknown repeater port values remain unresolved. Full LLDP `(timeMark,localPortNum,remoteIndex)` and CDP `(cacheIfIndex,deviceIndex)` indexes/aliases/port descriptions/mapping method/reasons are retained. Parallel ports remain distinct.
- Remote LLDP non-ifName identifiers remain unresolved; no guessed remote-description or reverse resolver. No management addresses, vendor/capability guesses or recursive dial targets are invented. Raw ASN.1/OID decoding, management-address table joins and reciprocal collection remain **unimplemented**. Unresolved observations must not be submitted as successful empty captures or used to mark historical links absent.
- Missing/denied/timeout/incomplete/unsupported tables raise fixed errors rather than empty success. Complete empty tables are distinguishable. Limits reject >2,000 rows/table, oversized/ASCII-control-character text, invalid indexes and duplicate indexes without silently truncating or copying unknown fields.
- **123 Python topology/dispatcher tests passed, zero skips**, including **49 new synthetic SNMP cases**. Tests are decoded-table projections, not raw PDU/device fixtures. Scoped review found duplicate canonical ifName ambiguity despite distinct ifIndex/alias/description evidence; three regression cases genuinely failed, then passed with the shared uniqueness guard. Re-review found no remaining concrete findings in the two new source/test files. The initial missing-module collection error is not behavioral RED.
- Reproduce from repository root: `PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 sidecar/.venv/bin/python -m pytest -p no:cacheprovider sidecar/tests/topology sidecar/tests/parsers/test_dispatcher.py -q -rs`. Log: `/tmp/ccie-phase6-topology-final.log`; ambiguity RED: `/tmp/ccie-phase6-duplicate-ifname-red.log`. Offline installed probe: `/var/folders/9g/wq8jzzxx40n7zdntcl67t8x00000gn/T/ccie-topology-phase6-xqj6tu7w/probe_installed_snmp.py`, run with `sidecar/.venv/bin/python -I`; log `/tmp/ccie-phase6-installed-probe.log`. Scratch evidence is temporary, not a released compatibility guarantee.

### Remaining gates and scope

**Full Phase 6 is not implemented or enabled.** Resolve Context7 authentication; establish a pinned, directly declared, hashed dependency/release path including Windows; design a narrow SNMPv3 credential-reference handoff within the existing encrypted vault; then implement an independently terminable read-only worker and source-aware receipt ownership under existing admission limits. Prefer v3 authPriv; v2c must be an explicit operator selection. No default communities, credential spraying, SET, unattended subnet scanning or automatic SNMP/SSH fallback. Add actual OID decoding, ASN.1/missing-table/permission/timeout/limit fixtures and native worker cleanup/packaging checks before enabling a UI entry. Authorized lab comparison remains a separate gate. Phase 5 physical association and earlier native/device/export acceptance remain open.

Only two new offline Python files, this plan, the mistake ledger and owned Graphify outputs are changed by this subset. Existing dependency/lock, Rust, frontend, shared SSH, parser bridge, sidecar server and secret-storage code remain untouched; no Rust/frontend/build/native tests were rerun for this offline-only change. Phase 5 test counts above remain historical evidence, not Phase 6 reruns. Branch/HEAD and index are preserved. No device access, dependency install, app/dev-server restart, credential inspection, commit/push or external publication occurred. Owned graph refresh and before-image audit are recorded in `graphify-out/securecartography2-review-20261105-sik42r54/phase6-implementation-manifest.json` and the Phase 6 scratch directory; canonical graph and historical manifests are preserved. AST navigation is not runtime proof.

## Implementation completion — 2026-11-06

Authorization: **“use subagent driven and finish this up please”**. Three bounded implementation agents handled the Python SNMP collector, native discovery/supervision/receipts, and PNG/export verification. Parent integrated Vault/discovery UI, interface evidence and inspector, then ran aggregate verification. Independent Python, Rust, TypeScript and React reviewers rechecked corrected findings. This section supersedes earlier statements of unimplemented code; historical results above remain unchanged.

### Delivered code

- **SNMP collection:** `snmp_worker.py` performs read-only numeric GETBULK outside the persistent sidecar; `snmp_mib.py` validates raw numeric OIDs/ASN.1 and joins IF/CDP/LLDP tables before the existing neighbor contract. Correct CDP address/primary-management columns and Cisco IPv6 type20; LLDP management indexes retain address pairing/order/duplicates. Unavailable objects/incomplete walks are fixed failed outcomes, never empty success. An independent joined-interface limit prevents over-limit prerequisites becoming completed empty tables.
- **Worker boundary:** one authoritative saved host and selected credential, request≤16KiB/result≤2MiB; independent rows/cells/bytes/calls limits, bounded stdin read, Python collection80s and native hard85s. The native deadline also covers resolver/executor shutdown hangs that Python cancellation cannot prove away. Native supervises owned processes through cancel/drop/shutdown/kill/reap. No credential arguments/environment/logs; trusted isolated imports, and no release checkout fallback.
- **Vault and UI:** versioned encrypted profiles reuse `snmp_community`; public metadata is only format/version. Default v3 SHA-256/AES-128 authPriv, explicit warned v2c, strict fields/ports, no legacy reinterpretation. Discovery chooses explicit mode and one matching unlocked profile by ID, without revealing the value or sending SSH passwords. No fallback, SET, credential guessing or new address crawl. Existing saved-host budgets apply.
- **Receipts:** V0100 adds source-command authority while preserving populated V0099 data/tokens. `snmp:cdp`/`snmp:lldp` do not overwrite CLI receipts. Safe table provenance retains per-row native timestamps and latest-attempt flags. Failed identical rows do not refresh timestamps; partial failures can add unresolved rows without changing canonical observations. Historical union remains bounded and rejects atomically rather than silently pruning. Inspector distinguishes table evidence from topology freshness.
- **Routing association:** opt-in SSH routing collects `show ip interface` once; installed Genie schema supplies default-VRF IPv4 address/prefix ownership. A single eligible same-subnet owner can annotate evidence without changing ports, routing IDs, management targets or L2 edges. Missing/ambiguous/overlapping/unsupported/loopback/tunnel/null/self evidence stays unknown. The annotation expressly does not prove a direct session or physical cable.
- **PNG:** complete graph or complete filtered scope, not a viewport screenshot. Measured renderer node/handle/font geometry plus exact cubic edge paths are serialized as self-contained SVG primitives and rasterized using a data-image URI permitted by native CSP. Parallel/reversed links, signed self-loops, hostile/long labels and off-screen nodes are covered. Native binary helper handles save/cancel/error and abort before write; limits are16,384px per dimension,32Mi pixels,10MiB source/output. No CSP expansion or external image fetch.
- **Dependency packaging:** directly pinned already installed PySNMP7.1.22, retained existing lock hashes/unrelated edits, added exact installed BSD-2-Clause license. Agent verified offline lock/check206packages, frozen hashed export and actual wheel contents/Requires-Dist/license. No install/upgrade; no OS release-artifact claim.

### Final verification

- **Rust110passed:** final parent `--lib topology::`40tests plus70 across discovery Phase4(2), evidence Phase5(11), foundation(19), graph CRUD(6), ingest(7), interchange(21), migration(4). Includes real controlled child-process kill/reap tests, populated V0099→V0100 migration, CLI/SNMP independence, historical provenance, stale results and atomic limits. Fresh `cargo check --lib` passed; existing `retry_retained_sidecars` dead-code warning remains.
- **Python244passed, zero skips:** final parent topology plus parser-dispatcher run, including installed ASN.1/bulk behavior with mocked lower transport, raw synthetic interface parser fixtures and abbreviation regressions. No actual SNMP or SSH device was contacted. The worker agent separately passed139focused tests.
- **Frontend330files /2,731tests passed** in the final parent rerun with worktree/archive/Graphify exclusions and maxWorkers4. Production `build:relaxed`, structural-color guard and contrast guard passed (3themes,42semantic pairs,906rule-level usages,0unsupported). Existing Monaco sourcemap/jsdom navigation and Vite chunk-size notices remain; no root strict-test TypeScript/Clippy/lint acceptance is claimed.
- **Browser discovery:** parent reran `scripts/tests/topology_discovery.browser.mjs`, including explicit SNMP profile metadata selection/no reveal/no SSH passwords, routing disabled for SNMP, scope/Stop/reset/remount and evidence. Synthetic IPC only. Narrow390px layout has no horizontal overflow;12observations expand the existing inspector to4722px and final actions are reachable by page scrolling, not a viewport-bounded inspector.
- **PNG browser/editor engine:** agent Chromium harness proved6exported curves exactly equal actual NeighborEdge paths; rasterized full5190×2109 and filtered1048×646 outputs contain text/off-screen/edge pixels under data-image CSP, with no external requests. Installed Draw.io26.2.2 Graph/mxCodec decoded3independently editable/movable vertices and6editable links, preserved positions and endpoints after independent edits. **Full desktop EditorUi startup hung and was stopped/bounded; this is engine/model acceptance, not full desktop UI acceptance.** Native save IPC was synthetic.
- Logs: `/tmp/ccie-topology-completion-{rust-lib,rust-integration,python,vitest-final,check-final,build-final,browser}.log`. Browser evidence: `/var/folders/9g/wq8jzzxx40n7zdntcl67t8x00000gn/T/ccie-topology-discovery-MTnGxQ/` and `ccie-topology-interchange-LQf8YT/` under the same temporary parent. Evidence is local/temporary, not a release guarantee.
- Owned structural Graphify refresh/audit is recorded in `graphify-out/securecartography2-review-20261105-sik42r54/completion-implementation-manifest.json`; see its exact hashes/counts and `GRAPH_REPORT.md`. Canonical project graph and historical manifests are protected. AST navigation is not behavioral evidence.

### Remaining operator/release acceptance — not missing collector code

1. Authorized lab: known/unknown/changed SSH host keys, actual v3/v2c CDP/LLDP port/address accuracy, ambiguous/denied/unreachable targets, Stop and sidecar responsiveness on identical bounded scope. No superiority over SC2 has been demonstrated.
2. Native application: restart persistence, real SSH/NETCONF open/no duplicate PTYs, native lifecycle cleanup and actual WKWebView PNG/dialog/filesystem save/cancel. Existing app/dev server was not restarted.
3. Release: build and verify supported OS artifacts with bundled Python/dependencies/license; Windows discovery remains unsupported. Existing cryptography CFB deprecation needs dependency compatibility/release follow-up, not a patched third-party implementation.
4. Restore configured Context7 connection (`invalid_target`) and complete documentation acceptance. No successful Context7 fetch is claimed.
5. Full installed Draw.io desktop UI open/edit/save acceptance; engine/model tests are narrower.

No live-device access, real credential inspection, dependency installation, app/dev-server restart, Git staging/commit/push/merge, release or external publication was performed. Pre-existing unrelated dirty work and running server were preserved.

## EIGRP collection follow-up — 2026-11-08

Authorization: **“can we add that collector”**, following clarification that the original EIGRP support covered import/display only. This follow-up supersedes the earlier import-only scope, not the historical verification records.

- Existing SSH routing opt-in now also collects exactly `show ip eigrp neighbors` for saved Cisco IOS/IOS-XE profiles. CDP/LLDP remain default; SNMP routing remains disabled. Strict host trust, exact command validation, process supervision, parser admission, size/deadline limits, Stop semantics and eligible saved-profile scope are unchanged.
- Installed Genie `iosxe/show_eigrp.py` schema was inspected directly: AS → VRF → AF → local interface → neighbor rows. The canonical evidence retains AS in `instance`, peer address, AF/VRF and reported local interface. Complete neighbor-table membership supplies `up`, not a queue-count inference. Missing/invalid fields remain unknown. Distinct AS identities do not merge. Only supported default-VRF IPv4 established evidence becomes logical map links; unsupported contexts remain observations. No peer becomes a management address in either evidence or legacy mode, and no routing peer becomes a recursive target or an invented remote port.
- Valid zero-neighbor success requires exact classic/named IPv4 table framing with implicit or literal `VRF(default)`, optional exact command echo and both header lines. Unframed/parser-empty/junk/CLI-error/other-scope empty output cannot refresh evidence as completed empty. Existing optional interface association remains same-subnet support, never physical-cable proof.
- V0101 extends the receipt protocol CHECK while preserving keys, source commands, existing JSON and attempt tokens. Applied V0099/V0100 remain unchanged. `build.rs` now tracks migration-directory changes so newly added embedded migrations are rebuilt. Upgrade/reopen/cascade and ownership regressions exercise a synthetic populated V0100 database, not the running app database. Next free migration is V0102.
- UI help explicitly says IPv4/default-VRF neighbors, not routes or the full EIGRP topology table. Existing inspector/filter/render paths already handle EIGRP; a regression now checks its peer/interface values, AS, state and scope. Real Chromium discovery harness passed with synthetic IPC; the narrow routing-control screenshot was inspected. Default-off/reset, SNMP disabling, focus, scope and Stop checks remain intact.
- Final frontend checks: 12 files / 134 tests passed, production `build:relaxed` passed, structural-color and three-theme contrast guards passed. Final parent isolated-HOME topology/parser run passed 296 tests, zero skips. The implementation agent additionally simulated Genie unavailable: 9 passed / 44 intentionally skipped. Final rebuilt Rust checks passed 42 topology unit tests plus 72 integration tests across seven targets (discovery 2, evidence 13, foundation 19, graph CRUD 6, ingest 7, interchange 21, migration 4). Includes populated V0100 upgrade/reopen/cascade/ownership, AS identity, unsupported scope, missing evidence, optional snapshot and failed/empty freshness. Logs: `/tmp/ccie-eigrp-rust-verified.log`, `/tmp/ccie-eigrp-integration-verified.log`, `/tmp/ccie-eigrp-python-reviewed.log`, `/tmp/ccie-eigrp-ui-reviewed.log`, `/tmp/ccie-eigrp-build.log`, `/tmp/ccie-eigrp-browser.log`. Intermediate failures remain documented in the mistake ledger, not relabeled as green.
- Independent Python review findings (legacy management promotion, explicit-default empty framing, parser availability) were corrected with genuine RED/GREEN regressions and rechecked with no remaining finding in scope. React review's missing value assertions were strengthened and passed. Rust scoped review found no actionable EIGRP defect; cargo check passed, while global clippy still failed on five warnings outside this delta. No repository-wide strict TypeScript/Clippy approval is claimed. Context7 remains configured but connection failed `invalid_target`; installed source was used, not fetched documentation.
- Native/live boundary: the existing development app was not restarted or replaced and still runs the earlier collector binary. A coordinated native rebuild/restart is required before an operator EIGRP run. No actual switch command, credential inspection, dependency installation, stage/commit/push, release or external publication occurred. Full routes/topology table, other VRFs/IPv6 collection, terminal auto-ingest and legacy single-device discovery expansion are not included.



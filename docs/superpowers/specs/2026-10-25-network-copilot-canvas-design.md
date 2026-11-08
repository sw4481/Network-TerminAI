# Network Copilot Canvas

Date: 2026-10-25

Status: full design and implementation plan approved on 2026-10-25, including the UI baseline and decisions Q1–Q17. Surgical, minimal subagent-driven execution is underway; task reviews and verification are recorded in the implementation progress ledger.

## 1. Purpose and acceptance journey

Add a graphical evidence workspace beside the existing Network Architect conversation. The Architect remains the CCIE networking copilot that plans investigations and invokes the existing tools. Canvas presents meaningful results; it is not another agent or execution engine.

The user's first acceptance journey is:

> Show me all switch-related issues in my network, with information on why each issue is occurring and how to remediate it.

This does not promise exhaustive discovery, confirmed causes without sufficient evidence, or access to unconfigured platforms. It does not restrict Canvas to switching, troubleshooting or one vendor. Other questions should receive appropriate visual representations when the existing Architect can investigate them.

## 2. User-approved decisions

- Q1–Q3: One named, reopenable investigation contains conversation and curated evidence. Use an automatically arranged, scrollable board, not an infinite spatial whiteboard or a card for every tool invocation.
- Q4: Existing Architect authority and execution/approval behavior remain unchanged. The user's explicit direction was “same as the architect do not alter that”.
- Q5–Q8: Dedicated main workspace, chat left and board right, adjustable divider. Terminals remain accessible elsewhere. Cards appear as available. Evidence is timestamped and immutable; reopening does not rerun tools. Selected cards become explicit context for the same Architect conversation.
- Q9–Q10: Use the fleet-wide switch question above. Autosave title, conversation and completed evidence; restore interrupted runs as interrupted, not silently resumed.
- Q11–Q14: Show actual coverage and missing evidence. Separate supported, likely and undetermined causes. The initial request produces remediation advice, not changes. For this fleet journey, start with switch-grouped findings and allow issue drill-in.
- Q15: The reviewed synthetic interactive mockup is the visual baseline.
- Q16–Q17: The same Architect chooses appropriate forms through validated presentation metadata. Observed table/chart values come from captured source references, not model retyping. Calculations are labeled derived; narrative interpretation is separate.

## 3. Visual and interaction design

### Authoritative mockup

The Q15 baseline is archived at [assets/network-copilot-canvas-review.html](assets/network-copilot-canvas-review.html), revision 2026-10-25, SHA-256 `a1abbd21cd649766c116a05f3592dbcb70c32929c74dd5c02727f556a1868b8b`. This is an exact byte-for-byte copy of the reviewed session mockup, including its pre-approval state/focus/selection corrections and explicit UTF-8 declaration. No new UI revision was introduced by archiving it.

It is a design-only synthetic preview, not application implementation: no connected Architect, actual autosave, network calls or executable remediation. Its disabled Send control, synthetic findings and preview-state controls are not production features. Sections below define production behavior where the mockup only simulates it. The archive, rather than a temporary local-server URL or an older screenshot, identifies the baseline for the builder.

### Workspace

Use the application's semantic theme tokens and existing controls, not Cisco branding. The approved mockup demonstrates dark surfaces, cyan accent, a persistent left conversation, and a wider right evidence board. Support the application's light theme as well.

Provide a visible Canvas entry through the app's existing workspace navigation, a mounted main view, and a way to reopen named investigations. A keyboard shortcut alone does not satisfy discoverability. The builder should use the current navigation mechanism after inspecting it, not invent another application shell.

Chat and board scroll independently. The divider is adjustable. At narrow widths, provide a usable stacked/toggled presentation without squeezing both sides into unreadable columns. Long identifiers and source output must not force horizontal page overflow; tables/code have their own accessible overflow containers.

### Fleet overview

Show the title, actual investigation scope, observation/collection times, run status and separate save status. Above findings, show assessed, unavailable and unassessed devices/checks where known. If the inventory denominator is unknown, say coverage unknown; do not create a completion percentage. A device assessment is not proof that every possible check was performed: show the checks/categories actually assessed and material omissions.

While collecting, say “Findings so far”. Group the findings table by stable switch identity. Communicate symptom/interface, severity, cause assessment, selection and inspection without hundreds of repetitive device cards. Compute counts/grouping from referenced records rather than accepting unchecked model-authored totals.

Use “Unavailable” for the combined category and retain precise reasons, such as timeout or authentication failure. Authentication failure does not prove network unreachability. No findings under incomplete coverage is not an all-clear.

### Issue detail

Keep chat accessible and provide a clear route back to the originating finding. Show:

1. Observed problem: device/interface, source, collection time and actual observation window.
2. Cause assessment: evidence-supported, likely or undetermined, with supporting/contradictory evidence and unknowns. No invented confidence percentages or business impact.
3. Remediation: recommendation, prerequisites, risks, verification and rollback considerations where supported. Label it “Recommendation — not executed”.
4. Inspectable evidence and redacted source excerpts. Historical events must not be forced into misleading before/after columns.

“Add to chat” attaches explicit, removable evidence-context chips to the draft. Selecting or inspecting a card does not send a turn or authorize changes. Pending checkbox selection and attached draft context are different states. Filters must not leave hidden pending selections that unexpectedly attach unseen findings.

Navigation/filter state is independent of run/refresh status. Inspect/back must not change collection counts or clear stale-evidence warnings. A failed recheck retains previous evidence unchanged and reports the failed attempt. Fresh observations create new snapshots rather than changing the basis of old conclusions.

### Appropriate representations

Use tables for comparable records; key/value cards for one entity; charts for real quantities/time series; topology for evidenced relationships; exact text/configuration where structure would misrepresent the source; and explanatory cards for assessment/remediation. Do not manufacture a trend from one snapshot.

Chat still provides the direct answer and limitations; users should not need to inspect cards to understand a simple answer. Discovery calls, retries and schema lookups can remain in activity/chat instead of becoming cards.

## 4. Existing implementation and reuse boundary

Source reconnaissance established these constraints; it was not runtime acceptance:

- `src/components/AgentPanel.tsx:850–945` dispatches the existing react-code route with recent text history. `src/lib/tauri.ts:1485–1502` sets up the channel. Reuse that execution path rather than duplicating it.
- `bundled-agents/network-architect/AGENT.md:122–125` selects react-code/deepagents. The configured sandbox and existing specialist delegation remain the backend.
- `sidecar/src/ccie_sidecar/agents/architect_subagents.py:891–899` returns formatted execution output, not an original vendor object exposed through stable handles.
- `sidecar/src/ccie_sidecar/agents/tool_output.py:321–330,411–413,502–586` retains latest bounded text. `tool_output.json()` reparses it. Defaults are 48,000 inline characters and a 2 MiB latest-result retention bound. Complete valid JSON stdout is conditionally reusable; mixed/clipped text is not a complete structured dataset.
- `src-tauri/src/commands/ai.rs:1129–1136` forwards success/string output. Ordinary result events in `src/lib/tauri.ts:1259–1265` do not yet provide a general correlated evidence/card contract.
- Temporary chat code/result blocks are not reloadable evidence storage. An apparent Architect assistant-answer save gap in `src/components/AgentPanel.tsx:570–580,1082–1105` must be reproduced before treating it as a confirmed defect.
- Reuse candidates are `src/components/api/ArrayTableView.tsx`, `src/components/topology/InlineTopologyPanel.tsx`, `src/components/DiagramPanel.tsx`, existing Markdown rendering and the application database. `src/state/diagramStore.ts` is not already workspace/turn-owned evidence storage.
- No general statistical-chart renderer was found in the inspected UI/direct dependencies. Existing topology/diagram support is not a substitute for quantitative charts.

Revalidate line anchors against the current checkout before planning edits. Installed agent overrides and all vendor mutation policies were not audited; unchanged authority is a requirement, not a security-audit claim.

## 5. Minimal additional architecture

Keep the existing Architect, tools, sandbox, specialists, bridge, approvals, limits, cancellation and continuation mechanisms. Add only:

- Stable workspace/turn/tool-call/evidence/card association.
- Bounded, redacted evidence capture and references.
- A small data-only presentation contract exposed to the same Architect during Canvas turns.
- Progressive evidence/card transport and durable saves.
- The approved view and selected-evidence handoff.

Extract the smallest shared execution seam if necessary. Do not copy AgentPanel's dispatch/approval machinery into an independent implementation. Ordinary Architect chat must not suddenly emit Canvas cards or change behavior.

### Capture at actual result boundaries

Capture results where actual helper/source identity is known, before formatting/truncation loses information. Preserve request arguments, approvals, helper return values and existing text output. Use the existing helper wrapping/capture patterns where compatible, without changing their existing memory behavior.

Application code assigns capture identity, call correlation, collection time and completeness. A source/network timestamp is a separate field. Do not trust model-authored provenance as proof of a call.

Apply existing sensitive-data protections before persistence/display. Persist the redacted source data needed to reproduce saved cards, including their evidence excerpts. Temporary unreferenced capture is bounded; do not create a permanent duplicate archive of every discovery response. Do not silently discard evidence backing saved cards or automatically delete old workspaces.

Do not raise existing output/context/step/timeout limits. If a result cannot be captured completely within applicable bounds, expose that limitation and reject unsupported complete-dataset projections. A capture/render/save failure is distinct from a network-call failure: do not retry a successful vendor operation or relabel it failed because Canvas failed.

### Data-only presentation

A presentation identifies a known card type, title, evidence IDs and simple validated row/field selections. The renderer reads observed values from those references. It does not parse final prose into authoritative data or ask the model to restate a source array.

Stable device/interface/source identifiers stay source-bound. Friendly labels must keep actual source paths inspectable. No arbitrary JavaScript/HTML, dynamic modules or executable chart callbacks. Tool strings are data.

The findings overview is a synthesized agent assessment backed by evidence, not a raw API table. Symptom narratives, severity and cause classification are explicitly interpretation. Observed identifiers/measurements are reference-bound, while grouping/counts are computed.

When calculations are required, use the existing approved computation path and capture a derived result with parent evidence references and an inspectable calculation description. Do not introduce a transformation DSL or label derived data as direct observation.

Reference validation prevents misassociation and inaccurate value copying; it does not prove that diagnosis, labels, units or model-authored calculations are semantically correct. Contradictions and uncertainty still matter.

Invalid references, missing fields, unsupported shapes and clipped output produce a visible warning or honest raw-text fallback, not fabricated rows or an empty success state. Card failures must not erase the existing chat result.

Use existing renderers first. The builder may select one established chart library after verifying actual dependencies/current Context7 documentation; do not build a chart framework. Charts need meaningful units, stable series identity, accessible labels and a tabular alternative. Do not use color alone to convey findings or series.

## 6. Persistence and follow-up context

Use the existing application database and message infrastructure. Exact tables/indexes, type names and the next migration number are builder decisions after inspecting the current repository, not remembered numbers.

Persist the minimum records for:

- Named workspace identity and stable conversation ownership.
- Run/turn identity, status, timestamps, known scope and coverage.
- Redacted evidence backing cards: actual origin, completeness and observed/derived distinction.
- Card presentation, evidence associations and arranged order.
- Conversation content, including completed Architect answers, through the existing message-save path.

Make workspace ownership independent of whichever terminal is active. Reopen must not silently spawn a PTY or attach unrelated chat. Reuse existing message keys where possible; add the smallest workspace association if terminal-derived keys cannot represent this safely.

Autosave completed evidence/card changes and meaningful run states. Clearly separate “collecting”, “saved”, “save failed” and “interrupted”. Restore without polling, retries, approval replay or execution. Existing valid continuations remain owned by the current engine; do not add a restart/resume engine.

Selected-card context supplies explicit references plus bounded relevant evidence, not the whole board. Disclose omissions/size limits rather than silently dropping selections. Follow-ups remain in the same Architect conversation. Later explicit requests to execute changes use the unchanged existing authority and approval path.

## 7. Non-goals

No second agent, replacement execution system, provider/model change, rule engine, per-vendor response-parser catalog, separate server/database service, automatic polling, scheduled collection, infinite board, drawing tools, arbitrary connectors, collaboration, export/share feature or generated web application.

Do not resurrect the removed Canvas implementation/design or automatically inspect/import/delete its saved application data. Do not refactor adjacent features, run wholesale formatting, alter peer-owned graph work or touch unrelated dirty changes. No commit/push, dependency install, build or live network call is authorized by this document.

## 8. Later implementation acceptance gates

These are required future checks, not completed verification:

1. **Architect parity:** ordinary and Canvas turns preserve dispatch, target binding, approval/resume, cancellation and budgets. Canvas interactions add no implicit network calls or authority.
2. **Evidence fidelity:** concurrent calls cannot cross-associate cards. Observed values equal referenced snapshots, including adversarial component/slot examples. Interpretations/calculations are labeled.
3. **Honest incompleteness:** mixed/malformed/clipped/empty results and failed collection stay distinguishable. Missing coverage never becomes an all-clear or invented denominator.
4. **Progressive states:** useful cards arrive before the answer finishes. Inspect/back/filter preserve coverage and stale warnings. Incoming results do not unexpectedly reorder a row being inspected.
5. **Durability:** reopen restores conversation and evidence with no network call, PTY spawn or automatic continuation. Save failures are visible.
6. **Follow-up:** one/multiple selected cards reach the same Architect with explicit, correctly scoped references and tested context-size handling.
7. **Safety:** redaction precedes persistence; source text cannot execute scripts or bypass an approval.
8. **UI:** keyboard access, focus restoration, headings/headers, non-color status, independent scrolling and usable overflow. Measure at 1440×1000 and 1280×800, narrow layout, and light/dark themes; do not infer native acceptance from unit tests.
9. **Reachability:** visible navigation entry, actual main-view mounting and saved-workspace reopening work together.
10. **Real journey:** after isolated checks and explicit live-test authorization, run the user's fleet-switch question through the actual app. Verify intermediate cards, source fidelity, final answer, missing evidence, advice-not-action and reopen behavior. Synthetic data cannot substitute.

## 9. Review status and builder-owned details

The enterprise-networking UI specialist reviewed the approved mockup source and one desktop screenshot, not production behavior. A small Node/vm check passed for navigation preserving collecting/failed-refresh state and the declared UTF-8 metadata. Detail/narrow-layout browser behavior remains unverified; the screenshot predates the charset correction.

Builder-owned details include component extraction, names/schema, bounded capture mechanics, renderer adapters and chart-library choice within this design. These are engineering choices, not additional product approvals.

The relevant `Plans/Mistakes.MD` lessons apply: citations/schema validation do not establish semantic truth; separate run and view state; verify completion in the actual UI; preserve unrelated edits. Reproduce the apparent answer-save gap before fixing it.

The session's bounded Graphify refresh was hash-verified, not certified as whole-repository freshness. After approved source implementation, update only affected graph scope without overwriting peer contributions.

Independent builder check: completed. The reviewer identified one missing prerequisite: an authoritative location/revision for the approved mockup. Section 3 now supplies the archived exact copy and checksum; the reviewer confirmed “nothing important left” to clarify before planning. This check does not validate source correctness or runtime behavior.

Next: execute the approved implementation plan using the user's selected subagent-driven method, with task-level reviews and separately recorded runtime acceptance. Full-design and implementation-plan approvals are complete.

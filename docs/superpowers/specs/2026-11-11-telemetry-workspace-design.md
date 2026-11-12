# Telemetry workspace design

Status: design draft for Shaun's final review. Q1–Q18 and the dashboard/editor visual directions are accepted. An independent builder check found nothing important left unanswered for planning. This document is not an implementation plan or authorization to implement.

## Intent

Add an attractive native Telemetry tab to Network-TerminAI for live troubleshooting of the computer running the app and a selected fleet of network devices. Reuse existing tab, connection, parsing, editor and chart infrastructure. Take inspiration from terminaltelemetry2's configurable panels while retaining the app's React/Tauri presentation.

The distinguishing requirement is full YAML widget authoring, including editable TextFSM templates and captured-output testing. This is part of the initial feature, alongside routing and switching visibility.

## Accepted scope

| Area | Agreed behavior |
| --- | --- |
| Desktop | Local machine running macOS, Windows or Linux |
| Network platforms | Cisco IOS and IOS-XE initially |
| Fleet | Design and acceptance baseline: 10 simultaneous network targets |
| Collection | Read-only; saved SSH connections for network devices, built-in OS collectors for the local PC |
| Dependencies | No AI/model, external monitoring server or remote PC agent required |
| Views | Fleet, Device, Local PC and Widgets authoring workspace |
| History | Rolling one hour in memory; no history across tab close/app exit |
| Lifecycle | Explicit Start/Stop; continues across view/tab switches; stops on closing Telemetry or quitting |
| Configuration | Persistent user YAML widgets, layouts, platform defaults, per-device overrides and TextFSM template overrides |

Initially support all three desktop operating systems and the full agreed Cisco panel scope. A platform-specific missing permission, unsupported command or absent metric must be visible; it must not silently narrow support or produce a healthy zero.

Other network vendors, remote Linux host monitoring, SNMP metric polling, streaming gNMI, unattended background services, durable metric databases, external notifications, automated remediation and AI analysis are outside this design. Existing integrations remain available in their existing workflows.

## User experience

Match the existing app theme, typography, controls and status colors. The reviewed mockups use the actual dark-theme palette from `src/theme/themes.css`. Production visuals must follow active theme tokens rather than hardcoded mockup colors.

### Fleet

Show the 10 selected targets with human-readable saved names, platform, collection status, CPU, memory, routing summary, ports up and last successful sample. Separate healthy observations, conditions needing attention and collection gaps. Provide selection/start/stop controls using saved connection identities; do not create a separate credential inventory.

Clicking a device opens its Device view. Include routing summary across responding targets, a selected-interface traffic chart and a compact Local PC summary. Totals declare coverage and exclude unknown measurements rather than treating them as zero. Collection status and device/protocol condition are distinct: a reachable device can have a failed widget, and an unanswered poll does not prove a device is down.

### Device

Provide Overview, Routing, Switching and Interfaces sections. Keep tables searchable where appropriate, charts labeled with units and time, and command/parser errors inspectable without overwhelming the default view.

| Section | Required information |
| --- | --- |
| Overview | Identity/version/uptime, CPU, memory, interface summary, selected uplink traffic and current observations |
| Routing | BGP peers/state/AS/uptime/prefixes; OSPF neighbors/state/interface/context; EIGRP neighbors and relevant context |
| Switching | VLANs and trunks, STP root/port roles/states, EtherChannel and member states, CDP/LLDP neighbors, searchable MAC table |
| Interfaces | Admin/link/protocol states, descriptions, rates/utilization where available, errors/drops, addressing and interface traffic drill-down |

Show available protocol/process/VRF context so unrelated adjacencies do not collapse into one row. Unconfigured, unsupported, not collected, failed and stale are separate states. A protocol panel reports only what the commands and parser actually establish.

A physical port display is a convenience backed by real interface inventory, not a fixed 48-port assumption. Devices whose inventory cannot support a physical layout retain a usable interface table. No implied physical topology is inferred from routing neighbors.

### Local PC

Show overall/per-core CPU, memory, filesystem capacity, network adapter traffic and top processes, with rolling charts where meaningful. Collect from the machine running Network-TerminAI, not an SSH target. Expose OS-specific labels and permission limitations without requiring elevated privileges for the entire app.

Use consistent documented units and CPU semantics. Missing process access or unsupported per-core detail remains explicitly unavailable while other metrics continue. Widgets select built-in local collector fields; YAML is not an arbitrary local shell execution facility.

### Widget studio

Use the accepted library → YAML editor → sample preview arrangement. Reuse the installed Monaco/YAML editing pattern with completion, syntax highlighting and line/column diagnostics. Keep an editor draft distinct from the effective applied definition.

Support creating widgets and editing titles, collection-source bindings/platform commands, parser bindings, field aliases, refresh intervals, view types, table columns/labels, thresholds and dashboard placement. Initial view primitives cover the agreed dashboard: tables, key/value summaries, aggregate/stat tiles and time-series charts/sparklines. Unsupported primitives produce explicit diagnostics.

Import/export YAML so definitions can also be edited externally. External-file imports create drafts and never bypass validation or silently hot-apply. Layout definitions control panel ordering, grouping and relative placement through the same validate/preview/apply discipline.

## YAML and parser contracts

Use a versioned documented schema, preserving familiar upstream concepts where practical: widget identity/title, per-platform commands/templates, field aliases, row keys, polling interval, view configuration, alerts and layout placement. The builder chooses exact internal schema details and native local-source syntax; publish representative network, local, routing and switching examples.

Field aliases map parser output to stable metric names. Stable row keys distinguish legitimate repeated entries by sufficient protocol/VRF/interface context. Computed rates, counter deltas, basic bounded arithmetic and threshold conditions are declarative data operations, not executable Python/JavaScript or general expressions with code access.

### Validate → Preview → Apply

1. Validate YAML syntax, schema version/types, duplicate keys, widget/layout/template references, field mappings, intervals and source compatibility. Validate backend-side as well as in the editor.
2. Preview against a matching captured output/sample with a known platform, command and parser. Show raw capture, parsed records and rendered widget; show a mismatch or unavailable sample rather than presenting unrelated records as proof.
3. Before Apply, identify the changed scope and affected targets. Apply the validated revision explicitly. A changed draft invalidates its previous validation/preview.

Invalid edits/imports preserve the last working configuration. Apply definition/template/layout changes consistently so a running poll cannot pair an old parser with a new schema. Update scheduling at a safe collection boundary; discard results whose target/config revision is obsolete. Save configuration atomically and retain the working revision when saving fails.

Separate immutable bundled defaults from persistent user overrides. Reset loads the bundled default into the draft; validation, preview and explicit Apply still govern making it effective. App upgrades do not overwrite user overrides. Secrets and raw credentials never belong in YAML; refer to existing saved connection identities.

Configuration precedence is bundled defaults → user platform profile → explicit device override. Show when a device override masks a profile change. A layout edit changes presentation without destroying retained metric history; source/key/unit changes reset incompatible series instead of splicing incompatible samples together.

### Editable TextFSM templates

Allow selecting, creating and editing user TextFSM templates as well as changing widget bindings. Provide captured-command-output testing with parsed rows and useful errors. Preserve bundled templates. Template changes follow the same draft/preview/apply lifecycle and identify affected widgets/targets. New templates never become trusted merely because they return some rows: sample/platform/command binding must match.

Captures can include device information. Keep them local, bounded and inspectable; do not send them to AI or external services. Explicitly imported/saved test fixtures may persist as user configuration assets; incidental live raw output is retained only within the bounded active workspace unless explicitly saved. Do not persist credentials in fixtures.

### Upstream YAML imports

Import the supported subset of terminaltelemetry2 definitions through an explicit adapter/version boundary. Report unsupported fields/features, unknown platform identifiers, missing templates and unsupported view types with actionable diagnostics. Do not silently drop behavior or execute unsupported hooks. Display compatibility results before Apply.

Full upstream compatibility is not promised. Arbitrary Python parser hooks, Qt-specific presentation and shell execution are outside the supported runtime. Imported TextFSM assets must have compatible field expectations and appropriate provenance. Upstream declares GPL-3.0-or-later; that declaration is a source-reuse consideration, not a legal conclusion. Prefer existing app infrastructure and independently authored definitions; copied upstream assets require an explicit provenance/license review before inclusion in shipped artifacts.

## Collection and lifecycle

| Source/panel | Accepted default |
| --- | --- |
| Local metrics | 2 seconds |
| Network metric/protocol panels | 30 seconds |
| Explicitly selected interface traffic | 5 seconds |
| Inventory | 60 seconds |

Intervals are YAML-editable within validated runtime bounds. These are scheduling intentions, not guaranteed collection latency. The builder sets and documents safe bounds, per-command timeouts, concurrency and output/memory limits against the 10-device baseline.

Deduplicate identical command requests for the same target at the fastest required interval and share compatible parse results. Serialize conflicting CLI work per target. Slow polls do not create a backlog or overlap indefinitely; skip/coalesce overdue ticks and expose reduced freshness. One stalled target must not monopolize the collector or block local metrics.

Reuse saved SSH identity, credentials and relevant connection settings. Telemetry collection must not inject commands into or consume output from the user's interactive terminal. Use owned, cancellable collection resources and preserve host verification. Do not inherit a legacy transport's disabled host verification or assume request timeout kills underlying work. Do not globally weaken unrelated SSH behavior.

Validate platform-specific read-only operational commands before collection. Reject configuration, destructive/interactive commands, shell chaining and executable hooks. A `show` prefix alone is not proof of a safe command. The builder defines conservative supported command shapes for the agreed panels and makes rejected custom bindings actionable. YAML can author widgets over admitted sources; adding a new command capability cannot bypass this boundary.

Start uses explicit selected targets. Selecting a different view, minimizing the app or activating a terminal tab does not stop the workspace. Stop cancels new scheduling and owned in-flight work, retains existing samples and displays them as stopped rather than live. Removing a target cancels its owned collection and invalidates late results. Closing Telemetry/quitting clears its metric history and terminates collection, including child processes/SSH resources. Configuration persists independently.

On failure, retain the last successful timestamp/value as historical data, mark freshness and retry with bounded backoff. Parsing, authentication, permission, transport and unsupported-command failures are distinguishable. No tight retry loops or silent authentication hammering. Reconnect starts a fresh counter baseline. Sleep/resume must expose the gap, coalesce elapsed work and rebaseline counters; do not fabricate samples for the elapsed period.

## Metric history and interpretation

Keep at most the rolling hour in memory, with bounded series/row/sample capacity. Clearly distinguish source-observed values from derived rates and aggregates. Preserve original source units/timestamps alongside normalized display fields where necessary. Do not scrape displayed chart text for future consumers.

Calculate rates from validated monotonic counter deltas over actual elapsed sampling time. First samples, reset/reboot, counter wrap that cannot be established, reconnects and incompatible key/source changes yield a gap/new baseline rather than negative spikes or invented zero. Interface utilization uses observed capacity when available; unknown capacity yields unavailable utilization.

Not every `down` state is a fault. Protocol-aware bundled conditions distinguish normal STP alternate/discarding and valid OSPF 2-Way states from unexpected conditions. BGP state and prefix counts must be interpreted correctly. Never infer a missing configured neighbor from the current neighbor list alone; that needs an explicit expected-state definition. Thresholds/expectations are inspectable YAML data. Changing freshness or threshold policy does not rewrite historical observations.

The structured samples should remain suitable for future AI use, but this feature adds no model calls, prompts, AI dependencies or automatic remediation.

## Reuse boundaries verified in the existing source

Research began at local commit `bad9758f`; use Graphify for navigation and verify current producers/callers before implementation. The refreshed root graph has 47,281 nodes and 152,332 edges; missing SQL parser coverage means graph absence cannot prove schema absence.

| Existing capability | Reuse | Required new behavior / limitation |
| --- | --- | --- |
| Tab system: `src/lib/types.ts`, `src/App.tsx`, `src/components/TabBar.tsx`, `src/state/tabsStore.ts` | Existing tab creation/mount/state patterns | Telemetry ownership, close cleanup and explicit stopped restoration; hidden tabs can stay mounted |
| Saved targets and `src-tauri/src/ssh_exec/mod.rs` | Existing identity/credential resolution and operational-command patterns | Continuous bounded scheduling and cancellable ownership; current one-shot execution is not a telemetry broker |
| Structured parse chain: `src/lib/structured.ts`, `commands/structured.rs`, `structured/auto_parse`, `agent_bridge.rs`, sidecar parsers | Genie/TextFSM and installed template infrastructure | Stable metric mappings, bounded parse work and safe revision association; don't assume shared bridge work is parallel/cancelled on timeout |
| `src/features/troubleshoot/PlaybookEditorMonaco.tsx`, `playbook-validate.ts` | Monaco/YAML editing and diagnostics patterns | Widget schemas and isolated model/schema registration; existing global `fileMatch: ["*"]` schema setup must not hijack other editors |
| Recharts 3.3.0; `src/components/canvas/CanvasChart.tsx` | Chart library and theme/presentation patterns | Live metric series/history; Canvas evidence snapshots are not a sampling service |
| Native topology discovery/isolated workers | Bounds, cancellation and process-lifetime patterns | A telemetry-owned service; do not repurpose discovery as continuous sampling or change its behavior |
| Existing gNMI/SNMP/heartbeat | Knowledge/patterns only where useful | gNMI is bounded ONCE; SNMP is discovery; heartbeat is minute-scale AI checks. None proves a working telemetry collector |

Genie support is not uniform across desktop OSes; the existing TextFSM fallback is relevant to Windows. Verify the agreed parser/collector path on each supported desktop platform rather than relying on dependency presence.

The local-machine collector is new behavior; an existing remote Linux widget or a process utility dependency is not evidence of a working macOS/Windows/Linux collector. Choose the smallest suitable OS collector implementation after checking existing dependencies and packaging constraints.

## Acceptance criteria for the later implementation plan

- All three desktop OSes display actual local metrics and explicit per-metric permission/unavailability states. Verify on the actual OS, not merely through mocked platform flags.
- An authorized IOS/IOS-XE lab validates each required routing/switching/system/interface command and parser against real captured output. Unsupported releases/features remain explicit. No writes or terminal interference occur.
- Ten selected targets can collect concurrently with one slow/unreachable target without starving others; cancellation, authentication failure, reconnect and app/tab close leave no owned polling resources running.
- Fleet → Device → Local PC and Widgets navigation preserves the active workspace; stopped and stale readings never appear live. Closing clears history while saved YAML overrides remain.
- YAML creation/import/export, schema/reference/duplicate-key diagnostics, TextFSM captured-output tests, upstream compatibility diagnostics, profile/device precedence, reset and atomic apply behave as specified. Invalid drafts preserve working definitions.
- Editing widget titles, columns, thresholds and intervals changes the resulting widget; source/key/unit changes safely rebaseline. Template/layout revisions do not mix results across definitions.
- Counter resets, first samples, gaps, empty tables, multi-VRF neighbors, STP blocking and OSPF 2-Way cases have meaningful regression coverage.
- Charts/tables are readable in the approved visual direction, keyboard-accessible, theme-aware and usable at narrow widths; missing values, units, collection times and errors are clear.
- Separate source/unit tests, browser mockup validation, native app interaction, live device traffic and actual multi-OS validation in the acceptance report. One layer does not stand in for another.

## Mockups and current verification

Reviewed dashboard draft: `.superpowers/brainstorm/83831-1794447374/content/telemetry-review-v1.html`.

Reviewed editor direction: `.superpowers/brainstorm/83831-1794447374/content/telemetry-widget-studio-v2.html`. Images in that session directory: `fleet-review.png`, `device-review.png`, `local-review.png`, `widget-studio-desktop.png`.

Mockups use illustrative data and are not production code. Their editor is a textarea with the installed YAML parser, not an integrated Monaco editor. Only the BGP table definition is interactive; TextFSM execution, real scheduling, persistent configuration and network connections are absent. Verified browser behavior covers navigation, sample preview, apply gating, syntax/reference/duplicate-key failures, preservation/reset and narrow layout. Import/export remain unverified because the attempted import assertion was blocked by a file chooser.

## Builder choices and approval boundary

The product scope, visuals, YAML workflow, template editing, import compatibility limits, cadences, sources, override model and memory-only history are user decisions recorded above. The following are engineering calls in this document for Shaun to review: backend-enforced conservative command admission; separate owned collection resources; a versioned declarative schema; atomic revisions and override persistence; explicit sample compatibility; typed metric provenance; bounded retry/history; and physical-port visualization derived from actual inventory.

The builder may choose exact object-oriented service boundaries, schema encoding, resource limits, OS collector dependency and storage location using existing project conventions. Keep those choices minimal; do not add speculative abstractions or a general plugin runtime. Preserve unrelated dirty work, existing topology/terminal behavior and configured credentials.

After this complete design is approved, write the implementation plan with concrete file scope, phases, real validation gates and documented open platform/device constraints. Do not start implementation or claim live monitoring based on the mockups.

## Sources

- [Pinned upstream repository](https://github.com/scottpeterman/terminaltelemetry2/tree/09d2a0b3f9c77e2b85bd5b48a055b7bedb40fe98)
- [Upstream Cisco layout](https://github.com/scottpeterman/terminaltelemetry2/blob/09d2a0b3f9c77e2b85bd5b48a055b7bedb40fe98/terminaltelemetry2/data/layouts/ios.yaml)
- [Upstream widget guide](https://github.com/scottpeterman/terminaltelemetry2/blob/09d2a0b3f9c77e2b85bd5b48a055b7bedb40fe98/docs/WIDGETS.md)
- Current local source paths in the reuse table and `Plans/Mistakes.MD`; Q1–Q18 decisions and visual review in this session.

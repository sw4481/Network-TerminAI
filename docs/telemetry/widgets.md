# Telemetry widgets and import compatibility

Bundled definitions are compiled from `src-tauri/telemetry/widgets.yaml`, `layouts.yaml`, `catalog.json` and the listed TextFSM files. `Catalog::builtin()` checks template hashes and validates definitions through the authoring validator. There are 23 network panels and five Local PC panels. Opening/editing/importing definitions does not collect or Apply.

All network fixtures are **source-pinned public format evidence**, with sanitized bytes and original/source hashes in `sidecar/tests/telemetry/fixtures/manifest.json`. They establish offline parsing only. Authorized lab, IOS/IOS-XE release, exec/shell channel, supported-empty, counter width/reset and hardware calibration gates remain OPEN. NTC templates are Apache-2.0; attribution and the license are in `src-tauri/telemetry/NOTICE.md` and `NTC-LICENSE`. No terminaltelemetry2 GPL application/widget/template asset is bundled.

| Panels | Observed fields / units | Explicit limits |
| --- | --- | --- |
| `version`, `inventory` | Hostname, image version, CLI uptime text; product/serial inventory | 60s; inventory does not imply physical port geometry. Its public sample repeats identical name+serial rows and fails duplicate-key normalization |
| `cpu`, `memory` | CPU5s/1m/5m and per-process5s percentages; processor-pool total/used/free bytes | CPU rows retain process PID/name; memory parser's process lists are not misrepresented as scalar process metrics |
| `interfaces`, `interface_descriptions`, `port_status`, `ip_interfaces`, `ip_interface_brief` | Interface/link/protocol text, descriptions, IPv4/prefix and observed VRF, CLI averaged bit/s, packet/error/drop counters | Admin-down only when explicitly present in link text; no independent admin flag, missing VRF is unknown; CLI averages are separate from byte rates |
| `interface_traffic` | Supplemental cumulative input/output bytes; delta×8/elapsed seconds → bit/s; configured BW kbit/s; rate/(BW×1000)×100 → percent | Initial/reset/clock/missing baselines leave gaps; BW is configured bandwidth, not measured/negotiated capacity. Missing/zero BW leaves utilization Missing. Selected-interface command binding and live reset proof remain OPEN |
| `bgp_peers` | Router ID/local AS/AF/peer composite key; remote AS, uptime text; numeric final token → Established + unsigned prefix count; state token → state + Missing prefixes | Zero prefixes still means Established. Summary lacks VRF; never join to detail by peer address. Existing wrapped IPv6 repository format is a parser miss |
| `bgp_vrf_peers` | VRF+peer identity and local/remote AS/state | AF/uptime/prefixes unavailable. Pinned public detail includes an empty-identity phantom row; full sample fails visibly rather than dropping it. Valid same-address/different-VRF rows remain distinct |
| `ospf_neighbors`, `ospf_interfaces` | Neighbor/address/interface/state; separate interface PID/area observations | Neighbor lacks process/VRF; interface sample lacks VRF. No unproven join. 2-Way can be valid between broadcast DROTHERs; absent network/local-role context is diagnosed, never a blanket fault |
| `eigrp_neighbors` | AS+neighbor+interface key; hold seconds, uptime text, SRTT/RTO ms, queue packets, sequence | VRF, named process and AF unavailable; no inferred default scope |
| `vlans`, `trunks` | VLAN/name/state/interfaces; switchport operational/admin mode, native VLAN, enabled VLAN list/range tokens | Enabled VLANs alone do not establish trunk mode. Operational active/forwarding/pruned trunk sets remain unavailable; no invented `show interfaces trunk` parser |
| `stp_ports`, `stp_roots` | VLAN/port role/state/cost and separate root identity/cost/port | Alternate/backup blocking/discarding is normal; no blanket down-state fault |
| `etherchannel`, `cdp_neighbors`, `lldp_neighbors`, `mac_table` | Bundle/member states, discovery identities/ports/addresses, VLAN/MAC/type/destination lists | TextFSM lists remain JSON text arrays, preserving list order/ranges and member/status correspondence; no list-to-scalar guesses or topology inference |
| `local_cpu`, `local_memory`, `local_filesystems`, `local_network`, `local_processes` | Exact Task5 local source names; percent CPU, byte capacities, cumulative byte/packet/error counters, Unix-second process start identity; network rates in bit/s | Local CPU core `total` is aggregate; processes keyed by PID+start time, CPU is whole-machine percent. Inaccessible process fields remain explicitly unavailable. Windows/Linux/integrated lifecycle gates remain OPEN |

Default intervals: network30s, inventory/version60s, Local2s. Interface drill-down scheduling/bindings are the service's responsibility; built-in all-interface traffic remains30s. Layout `platforms: []` selects **Local PC only**. Network layouts explicitly list `ios`/`iosxe`.

Scalar TextFSM values remain Text on the wire. Dashboard display arithmetic accepts complete finite decimal text, rejects blank/malformed/nonfinite and unsafe integer values, and preserves the original table/counter/key strings. Native counter/rate/alert/Preview arithmetic is unchanged. Histories contain floating-point display values and may round; latest tables preserve exact source counters.

Explicit view-field/chart-series and rate/delta units must agree for each field. The resolved declaration accompanies normalized base/computed/transform fields. Applying a changed unit removes only that field's retained series; source/key/compute changes retain their stricter invalidation, while titles, labels and layouts preserve compatible history. No unit conversion is performed. Failure and Stop boundaries append real-time gaps; an event whose wall clock cannot follow the last observation marks the next valid numeric observation with a readable discontinuity reason. The plot segments that point without changing its recorded value, time or paging cursor.

Draft Capture and TextFSM Test replies use the rechecked global authoring base in their envelopes. Physical Capture.revision remains the original effective target source; ordinary current Capture replies retain their source envelope. Both source/generation and global publication fences remain mandatory.

`ProtocolClassifier::normalize(context, definition, capture, records, previous)` calls the shared `FrameNormalizer` for aliases, composite keys, rate/delta arithmetic and computes, with source-bound BGP value enrichment at the selected-alias boundary, then adds diagnostic observations. `previous` is an optional `(prior normalized rows, prior monotonic_ms)` supplied by the caller. `ProtocolClassifier::normalize_bounded(..., maximum_bytes)` is crate-visible and passes Preview’s remaining budget unchanged to the shared normalizer; it never repairs failed/limit/duplicate-key frames. `classify(&mut frame, definition, capture)` adds diagnostics only for the current capture platform/command/parser binding. The crate-visible `field_value(definition, capture, field, selected_alias, value)` replaces only known BGP source values **before** byte admission/cloning, row-key creation, rates/deltas, computes and alerts. This native canonical contract is independent of widget ID: command `show ip bgp summary`, the actual platform-specific `ios.show_ip_bgp_summary`/`iosxe.show_ip_bgp_summary` parser, selected alias `STATE_OR_PREFIXES_RECEIVED` (case-insensitive), and semantic output field `state`/`prefixes_received` jointly select conversion. Copies/renames preserve keys, computes and alerts. Other parser IDs, selected custom aliases and output names retain their declared raw meaning. Local input supplies no capture and remains unchanged; custom selected aliases retain their own meaning. A key containing `state` therefore agrees with displayed `Established` and stays stable across prefix counts7→5; state arithmetic becomes Missing, while prefix arithmetic uses the unsigned canonical count. Severity rules stay inspectable YAML data and retain the shared first-match evaluation; classification does not override them. Duplicate/missing keys are failures, never deduplicated or assigned invented context. `capture_rejection(&Capture)` is a shared pre-parser check, called only after capture metadata/hash/size validation; Task8 must call it before live TextFSM as Preview does. It recognizes only the explicit source-documented `% Invalid input detected` prefix and exact `Command authorization failed.` line, returning a sanitized state/diagnostic without raw text. Preview returns no token and does not mark a rejected changed template as tested. Unknown forms remain parser errors. Device command rejection, permission denial, parse mismatch and protocol observations are distinct diagnostics. No bundled binding currently has source-pinned supported-empty evidence; zero parsed records fail with `parse_mismatch`, never `NotConfigured`. A current neighbor list is not an expected-peer inventory.

The full public interface sample contains two contradictory `GigabitEthernet0/2` blocks. Full replay preserves both and fails duplicate-key validation. The `interfaces_one.raw` excerpt ends before the second interface header; it demonstrates one parser record, not a complete inventory or lab capture.

## Native YAML examples

The authoritative envelopes are `schema_version: 1` plus `widgets:` or `layouts:`. Definitions below are independently authored examples over actual bundled aliases. Use the repository's selected Local/profile/device scope; scope and revision never come from YAML. All references, commands, intervals, views, transforms and layout spans are validated before Preview/Apply.

Network counter example:

```yaml
schema_version: 1
widgets:
  - widget: interface_traffic
    title: Interface byte rates
    source:
      kind: ssh
      commands: {ios: show interfaces, iosxe: show interfaces}
      templates: {ios: ios.interface_bytes, iosxe: iosxe.interface_bytes}
    interval: 30
    key: [interface]
    fields:
      interface: [interface, INTERFACE]
      input_bytes: [input_bytes, INPUT_BYTES]
    rates:
      input_bit_s: {field: input_bytes, multiplier: 8, unit: bit/s}
    view:
      type: chart
      series: [{field: input_bit_s, label: Input, unit: bit/s}]
```

Local example (Local scope; no network platform tag):

```yaml
schema_version: 1
widgets:
  - widget: local_cpu
    title: CPU per logical core
    source: {kind: local, collector: local.cpu}
    interval: 2
    key: [core]
    fields: {core: [core], usage: [usage]}
    view:
      type: table
      columns: [{field: core, label: Core}, {field: usage, label: CPU, unit: '%'}]
```

Routing example retains the parser's observed identity without inventing VRF/process:

```yaml
schema_version: 1
widgets:
  - widget: ospf_neighbors
    title: OSPF neighbors
    source:
      kind: ssh
      commands: {ios: show ip ospf neighbor, iosxe: show ip ospf neighbor}
      templates: {ios: ios.show_ip_ospf_neighbor, iosxe: iosxe.show_ip_ospf_neighbor}
    interval: 30
    key: [neighbor, address, interface]
    fields:
      neighbor: [neighbor_id, NEIGHBOR_ID]
      address: [ip_address, IP_ADDRESS]
      interface: [interface, INTERFACE]
      state: [state, STATE]
    view:
      type: table
      columns: [{field: neighbor, label: Neighbor}, {field: interface, label: Interface}, {field: state, label: State}]
```

Switching layout example (widgets refer to complete bundled definitions):

```yaml
schema_version: 1
layouts:
  - layout: switching
    platforms: [ios, iosxe]
    sections:
      - id: switching
        title: Switching observations
        rows:
          - [{widget: stp_ports, span: 6}, {widget: stp_roots, span: 6}]
          - [{widget: trunks, span: 12}]
```

## Strict terminaltelemetry2 import boundary

`UpstreamWidgetImporter::new(&repository, selected_scope).import(yaml)` accepts one widget or layout document from the documented subset at commit `09d2a0b3f9c77e2b85bd5b48a055b7bedb40fe98`. It returns `ImportReport {draft, diagnostics}`. Successful translation calls `repository.import_draft`, which checks backend-known Device scope and stamps the **current global** base revision under lock. No import executes, saves effective configuration or bypasses Validate → Preview → Apply.

Unsupported YAML is preserved verbatim at the start of the editable draft plus an explicit unsupported-input marker that prevents native validation/Apply. A native envelope cannot bypass this block. Oversize documents and invalid backend scope return no draft. Duplicate keys, aliases/anchors/tags, multiple YAML documents and nesting/size limits use the existing bounded safe-YAML parser.

| Upstream feature | Imported subset / rejection |
| --- | --- |
| `widget`, `title`, `interval` | ID preserved; title defaults to ID, interval defaults30; native interval/identifier rules still apply |
| `commands` | Only documented upstream `cisco_ios` expands to both `ios`/`iosxe`; other identifiers fail with their field path. Conservative native command policy remains authoritative |
| `templates` | Explicit exact bundled NTC name matching platform+command, or a unique known bundled default for that exact command. No filesystem/template DB, siblings, remembered parser or scored sweep. Missing template is a diagnostic |
| `fields`, `key` | Ordered aliases expanded to lowercase+original; scalar/composite key accepted. Non-singleton commands require explicit stable key. Imports mapping the known BGP summary alias to native `state`/`prefixes_received` fail at `fields.<name>` for **every widget ID**, because native canonicalization changes upstream raw values. Use a distinct raw output name such as `raw_state`, or author native canonical YAML explicitly. Custom aliases retain their own meaning |
| `rates`, `deltas` | String source-field maps → native multiplier1 transforms, only when all selected templates prove the aliases are unsigned u64 scalar counters. Lists, unit-bearing/unknown operands fail |
| `computes` | Existing bounded arithmetic evaluator; exact unsigned scalar fields/rates/deltas only. Functions, unit-prefix coercion and compute chaining fail explicitly |
| `view.type: table` | String `columns`, `labels`; omitted `alerts` or `alerts: []` accepted. Every nonempty upstream alert list fails at `view.alerts[0]`, preserving verbatim blocked input. Native YAML alerts remain fully available. Unknown labels fail |
| `view.type: kv` | Explicit `show`, labels, or upstream default field/rate/delta list (computes excluded unless explicitly shown) |
| `view.type: stat` | `aggregate: count/sum/min/max`, numeric scalar `field`, label. Filtering/aggregate alerts are unsupported |
| Layout `layout`, `platforms`, `rows` | Names or `{name,span}` entries → one native section; relative positive integer spans must map **exactly** to12columns. Fractional/rounded layouts, upstream empty/default platforms and Qt `terminal` placement fail |
| Hooks/other behavior | `requires`, `py:`, arbitrary parser hooks/shell commands, `drop`, `unique`, `monitor`, sorting/top-N, `where`, regex/conditional/style-only alerts, cells/sparks/Qt views, unknown keys all report a precise path and block Apply. No unsupported behavior is silently discarded |

A simple supported upstream counter widget:

```yaml
widget: packet_rate
commands: {cisco_ios: show interfaces}
templates: {cisco_ios: cisco_ios_show_interfaces}
key: interface
fields: {interface: [INTERFACE], packets: [INPUT_PACKETS]}
rates: {packets_s: packets}
view: {type: table, columns: [interface, packets_s], labels: {packets_s: Packets/s}}
```

Upstream alert rules are unsupported because their string/missing fallback, comma/whitespace numeric coercion and float precision differ from native predicates. For example, upstream float equality rounds counter `9007199254740993` to threshold `9007199254740992`; native comparison keeps the integer distinct. No value ceiling, coercion mode or native predicate change is introduced. The source contract is [pinned upstream rules.py](https://github.com/scottpeterman/terminaltelemetry2/blob/09d2a0b3f9c77e2b85bd5b48a055b7bedb40fe98/terminaltelemetry2/widgets/rules.py).

Compatibility is a tested subset, not full upstream or operational support. Original upstream documentation: [widget guide](https://github.com/scottpeterman/terminaltelemetry2/blob/09d2a0b3f9c77e2b85bd5b48a055b7bedb40fe98/docs/WIDGETS.md). Primary template/raw provenance: [NTC pinned tree](https://github.com/networktocode/ntc-templates/tree/e60dae39a28d148253e751176bd3ff15e35bfd56).

Rejection format references: [Cisco IOS-XE17 CLI guide](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/syst-mgmt/b-system-management/m_cf-cli-basics.html) and [Cisco IOS TACACS verification](https://www.cisco.com/c/en/us/support/docs/security/identity-services-engine/200208-Configure-ISE-2-0-IOS-TACACS-Authentic.html). These establish the stated messages, not complete release/channel acceptance.

## Verification boundary

The real-App browser acceptance visits every bundled routing and switching panel, filters MAC rows, and drives Validate → Preview → Apply for Local, IOS-XE profile, device and layout drafts. It also exercises explicit draft Capture/Test, running target reconciliation, failed Apply and delayed Preview invalidation. Its observations, parser replies and file operations are synthetic IPC fixtures. This proves presentation and frontend authority handling; the release/channel/parser limitations above remain in force. Native device collection, OS lifecycle and packaged-app behavior require separate validation.

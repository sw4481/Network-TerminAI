# Telemetry feasibility and validation record

Recorded 2026-11-11 on `feat/telemetry-workspace`, starting baseline `1047e5d8`.
The initial source/installed-asset feasibility record is supplemented by Task5's direct native local-sampler evidence below. **No live network or integrated native Telemetry acceptance gate is closed.**

## Inputs and authorization

No specific IOS/IOS-XE lab targets, saved connection IDs, releases, feature inventory or Windows/Linux test environments have been supplied for this task. No saved-connection inventory, credential/configuration files or live devices were queried. No captures were created or imported. Existing repository fixtures below were inspected locally; their filenames do not prove real-device provenance or current-lab compatibility.

The available shell host reports `Darwin 27.2.0 arm64`, macOS `27.2`, build `26B123` (`uname -srm`, `sw_vers`). This establishes a macOS development host, not a running native Telemetry collector. Windows and Linux availability remains OPEN.

## Evidence meaning

- **INSTALLED / OPEN:** index resolution and template fields were checked; command execution, framing, semantics and release support are unverified.
- **GAP / OPEN:** an actual installed-source or offline-replay limitation needs a demonstrated capture and explicit resolution.
- `capture_path=—` means no authorized capture exists in this task; `ssh_channel_mode=OPEN` means neither exec nor shell acceptance was exercised.
- `release=OPEN` never means every release. IOS-XE uses the installed adapter's `cisco_ios` mapping, not an independently verified IOS-XE compatibility promise.

## Required network panel matrix

All commands below are candidate operational bindings for later conservative admission and authorized lab checks. This table does not authorize sending them. Template filenames are relative to the installed template directory recorded below.

| platform | release | feature | command | template | capture_path | outcome | ssh_channel_mode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IOS / IOS-XE | OPEN | Identity, version, uptime | `show version` | `cisco_ios_show_version.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | CPU | `show processes cpu` | `cisco_ios_show_processes_cpu.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Memory | `show processes memory sorted` | `cisco_ios_show_processes_memory_sorted.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Interface states, rates, capacity, errors/drops | `show interfaces` | `cisco_ios_show_interfaces.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Interface descriptions | `show interfaces description` | `cisco_ios_show_interfaces_description.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Port inventory and state | `show interfaces status` | `cisco_ios_show_interfaces_status.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Addressing and VRF context | `show ip interface` | `cisco_ios_show_ip_interface.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Interface summary | `show ip interface brief` | `cisco_ios_show_ip_interface_brief.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | BGP peers, AS, uptime, prefixes/state | `show ip bgp summary` | `cisco_ios_show_ip_bgp_summary.textfsm` | — | GAP / OPEN: context/replay limits below | OPEN |
| IOS / IOS-XE | OPEN | BGP peer state and VRF context | `show ip bgp neighbors` | `cisco_ios_show_ip_bgp_neighbors.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | BGP VPNv4 peer context | `show ip bgp vpnv4 all neighbors` | `cisco_ios_show_ip_bgp_vpnv4_all_neighbors.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | OSPF neighbors, state, interfaces | `show ip ospf neighbor` | `cisco_ios_show_ip_ospf_neighbor.textfsm` | — | GAP / OPEN: context/replay limits below | OPEN |
| IOS / IOS-XE | OPEN | OSPF process/area interface context | `show ip ospf interface brief` | `cisco_ios_show_ip_ospf_interface_brief.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | EIGRP neighbors, AS, uptime | `show ip eigrp neighbors` | `cisco_ios_show_ip_eigrp_neighbors.textfsm` | — | GAP / OPEN: context/replay limits below | OPEN |
| IOS / IOS-XE | OPEN | VLANs | `show vlan brief` | `cisco_ios_show_vlan.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Switchport/trunk configuration observations | `show interfaces switchport` | `cisco_ios_show_interfaces_switchport.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | STP roles/states | `show spanning-tree` | `cisco_ios_show_spanning-tree.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | STP root | `show spanning-tree root` | `cisco_ios_show_spanning-tree_root.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | EtherChannel and members | `show etherchannel summary` | `cisco_ios_show_etherchannel_summary.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | CDP neighbors | `show cdp neighbors detail` | `cisco_ios_show_cdp_neighbors_detail.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | LLDP neighbors | `show lldp neighbors detail` | `cisco_ios_show_lldp_neighbors_detail.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | MAC table | `show mac address-table` | `cisco_ios_show_mac-address-table.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Hardware inventory | `show inventory` | `cisco_ios_show_inventory.textfsm` | — | INSTALLED / OPEN | OPEN |
| IOS / IOS-XE | OPEN | Operational trunks | `show interfaces trunk` | index selects `cisco_ios_show_interfaces.textfsm` | — | GAP / OPEN: generic interface parser is not trunk coverage | OPEN |

Fleet CPU/memory/ports-up and routing summaries consume these same captures. Selected-interface traffic/utilization additionally requires actual counter units/width, observed link capacity, elapsed-time baselines and reset/reconnect evidence; displayed CLI averaged rates are not monotonic counter deltas. The installed interface fields include packet counters and averaged rates, but no explicit input/output byte-counter fields. A valid byte-rate source for the agreed traffic charts remains OPEN. Physical-port presentation requires real inventory classification; `show inventory` alone is not proof of a complete port layout. Missing commands/features must stay visible, not become zero totals.

## Installed parser inventory and reproducibility

The task used the existing `sidecar/.venv/bin/python` with `PYTHONPATH` set to **this worktree's** `sidecar/src`; no dependency was installed or changed. `importlib.metadata.version` reports `ntc_templates=9.1.0`, `textfsm=2.1.0`. Package root:

`/Users/shaunwhi/CCIE Terminal/sidecar/.venv/lib/python3.12/site-packages/ntc_templates`

Its `templates/` directory contains **966 `.textfsm` files**. No sample/test directories are installed alongside that package (only `templates/` and `__pycache__/` were present). The installed `templates/index` was consulted with `textfsm.clitable.CliTable('index', template_directory).index.GetRowMatch({'Platform':'cisco_ios','Command':command})` for every matrix command. The generic match for `show interfaces trunk` is explicitly retained above as a gap.

The following are **TextFSM header names**, obtained by constructing `textfsm.TextFSM` for each selected asset. `ntc_templates.parse.parse_output` returns lowercase dictionary keys. List-valued fields (for example EtherChannel members or trunk VLANs) need type-aware mapping, not stringification.

| template | actual header fields |
| --- | --- |
| `cisco_ios_show_version.textfsm` | `SOFTWARE_IMAGE`, `VERSION`, `RELEASE`, `ROMMON`, `HOSTNAME`, `UPTIME`, `UPTIME_YEARS`, `UPTIME_WEEKS`, `UPTIME_DAYS`, `UPTIME_HOURS`, `UPTIME_MINUTES`, `RELOAD_REASON`, `RUNNING_IMAGE`, `HARDWARE`, `SERIAL`, `CONFIG_REGISTER`, `MAC_ADDRESS`, `RESTARTED` |
| `cisco_ios_show_processes_cpu.textfsm` | `CPU_USAGE_5_SEC`, `CPU_INTERRUPTION_5_SEC`, `CPU_USAGE_1_MIN`, `CPU_USAGE_5_MIN`, `PROCESS_PID`, `PROCESS_RUNTIME`, `PROCESS_INVOKED`, `PROCESS_CPU_TIME_FOR_INVOCATION`, `PROCESS_CPU_USAGE_5_SEC`, `PROCESS_CPU_USAGE_1_MIN`, `PROCESS_CPU_USAGE_5_MIN`, `PROCESS_TTY`, `PROCESS_NAME` |
| `cisco_ios_show_processes_memory_sorted.textfsm` | `MEMORY_TOTAL`, `MEMORY_USED`, `MEMORY_FREE`, `PROCESS_ID`, `PROCESS_ALLOCATED`, `PROCESS_FREED`, `PROCESS_HOLDING`, `PROCESS` |
| `cisco_ios_show_interfaces.textfsm` | `INTERFACE`, `LINK_STATUS`, `PROTOCOL_STATUS`, `HARDWARE_TYPE`, `MAC_ADDRESS`, `BIA`, `DESCRIPTION`, `IP_ADDRESS`, `PREFIX_LENGTH`, `MTU`, `DUPLEX`, `SPEED`, `MEDIA_TYPE`, `BANDWIDTH`, `DELAY`, `ENCAPSULATION`, `LAST_INPUT`, `LAST_OUTPUT`, `LAST_OUTPUT_HANG`, `QUEUE_STRATEGY`, `INPUT_RATE`, `OUTPUT_RATE`, `INPUT_PPS`, `OUTPUT_PPS`, `INPUT_PACKETS`, `OUTPUT_PACKETS`, `RUNTS`, `GIANTS`, `INPUT_ERRORS`, `CRC`, `FRAME`, `OVERRUN`, `ABORT`, `OUTPUT_ERRORS`, `VLAN_ID`, `VLAN_ID_INNER`, `VLAN_ID_OUTER`, `QUEUE_SIZE`, `QUEUE_MAX`, `QUEUE_DROPS`, `QUEUE_FLUSHES`, `QUEUE_OUTPUT_DROPS` |
| `cisco_ios_show_interfaces_description.textfsm` | `PORT`, `STATUS`, `PROTOCOL`, `DESCRIPTION` |
| `cisco_ios_show_interfaces_status.textfsm` | `PORT`, `NAME`, `STATUS`, `VLAN_ID`, `DUPLEX`, `SPEED`, `TYPE`, `FC_MODE` |
| `cisco_ios_show_ip_interface.textfsm` | `INTERFACE`, `LINK_STATUS`, `PROTOCOL_STATUS`, `IP_ADDRESS`, `PREFIX_LENGTH`, `VRF`, `MTU`, `IP_HELPER`, `OUTGOING_ACL`, `INBOUND_ACL` |
| `cisco_ios_show_ip_interface_brief.textfsm` | `INTERFACE`, `IP_ADDRESS`, `STATUS`, `PROTO` |
| `cisco_ios_show_ip_bgp_summary.textfsm` | `ROUTER_ID`, `LOCAL_AS`, `ADDRESS_FAMILY`, `BGP_NEIGHBOR`, `BGP_VERSION`, `NEIGHBOR_AS`, `MESSAGES_RECEIVED`, `MESSAGES_SENT`, `TABLE_VERSION`, `INPUT_QUEUE`, `OUTPUT_QUEUE`, `UP_DOWN`, `STATE_OR_PREFIXES_RECEIVED` |
| `cisco_ios_show_ip_bgp_neighbors.textfsm` | `NEIGHBOR`, `VRF`, `REMOTE_AS`, `PEER_GROUP`, `REMOTE_ROUTER_ID`, `BGP_STATE`, `LOCALHOST_IP`, `LOCALHOST_PORT`, `REMOTE_IP`, `REMOTE_PORT`, `INBOUND_ROUTEMAP`, `OUTBOUND_ROUTEMAP` |
| `cisco_ios_show_ip_bgp_vpnv4_all_neighbors.textfsm` | `NEIGHBOR`, `VRF`, `REMOTE_AS`, `LOCAL_AS`, `DESCRIPTION`, `PEER_GROUP`, `REMOTE_ROUTER_ID`, `BGP_STATE`, `LOCALHOST_IP`, `LOCALHOST_PORT`, `REMOTE_IP`, `REMOTE_PORT`, `INBOUND_ROUTEMAP`, `OUTBOUND_ROUTEMAP` |
| `cisco_ios_show_ip_ospf_neighbor.textfsm` | `NEIGHBOR_ID`, `PRIORITY`, `STATE`, `DEAD_TIME`, `IP_ADDRESS`, `INTERFACE` |
| `cisco_ios_show_ip_ospf_interface_brief.textfsm` | `INTERFACE`, `PROCESS`, `AREA`, `IP_ADDRESS`, `PREFIX_LENGTH`, `COST`, `STATE`, `NEIGHBORS_FC` |
| `cisco_ios_show_ip_eigrp_neighbors.textfsm` | `AS`, `IP_ADDRESS`, `INTERFACE`, `HOLD`, `UPTIME`, `SRTT`, `RTO`, `Q_CNT`, `SEQ_NUM` |
| `cisco_ios_show_vlan.textfsm` | `VLAN_ID`, `VLAN_NAME`, `STATUS`, `INTERFACES` |
| `cisco_ios_show_interfaces_switchport.textfsm` | `INTERFACE`, `SWITCHPORT`, `SWITCHPORT_MONITOR`, `SWITCHPORT_NEGOTIATION`, `MODE`, `ADMIN_MODE`, `ACCESS_VLAN`, `NATIVE_VLAN`, `VOICE_VLAN`, `TRUNKING_VLANS` |
| `cisco_ios_show_spanning-tree.textfsm` | `VLAN_ID`, `INTERFACE`, `ROLE`, `STATUS`, `COST`, `PORT_PRIORITY`, `PORT_ID`, `TYPE` |
| `cisco_ios_show_spanning-tree_root.textfsm` | `VLAN_ID`, `PRIORITY`, `ROOT_ID`, `ROOT_COST`, `HELLO_TIME`, `MAX_AGE`, `FWD_DLY`, `ROOT_PORT` |
| `cisco_ios_show_etherchannel_summary.textfsm` | `GROUP`, `BUNDLE_NAME`, `BUNDLE_STATUS`, `BUNDLE_PROTOCOL`, `MEMBER_INTERFACE`, `MEMBER_INTERFACE_STATUS` |
| `cisco_ios_show_cdp_neighbors_detail.textfsm` | `NEIGHBOR_NAME`, `MGMT_ADDRESS`, `PLATFORM`, `NEIGHBOR_INTERFACE`, `LOCAL_INTERFACE`, `NEIGHBOR_DESCRIPTION`, `CAPABILITIES` |
| `cisco_ios_show_lldp_neighbors_detail.textfsm` | `LOCAL_INTERFACE`, `CHASSIS_ID`, `NEIGHBOR_PORT_ID`, `NEIGHBOR_INTERFACE`, `NEIGHBOR_NAME`, `NEIGHBOR_DESCRIPTION`, `CAPABILITIES`, `MGMT_ADDRESS`, `VLAN_ID`, `MAC_ADDRESS`, `SERIAL`, `MANUFACTURER`, `HW_REVISION`, `FW_REVISION`, `SW_REVISION`, `PLATFORM`, `POWER_PAIR`, `POWER_CLASS`, `POWER_DEVICE_TYPE`, `POWER_PRIORITY`, `POWER_SOURCE`, `POWER_REQUESTED` |
| `cisco_ios_show_mac-address-table.textfsm` | `DESTINATION_ADDRESS`, `TYPE`, `VLAN_ID`, `DESTINATION_PORT` |
| `cisco_ios_show_inventory.textfsm` | `NAME`, `DESCR`, `PID`, `VID`, `SN` |

## Offline sample coverage and demonstrated limits

These results are offline parsing of existing repository files with `parse_output(platform='cisco_ios', command=..., data=fixture.read_text())`; no device traffic was generated. Fixture origin/release is unverified in this task, so none closes the live-capture gate.

| sample path | command | observed result | coverage limitation |
| --- | --- | --- | --- |
| `sidecar/tests/fixtures/show_ip_bgp_summary_iosxe.txt` | `show ip bgp summary` | **0 rows** | Fixture contains an IPv6 Unicast Idle peer; this is a parser miss, not a demonstrated empty neighbor table. |
| `sidecar/tests/fixtures/show_ip_ospf_neighbor_iosxe.txt` | `show ip ospf neighbor` | 5 rows | Flat neighbors; no VRF/process identity established by this replay. |
| `sidecar/tests/fixtures/show_cdp_neighbors_detail_iosxe.txt` | `show cdp neighbors detail` | 3 rows | Offline fixture only. |
| `sidecar/tests/fixtures/show_lldp_neighbors_detail_iosxe.txt` | `show lldp neighbors detail` | 4 rows | Offline fixture only. |
| Empty string (synthetic probe; no file/capture) | BGP summary, OSPF neighbor, EIGRP neighbors | direct parser returns 0 rows for each; existing adapter raises `TextFSMUnsupportedError` for each | Empty bytes do not prove supported-empty output, unconfigured protocols or valid command framing. |

`sidecar/tests/topology/test_eigrp_neighbors.py` explicitly calls its CLI evidence synthetic. `test_routing_evidence.py` includes synthetic multi-AF/VRF parsed envelopes; those are not raw multi-VRF TextFSM proof. No new synthetic fixtures were added. Actual supported-empty and repeated-peer multi-VRF CLI capture/replay remains OPEN for every routing panel.

Installed headers demonstrate concrete context gaps: BGP summary has `ADDRESS_FAMILY` but no `VRF`; OSPF neighbor has neither VRF nor process; EIGRP neighbor has `AS` but no VRF, named-mode name or address family. BGP neighbor/detail assets contain VRF, but do not alone establish complete uptime/prefix/AF coverage. OSPF interface brief has process/area, but a safe join to neighbor context needs actual scope evidence. Do not merge distinct scopes by peer address or infer absent configured peers from an empty current table.

## Existing-source boundaries

Graphify root query `graphify query 'textfsm_adapter VENDOR_MAP parse_output' --budget 1200` navigated to the parser and dispatcher; current worktree source was then read directly. Graph traversal is navigation, not complete call-graph proof.

- `sidecar/src/ccie_sidecar/parsers/textfsm_adapter.py`: IOS and IOS-XE map to `cisco_ios`; zero rows raise `TextFSMUnsupportedError`. Telemetry must distinguish validated supported-empty captures from parser failures instead of inheriting this blanket zero-row policy.
- `src-tauri/src/fanout/worker_live.rs`: uses `channel_open_session`/`exec`; this proves an existing API usage, not lab-device exec support.
- `src-tauri/src/ssh_exec/mod.rs`: one-shot system SSH includes `StrictHostKeyChecking=no`; it is not an acceptable telemetry transport/host-verification precedent. No existing transport behavior was changed.

## Local platform and acceptance gates

| platform | release | feature | command | template | capture_path | outcome | ssh_channel_mode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | 27.2 / 26B123 | Overall/per-core CPU, memory, filesystem, adapter traffic, processes | `telemetry::local::tests::native_os_metric_smoke` (actual sysinfo sampler, UID501) | Not applicable | — | Native sampler PASS; first CPU Missing, warmed CPU finite, byte counters exact, top50 bounded; app/lifecycle acceptance remains OPEN | Not applicable |
| Windows | OPEN | Same agreed local panels and parser-process cleanup | Built-in OS collector | Not applicable | — | OPEN: native environment not supplied | Not applicable |
| Linux | OPEN | Same agreed local panels and parser-process cleanup | Built-in OS collector | Not applicable | — | OPEN: native environment not supplied | Not applicable |

Before network execution, Shaun must identify authorized saved targets and actual releases/features. For each target record command, sanitized explicitly approved capture path, platform/release, prompt/privilege requirement, output size/framing, pagination behavior, completion/error signal and channel mode. Verify host identity and preserve existing interactive terminals. Any session-only pagination control must be explicitly identified as session-only; do not send persistent configuration commands. No pagination command was sent in this task.

Try exec on authorized targets; if rejected, retain the actual rejection before considering a telemetry-owned shell collector. Exec sufficiency and shell fallback necessity are both OPEN. If a supported read-only collection path cannot be established, stop network execution and report the evidence; do not substitute a generic terminal emulator or weaken host verification.

Remaining acceptance evidence: real empty/multi-VRF captures, each agreed panel on actual IOS/IOS-XE releases, ten simultaneous targets with slow/failing target isolation, command/parser deadlines and cancellation, native app Start/Stop/tab/app-close behavior, one-hour history bounds and counter gaps, and actual local/parser/cleanup behavior on macOS/Windows/Linux. Source checks and offline fixtures cannot close these gates.

## Task 5 local collector evidence

The synchronous `LocalCollector` uses pinned `sysinfo=0.39.6` with only `system,disk,network` features for host CPU/memory/disks/network and non-macOS processes. macOS processes use the private native `local_macos.rs` reader through existing libc: `proc_listpids`, `proc_pidinfo(PROC_PIDTASKALLINFO)` (short name, start time, resident bytes and CPU ticks), with BSD-only metadata fallback when task data is unavailable. No sysinfo process refresh runs on macOS. The initial empty-retained-vector privacy claim is withdrawn: review proved pinned sysinfo unconditionally requests `KERN_PROCARGS2` before its retention flags. A test-only syscall interceptor now positively controls, counts and rejects that MIB without inspecting/returning its payload: old sampler RED568requests, fixed sampler GREEN0requests across initial and warm observations. It is absent from production builds.

Retained instances refresh on invocation (2s default belongs to the service); CPU respects the platform's real `MINIMUM_CPU_UPDATE_INTERVAL`. First/too-early CPU and newly observed process CPU are Missing/warming_up. Following an early memory-only process refresh, the next eligible process CPU interval also rewarms, then the following valid interval reports a value; this prevents the pinned Linux numerator/denominator mismatch while keeping memory refreshed. Disk inventory refreshes every60s; capacity refreshes on each sample. Non-macOS process cmd/environ/exe/task retention flags remain disabled; empty vectors are only retention evidence, not independent proof of no reads on those untested OSes.

| gate | evidence | result |
| --- | --- | --- |
| Numeric semantics | Focused tests require synthetic200% single-core process observation /4logical cores =50.0% whole-machine usage; exact `u64::MAX` decimal string; memory/filesystem bytes; ambiguous sysinfo zero resident memory stays Missing. Successful native macOS task data preserves real zero bytes | PASS (algorithm tests, not other-OS evidence) |
| Disappearance | Previous reported identity compared with refreshed full process map; leaving top50 is not an exit. Removed adapter/process rows remain absent, with no_longer_observed diagnostics and no zero tombstones. Unknown process start times are omitted with an aggregate access/data limitation diagnostic | PASS (algorithm tests) |
| macOS normal-user sampler | UID501, Darwin27.2.0arm64/macOS27.2build26B123; corrected native process reader and real two-observation sampler;15CPU rows/2filesystems/23adapters/50process rows;25769803776total memory bytes. Separate native task test verifies own PID/start identity, resident bytes and CPU counter availability; syscall boundary test verifies zero PROCARGS2 requests | PASS for native sampler only; final latencies/commands recorded in Task5 fix1 report |
| Early CPU baseline | Initial→early→eligible→following-valid regression fails on old retained baseline, then passes with early/eligible Missing and following numeric value, with memory still refreshed. Source-proven Linux issue; timing policy exercised on actual macOS host | PASS regression; native Linux remains OPEN |
| Windows/Linux sampler | No actual native environments supplied | OPEN; no simulated OS flags used |
| Blocking worker and cleanup | This module has no scheduler/runtime, GUI call site, thread owner or cancellation promise. `sysinfo` refreshes can block, including slow mounted filesystems; the later service must own its blocking worker and establish shutdown behavior | OPEN integration gate |

Permission limitations are reported only where data supports them: sysinfo process memory/start integers lack per-field error status, so ambiguous zero is unavailable_or_zero, never proof of denial. Native macOS task reads return status: EPERM/EACCES produce Missing/permission_denied; other task failures produce Missing/unavailable while valid BSD identities remain usable. Unknown identities are omitted with an aggregate limitation diagnostic. macOS process CPU divides delta(user+system Mach ticks) by delta(mach_absolute_time ticks), then by logical cores and multiplies100; it does not assume these counters are nanoseconds. Internal macOS CPU identities include start-time microseconds to reject PID reuse; published `start_time` and configured keys retain Unix seconds. Native names are kernel short names, potentially truncated. Valid zero swap/network counters stay zero. Networks/System refresh APIs still lack complete per-field success status; unchanged cached counters alone do not prove failure. Disk capacity uses its returned refresh result. These observations do not establish Windows/Linux runtime behavior.

Source field names/units/row keys, exact commands and retained outputs are documented in `.superpowers/sdd/2026-11-11-telemetry-workspace/task-5-report.md`. No native app was launched/replaced; no saved devices or user configuration were accessed.


## Task 6 isolated SSH transport evidence

`telemetry::ssh` uses native pinned russh0.60.2 with a resolver-owned cleanup registry per target/generation. The backend supplies the DB, trust-file path and explicit `TargetRef` profile; saved `ios`/`iosxe` must match, saved `generic` uses that explicit selection, and other saved platforms fail. Existing DB/decryption helpers resolve actual saved password or identity-file authentication. Identity selection never falls back to a saved password; unavailable/encrypted/unsupported identities, missing auth and additional authentication methods fail explicitly. Password/key-text/user fields remain private and non-Debug/non-serializable; owned password/key-text buffers zeroize. No saved credentials, actual key files, user known_hosts or real targets were accessed for development.

Host trust reads the backend-selected known-host file once into owned bytes. Marker checks and the pinned host/port matcher consume those identical bytes through a secure owned temporary copy, including the pinned hashed-name behavior; no second read of the mutable user path supplies keys. Unknown/changed keys fail before authentication with a SHA256 fingerprint and an explicit-trust instruction. No learning, system SSH configuration change, shell collector or exec-to-shell fallback exists. OpenSSH trust markers (`@revoked`, certificate-authority markers) fail closed as unsupported rather than being silently ignored. Identity-file paths are used as saved; agent, OpenSSH config interpretation and passphrase prompting are outside this transport.

| gate | retained evidence | outcome |
| --- | --- | --- |
| macOS local SSH peer | `task-6-final-telemetry.log`:72 passed/1 existing ignored, including12 SSH tests; strict unknown/changed keys, saved password/key, auth failure without retry, bounded output/framing, deadlines/cancel, dropped futures, real socket EOF and observed actor/session joins | PASS for isolated native peer only; actual IOS/IOS-XE exec/release support OPEN |
| Interactive isolation | Distinct authenticated peer shell remains usable through telemetry timeout. Telemetry open-channel count reaches0 and its interactive-command count remains0; a deliberate post-cleanup sentinel then reaches the live shell | PASS; no real terminal/app was opened |
| Failed-connect pending cleanup | After actual KEX bytes prove russh task startup, held join acknowledgment produces `ssh_cleanup_pending` within3s; socket EOF is observed, the same registered JoinHandle remains owned, and later resolver shutdown observes its completion | PASS; caller must retain resolver/runtime and retry pending shutdown |
| Logger privacy/startup | Genuine credential-packet/raw-prefix RED; actual JSON+pretty pipelines under adversarial Trace directives reject password/username plaintext and decimal-byte forms plus first11 raw-capture bytes. Foreign subscriber/logger installations reject telemetry before socket/auth (a persistent accepted-connection counter remains0). Reflected-disconnect cases require both sinks and public diagnostics to exclude saved username/password/raw-prefix markers; the private telemetry handler suppresses the pinned default callback's verbatim description logging while preserving internal error propagation. Application-owned/unrelated records remain visible at every level | PASS after review fix1; the earlier vendor-severity preservation claim is withdrawn. Immutable application-wide deny now covers the exact `russh` namespace and all descendants at every level, including native/bridged records |
| Existing logging coverage | `task-6-final-logging.log`:22 passed, including all8 existing/shared logging cases,2 prior logging unit cases and12 selected terminal-logging regressions. Shared tests permanently included under cfg(test) to run with `--lib` | PASS; isolated child processes exercise real global startup |
| Native source check | `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked` | PASS; unchanged `bridge.rs:795` dead-code warning |
| Windows/Linux local SSH peers; actual devices; integrated app lifecycle | Native environments/authorized target inputs not supplied | OPEN |

`CaptureRequest` carries a private admitted command and trusted effective revision; the transport preserves command/parser/revision metadata and uses saved target ID plus the explicit validated platform. Capture admission requires exec acceptance, EOF, a successful exit status and channel completion; stdout+stderr bytes count against the command cost (never above2MiB). Raw data is neither an event nor a log field. Connect/auth has one10s phase budget; capture has10s; cleanup waits up to3s across its owned joins, including lock waiting. Timeouts/cancellation stop the whole owned session, not another terminal. `close` and resolver `shutdown` observe actual joins; pending retains ownership. Drop cancels but is not cleanup acknowledgment: keep the owning runtime alive until resolver shutdown succeeds.

Task 6 verification incident: an early `cargo test --test logging_test` implicitly rebuilt shared `src-tauri/target/debug/TerminAI` (Nov12 00:10:40-0500,235722920bytes). The prior binary checksum was not recorded, so original-byte restoration is unverified and was not attempted. No installed bundle or app-launch operation was performed. All subsequent verification used `--lib`; the executable remained SHA256 `e0edc603644e895362ff9b4e830bc52e11f88fbe140f886717b087433ab7210e` before/after those checks. The exact issue/RCA/prevention is in `Plans/Mistakes.MD`.


### Task 6 review fix round1

The earlier per-site/severity privacy guarantee is withdrawn: a real authenticated peer reproduced unknown channel/global request reflection at Info/Warn and pre-confirmation raw data at Debug. Strict privacy now takes precedence over preserving vendor diagnostics. Every `russh` namespace record at every level is denied before JSON/pretty sinks, including future descendants and bridged `log.target` events. The deliberate cost is loss of all russh library diagnostics application-wide. Application-owned sanitized diagnostics, unrelated logging at all levels and similarly named unrelated namespaces remain available. Immutable installation/readiness admission remains unchanged.

The host-trust race also reproduced: after a first read with a different key, atomically replacing the fixture with an ordinary matching key plus `@revoked` caused the old resolver to authenticate. The fixed resolver binds marker policy and key matching to the same owned String. Existing `tempfile`3.27.0 is promoted to runtime (same lockfile/packages); one secure temporary creation/write/read/unlink per resolution preserves the pinned exact/hashed matching implementation without custom security parsing. Creation/write/parse failures remain sanitized `ssh_trust_unavailable`; all resolver I/O stays within the future service's blocking-owner requirement.

New test-only `sidecar/tests/telemetry/ssh_peer.py` uses the already locked/installed Paramiko5.0 peer because public russh server APIs cannot emit these arbitrary/pre-confirmation packets. It runs under the existing sidecar interpreter with `-I`, fixture-generated keys and loopback sockets, never application/config/agent/user key APIs. Metadata counters require all3 adversarial packets actually sent, one authentication and joined transport thread; Rust bounds stdout to4096bytes, discards stderr, sets deadlines and explicitly kills/awaits failed child cleanup. Both actual production logging formats and returned diagnostics are checked. This adds a development-test interpreter requirement, not a production SSH/Python dependency or other-OS acceptance claim.

Fix1 retained logs: `task-6-fix1-trust-red.log`, `task-6-fix1-wire-red.log`, `task-6-fix1-wire-pretty-red.log`, `task-6-fix1-ssh-green.log`, `task-6-fix1-logging-green.log`, `task-6-fix1-check.log`. Current focus is13 native SSH tests plus all8 shared logger cases and locked library checking; actual devices/Windows/Linux/app acceptance remain OPEN.

## Task 7 — source-pinned catalog and import verification (2026-11-12)

Scope is offline source/library validation. The complete catalog represents23network panels and5Local panels,2layouts (`device`, Local-only `local_pc`) and46platform-specific bindings over22unchanged NTC9.1.0 templates plus1independently authored interface-byte/BW supplement. No authorized target/release/channel/supported-empty/reset or native workspace acceptance is added.

| Evidence | Result and limit |
| --- | --- |
| NTC immutable commit `e60dae39a28d148253e751176bd3ff15e35bfd56` | Every shipped NTC template byte-compared with immutable upstream; catalog.json records exact URLs/SHA256 and Apache-2.0. NOTICE.md, original notice and full Apache license included. No GPL terminaltelemetry2 widget/template/application asset bundled |
|24sanitized public raw files /26manifest parser cases | Original and sanitized hashes, excerpt selection and identity-preserving pseudonyms recorded locally. Tests require no network after acquisition. All aliases are checked against actual template headers; Local fields match Task5 exactly |
| Real standalone worker → shared normalization for every network widget |21normalizable panel examples (interfaces use explicitly limited first-interface excerpt); BGP VRF detail fails missing identity and inventory fails duplicate identity visibly. Full interface sample's contradictory repeated Gi0/2 blocks remain duplicate-key failures, not renamed/deduplicated |
| Supplemental interface bytes | Pinned raw input48614/output62737bytes retained; installed NTC parser discards those bytes. Monotonic delta×8/elapsed → bit/s and configured-BW utilization checked; initial/reset/missing-capacity gaps retained. Synthetic reset test does not close actual hardware reset/width/calibration gates |
| Routing/switching semantics | BGP numeric counts including0 distinguish Established from state tokens; same peer in different known VRFs stays distinct. OSPF2-Way lacks network-role context and is not a blanket alert. STP alternate/blocking/discarding is not a blanket fault. No VRF/process/AF/default-scope/operational trunk-set joins invented |
| Canonical field ordering | Three genuine REDs caught stale BGP row keys, state arithmetic and alert severity after display enrichment. Selected source alias → canonical value now precedes existing byte admission/cloning, key, rate/delta/compute and first-match alert finalization. Current capture binding is used; Local/custom aliases/other platform bindings do not gain unintended BGP semantics |
| Parser rejection stage | Primary Cisco IOS-XE17 CLI and IOS15.4 TACACS docs ground the two explicit rejection signatures recorded in catalog.json. Real strict NTC worker would report parser_template; Preview now reports command_unsupported/command_permission before parsing, after metadata/hash/size checks. Rejected changed templates issue no Apply grant and are not marked tested. Unknown message forms remain parser diagnostics |
| Strict upstream import | Pinned terminaltelemetry2 guide commit `09d2a0b3f9c77e2b85bd5b48a055b7bedb40fe98`, guide SHA256 `8a16d5d5189f533f65169892842e19279a101627039ceb63c3551e74709fa212`. Supported subset only; hooks/requires/unknown behavior/unsafe YAML/unknown platform/template/view/fractional spans fail with paths. Original YAML is preserved with an invalid marker; repository supplies selected scope and current global base |
| Final task checks | Complete telemetry library92passed/0failed/1ignored; Python template+worker25passed; production TypeScript and editor-schema parity pass. Ignored native smoke is not claimed as a new run. Default tsconfig check reports diagnostics in untouched app/test files and is not a passing whole-repository claim |

All actual IOS/IOS-XE release/feature/channel/ten-target lifecycle/supported-empty/expected-peer and Windows/Linux/native workspace acceptance gates remain OPEN. Public/synthetic tests are not substituted for those gates. Root debug executable remains SHA256 `e0edc603644e895362ff9b4e830bc52e11f88fbe140f886717b087433ab7210e`; only explicit library Cargo checks were used. Root owns graph refresh, independent review and vault session write-out.

## Task 8 — owned service, authoring and retained history

`TelemetryService` owns a dedicated runtime thread. Construction and explicit idempotent `establish` create no collectors, sockets or parser children. Only Start enables periodic collection. Explicit Local Preview validates first and acquires one real local sample; network Preview replays private retained captures. `capture_sample` admits current effective bindings; `capture_draft_sample` admits a validated draft command/template without starting periodic collection. Editing and validation alone collect nothing.

Task8 review round1 separates authoring references from private per-target periodic eligibility: a one-shot capture of B while A runs leaves B registered for authoring and never enables B's polls. Apply preserves that eligibility; a subsequent Start selecting B enables it. Preview first validates every supplied physical source/proof, scope, size and identity, then interprets only commands used by its candidate. An unused valid old command does not block a newly sampled command, while missing required samples and foreign/malformed inputs still fail. Generation fences evict draft-backed captures with their proofs and quota charges; a successful global-base change also invalidates draft authority in unaffected workspaces. Compatible ordinary source captures/history remain, and source-changing publication discards obsolete ordinary captures. One fresh capture after Stop/repeated Start/base change suffices; no third capture or workspace reset is required.

| Contract | Evidence |
| --- | --- |
| Scheduling | Deterministic clock tests use ten targets, one stalled target and independent local progress. Identical commands coalesce within each workspace at the fastest requested cadence; admission rotates across workspaces/targets, skips globally busy saved target IDs, caps commands at four globally and one per saved target, and skips missed ticks |
| Selected interfaces | Optional native YAML `selected_interval` is 5–3600 seconds and requires every declared source command to be exactly `show interfaces`. Built-in interface traffic uses ordinary30/selected5. Explicit validated nonempty selection chooses that widget's selected interval instead of its ordinary interval, then command groups choose their fastest interval. Tests cover selected7, selected120 versus ordinary30, and preservation through Apply. Full interface facts and the actual full command/template remain intact; parameterized interface exec support is not claimed |
| Parser ownership | One shared parser Arc serves repository and service; mismatched owners are refused. Two total parses, at most one active Preview plus one waiting Preview, bounded admission and cancellation. Actual child-process tests cover quiesce/restart, pending cleanup, cancellation, actor allocation and final `Child::wait` acknowledgements. A slot/epoch pending flag prevents Stop/Close from acknowledging a delayed child wait while another workspace remains active. This conservatively may delay another workspace's cleanup; it never quiesces an active workspace, and healthy parsing does not count as pending cleanup |
| Publication | A stalled real repository persistence gate proves cached collection, snapshot and Stop stay responsive. Potentially affected generations are fenced before persistence. Other synchronous repository operations report `config_busy` during publication. All affected open workspaces refresh after success; fully masked devices retain their effective revisions/history. Failed publication retains the working configuration |
| Capture interpretations | Original source assets/revisions/hash/size are checked before deriving only parser ID for a validated candidate interpretation. Physical capture ID, target/platform/command, raw bytes, source revision and timestamps stay unchanged. Conflicting physical identities and duplicate `(capture_id, parser_id)` pairs fail. New command captures have opaque backend proofs bound to workspace/generation/current global base/source/scope/target/command/raw hash/time; parser text/ID edits can replay that same physical command, while stale or changed-command proofs cannot |
| Local quality | Actual normal-user macOS memory-only and process-only Preview→Apply use the production collector. The observed `local_process_access_limited` warning remains on frames. Known other-collector paths do not invalidate an unrelated selected collector. Matching `local_process_access_limited`/`local_rows_disappeared` are partial-data warnings only with current keyed Fresh rows; unknown/global paths, relevant fatal diagnostics, empty warning-bearing sources and invalid keys still block grants. Missing process fields and omitted identities are not claimed complete |
| Counter continuity | The existing shared normalizer exclusively calculates aliases, exact integer deltas/rates, computes and alerts. Service-owned baselines reset on initial observations, counter reset, reconnect, missed observation intervals and wall-clock discontinuity. Gap thresholds use the actual coalesced schedule; capture counter elapsed time retains its own monotonic origin |
| Retention | Numeric histories contain only configured fields, expire by owner monotonic time after3600s plus one boundary sample, and admit at most512series. Latest full bounded rows and two private captures per command are retained separately. Combined conservative charges cap retained metric data at64MiB/workspace; exact encoded escape/metadata charges are cached on admission and updated on replacement/eviction. Exceeded limits remain visible; facts are not silently truncated |
| History compatibility | Source/aliases/key/arithmetic/template changes reset incompatible histories. Titles/layouts/labels/cadences/alerts preserve compatible data. Units reset their affected series. Non-increasing same-series wall timestamps are refused atomically with `history_clock`; latest exact rows and previous history remain, with an explicit recovery message and a gap on resumed rates |
| Paging and display precision | Latest rows and retained display points page at1000. Latest Unsigned counters remain decimal strings and rate subtraction remains integral. Numeric history is a finite f64 display representation; base counters above f64 precision may round. No exact raw historical-counter precision is claimed |
| Stop/Close/exit | Stop retains history; Close clears it only after owned cleanup succeeds. Stopped authoring retains its Local sampler between explicit Previews; Stop/Close dispose of that sampler before acknowledgement, and pending cleanup rejects a replacement collector. Pending Close rejects establishment/new work and late Start cannot recreate a closed workspace. Closing one workspace leaves another active. Blocking OS/DB calls remain owned through timeout; cleanup failures retain actual handles and runtime for retry. Current-thread-runtime tests exercise the synchronous3s exit boundary; dropping a join handle is not considered reaping |

Exact RED/GREEN commands, log paths, source interfaces and final counts are in `.superpowers/sdd/2026-11-11-telemetry-workspace/task-8-report.md`. All Cargo commands after storage recovery disable incremental compilation and use explicit library targets. No installed/running app, credentials, trust files or devices were changed.

These checks establish library behavior, real owned parser processes and a real macOS local collector. Actual IOS/IOS-XE device collection, native GUI/tab/app integration, Windows/Linux execution, physical suspend/resume, live one-hour retention and hardware counter calibration remain OPEN. Source checks and injected collectors do not close those operational gates.

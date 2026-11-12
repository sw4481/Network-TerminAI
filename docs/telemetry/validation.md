# Telemetry feasibility and validation record

Recorded 2026-11-11 on `feat/telemetry-workspace`, starting baseline `1047e5d8`.
This is a source/installed-asset record before collector implementation. **No live network or native Telemetry acceptance gate is closed.**

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
| macOS arm64 | 27.2 / 26B123 | Overall/per-core CPU, memory, filesystem, adapter traffic, processes | Built-in OS collector; not arbitrary shell | Not applicable | — | OPEN: host identified; collector/native app/permissions/units not exercised | Not applicable |
| Windows | OPEN | Same agreed local panels and parser-process cleanup | Built-in OS collector | Not applicable | — | OPEN: native environment not supplied | Not applicable |
| Linux | OPEN | Same agreed local panels and parser-process cleanup | Built-in OS collector | Not applicable | — | OPEN: native environment not supplied | Not applicable |

Before network execution, Shaun must identify authorized saved targets and actual releases/features. For each target record command, sanitized explicitly approved capture path, platform/release, prompt/privilege requirement, output size/framing, pagination behavior, completion/error signal and channel mode. Verify host identity and preserve existing interactive terminals. Any session-only pagination control must be explicitly identified as session-only; do not send persistent configuration commands. No pagination command was sent in this task.

Try exec on authorized targets; if rejected, retain the actual rejection before considering a telemetry-owned shell collector. Exec sufficiency and shell fallback necessity are both OPEN. If a supported read-only collection path cannot be established, stop network execution and report the evidence; do not substitute a generic terminal emulator or weaken host verification.

Remaining acceptance evidence: real empty/multi-VRF captures, each agreed panel on actual IOS/IOS-XE releases, ten simultaneous targets with slow/failing target isolation, command/parser deadlines and cancellation, native app Start/Stop/tab/app-close behavior, one-hour history bounds and counter gaps, and actual local/parser/cleanup behavior on macOS/Windows/Linux. Source checks and offline fixtures cannot close these gates.

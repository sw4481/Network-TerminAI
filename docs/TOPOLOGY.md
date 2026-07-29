# Topology — Architecture & Extension Guide

Plan 13 ships an end-to-end topology pipeline that converts neighbor-discovery
output (CDP, LLDP, BGP, OSPF, IS-IS) into a clickable graph. This document
covers what triggers ingestion, how data flows from a `show` command to a
node on the canvas, and how to extend the pipeline with a new protocol.

## Trigger commands

The frontend block-completion hook in `src/state/blocksStore.ts` watches for
commands that match `TOPOLOGY_TRIGGER_CMD_RE` (defined in
`src/lib/topology.ts`):

| Protocol | Command(s) matched (case-insensitive)             |
| -------- | -------------------------------------------------- |
| `cdp`    | `show cdp neigh[bor[s]]` (supports abbreviations)  |
| `lldp`   | `show lldp neigh[bor[s]]` (supports abbreviations)|
| `bgp`    | `show ip bgp summ[ary]` (supports abbreviations)   |
| `ospf`   | `show ip ospf neigh[bor]` (supports abbreviations) |
| `isis`   | `show isis neigh[bors]` (supports abbreviations)   |

**Note**: The regex supports Cisco IOS command abbreviations. For example,
`show cdp neigh`, `show cdp neighbor`, and `show cdp neighbors detail` all
trigger topology ingestion.

The hook is gated behind a localStorage flag `ccie:enableTopologyIngest`
(default ON). To opt out:

```js
localStorage.setItem("ccie:enableTopologyIngest", "false");
```

Set it back to anything other than `"false"` (or remove the key) to re-enable.

## Data flow

```
PTY tab: show cdp neighbors
        │
        ▼
blocksStore.completeBlock
        │  (regex matches → dispatch)
        ▼
topologyStore.ingestFromBlock(blockId, vendor, platform, deviceRef, deviceKind)
        │  (Tauri invoke)
        ▼
topology_ingest_from_block (Rust, src-tauri/src/commands/topology.rs)
        │
        ├── reads cmd + output from command_blocks (V0002)
        ├── derives protocol via protocol_re()
        ├── calls ParserBridge::neighbors(protocol, vendor, platform, cmd, raw)
        │           │
        │           ▼
        │    NDJSON: {"method": "topology.neighbors", ...}
        │           │
        │           ▼
        │    sidecar/src/ccie_sidecar/server.py
        │           │
        │           ├── parse_show(vendor, platform, cmd, raw) → Genie/TextFSM
        │           └── normalize_neighbors(protocol, parsed) → list[NeighborRecord]
        │           │
        │           ▼
        │    {"records": [...]}
        │
        ├── ingest::ingest_neighbors(...) (src-tauri/src/topology/ingest.rs)
        │           │
        │           ├── upsert neighbor_cache (PK: device_ref, device_kind, source_cmd)
        │           ├── upsert source TopologyNode (Global graph)
        │           ├── for each NeighborRecord:
        │           │     ├── promote device_kind via ssh_connections / netconf_devices lookup
        │           │     ├── upsert neighbor TopologyNode
        │           │     └── upsert canonicalised TopologyEdge
        │           │
        │           └── return IngestSummary
        │
        ▼
topologyStore.refresh() → InlineTopologyPanel + TopologyTab re-render
```

## Canonical NeighborRecord schema

Defined identically in three places (kept manually in sync):

- Python: `sidecar/src/ccie_sidecar/topology/neighbors.py::NeighborRecord`
- Rust:   `src-tauri/src/topology/mod.rs::NeighborRecord`
- TS:     (consumed structurally; fields appear in `topologyApi.ingestFromBlock` payloads)

```python
@dataclass
class NeighborRecord:
    protocol: Literal["cdp", "lldp", "bgp", "ospf", "isis"]
    local_port: str
    neighbor_name: str
    neighbor_port: str
    neighbor_mgmt_ip: Optional[str]
    neighbor_platform: Optional[str]
    neighbor_vendor: Optional[str]   # heuristic from platform string
    capabilities: list[str]          # ['router','switch',...]
```

For routing protocols (BGP, OSPF, IS-IS) `local_port` and/or `neighbor_port`
may be empty strings. The Rust ingest layer substitutes placeholders before
edge upsert (see "Edge canonicalisation" below).

## Edge canonicalisation rule

`graph::upsert_edge` (`src-tauri/src/topology/graph.rs`) sorts the full
`(device_ref, port)` tuple lexicographically before INSERT so bidirectional
records collapse to a single row.

**Concrete example.** R1's CDP says:

```
local: Gi0/1   ↔   neighbor: R2 / Gi0/2
```

R2's CDP says:

```
local: Gi0/2   ↔   neighbor: R1 / Gi0/1
```

Both records canonicalise to the same edge:

```
a_device_ref="R1", a_port="Gi0/1", b_device_ref="R2", b_port="Gi0/2", protocol="cdp"
```

(Because `("R1","Gi0/1") < ("R2","Gi0/2")` lexicographically.)

For routing protocols where ports are empty, ingest substitutes:

- Empty `local_port` → `peer:<neighbor_ip_or_name>`
- Empty `neighbor_port` → `peer:<source_device_ref>`

This keeps the PK unique across multiple BGP/OSPF peers from the same source
device.

## Click-to-SSH

When the user clicks a neighbor node in the inline panel or the global
Topology tab, the resolver `openNeighbor(node, handlers)` from
`src/lib/topology.ts` runs:

1. Pick `ref = node.mgmt_ip ?? node.device_ref`.
2. `invoke("device_lookup_by_ref", { ref })` queries
   `ssh_connections.host` (priority 1) and `netconf_devices.host` (priority
   2) and returns `{kind, device_ref}` or `null`.
3. If `kind === "ssh"`: handler `onOpenSshTab(saved.device_ref)` runs.
4. If `kind === "netconf"`: handler `onOpenNetconfTab(saved.device_ref)` runs.
5. If `null` (or the lookup throws): handler `onUnknownNeighbor(node)` runs;
   the parent component renders `SaveNeighborModal` which lets the user save
   the neighbor as either an SSH or NETCONF connection.

### Plan 10 chain integration (deferred)

Plan 10 ships `chain_create / list / execute / ...` Tauri commands but does
NOT expose `session_chain_resolve(device_ref)`. Once that command lands, the
resolver should call it before dispatching `onOpenSshTab` so jump-host chains
flow through automatically. The TODO sits at `src/lib/topology.ts::openNeighbor`.

## Auto-refresh

The full Topology tab supports an auto-refresh timer (Plan 13 Phase 5.1).
Configurable in the toolbar dropdown:

- Off (default for tests; `null` interval)
- 30 seconds (`30000` ms)
- 1 minute (`60000` ms — recommended default for live labs)
- 5 minutes (`300000` ms)
- 15 minutes (`900000` ms)

The selected interval persists to localStorage at
`ccie:topology.autoRefreshIntervalMs`. Clear that key to reset to the
default. The timer lives in a `useEffect` inside `TopologyTab.tsx`; it tears
down cleanly on unmount or when the interval is set back to null.

## Adding a new protocol

To add (for example) EIGRP:

1. **Sidecar parser**
   - Open `sidecar/src/ccie_sidecar/topology/neighbors.py`.
   - Add `"eigrp"` to the `Protocol` literal and `_ALL_PROTOCOLS` tuple.
   - Add a `_from_genie_eigrp(data)` helper that walks the Genie schema
     (`show ip eigrp neighbors` returns
     `data["eigrp_instance"][<asn>]["vrf"][<vrf>]["interfaces"][<if>]["eigrp_nbr"][<ip>]`).
   - Wire the dispatcher (`_from_genie`) to the new helper.
   - Drop a real fixture into
     `sidecar/tests/fixtures/show_ip_eigrp_neighbors_iosxe.txt` (NEVER
     fabricate — copy from the Genie test corpus).
   - Add a test case in
     `sidecar/tests/topology/test_routing_neighbors.py`.

2. **Sidecar protocol gate**
   - Update the validation in `sidecar/src/ccie_sidecar/server.py` for the
     `topology.neighbors` method to accept `"eigrp"`.

3. **Rust ingest**
   - Update `protocol_re()` in `src-tauri/src/commands/topology.rs` to match
     `show ip eigrp neighbors` and surface `"eigrp"` from the regex.
   - Update the protocol CHECK constraint in a NEW migration (V0041+) — the
     `topology_edges` table currently restricts `protocol` to
     `'cdp','lldp','bgp','ospf','isis'`. Add the new value via:

     ```sql
     -- V004X__topology_edges_eigrp.sql
     -- SQLite doesn't support ALTER TABLE ... DROP CONSTRAINT, so we follow
     -- the standard rebuild pattern: rename, create-with-new-check, copy,
     -- drop-old, indexes.
     ```

4. **Frontend**
   - Update `Protocol` and `TOPOLOGY_TRIGGER_CMD_RE` and `detectTopologyProtocol`
     in `src/lib/topology.ts`.
   - Add an edge style for `eigrp` to `PROTOCOL_EDGE_STYLE` in
     `src/components/topology/topologyTheme.ts` (e.g., teal solid stroke
     1.5px).
   - Add coverage in `src/lib/topology.test.ts` to assert the new regex
     matches the new command.

5. **Docs** — update this file's "Trigger commands" table + the new edge
   style row.

## Vendor color tokens

Defined in `src/components/topology/topologyTheme.ts::VENDOR_COLOR`:

| Vendor   | Hex        | Notes                                              |
| -------- | ---------- | -------------------------------------------------- |
| cisco    | `#1e6cb6`  | blue                                                |
| juniper  | `#3aa676`  | green                                               |
| arista   | `#c0392b`  | red                                                 |
| meraki   | `#7f5fb0`  | purple                                              |
| unknown  | `#7f7f7f`  | grey — fallback for null vendor or unmapped string  |

The vendor heuristic in `neighbors.py::_vendor_from_platform` infers vendor
from the `platform` field returned by Genie / TextFSM:

- "cisco", "nexus", "catalyst", "csr", "isr", "c93", "c92", "n9k", "ws-c"
  → `"cisco"`
- "juniper", "junos", "vmx" (substring) or padded " mx", " ex", " qfx",
  " srx" (token) → `"juniper"`
- "arista", "dcs", "7050" → `"arista"`
- " ms ", " mr " (padded tokens) → `"meraki"`
- otherwise → `"unknown"` (or `None`)

The padded-token check on Juniper/Meraki avoids substring false-positives on
common words.

## Edge protocol styles

Defined in `src/components/topology/topologyTheme.ts::PROTOCOL_EDGE_STYLE`:

| Protocol | Stroke    | Width | Dasharray      | Notes                             |
| -------- | --------- | ----- | -------------- | --------------------------------- |
| cdp      | `#888`    | 1.5   | (none)         | solid grey                        |
| lldp     | `#888`    | 1.5   | `4 3`          | dashed grey                       |
| bgp      | `#c0392b` | 2.5   | (none)         | thick red — emphasises peering    |
| ospf     | `#7f5fb0` | 1.5   | `1 3`          | dotted purple                     |
| isis     | `#d68a3c` | 1.5   | `6 3`          | dashed orange                     |

The custom `NeighborEdge` component in
`src/components/topology/NeighborEdge.tsx` reads `edge.data.protocol` and
forwards both the protocol-specific style AND a `data-protocol` attribute on
the underlying SVG path so e2e tests can assert on edge protocol.

## Tables (V0040)

Schema lives in `src-tauri/migrations/V0040__topology_graphs_and_neighbor_cache.sql`.

- `topology_graphs(id PK, name UNIQUE, description, created_at, updated_at)` —
  one row seeded as `Global` (id `00000000-0000-0000-0000-0000000000g1`).
- `topology_nodes(graph_id, device_ref, device_kind, label, vendor, platform, mgmt_ip)` —
  PK `(graph_id, device_ref, device_kind)`. FK to `topology_graphs(id)` ON
  DELETE CASCADE.
- `topology_edges(graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol, captured_at)` —
  PK `(graph_id, a_device_ref, a_port, b_device_ref, b_port)`. FK to
  `topology_graphs(id)` ON DELETE CASCADE. `protocol` CHECK constraint:
  `'cdp','lldp','bgp','ospf','isis'`.
- `neighbor_cache(device_ref, device_kind, source_cmd, raw_output, parsed_json, captured_at)` —
  PK `(device_ref, device_kind, source_cmd)`. Caches the raw + canonical
  records the last time the source device was queried.

## Known limitations / deferrals

- **Site dimension** — the filter tree's "Site" group is disabled until
  Plan 13.x adds a tagging surface that lets users assign devices to sites.
- **Layout for >50 nodes** — current deterministic layout (radial ≤15,
  vendor-bucketed grid otherwise) is sufficient for lab topologies.
  Production deployments with 50+ devices will likely want `d3-force`;
  documented in `docs/design/topology-global.md`.
- **Export PNG** — toolbar button is a `console.warn` stub; needs
  `html-to-image` or a `@xyflow/react` v12 export helper.
- **Inspector "Open SSH/NETCONF" buttons** dispatch `openNeighbor` but the
  `onOpenSshTab` / `onOpenNetconfTab` handlers are currently `console.info`
  stubs in both `CommandBlock.tsx` and `TopologyTab.tsx`. Wiring them to
  `tabNewApi`/`tabNewNetconf` (or a new `tabNewSshFromConnection` helper)
  remains a follow-up.
- **Plan 04 palette entry** — not registered. The palette is server-driven
  (Rust-backed seed); adding the topology entry is a separate small task
  for whoever next touches the palette layer.
- **`session_chain_resolve` from Plan 10** — not yet exposed; resolver
  falls back to direct connect.

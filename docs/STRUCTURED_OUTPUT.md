# Structured Show-Output Layer

The Structured tab on every `CommandBlock` parses `show *` output via the
sidecar's Genie / TextFSM bridge (Plan 00) and renders it as a
sortable / filterable table. Pinned snapshots can be diffed via a public
diff engine consumed by Plans 06 (Pre/Post Change Verification) and 08
(Config Intent + Drift).

## Architecture

```
┌──────────────────────────┐
│ user types `show ip route│
│       → enter`           │
└────────────┬─────────────┘
             │
             ▼
   ┌──────────────────────┐         ┌──────────────────────┐
   │ usePty fires         │         │  blocksStore         │
   │ command_start        │ ──────▶ │  addBlock() splits   │
   │ command_end          │         │  pipe-filter, stores │
   └──────────┬───────────┘         │  it on the block     │
              │                     └──────────┬───────────┘
              │                                │
              ▼                                ▼
   ┌──────────────────────┐         ┌──────────────────────┐
   │ blocksStore          │         │ structured_auto_parse│
   │ completeBlock()      │ ──────▶ │ Tauri command +      │
   │  → autoParseBlock()  │         │ ParserBridge.parse() │
   └──────────────────────┘         │  → parsed_outputs    │
                                    │   (UNIQUE block_id)  │
                                    └──────────┬───────────┘
                                               │
                                               ▼
                                    ┌──────────────────────┐
                                    │ StructuredTab fetches│
                                    │ via getStructured(),│
                                    │ renders react-table  │
                                    └──────────────────────┘
```

## Data shapes

The bridge always returns one of two shapes:

**List of dicts** (TextFSM): `[{ "interface": "Gi1", "status": "up" }, …]`.
Renders directly as a table; columns inferred via `inferColumns`.

**Nested dict** (Genie): `{ "vrf": { "default": { "address_family": … } } }`.
Flattened by `flattenToRows` to dotted-path key/value pairs:

```json
[
  { "key": "vrf.default.address_family.ipv4.routes.10.0.0.0/24.metric", "value": 0 },
  { "key": "vrf.default.address_family.ipv4.routes.10.0.0.0/24.next_hop.…", "value": "Gi1" }
]
```

A JSONPath bar lets the user drill into a nested dict before the flattener
runs (e.g. `$.vrf.default.address_family.ipv4.routes`).

## Pipe-filter syntax

Append `| ↗structured.<expr>` to any command. The raw command sent to the
device is everything LEFT of the `|`; the expression is parsed and stored
on the block as `block.structuredFilter`, then auto-applied to the
StructuredTab.

```
show ip route                | ↗structured.nexthop=10.0.0.1
show interfaces              | ↗structured.intf ~ /^Gi[0-9]+$/
show ip interface brief      | ↗structured.status in (up, down)
show vlan brief              | ↗structured.status not in (suspended)
show ip route                | ↗structured.jsonpath:$.vrf.default.address_family.ipv4
```

Supported ops: `=`, `~`, `in (...)`, `not in (...)`, `jsonpath:`. Malformed
expressions are silently ignored (the full command stays on the block, no
filter recorded — `console.warn` logs the parse error).

## Snapshot lifecycle

1. **Pin** — toolbar button on the StructuredTab (or `View → Pin
   Snapshot…`, `⌘⇧P`) opens a dialog with the command pre-filled as the
   default name. Submits via `structured_snapshot_create`.
2. **Rename** — click the ✎ on `SnapshotList`.
3. **Delete** — click the × on `SnapshotList`.

The `parsed_snapshots` table holds `(tab_id, name, parsed_output_id)`;
deleting a snapshot leaves `parsed_outputs` intact.

## Diff engine — public contract

The diff engine is the foundation for Plans 06 and 08. Its signature is
**frozen** as of Plan 05 Phase 4.

### Rust

```rust
use ccie_terminal_lib::structured::diff_snapshots;
// also re-exports CellDiff, DiffStatus

let cells: Vec<CellDiff> = diff_snapshots(pre_id, post_id, db.clone())?;
for cell in cells {
    match cell.status {
        DiffStatus::Added | DiffStatus::Removed | DiffStatus::Changed => {
            println!("{} {}: {:?} → {:?}", cell.row_key, cell.column, cell.a, cell.b);
        }
        DiffStatus::Unchanged => {}
    }
}
```

### TypeScript

```ts
import { diffSnapshots, type CellDiff } from "@/lib/diff";

const cells: CellDiff[] = await diffSnapshots(preId, postId);
```

### Alignment strategy

1. If a `parse_schemas(parser, command, vendor, platform)` row exists with
   `schema_json.key`, that field is the alignment key.
2. Otherwise, for list-of-dicts data, the first column whose values are
   unique on both sides becomes the key.
3. For nested-dict data, both sides are flattened by the same algorithm
   used in `src/lib/flatten.ts` and aligned by dotted-path key.

### Tuning alignment

Insert a row into `parse_schemas` to override the auto-detected key:

```sql
INSERT INTO parse_schemas (parser, command, vendor, platform, schema_json)
VALUES (
  'textfsm',
  'show ip interface brief',
  'cisco',
  'iosxe',
  '{"key": "interface"}'
);
```

## Export & clipboard

The toolbar exposes:
- **Export CSV** — `papaparse` round-trip of the currently filtered+sorted
  view (not the raw payload). Quotes embedded commas and double-quotes per
  RFC 4180.
- **Export JSON** — pretty-printed JSON of the visible rows.
- **Copy as Markdown** — GFM-compatible table; pipes inside cells are
  escaped as `\|`.

The same actions are also reachable from the **View** menu and via the
`structured:export-trigger:<blockId>` window event.

## Migration

| Migration | Tables                              | Notes |
| --------- | ----------------------------------- | ----- |
| V0032     | `parsed_outputs(block_id UNIQUE)`,  | Plan 05 |
|           | `parsed_snapshots`,                 | |
|           | `parse_schemas`                     | |

## Tests

| Suite | File | Count |
| --- | --- | --- |
| Auto-parse hook | `src-tauri/tests/structured_auto_parse_test.rs` | 5 |
| Snapshot CRUD | `src-tauri/tests/structured_snapshot_test.rs` | 6 |
| Diff engine | `src-tauri/tests/structured_diff_test.rs` | 8 |
| 8 canonical shows round-trip | `src-tauri/tests/structured_e2e_test.rs` | 8 |
| Flatten | `src/lib/flatten.test.ts` | 7 |
| Wrappers | `src/lib/structured.test.ts`, `src/lib/diff.test.ts` | 8 |
| Pipe filter | `src/lib/structuredPipe.test.ts` | 14 |
| Export | `src/lib/export.test.ts` | 8 |
| Hook + components | `src/hooks/useStructuredOutput.test.tsx`, `src/components/{StructuredTab,BlockTabStrip,SnapshotPinDialog,SnapshotList,StructuredDiff,CommandBlock.structured}.test.tsx` | 31 |
| blocksStore pipe wiring | `src/state/blocksStore.pipe.test.ts` | 3 |


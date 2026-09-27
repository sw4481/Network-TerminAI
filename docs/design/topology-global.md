# Topology — Global Tab Design Spec

Pre-impl design checkpoint for Plan 13 Phase 4: a full-tab Topology view that
aggregates ALL `neighbor_cache` rows across ALL devices into one merged,
force-directed graph with filters and an inspector.

## Context7 verification

`@xyflow/react@^12` already verified for Phase 2 (see `topology-inline.md`).
Same package, same import path. Additional v12 surface used in this tab:

- **`<MiniMap />`** — `import { MiniMap } from "@xyflow/react";` — props:
  `nodeStrokeColor?`, `nodeColor?`, `nodeClassName?`, `position?`, `pannable?`,
  `zoomable?`, `style?`. We use the default `bottom-right` position with
  `pannable + zoomable`.
- **`<Controls />`** — `import { Controls } from "@xyflow/react";` — props:
  `showZoom`, `showFitView`, `showInteractive`, `position`. We hide the
  interactive (lock) toggle since the graph is read-only.
- **`<Background />`** — `import { Background } from "@xyflow/react";` —
  variant `"dots"` for a subtle backdrop.
- **`fitView` prop** on `<ReactFlow>` — set on initial mount only via
  `defaultViewport` so user pan/zoom isn't snapped back on every refresh.

`d3-force` (per plan): NOT introduced for Phase 4 v1. We use a simple
deterministic radial layout for ≤15 nodes (Phase 1 fixtures) and a tier-based
grid for larger graphs. If a real customer deploys with 50+ devices we'll add
`d3-force` then; for the initial release the layout cost isn't worth a new
dependency. Documented as a deferral.

## UX wireframe

```
┌────────────────────────────────────── Topology Tab ─────────────────────────────────────┐
│ ┌─ Toolbar ──────────────────────────────────────────────────────────────────────────┐ │
│ │ [⟳ Refresh]  Auto-refresh: [60s ▾]  [📷 Export PNG]  [🗑 Clear graph]               │ │
│ └─────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ Filter Tree ────────┐ ┌─ Canvas ──────────────────────────────┐ ┌─ Inspector ──────┐ │
│ │ ▾ Site               │ │                                        │ │ R5               │ │
│ │   ☑ lab1            │ │     ●R1                                │ │ vendor: cisco    │ │
│ │   ☑ lab2            │ │       ╲                                │ │ platform: csr    │ │
│ │ ▾ Vendor            │ │        ●R3 ──── ●R5                    │ │ mgmt: 10.0.0.5   │ │
│ │   ☑ cisco           │ │       ╱     ╲                          │ │                  │ │
│ │   ☑ juniper         │ │     ●R2      ●R4                       │ │ Neighbors:       │ │
│ │ ▾ Platform          │ │                                        │ │ • R3 (Gi0/1)     │ │
│ │   ☑ iosxe           │ │ MiniMap (bottom-right)                 │ │ • R4 (Gi0/2)     │ │
│ │   ☑ nxos            │ │ Controls (bottom-left)                 │ │                  │ │
│ │ ▾ Protocol          │ │                                        │ │ [Open SSH]       │ │
│ │   ☑ cdp             │ │                                        │ │ [Open NETCONF]   │ │
│ │   ☑ lldp            │ │                                        │ │                  │ │
│ │   ☐ bgp (none)      │ │                                        │ │                  │ │
│ └──────────────────────┘ └────────────────────────────────────────┘ └──────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Layout: 3-column flex (filter tree fixed-width 220px on left; canvas flex-1
center; inspector slides in 280px on right when a node is selected; otherwise
hidden so the canvas reclaims that width).

## Filter Tree (sidebar)

`TopologyFilterTree` derives groups from `topologyStore.nodes` and `.edges`:

```ts
interface TopologyFilterState {
  sites: Set<string>;        // Phase 4 v1: empty (no site dimension yet — derived from "site" tag once Plan 13.5 adds tagging)
  vendors: Set<string>;      // 'cisco', 'juniper', 'arista', 'meraki', 'unknown'
  platforms: Set<string>;    // 'iosxe', 'nxos', etc — derived from node.platform
  protocols: Set<Protocol>;  // 'cdp', 'lldp' (Phase 5: + bgp/ospf/isis)
}
```

**Default state**: ALL options checked (show everything). Users toggle off to
filter.

**Tree shape**: each top-level (Site / Vendor / Platform / Protocol) is a
collapsible `<details>` with a parent checkbox that toggles all children. For
Phase 4 v1, the **Site** group is grayed out / disabled with a "(coming soon)"
hint since we don't have a site dimension yet.

CSS classes: `.topology-filter-tree`, `.topology-filter-tree__group`,
`.topology-filter-tree__leaf`, `.topology-filter-tree__checkbox`.

## Toolbar

`TopologyToolbar`:
- **Refresh** button (`⟳`) — calls `topologyStore.refresh()`.
- **Auto-refresh interval dropdown** — values: `off | 30s | 60s | 5min | 15min`,
  default `60s`. Persists to localStorage key
  `ccie:topology.autoRefreshIntervalMs`. Phase 5.1 will refine.
- **Export PNG** — uses `@xyflow/react`'s `toPng` from `@xyflow/react/dist`
  (verify availability before wiring — fallback: skip the button if helper
  not exposed in v12, document deferral).
- **Clear graph** — destructive; opens a confirm dialog ("This deletes all
  nodes and edges in the current graph. Cancel/Confirm."). Calls
  `topologyStore.clearGraph(currentGraphId)`.

CSS: `.topology-toolbar`, `.topology-toolbar__group`, `.topology-toolbar__button`,
`.topology-toolbar__select`, `.topology-toolbar__danger`.

## Canvas

`TopologyTab` renders `<ReactFlow>` with:

- `nodes` and `edges` derived from `topologyStore` filtered by
  `filterState`.
- `nodeTypes={{ neighbor: NeighborNode }}` reusing the Phase 2 NeighborNode
  component.
- `edgeTypes={{ default: NeighborEdge }}` reusing Phase 2's NeighborEdge so
  `data-protocol` survives.
- `<MiniMap pannable zoomable />`, `<Controls showInteractive={false} />`,
  `<Background variant="dots" />`.
- `nodesDraggable={true}` (full-tab view allows the user to drag nodes for
  manual layout fixes — unlike the inline panel).
- `nodesConnectable={false}` (read-only graph topology).
- `onNodeClick={(_, n) => setSelectedNodeId(n.id)}` to drive the inspector.

**Layout algorithm** for Phase 4 v1: deterministic + simple.

```
For ≤15 nodes: radial — one node at center (highest connection count),
others arranged on concentric rings by hop distance.

For >15 nodes: tier grid — group by vendor, then arrange in rows of 6.

Both algorithms produce a stable, deterministic layout per topology so
auto-refresh doesn't shuffle nodes.
```

`d3-force` is deferred until customer feedback warrants it.

## Inspector

`TopologyInspector` slides in from the right when a node is selected.

Content for the selected node:
- Label + vendor badge.
- `device_kind` chip (`ssh` / `netconf` / `discovered`).
- `mgmt_ip` (clickable copy-to-clipboard).
- Platform.
- All edges touching this node, grouped by protocol.
  Each edge row: `<protocol> · <local_port> ↔ <neighbor>:<neighbor_port>`.
- Action buttons:
  - **Open SSH** — calls the same `openNeighbor` resolver as the inline
    panel (`onOpenSshTab` handler). Hidden if `device_kind !== 'ssh'`.
  - **Open NETCONF** — analogous, hidden unless `device_kind === 'netconf'`.

CSS: `.topology-inspector`, `.topology-inspector__header`,
`.topology-inspector__neighbors`, `.topology-inspector__action`.

## tab_type registration

In `src/lib/types.ts`, add `"topology"` to `TabType`:
```ts
export type TabType = "terminal" | "api" | "netconf" | "editor" | "topology";
```

`tabsStore` accepts the new kind without further changes (Tab type literally
just stores the string).

## Command palette entry

Plan 04 contract: surface "New Topology Tab" via the palette so users can
launch the global view from `⌘K`. Palette registration lives in
`src/lib/palette.ts` (look at how "New API Tab" / "New NETCONF Tab" entries
are registered). Add:

```ts
{
  id: 'topology.new-tab',
  title: 'Topology — Open Global View',
  category: 'Open',
  perform: () => useTabs.getState().addTab({
    id: nanoid(),
    title: 'Topology — Global',
    shell_cmd: '',
    cwd: '/',
    created_at: Math.floor(Date.now()/1000),
    tab_type: 'topology',
  }),
}
```

(Adapt to the exact palette-entry shape used elsewhere.)

## App.tsx mount

The tab content router (look at `src/App.tsx` for where it switches on
`tab.tab_type`) needs a new case:

```tsx
} else if (tab.tab_type === 'topology') {
  return <TopologyTab key={tab.id} tabId={tab.id} />;
}
```

## Files to create

- `src/components/topology/TopologyTab.tsx` + `.css` (the parent)
- `src/components/topology/TopologyFilterTree.tsx` + `.css`
- `src/components/topology/TopologyInspector.tsx` + `.css`
- `src/components/topology/TopologyToolbar.tsx` + `.css`
- `src/components/topology/TopologyTab.test.tsx`

## Files to modify

- `src/lib/types.ts` — add `"topology"` to TabType.
- `src/state/topologyStore.ts` — add `autoRefreshIntervalMs: number | null`
  + `setAutoRefreshInterval(ms)` action persisted to localStorage. (Phase 5.1
  will hook the actual `setInterval` timer; Phase 4 just stores the
  preference.)
- `src/lib/palette.ts` — register the new palette entry (or whatever file
  hosts palette commands).
- `src/App.tsx` — add the `topology` tab-type case.

## Phase 4 vs Phase 5 split

| Concern                        | Phase 4 | Phase 5 |
|--------------------------------|---------|---------|
| TopologyTab + filter tree      | ✓       |         |
| Inspector + Open SSH/NETCONF   | ✓       |         |
| Refresh button                 | ✓       |         |
| Auto-refresh dropdown (UI)     | ✓       |         |
| **Auto-refresh actual timer**  |         | ✓       |
| Export PNG                     | ✓ (best-effort) |  |
| Clear graph                    | ✓       |         |
| BGP/OSPF/ISIS ingestion        |         | ✓       |
| `docs/TOPOLOGY.md`             |         | ✓       |

## Test selectors

- `data-testid="topology-tab"` on the root container
- `data-testid="topology-filter-tree"` on the sidebar
- `data-testid="topology-inspector"` when visible
- `data-testid="topology-toolbar"` on the toolbar
- `data-testid="topology-clear-confirm"` on the destructive confirm dialog
- `data-testid="topology-empty"` when no nodes after filtering

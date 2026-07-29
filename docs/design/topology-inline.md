# Topology — Inline Panel Design Spec

Design checkpoint for Plan 13 Phase 2: an inline neighbor-graph panel that
slots into the right of a `CommandBlock` whenever the block's command matches
`/^\s*show\s+(cdp|lldp)\s+neighbor/i`.

## Context7 verification (PRE-impl)

Verified via `mcp__plugin_context7_context7__resolve-library-id("React Flow")`
and `mcp__plugin_context7_context7__query-docs` on **2026-05-19**.

- **Package name (current major):** `@xyflow/react` (NOT `reactflow` — the
  package was renamed when v12 shipped). The plan's literal use of "reactflow"
  is therefore historical; we install `@xyflow/react`.
- **CSS import:** `import "@xyflow/react/dist/style.css";`
- **`<ReactFlow />` props (verified, abridged):**
  - `nodes: Node[]`, `edges: Edge[]`
  - `nodeTypes: Record<string, ComponentType<NodeProps<...>>>`
  - `onNodeClick: NodeMouseHandler<Node>` — signature
    `(event: React.MouseEvent, node: Node) => void`
  - `fitView?: boolean`, `fitViewOptions?: FitViewOptions`
  - `nodesDraggable?: boolean`, `panOnDrag?: boolean | number[]`,
    `zoomOnScroll?: boolean`, `zoomOnPinch?: boolean`
  - Children include optional `<MiniMap />`, `<Controls />`, `<Background />`
- **`Node` type (verified):**

  ```ts
  type Node<DataT = Record<string, unknown>, TypeT extends string = string> = {
    id: string;
    type?: TypeT;
    data: DataT;
    position: { x: number; y: number };
    // …optional layout/styling
  };
  ```

- **Custom-node component signature:**

  ```tsx
  import type { NodeProps, Node } from "@xyflow/react";
  type NeighborNodeT = Node<{ vendor?: string; label: string; mgmtIp?: string; localPort?: string; neighborPort?: string }, "neighbor">;
  export function NeighborNode(props: NodeProps<NeighborNodeT>) { … }
  ```

- **MiniMap / Controls disable:** simply OMIT the `<MiniMap />` / `<Controls />`
  children. They render only when explicitly placed inside `<ReactFlow>`.

- **Install command:** `bun add @xyflow/react`. We pin the major version with
  `bun add @xyflow/react@^12` so future v13 releases don't silently break us.

## UX wireframe — wide screen (≥ 900px CommandBlock width)

```
┌─────────────────────────── CommandBlock ────────────────────────────────────┐
│ ▾ R1#  show cdp neighbors detail                       …  ✓  2.4s          │
│                                                                             │
│ ┌─ output (left, scrollable) ────────────────┐ ┌─ topology side panel ─────┐ │
│ │                                            │ │ Neighbors (3)         ⛶  │ │
│ │ Device ID: R2.lab.example                  │ │ ┌──────────────────────┐ │ │
│ │ IP address: 10.0.0.2                       │ │ │      ●  R1 (this)    │ │ │
│ │ Platform: cisco WS-C2960S                  │ │ │     ╱│╲              │ │ │
│ │ ...                                        │ │ │   ── ── ──  edges    │ │ │
│ │                                            │ │ │  ●R2  ●R3   ●R4      │ │ │
│ │                                            │ │ │ cisco juniper unknwn │ │ │
│ │                                            │ │ └──────────────────────┘ │ │
│ │                                            │ │ Click a neighbor to open │ │
│ └────────────────────────────────────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

## UX wireframe — narrow screen (< 900px CommandBlock width)

```
┌─────────────────────── CommandBlock ──────────────┐
│ ▾ R1#  show cdp neighbors detail   ✓  2.4s        │
│ [output]                                          │
│                                                   │
│ 🔗  3 neighbors — show graph ▶                    │
└───────────────────────────────────────────────────┘
        ↑
    chip collapses panel; click expands inline below output
```

## Component layout — Tailwind-ish CSS class names

Even though the codebase uses plain CSS files (no Tailwind), the design uses
semantic class names. We'll define them in `src/components/topology/InlineTopologyPanel.css`.

- Container: `.cb-side-panel` (placed in a flex child of the CommandBlock)
- Inner wrapper: `.topology-inline` (height capped at 280px — `max-height: 280px; overflow: hidden;`)
- Header strip: `.topology-inline__header` ("Neighbors (N)" + expand icon button)
- ReactFlow canvas wrapper: `.topology-inline__canvas` (`flex: 1; min-height: 200px;`)
- Empty state: `.topology-inline__empty` ("No neighbors discovered yet.")
- Narrow-screen chip: `.topology-inline__chip` (collapsed mode, single-line link)
- Custom node root: `.neighbor-node` (vendor color from CSS var
  `--neighbor-vendor-color`)
- Tooltip (renders on hover via `aria-describedby`): `.neighbor-node__tooltip`

Vendor color tokens (define in `topologyTheme.ts`):

```ts
export const VENDOR_COLOR: Record<string, string> = {
  cisco:   "#1e6cb6", // blue
  juniper: "#3aa676", // green
  arista:  "#c0392b", // red
  meraki:  "#7f5fb0", // purple
  unknown: "#7f7f7f", // grey
};
```

Edge style tokens:

- CDP → solid (`stroke-dasharray: none`), stroke `#888`, strokeWidth 1.5
- LLDP → dashed (`stroke-dasharray: 4 3`), stroke `#888`, strokeWidth 1.5

## ReactFlow `Node` / `Edge` shapes for THIS panel

`Node`:

```ts
type NeighborNodeT = Node<
  {
    label: string;       // visible label below the circle
    vendor: string;      // 'cisco' | 'juniper' | 'arista' | 'meraki' | 'unknown'
    mgmtIp?: string;     // tooltip
    localPort?: string;  // tooltip — `localPort` ↔ `neighborPort`
    neighborPort?: string;
    isSource?: boolean;  // marks the source node (e.g. R1 itself)
  },
  "neighbor"
>;
```

`Edge`:

```ts
type NeighborEdgeT = Edge<
  { protocol: "cdp" | "lldp" },
  "default"
>;
// Style applied via `data` lookup in InlineTopologyPanel:
//   protocol === 'cdp'  → solid
//   protocol === 'lldp' → dashed
```

## Behavior

- Panel renders only when `block.status === "completed"` and the trigger regex
  matches the block command. Hidden otherwise.
- Hydrates asynchronously: `useEffect` subscribes to `topologyStore` and slices
  the global graph nodes/edges down to those involving `block.device_ref`.
  (Phase 1 inserted into the Global graph; Phase 2 read-side filter.)
- `onNodeClick` calls `openNeighbor(node)` (Phase 3 implements; Phase 2 stubs
  to a no-op + console.warn for now).
- The "expand to full topology tab" button (⛶) opens the Global graph in a new
  topology tab — Phase 4 implements; Phase 2 stubs.
- Max 6 visible nodes before vertical scroll inside the canvas wrapper. The
  ReactFlow viewport `fitView` is enabled; for >6 nodes we cap the visible
  region with `maxZoom: 1.5`.

## Accessibility

- `aria-label="Neighbor topology graph"` on the ReactFlow root.
- Each `NeighborNode` has `role="button"`, `tabIndex={0}`, `aria-label`
  reflecting the neighbor name + vendor.
- Keyboard: focus moves between nodes with Tab; Enter triggers click.

## Test selectors (test_ids for vitest + playwright)

- `data-testid="topology-inline-panel"` on container
- `data-testid="topology-node"` on each `NeighborNode` root
- `data-vendor="cisco|juniper|arista|meraki|unknown"` on each node
- `data-protocol="cdp|lldp"` on each edge path
- `data-testid="topology-inline-empty"` on empty state
- `data-testid="topology-inline-chip"` on narrow-screen chip

---

## Implementer notes

1. **Install version**: `bun add @xyflow/react@^12`. Then check `package.json`
   shows `"@xyflow/react": "^12.x.y"` and the lockfile updated.
2. **Imports**: `import { ReactFlow, type Node, type Edge, type NodeProps } from "@xyflow/react";` plus `import "@xyflow/react/dist/style.css";` once at the top of `InlineTopologyPanel.tsx` (CSS bleeds globally — that's intentional).
3. **Avoid `useNodesState` / `useEdgesState`**: this graph is *display-only*.
   Pass `nodes` and `edges` directly with no `onNodesChange` / `onEdgesChange`.
   Set `nodesDraggable={false}` and `nodesConnectable={false}`.
4. **No `<MiniMap />` and no `<Controls />`** — match the design wireframe
   (the panel is small; controls would dominate it).
5. **Custom node**: `NeighborNode.tsx` is a vendor-coloured circle (40px
   diameter), label below, on hover surfaces a tooltip with
   `localPort ↔ neighborPort` and `mgmtIp`.
6. **Test file**: see Test selectors above. Use vitest + Testing Library; mock
   the store with three preset nodes and two edges.

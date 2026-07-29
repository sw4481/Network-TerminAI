# Blocks: Pin / Tag / Filter — Design Spec

> Phase 2 deliverable for Plan 01 (Command Blocks). This spec covers three new
> UI regions that extend the existing block model: a pinned-blocks row above
> the scrolling block list, an inline tag-chip strip on each block header, and
> a tag-filter bar fixed to the top-right of the active tab.

## 1. Aesthetic direction

**Tone:** "operator-console minimalism." We lean into the existing Warp-inspired
dark palette and double down on the network-engineer's mental model — these are
machine artifacts, not social media chips. Chips read as **monospace labels with
sharp 2px corners**, never pill-rounded; the only rounded element on the page
remains the parent `.command-block` (6px). Pinned blocks float above the list
on a near-invisible **1px hairline divider with a faint cyan glow on the left
edge** — a quiet "this is sticky" cue.

**Conceptual through-line:** the pinned row should feel like a *wireshark
filter bar* fused with an *xterm bookmarks pane* — utilitarian, scannable,
zero ornament. No emoji icons (the existing ★ bookmark glyph is the one
exception, kept). Tags use the existing accent colors strictly:
- cyan `#5ccfe6` — selected/applied filter
- gold `#ffd700` — pinned/bookmarked
- muted `#8a8d94` — idle chip text
- danger `#e07b7b` (matches existing red exit code) — destructive remove hover

**Typography:** all chip text is **`SF Mono` 11px / weight 500 / letter-spacing
0.02em**, matching `.command-text`. The "+" add-tag affordance is an outlined
12×16px monospace plus, never an SVG.

## 2. ASCII wireframe — active tab, blocks mode

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ Tabs:  [ atl-edge-01 ●][ + ]                                                           │
├───────────────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────┐    ┌───────────────────────────────┐   │
│  │  PINNED  •  3 blocks                       │    │ FILTER  ▸  [golden] [site-atl]│   │
│  │  ┌────────────────────────────────────────┐│    │  [bgp]  [ +tag... ]           │   │
│  │  │ ▸ show ip bgp summary       2.4s  ★    ││    └───────────────────────────────┘   │
│  │  │   tags: [golden] [bgp] [site-atl] +    ││                                        │
│  │  └────────────────────────────────────────┘│                                        │
│  │  ┌────────────────────────────────────────┐│                                        │
│  │  │ ▸ show interface description  1.1s     ││                                        │
│  │  │   tags: [site-atl] +                   ││                                        │
│  │  └────────────────────────────────────────┘│                                        │
│  │  ┌────────────────────────────────────────┐│                                        │
│  │  │ ▸ show running-config | sec ospf 0.8s  ││                                        │
│  │  │   tags: [golden] +                     ││                                        │
│  │  └────────────────────────────────────────┘│                                        │
│  └───────────────────────────────────────────┘                                         │
│  ─────────────────────── pinned hairline (1px #262a33, cyan 4px left edge) ──────      │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │ ▾ show ip route                          1.7s   exit 0   12:04 PM        ★      │◄──┤ block (expanded)
│  │   tags:  [golden]  [site-atl]  [+]                                              │   │
│  ├─────────────────────────────────────────────────────────────────────────────────┤   │
│  │ Codes: L - local, C - connected, S - static ...                                 │   │
│  │ Gateway of last resort is 10.0.0.1 to network 0.0.0.0                           │   │
│  │ ...                                                                             │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │ ▸ ping 8.8.8.8                          0.4s   exit 0   12:05 PM                │   │
│  │   tags:  [+]                                                                    │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                         │
│  $ █                                                                                    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Key spatial rules:

- **PinnedRow** sits above `blocks-history` and shares its horizontal padding.
  It collapses to a single line ("PINNED · 0 blocks") and **renders nothing**
  (no chrome, no border) when there are zero pinned blocks — this avoids
  giving up vertical space on a fresh tab.
- **TagFilterBar** is `position: sticky; top: 0; right: 0` inside the tab body
  and floats over the right edge with a `backdrop-filter: blur(12px)` over the
  panel color, so blocks scroll cleanly behind it.
- **TagChipStrip** lives inside `.block-header`, on a *second row* under
  `.command-text`, only rendered when the block has tags **or** the block is
  hovered/focused (the "+" affordance appears on hover/focus only — keeps idle
  blocks from looking cluttered).

## 3. Component contracts

### 3.1 PinnedRow

```
src/components/PinnedRow.tsx
src/components/PinnedRow.css
src/components/PinnedRow.test.tsx
```

```tsx
interface PinnedRowProps {
  tabId: string;
}
```

- Subscribes to `useBlocksStore` and derives `pinnedBlocks = blocksByTab.get(tabId)?.filter(b => b.pinned).sort((a,b) => (a.pinPosition ?? 0) - (b.pinPosition ?? 0))`.
- Renders `null` when `pinnedBlocks.length === 0`.
- Renders a header row + N child `<PinnedBlockMini />` rows (visually a stripped-down
  `.command-block` — collapsed by default, no output, but full `BlockHeader` and
  `TagChipStrip`). Clicking the header anchors-and-scrolls the main list to
  that block (via `document.getElementById(`block-${id}`).scrollIntoView()`).
- **Drag-to-reorder** between pinned blocks: native HTML5 drag (`draggable`,
  `onDragStart`/`onDragOver`/`onDrop`) — no third-party lib. On drop, call
  `setPinPosition(blockId, newIndex)` for all affected blocks.

DOM structure / class names:

```html
<aside class="pinned-row" aria-label="Pinned blocks">
  <header class="pinned-row-header">
    <span class="pinned-row-label">PINNED</span>
    <span class="pinned-row-sep">·</span>
    <span class="pinned-row-count">3 blocks</span>
  </header>
  <ol class="pinned-row-list">
    <li class="pinned-row-item" draggable="true" data-block-id="…">
      <!-- BlockHeader + TagChipStrip, collapsed=true forced -->
    </li>
    …
  </ol>
</aside>
```

CSS hooks (`PinnedRow.css`):

```css
.pinned-row {
  padding: 8px 12px 12px;
  border-left: 2px solid #5ccfe6;       /* the "sticky" cue */
  background: linear-gradient(
    to bottom,
    rgba(92, 207, 230, 0.04),
    transparent 80%
  );
  margin-bottom: 8px;
  border-bottom: 1px solid #262a33;
}

.pinned-row-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font: 500 10px/1 'SF Mono', 'Menlo', monospace;
  letter-spacing: 0.12em;
  color: #5ccfe6;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.pinned-row-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pinned-row-item {
  background: #1a1d23;
  border: 1px solid #262a33;
  border-radius: 6px;
  cursor: grab;
}
.pinned-row-item:active { cursor: grabbing; }
.pinned-row-item[data-drop-target="true"] {
  outline: 1px dashed #5ccfe6;
  outline-offset: -1px;
}
```

### 3.2 TagChipStrip

```
src/components/TagChipStrip.tsx
src/components/TagChipStrip.css
src/components/TagChipStrip.test.tsx
```

```tsx
interface TagChipStripProps {
  blockId: string;
  tags: string[];
  /** When true, the "+ tag" add-affordance is always visible.
   *  Otherwise it only shows on parent hover/focus. */
  alwaysShowAdd?: boolean;
}
```

Behavior:

- Renders one `<button class="tag-chip">` per tag plus a trailing
  `<button class="tag-chip-add">+</button>`.
- Clicking the **chip body** toggles that tag in `filterTags` — i.e. clicking
  `[golden]` from any block's strip filters the list to golden blocks. Visual
  state mirrors the filter bar (cyan when active in `filterTags`).
- Hovering a chip reveals an inline `×` on the right side of the chip; clicking
  the `×` calls `removeTag(blockId, tag)`. The `×` is **not** a separate DOM
  element when not hovered — it expands via CSS width transition so chip
  layout doesn't reflow neighbours.
- The `+` affordance opens an inline `<input>` in place (replacing the `+`
  with a 120px-wide input). `Enter` calls `addTag(blockId, value)`; `Esc`
  cancels. Backspace in an empty input restores the `+`.

DOM:

```html
<div class="tag-chip-strip" role="list" aria-label="Tags">
  <button class="tag-chip" role="listitem" data-active="false">
    <span class="tag-chip-text">golden</span>
    <span class="tag-chip-remove" aria-hidden="true">×</span>
  </button>
  <button class="tag-chip" data-active="true">…</button>
  <button class="tag-chip-add" aria-label="Add tag">+</button>
  <!-- when adding: -->
  <input class="tag-chip-input" placeholder="tag…" />
</div>
```

CSS hooks:

```css
.tag-chip-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 0 0;
  font: 500 11px/1 'SF Mono', 'Menlo', monospace;
  letter-spacing: 0.02em;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid #3a3a3a;
  border-radius: 2px;             /* sharp, not pill */
  background: #1a1d23;
  color: #8a8d94;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  position: relative;
}
.tag-chip:hover {
  border-color: #5ccfe6;
  color: #e6e1cf;
}
.tag-chip[data-active="true"] {
  border-color: #5ccfe6;
  background: rgba(92, 207, 230, 0.12);
  color: #5ccfe6;
}
.tag-chip-remove {
  display: inline-block;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  transition: max-width 0.12s, opacity 0.12s;
  color: #e07b7b;
}
.tag-chip:hover .tag-chip-remove,
.tag-chip:focus-visible .tag-chip-remove {
  max-width: 12px;
  opacity: 1;
}
.tag-chip-add {
  /* same as .tag-chip but dashed border, muted, idle visibility 0 */
  border-style: dashed;
  color: #5a5d62;
  opacity: 0;
  transition: opacity 0.12s;
}
.command-block:hover .tag-chip-add,
.command-block:focus-within .tag-chip-add,
.tag-chip-strip[data-always-show-add="true"] .tag-chip-add {
  opacity: 1;
}
.tag-chip-input {
  width: 120px;
  padding: 2px 6px;
  border: 1px solid #5ccfe6;
  border-radius: 2px;
  background: #0f1114;
  color: #e6e1cf;
  font: inherit;
  outline: none;
}

/* Keyboard focus ring — macOS-native feel */
.tag-chip:focus-visible,
.tag-chip-add:focus-visible {
  outline: 2px solid #5ccfe6;
  outline-offset: 1px;
}
```

### 3.3 TagFilterBar

```
src/components/TagFilterBar.tsx
src/components/TagFilterBar.css
src/components/TagFilterBar.test.tsx
```

```tsx
interface TagFilterBarProps {
  /** Optional override; defaults to the union of every tag on every block in tabId. */
  availableTags?: string[];
  tabId: string;
}
```

Behavior:

- Reads `filterTags` and `setFilterTags` from the store.
- Computes `availableTags` as the deduped, sorted union of all tags present
  on blocks for `tabId`. (Cheap — block counts stay small in practice; we'll
  memoize on `blocksByTab.get(tabId)`.)
- Each chip click toggles its tag in `filterTags`.
- "Clear" appears only when `filterTags.length > 0`.
- Includes its own inline `+ tag…` input that adds an *unknown* tag to the
  filter (so the user can pre-filter for tags that don't yet exist on any
  block — useful when planning to tag in bulk).

DOM:

```html
<div class="tag-filter-bar" role="region" aria-label="Filter blocks by tag">
  <span class="tag-filter-bar-label">FILTER</span>
  <span class="tag-filter-bar-arrow" aria-hidden="true">▸</span>
  <div class="tag-filter-bar-chips">
    <button class="tag-chip" data-active="true">golden</button>
    <button class="tag-chip" data-active="false">site-atl</button>
    <input class="tag-chip-input" placeholder="+tag…" />
  </div>
  <button class="tag-filter-bar-clear" hidden>Clear</button>
</div>
```

CSS hooks:

```css
.tag-filter-bar {
  position: sticky;
  top: 8px;
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(26, 29, 35, 0.78);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid #262a33;
  border-radius: 6px;
  z-index: 5;
}
.tag-filter-bar-label {
  font: 500 10px/1 'SF Mono', 'Menlo', monospace;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #5ccfe6;
}
.tag-filter-bar-arrow { color: #5a5d62; font-size: 11px; }
.tag-filter-bar-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.tag-filter-bar-clear {
  background: none;
  border: none;
  color: #8a8d94;
  font: 500 11px/1 'SF Mono', 'Menlo', monospace;
  cursor: pointer;
  padding: 2px 6px;
}
.tag-filter-bar-clear:hover { color: #e07b7b; }
```

## 4. Updated `BlockHeader`

`BlockHeader` already renders a single row. The strip slots in **as a second
row beneath `.command-text`**, between `.command-text` and `.metadata`. To
avoid pushing `.metadata` (duration / exit-code / timestamp) out of alignment,
we restructure to a two-column flex:

```
.block-header
├── .block-header-row1   (collapse-btn + command-text + metadata + bookmark + actions)
└── .block-header-row2   (TagChipStrip — only rendered if tags.length || hovered/focused)
```

CSS additions in `BlockHeader.css`:

```css
.block-header {
  flex-direction: column;
  align-items: stretch;
}
.block-header-row1 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.block-header-row2 {
  padding-left: 24px;     /* aligns under .command-text past collapse-btn */
}
```

(The existing single-flex behaviour was inadequate for two rows; this is the
minimum churn.)

## 5. Interaction & accessibility notes

| Interaction                              | Behaviour                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Click chip body                          | Toggles tag in `filterTags`                                                                                     |
| Hover chip → click `×`                   | Removes tag from this block via `removeTag`                                                                     |
| Click `+` on a block                     | Replaces `+` with input; `Enter` adds, `Esc`/blur cancels                                                       |
| Click chip in `TagFilterBar`             | Toggles tag in `filterTags` (same store action)                                                                 |
| Drag pinned block                        | Reorders via `setPinPosition` for all affected blocks; drop-target gets dashed cyan outline                     |
| Click pinned block header                | `scrollIntoView({ behavior: 'smooth', block: 'center' })` on the underlying block in the list                   |
| Keyboard: Tab through chips              | Standard focus order; `:focus-visible` shows 2px cyan outline                                                   |
| Keyboard: ⌘K B / P / T (Phase 2 Task 5)  | Collapse / pin / open tag input on focused block                                                                |
| Empty pinned set                         | `PinnedRow` returns `null` — no chrome                                                                          |
| Empty filter result                      | Block list shows muted helper text: "No blocks match your filter — clear filter to see all 12 blocks"           |
| Reduced motion (`prefers-reduced-motion`) | All transitions collapse to 0ms; `backdrop-filter` retained (it's static)                                       |

## 6. Tailwind usage

The project uses hand-written CSS, not Tailwind. We extend the same
convention: each new component ships its own `.css` sibling file that mirrors
the variables already declared in `src/App.css` (`#0f1114`, `#1a1d23`,
`#262a33`, `#3a3a3a`, `#e6e1cf`, `#5ccfe6`, `#ffd700`, `#e07b7b`).
No new global tokens are introduced.

## 7. What's intentionally out of scope here

- **Share popover** — handled in Phase 3 (Task 3.3) with its own design pass.
- **Tag-color customization** — the cyan/gold/red triad is enough for
  Phase 2; per-tag color theming can come with Phase 4 polish.
- **Cross-tab tag filter** — `filterTags` stays per-store-global as the
  current `blocksStore` shape implies; a per-tab filter is a Plan 02+
  concern.

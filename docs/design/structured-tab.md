# Structured Tab — UI Design Spec

The `CommandBlock` component gains a three-way tab strip when the block's
command is a `show ` command. Tabs: **Raw | Structured | Diff**.

## Layout (ASCII wireframe)

```
┌────────────────────────────────────────────────────────────────────┐
│ ▶  show ip interface brief                          ✓ 3.2s         │  (block header — existing)
├────────────────────────────────────────────────────────────────────┤
│ [ Raw ]  [ Structured* ]  [ Diff ]                                 │  (BlockTabStrip — new)
├────────────────────────────────────────────────────────────────────┤
│  Export CSV   Export JSON   Copy MD   Pin Snapshot                 │  (toolbar)
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ interface ↕ │ ip-address ↕   │ status ↕   │ protocol ↕      │  │  (column headers, sortable)
│  │ [filter]    │ [filter]       │ [filter]   │ [filter]        │  │  (per-column filter row)
│  ├─────────────┼────────────────┼────────────┼─────────────────┤  │
│  │ Gi1         │ 10.0.0.1       │ up         │ up              │  │
│  │ Gi2         │ unassigned     │ admin down │ down            │  │
│  │ Gi3         │ 192.168.1.1    │ up         │ up              │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

## Empty / loading states

- **No parser available:** centered text "No structured parser available
  for this command on the current vendor/platform." Subtext: "Auto-parse
  ran but `parse.request` did not return a template." Includes a small
  "Switch to Raw" button.
- **Loading:** subtle skeleton row (3 placeholder rows, animated bg).
- **Pipe-filter active:** dismissible chip "Filter: `nexthop=10.0.0.1`
  (from pipe)" pinned above the toolbar.

## Visual conventions

- Reuse `.block-output` background `#1e1e1e` and color palette.
- Tab strip: 32px tall, `#252525` bg, `#3a3a3a` 1px bottom border;
  active tab uses `#1e1e1e` bg + 2px accent underline (`#5c8eda`).
- Toolbar: 28px tall, transparent bg, buttons are `#2a2a2a` rounded 4px.
- Table rows: 26–30px tall, font 12.5px, mono `'SF Mono', 'Menlo'`.
- Header row: `#2a2a2a` bg, semi-bold; sort arrows fade in on hover.
- Filter inputs: 22px tall, `#1e1e1e` bg, 1px `#3a3a3a` border, 11px font.

## Interaction

- Click column header → sort asc → desc → none.
- Type in filter input → string-contains (case-insensitive) filter for
  that column. For numeric-looking values, exact match if input is a
  bare number.
- JSONPath bar appears above the table only when input data is a
  nested dict (Genie). Validates on blur; invalid expressions show a
  red 1px outline + 12px error text below.
- Toolbar buttons fire CSV / JSON download (Phase 5), markdown
  clipboard copy, and snapshot pin dialog (Phase 3).

## Accessibility

- Tab strip: `role="tablist"`, individual tabs `role="tab"` + `aria-selected`.
- Sort arrows include `aria-sort` on the `<th>`.
- Filter inputs have `aria-label="Filter <column>"`.

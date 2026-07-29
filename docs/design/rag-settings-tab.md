# Settings → RAG Tab — Design Spec

**Plan 12 / Task 3.1.** Pre-implementation design checkpoint for the Settings → RAG tab. This document is read by the Phase 3.3 implementer; do NOT generate React in this file.

---

## 1. Aesthetic direction

**Name:** *Cataloged knowledge — operator notebook.*

The CCIE Terminal already commits to a Warp-inspired dark surface with warm parchment text (`#e6e1cf`) and amber/teal accents. RAG is the engineer's *private library* — vendor PDFs, internal runbooks, scraped HTML — feeding the assistant. The tab should feel like flipping through a librarian's index card drawer, not a generic file uploader.

**Tone:** restrained, archival, dense-on-purpose. We treat documents as catalog entries, not "files." Tag chips are small, monospaced, treated like Dewey-decimal call numbers. Progress is communicated as a stepwise line (`extract → chunk → embed → persist`), not a percent bar that tries to hide the pipeline. The empty state explains *why* this exists in 2 sentences — no marketing copy, no emoji, no illustrations.

**Differentiator:** the "kind icon" for each doc is the file extension stamped into a 28×20 monospace tile (e.g., `[ PDF ]`, `[ MD ]`) in amber on charcoal — like a rubber-stamp on a card-catalog entry. This single visual anchor makes the row legible at a glance and reads as *engineer*, not *consumer app*.

**Typography:**
- All-CSS, no new font deps. Headings use the existing UI font stack (`-apple-system, system-ui, sans-serif` per `src/App.css:3`). Tag chips, kind tiles, byte counts, and chunk counts use the existing terminal monospace stack (the project ships its own xterm font fallback chain — reuse `font-family: ui-monospace, "SF Mono", "Menlo", monospace;`).
- Tag chips: `11px / 600 weight / letter-spacing 0.02em / uppercase off` (taxonomy strings already encode their own structure).
- Doc title: `14px / 500 weight`. Truncate with single-line ellipsis at the available width.
- Timestamps: `12px / regular / muted (#8a8d94)`. Always relative ("3 min ago", "2 days ago", "May 17"); on hover, native title tooltip shows ISO-8601.

**Color tokens (reuse existing palette from `src/App.css`):**
| Token        | Hex        | Use                                     |
|--------------|------------|------------------------------------------|
| `--rag-bg`   | `#0f1114`  | tab content panel background             |
| `--rag-surface` | `#161a20` | doc rows, drop zone idle                |
| `--rag-surface-elevated` | `#1a1d23` | drop zone hover, modal panel    |
| `--rag-border` | `#262a33` | row dividers, drop zone border          |
| `--rag-fg`   | `#e6e1cf`  | primary copy                             |
| `--rag-fg-muted` | `#8a8d94` | timestamps, helper text               |
| `--rag-accent-amber` | `#d4a857` | kind tile, drop-zone active state |
| `--rag-accent-green` | `#79c879` | success states (done, persisted) |
| `--rag-accent-teal`  | `#5ccfe6` | links, secondary buttons (already in repo) |
| `--rag-danger`       | `#e87878` | error states, delete hover            |

These do not need to be added as CSS variables — `RagSettingsTab.css` can use the literal hex values directly to match the rest of the codebase, which has not committed to variables yet.

---

## 2. Information architecture

The tab has exactly **three vertically stacked regions** inside `.settings-content`:

1. **Header strip** (one line): title `RAG Library`, subtitle `Vendor docs the AI can cite`. Right-aligned: button `[ + Add document ]` (opens native file picker as a fallback to drag-drop).
2. **Drop zone**: full-width, 96px tall when idle; expands to 128px while a file is dragged over the window. Always visible — even when docs exist — so adding more is one motion.
3. **Document list**: scrollable; each row 56px tall; group separator (subtle `1px` rule) between documents uploaded on different days, with a sticky muted day-label ("Today", "Yesterday", "May 17").

There is **no separate "uploading" panel**. Files in flight render as ghost rows at the top of the list with a progress sub-row.

---

## 3. ASCII wireframes

### State A — Empty (zero docs)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ RAG Library                                                                    │
│ Vendor docs the AI can cite                              [ + Add document ]    │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│   ╭──────────────────────────────────────────────────────────────────────╮   │
│   │                                                                      │   │
│   │              Drop PDFs, HTML, MD, or TXT here                        │   │
│   │              ─────────────────────────────────                       │   │
│   │              The AI cites these on every chat turn                   │   │
│   │                                                                      │   │
│   ╰──────────────────────────────────────────────────────────────────────╯   │
│                                                                                │
│   No documents yet.                                                            │
│                                                                                │
│   When you upload vendor docs (Cisco IOS-XE references, Meraki API notes,      │
│   internal runbooks…), the assistant retrieves the most relevant chunks at     │
│   chat time and cites them inline. Tag each doc by platform — chats only       │
│   see docs tagged for the active session's vendor (plus `generic`).            │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

Empty-state copy is the only "marketing" prose in the tab; it appears nowhere else.

### State B — Drag-over (file is being dragged from Finder, not yet dropped)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ RAG Library                                                                    │
│ Vendor docs the AI can cite                              [ + Add document ]    │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│   ╔══════════════════════════════════════════════════════════════════════╗   │
│   ║                                                                      ║   │
│   ║              ↓  Release to upload 3 files                            ║   │
│   ║              ────────────────────────────                            ║   │
│   ║              PDF · HTML · MD · TXT                                   ║   │
│   ║                                                                      ║   │
│   ╚══════════════════════════════════════════════════════════════════════╝   │
│                                                                                │
│   [ existing doc rows continue below, dimmed to 60% opacity ]                  │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

Border swaps to a 2px amber stop, color `#d4a857`. Subtle inner glow `box-shadow: inset 0 0 0 1px rgba(212,168,87,0.25)`. Existing list dims to indicate the new file will be appended.

### State C — Tag picker modal (after drop / file-pick)

A drop or file-picker opens an inline modal centered over the Settings window (reuse `.settings-overlay` + a smaller `.settings-window` like `Settings.tsx:837`):

```
                  ┌────────────────────────────────────────────────────────┐
                  │ Add 3 documents                                  [×]   │
                  ├────────────────────────────────────────────────────────┤
                  │                                                        │
                  │  ┌──────────────────────────────────────────────────┐  │
                  │  │ [ PDF ]  ios-xe-17-cmd-ref.pdf            12.4 MB│  │
                  │  │   Title  ┃ IOS XE 17 Command Reference         ┃ │  │
                  │  └──────────────────────────────────────────────────┘  │
                  │  ┌──────────────────────────────────────────────────┐  │
                  │  │ [ MD ]   meraki-api.md                     45 KB │  │
                  │  │   Title  ┃ Meraki Dashboard API notes         ┃ │  │
                  │  └──────────────────────────────────────────────────┘  │
                  │  ┌──────────────────────────────────────────────────┐  │
                  │  │ [HTML]   nx-os-9000-cli.html                2 MB │  │
                  │  │   Title  ┃ NX-OS 9000 CLI guide                ┃ │  │
                  │  └──────────────────────────────────────────────────┘  │
                  │                                                        │
                  │  Tag the batch (applies to all 3, choose 1+):          │
                  │                                                        │
                  │  ⊘ cisco-iosxe-switch    ◉ cisco-iosxe-router         │
                  │  ⊘ cisco-nxos            ⊘ cisco-meraki               │
                  │  ⊘ juniper-junos         ⊘ arista-eos                 │
                  │  ◉ generic                                             │
                  │                                                        │
                  │  ⓘ One tag minimum. Chats see docs tagged for the     │
                  │    session's vendor + any tagged `generic`.            │
                  │                                                        │
                  │                       [ Cancel ]   [ Upload 3 docs ▸ ] │
                  └────────────────────────────────────────────────────────┘
```

- Selected tag chips: `border: 1px solid #d4a857; background: rgba(212,168,87,0.12); color: #d4a857;`
- Unselected: `border: 1px solid #262a33; background: transparent; color: #8a8d94;`
- Tag glyph: `◉` (selected) / `⊘` (unselected) — single-cell unicode keeps it monospace-aligned.
- Submit button is **disabled** until ≥1 tag is selected; help line appears in `--rag-danger` color if the user clicks the disabled button (no toast, just inline).
- For multi-file batches the tags apply to **all** files. Per-file tagging lives in the row's "Edit tags" affordance once uploaded (post-Phase-3 enhancement; out of scope here — but the design supports it without re-layout).

### State D — Populated list with one row mid-upload and one error

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ RAG Library                                                                    │
│ Vendor docs the AI can cite                              [ + Add document ]    │
├────────────────────────────────────────────────────────────────────────────────┤
│   ╭──────────────────────────────────────────────────────────────────────╮   │
│   │              Drop PDFs, HTML, MD, or TXT here                        │   │
│   ╰──────────────────────────────────────────────────────────────────────╯   │
│                                                                                │
│   Today                                                                        │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │ [ PDF ] IOS XE 17 Command Reference            12.4 MB · 1,847 chunks│   │
│   │         cisco-iosxe-router  generic                3 min ago    [ × ]│   │
│   ├──────────────────────────────────────────────────────────────────────┤   │
│   │ [ MD ]  Meraki Dashboard API notes              45 KB · 32 chunks   │   │
│   │         cisco-meraki                                7 min ago   [ × ]│   │
│   ├──────────────────────────────────────────────────────────────────────┤   │
│   │ [HTML]  NX-OS 9000 CLI guide                                        │   │
│   │   ▷ embedding   ●━━━━━━━━━━━●━━━━━━━━━━━○━━━━━━━━━━━○                │   │
│   │     extract        chunk         embed         persist               │   │
│   │                                            384/1,200 chunks · 32%    │   │
│   ├──────────────────────────────────────────────────────────────────────┤   │
│   │ [ PDF ] juniper-junos-25-cli.pdf                                    │   │
│   │   ⚠ extract failed: encrypted PDF, no text layer       [Retry] [×] │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│   May 17                                                                       │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │ [ TXT ] BGP runbook 2026                       18 KB · 14 chunks    │   │
│   │         cisco-iosxe-router  juniper-junos          2 days ago  [ × ]│   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

Row anatomy:
- **Kind tile** (left): 32×22 monospace label `[ PDF ]` | `[ MD ]` | `[HTML]` | `[ TXT ]`. 1px border in `--rag-border`, text in `--rag-accent-amber`. Constant-width so titles align across rows.
- **Title** (top-right of tile): doc title, `14px/500`, single-line ellipsis.
- **Meta strip** (under title): tag chips (small, see modal styling but slightly smaller font 10px), then `· bytes · chunks` in muted.
- **Timestamp** + **delete X**: right-edge.
- Mid-upload row collapses tags + meta into a sub-row showing the 4-step pipeline glyph: filled `●` for completed step, current step glows amber with a slow pulse, remaining steps are hollow `○`.
- Error row replaces sub-row with a single `⚠ <message>` line in `--rag-danger`, plus inline `[Retry]` and `[×]` (dismiss) buttons.

---

## 4. className suggestions and CSS file structure

Create `src/components/RagSettingsTab.css` (the project does not use Tailwind; co-locate plain CSS next to the component, like `EditorSettings.css`). Reuse parent classes from `src/App.css` where possible:

| Element                          | className(s)                                        | Borrowed from         |
|----------------------------------|-----------------------------------------------------|-----------------------|
| Tab content root                 | `rag-tab` (new)                                     | sibling of `tab-panel`|
| Header strip                     | `tab-header`                                        | `App.css:1388`        |
| Subtitle                         | `rag-subtitle` (new, `12px` muted)                  | —                     |
| Add-doc button                   | `btn-primary` if it exists, else `rag-add-btn`      | check `src/App.css`   |
| Drop zone                        | `rag-dropzone`, modifier `rag-dropzone--active`     | new                   |
| Drop zone copy                   | `rag-dropzone-copy`                                 | new                   |
| Day group                        | `rag-day-group`                                     | new                   |
| Day label (sticky)               | `rag-day-label`                                     | new                   |
| Doc list                         | `rag-doc-list`                                      | new                   |
| Doc row                          | `rag-doc-row`, modifiers `--uploading`, `--error`   | new                   |
| Kind tile                        | `rag-kind`, modifier `rag-kind--pdf`/`--md`/etc.    | new                   |
| Tag chip                         | `rag-tag`, modifier `rag-tag--selected`             | new (also used in modal) |
| Pipeline glyph                   | `rag-pipeline`, step `rag-pipeline-step`, modifiers `--done`, `--active`, `--pending` | new |
| Inline error sub-row             | `rag-row-error`                                     | new                   |
| Retry / delete buttons (row)     | `rag-row-action`                                    | new                   |
| Modal overlay                    | `settings-overlay`                                  | reused from `App.css:1290+` |
| Modal window                     | `settings-window` + extra `rag-modal`               | reused                |
| Modal file row                   | `rag-modal-file`                                    | new                   |
| Modal title input                | `rag-title-input`                                   | new                   |
| Submit / cancel                  | reuse existing `.btn` patterns from Settings.tsx    | inspect Settings.tsx for the standard Cancel/OK pair |

Component file split (matches the plan's `Files:` block in Task 3.3):
- `src/components/RagSettingsTab.tsx` — tab root, drop handler, modal orchestration.
- `src/components/RagDocRow.tsx` — single row (idle / uploading / error variants).
- `src/components/RagSettingsTab.css` — all styles above.
- `src/components/RagUploadModal.tsx` — *suggested* extra file for the multi-file tag modal. Keeps `RagSettingsTab.tsx` under ~300 LOC; revisit if implementer prefers inlining.

---

## 5. Micro-interactions (UX notes)

These are non-negotiable for the post-implementation review checkpoint (Task 3.4):

1. **Drop zone is the focus target.** When the tab mounts, `tabIndex={0}` on the drop zone receives focus so keyboard users can press Space/Enter to invoke the file picker without reaching for the mouse. Ring style: `outline: 2px solid #d4a857; outline-offset: 2px;` — never use the browser default.

2. **Esc cancels the upload modal**; Enter submits *only* when ≥1 tag is selected and at least one title has non-empty text. A focus-trap is mandatory — Tab cycles between the file rows, the tag grid, and the two action buttons; Shift-Tab cycles backward; Tab does not escape the modal.

3. **Tag chips are toggleable buttons, not checkboxes.** Each chip has `role="button"` `aria-pressed={selected}`. Spacebar toggles. Arrow-key navigation moves focus across the 7-chip grid (`role="group"` parent, `aria-label="Document tags"`). Visible focus ring identical to the drop zone's amber outline.

4. **Aria-live region for upload progress.** A single `<div role="status" aria-live="polite" className="sr-only">` reflects the active step transitions: `"Embedding NX-OS 9000 CLI guide, 384 of 1,200 chunks"`. Update at the *step transition* (extract→chunk→embed→persist), NOT every progress tick — chunk-level updates would overwhelm a screen reader. Final transition announces `"Done. NX-OS 9000 CLI guide indexed, 1,200 chunks."`.

5. **Delete is a two-step.** First click swaps the `[×]` for an inline `[Confirm delete]` button in `--rag-danger`, with a 4-second auto-revert. Second click within that window invokes `rag_delete_document` and removes the row optimistically. No native `window.confirm` — feels off-brand for a Tauri app. Esc within the 4s window cancels.

6. **Pipeline pulse is purely CSS.** The active step's filled `●` uses `animation: rag-pulse 1.4s ease-in-out infinite alternate;` — opacity 0.4 → 1.0. No JS timers. Honor `@media (prefers-reduced-motion: reduce)` and replace the pulse with a static 0.85-opacity dot.

7. **Optimistic delete + reconcile.** Removing a row optimistically should reconcile with the next `rag_list_documents` poll; if the backend says it's still there (e.g., delete RPC failed silently), the row reappears with a tiny `⟲` glyph and a hovercard `Failed to delete — click to retry`. Don't surface a toast.

8. **Per-day grouping is explicit, not derived from a formatter that gets lost in long lists.** "Today" / "Yesterday" / `MMM D` matches the rest of the project's `formatTimeAgo` outputs (see `src/lib/formatTimeAgo.ts`). Reuse that lib — do not roll a new one.

9. **Drag-over shows the file count from `dragEvent.dataTransfer.items`.** ("Release to upload 3 files"). When unknown (Safari, sometimes), fall back to "Release to upload". Reject the drop early (without opening the modal) if any file's extension is not in `{pdf, html, htm, md, markdown, txt}` — show an inline `--rag-danger` toast under the drop zone for 4 seconds.

10. **Empty-state copy is one block.** Do not split the explanation across two paragraphs or add a "Learn more" link. Engineers don't click it; they want one paragraph that justifies the tab's existence.

---

## 6. Out of scope for Phase 3

These are intentionally not designed here so the implementer doesn't accidentally build them:

- Per-document re-tagging (Phase 5+ if requested).
- Bulk-delete / bulk-retag UI.
- Sort and filter controls. The day-grouping with reverse-chronological order is the only ordering.
- Search inside docs. RAG retrieval handles this from AgentPanel — Settings is upload-only.
- "Re-embed" button on a doc (would matter only if the embedder model changes; tabled).
- Seed-pack download button — this lives at the *bottom* of the doc list once Phase 6 lands; the design will be revisited then.

---

## 7. Acceptance criteria (review checklist for Task 3.4)

After Phase 3.3 implementation, screenshot four states (empty / drag-over / mid-upload / populated-with-error) and verify:

- [ ] Drop zone visible in all four states (it is the entry point).
- [ ] Day-grouping labels appear when docs span multiple days; absent when only one day.
- [ ] Kind tile is exactly the same width across PDF / MD / HTML / TXT.
- [ ] Tag chips in modal and rows use the **same** taxonomy strings — no truncation, no hyphen-to-space transformation.
- [ ] Submit-disabled state is visually distinct from enabled (50% opacity, `cursor: not-allowed`).
- [ ] Pipeline pulse honors `prefers-reduced-motion`.
- [ ] Delete double-confirm works without `window.confirm`.
- [ ] Esc closes the upload modal; focus returns to the drop zone.
- [ ] Aria-live announces step transitions (verify with VoiceOver).
- [ ] Visual focus ring on every interactive element — drop zone, tag chip, file picker button, retry button, delete button.
- [ ] No emoji anywhere in the tab.
- [ ] No purple gradient anywhere — palette stays in the warm-charcoal/amber/teal/green family established by `src/App.css`.

---

## 8. Post-implementation review (Plan 12 Phase 3 / Task 3.4)

Date: 2026-05-19. Implementer: Phase 3 subagent.

### 8.1 What was verified by tests

The following acceptance-checklist items are mechanically verified by
the Vitest suite (`src/components/RagSettingsTab.test.tsx`,
`src/lib/rag.test.ts`):

- Empty state renders the design-spec copy when `documents.length === 0`
  (covered by `renders the empty state when no docs are loaded`).
- Each `DocRow` renders the configured tag chips
  (`renders one row per document with the right tag chips`).
- Two-step delete swaps the `[×]` for an inline `[Confirm delete]`
  button and only invokes `rag_delete_document` after the second
  click (`two-step delete: first click arms…`).
- Modal submit is **disabled** when no tag is selected; clicking the
  disabled button does not call `rag_upload`
  (`submitting the modal with NO tags surfaces an inline error…`).
- Submit dispatches `rag_upload` with the selected tag set and the
  derived kind (`submitting the modal with at least one tag dispatches
  ragUpload`).

The Rust side (`src-tauri/tests/rag_upload_test.rs`) covers happy-path
persistence, three reject paths (empty tags / unknown tag / unsupported
kind), and post-persist `list_documents` reconciliation.

### 8.2 Visual review — pending controller

`bun run tauri dev` was **not** launched from this subagent — the
session is headless and Tauri dev requires a windowed process. The
following items from §7 still need a visual pass against a live build
before Phase 3 can be considered visually accepted:

- [ ] Drop zone visible in all four states — empty / drag-over /
      mid-upload / populated-with-error.
- [ ] Day-grouping labels appear when docs span multiple days.
- [ ] Kind tile is exactly the same width across PDF / MD / HTML / TXT.
- [ ] Tag chips in the modal and in row meta use the same taxonomy
      strings (no truncation, no hyphen-to-space transformation).
- [ ] Submit-disabled state at 50% opacity + `cursor: not-allowed`.
- [ ] Pipeline pulse honors `prefers-reduced-motion`. (CSS rule
      present at `src/components/RagSettingsTab.css`; verify in Reduce
      Motion mode.)
- [ ] Aria-live announces step transitions (verify with VoiceOver).
- [ ] Visible focus ring on every interactive element.

### 8.3 Known deviations from spec

- ~~The modal does **not** yet implement a true focus-trap.~~
  **Resolved (post-Phase 3 review):** the modal now installs an
  inline focus trap (no new dependency) on mount — initial focus
  lands on the first tag chip, Tab/Shift+Tab wrap at the
  first/last focusable boundaries, and the previously-focused
  element is restored on unmount. See `RagUploadModal.tsx` and the
  Vitest case in `RagSettingsTab.test.tsx`.
- The drop-zone "release to upload N files" count uses
  `dataTransfer.items.length`. When the browser hides item metadata
  (Safari edge case) we fall back to displaying `Release to upload
  files` — verified to render in the current implementation.
- Per-day grouping uses `formatTimeAgo` boundaries reused from
  `src/lib/formatTimeAgo.ts`; the design called for `MMM D` for older
  dates which is implemented via `Date.toLocaleDateString()`.

When Tauri dev becomes available, capture screenshots of the four
states and replace this subsection with the actual design-review
findings.

---

## 10. Phase 6 addendum — "Download starter pack" button

**Plan 12 / Task 6.2.** A new optional helper sits at the **bottom** of
the tab, below the document list and above the modal layer.

### 10.1 Placement

```
┌─ Header ───────────────────────────────────────────┐
│ RAG Library                       [+ Add document] │
├─ Drop zone ────────────────────────────────────────┤
│              Drop PDFs/HTML/MD/TXT here            │
├─ Document list (groups by day) ────────────────────┤
│   ...rows...                                       │
├─ ── thin divider ─────────────────────────────────-┤
│   [ Download starter pack ]                        │
│   Download a small public starter pack to          │
│   ~/.ccie-terminal/rag-seed/. Idempotent.          │
└────────────────────────────────────────────────────┘
```

The button is **always rendered** — even when the doc list is empty
and even when it's full. Reasoning: a user might want to add the
starter pack later, after they've already populated their library
manually.

### 10.2 Visual style

- Class `.rag-btn--secondary`. **Teal accent** (`#5ccfe6`), 12px font,
  `4px 10px` padding. Distinct from the primary `+ Add document`
  button (amber, larger) — communicates "this is optional, not the
  default action."
- The drop zone above remains the **primary** call-to-action. The
  starter-pack button never tries to compete with it.
- During execution the button is `disabled` with `aria-busy="true"`,
  shows label `Downloading… i/N` (script phase) then `Uploading… i/N`
  (post-script ingestion phase).
- On error: label flips to `Retry starter pack`, an inline red error
  string appears below the help text.

### 10.3 Why this placement and not in the drop zone

The drop zone is reserved for **user-initiated**, **arbitrary** file
uploads — the pattern matches Warp's "drop a file to attach" affordance.
Embedding a "magic download" button inside it would conflate two very
different mental models:

- Drop zone → "I have a file; take it."
- Seed button → "I don't have a file; you fetch one for me."

Keeping them visually and structurally separate reinforces that the
seed pack is a **convenience helper**, not a core feature. The thin
divider above the seed row makes the boundary explicit.

### 10.4 A11y

- Button has a stable `data-testid="rag-seed-button"` for E2E.
- Inline error has `role="alert"` so screen readers announce it
  immediately.
- During the busy phases the button keeps focus (no programmatic blur)
  so a keyboard-only user knows where they are after the run.

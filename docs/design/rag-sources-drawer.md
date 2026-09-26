# AgentPanel — Sources Badge + Drawer Design Spec

**Plan 12 / Task 5.1.** Pre-implementation design checkpoint for the in-chat citations UI. Read by the Phase 5.4 implementer; do NOT generate React in this file.

---

## 1. Aesthetic direction

**Name:** *Margin notes — citation slips taped to the page.*

The CCIE Terminal already commits to a warm-charcoal terminal palette with parchment text (`#e6e1cf`) and amber/teal accents. Plan 11 (Captures) and Plan 12.3 (RAG library) treat docs as catalog entries. The Sources surface continues that vocabulary: each retrieved chunk is a *citation slip* — a small typed card the assistant pinned to its answer.

Critical principle: **sources are evidence, not decoration.** No glossy chrome, no glow effects, no generic "card with shadow" UI. The badge must be inert until the user is ready; the drawer must surface the cited *text* before any meta. Distance is a number engineers care about — exposed, not hidden.

**Tone:** archival, terse, mechanical. Same monospace font stack as the RAG library. Tag chips use the same `◉` / `⊘` glyphs. The badge looks like a pinned tag, not a CTA.

**Differentiator:** the drawer renders chunk text in `pre`-formatted monospace with a subtle 1-px left rule in `--rag-accent-amber`, the same way Cisco command output gets quoted in the rest of the terminal. This makes a citation visually feel like *the cited text itself*, not a UI wrapper.

**Constraints:**
- No new dependencies (Motion, framer-motion, etc.). All animation = CSS transitions.
- Drawer width 360px, slides in from the right edge of the AgentPanel — NOT a window-level modal. AgentPanel is already a right-anchored slide-out; the drawer is layered *inside* it (or one element to the right) so the chat thread stays visible behind/under it as a faded reading surface.
- Must respect `prefers-reduced-motion`.
- Esc closes; click on the chat thread closes; focus restores to the originating badge.

---

## 2. Color tokens (reuse established palette)

| Use | Hex | Notes |
|-----|------|-------|
| Drawer surface | `#0f1114` | matches `agent-panel` |
| Surface elevated (chunk card) | `#161a20` | row body |
| Border / divider | `#262a33` | inter-chunk rules |
| Primary fg | `#e6e1cf` | doc title, chunk text |
| Muted fg | `#8a8d94` | chunk index, similarity, timestamp |
| Amber accent | `#d4a857` | left-rule on chunk text, badge ring on hover |
| Teal accent | `#5ccfe6` | secondary action (Copy) — already in repo |
| Danger | `#e87878` | reserved (defensive empty-state ribbon) |

These mirror the RAG-settings tab tokens; do not introduce new variables. Use hex literals in `AgentSourcesDrawer.css`.

**Typography:**
- Doc title: `13px / 600 / system stack`. Single-line ellipsis.
- Tag chips: `10px / 600 / monospace / letter-spacing 0.02em`. Reuse `rag-tag` styling from `RagSettingsTab.css`.
- Chunk index + similarity meta: `11px / 500 / monospace / muted`.
- Chunk text body: `12px / 400 / monospace / line-height 1.55`. White-space: `pre-wrap`. Wrap at panel width.

---

## 3. Information architecture

The badge is **per-assistant-message**. The drawer is a **single instance** at the AgentPanel level whose content is bound to whatever badge was last opened (no two drawers stacked).

Lifecycle:
1. Sidecar emits `{ type: "sources", chunks: [...] }` BEFORE the first `token`.
2. Frontend stashes `sources` on the assistant Message that is *about to be appended* to the bucket. (Phase 5.3 wiring detail; design assumes the field is present on the Message by the time rendering happens.)
3. The badge renders inline under the assistant bubble's `.agent-message-content`. It says exactly `Sources · 3 docs` (note the `·` separator and singular/plural).
4. Click → drawer slides in from the right edge of the AgentPanel; the chat thread fades to 0.5 opacity behind it but remains scrollable for context.
5. Esc / click-outside → drawer slides out; focus returns to the originating badge.

A turn with `sources.length === 0` shows NO badge. Defensive empty state in the drawer is for "opened by keyboard navigation on a turn that lost its sources" — a rare edge case, but the empty content is not a hard error.

---

## 4. ASCII wireframes

### 4.1 Badge — three states

```
COLLAPSED (default, after sources event arrives)

   ┌── assistant bubble ───────────────────────────────────────────────┐
   │                                                                   │
   │  Here is the BGP summary you asked for. The neighbor is in        │
   │  Established state per the IOS-XE 17 reference.                   │
   │                                                                   │
   │   ┌───────────────────────────┐                                   │
   │   │ ▾ Sources · 3 docs        │   ← inline pill, monospace        │
   │   └───────────────────────────┘                                   │
   │                                                                   │
   └───────────────────────────────────────────────────────────────────┘

HOVER

   │   ┌───────────────────────────┐
   │   │ ▾ Sources · 3 docs        │   ← +1px amber ring, fg lifts to #e6e1cf
   │   └───────────────────────────┘     cursor: pointer, no scale transform
   │     ↑ amber underline anchors hover

DRAWER OPEN (badge stays in place but reads "open")

   │   ┌───────────────────────────┐
   │   │ ▴ Sources · 3 docs   open │   ← caret flips, suffix "open" in muted
   │   └───────────────────────────┘     amber filled-in to indicate active
```

The `▾` / `▴` caret is a single Unicode character — no SVG icon import. The amber ring on hover is `box-shadow: 0 0 0 1px #d4a857`, no transform.

### 4.2 Drawer body

```
            (chat thread fades to 50% opacity, still scrollable)
            ┌─────────────────────────────────────────────────────┐
            │                                                     │ <-- AgentPanel right edge
            │                                                     │
            │   ┌─ Sources ─────────────────────────────  [×] ──┐ │
            │   │                                                │ │
            │   │   3 chunks pinned to this answer               │ │
            │   │   ─────────────────────────────────────        │ │
            │   │                                                │ │
            │   │   ┌──────────────────────────────────────┐    │ │
            │   │   │  IOS XE 17 Command Reference         │    │ │
            │   │   │  ◉cisco-iosxe-router  ◉generic       │    │ │
            │   │   │  Chunk 7 / 1,847   ·   sim 0.86      │    │ │
            │   │   │  ┃ show ip bgp summary               │    │ │
            │   │   │  ┃ Neighbor    AS   PfxRcd  Up/Down  │    │ │
            │   │   │  ┃ 10.0.0.1    65001 12      03:14   │    │ │
            │   │   │  ┃ Established                       │    │ │
            │   │   │                            [ Copy ]  │    │ │
            │   │   └──────────────────────────────────────┘    │ │
            │   │                                                │ │
            │   │   ┌──────────────────────────────────────┐    │ │
            │   │   │  Meraki Dashboard API notes          │    │ │
            │   │   │  ◉cisco-meraki                       │    │ │
            │   │   │  Chunk 2 / 32      ·   sim 0.71      │    │ │
            │   │   │  ┃ POST /networks/{id}/devices...    │    │ │
            │   │   │                            [ Copy ]  │    │ │
            │   │   └──────────────────────────────────────┘    │ │
            │   │                                                │ │
            │   │   ┌──────────────────────────────────────┐    │ │
            │   │   │  BGP runbook 2026                    │    │ │
            │   │   │  ◉cisco-iosxe-router ◉juniper-junos  │    │ │
            │   │   │  Chunk 3 / 14      ·   sim 0.62      │    │ │
            │   │   │  ┃ Reset peer: clear ip bgp <addr>   │    │ │
            │   │   │                            [ Copy ]  │    │ │
            │   │   └──────────────────────────────────────┘    │ │
            │   │                                                │ │
            │   └────────────────────────────────────────────────┘ │
            │                                                     │
            └─────────────────────────────────────────────────────┘
                              ↑ drawer is 360px wide,
                                slides from right edge of AgentPanel
                                w/ transform: translateX(0) <-- (360px))
```

Anatomy of a chunk card:
- `1px` border in `#262a33`.
- Doc title row: 13px primary fg, ellipsis on overflow.
- Tag-chip row: same chip styling as RAG library tags. 4px gap. No truncation; chips wrap to a second line if needed (max 2 lines, then horizontal scroll inside the chip row — never let chips clip the title row beneath).
- Meta row: chunk index + similarity, separated by ` · ` (middle dot with non-breaking spaces). `Chunk N / TOTAL` is exact; sub `0` is shown as `Chunk 0 / N` (do NOT 1-index for users; the catalog uses 0-index everywhere else).
- Chunk text: `pre-wrap`, monospace, with a `2px solid #d4a857` left border 8px from the card's left edge. The text is selectable. Long lines wrap; do NOT add horizontal scroll.
- Copy button: bottom-right of the card. `[ Copy ]` reads as a tiny button — same styling as Settings tab buttons (`.btn` style). On press: button text flashes to `[ Copied ]` in amber for 1.2s, then reverts.

### 4.3 Empty state (defensive)

```
            ┌─ Sources ─────────────────────────────  [×] ──┐
            │                                                │
            │   No sources for this turn.                    │
            │   ─────────────────────────────                │
            │   The assistant answered without retrieving    │
            │   any documents. Check the RAG library to      │
            │   ensure docs are tagged for the active        │
            │   session vendor.                              │
            │                                                │
            └────────────────────────────────────────────────┘
```

This is *not* an error. Tone is informative, with a pointer to the RAG tab.

---

## 5. className suggestions and CSS file structure

Create `src/components/AgentSourcesDrawer.css` (co-located with the new components). Reuse classes from `src/App.css` where possible:

| Element | className(s) | Borrowed from |
|---------|--------------|---------------|
| Badge button | `agent-sources-badge`, modifier `--open` | new |
| Badge label | `agent-sources-badge-label` | new |
| Badge caret | `agent-sources-badge-caret` | new (single character) |
| Drawer overlay (panel-scoped, not window-scoped) | `agent-sources-overlay` | new |
| Drawer panel | `agent-sources-drawer` | new |
| Drawer header | `agent-sources-header` | new |
| Drawer close | `agent-sources-close` | reuse `.close-btn` from `App.css:1318` |
| Drawer body | `agent-sources-body` | new |
| Chunk card | `agent-source-card` | new |
| Chunk title | `agent-source-title` | new |
| Tag chip row | `agent-source-tags` | new |
| Tag chip | `rag-tag rag-tag--selected` | reused from `RagSettingsTab.css` |
| Meta row | `agent-source-meta` | new |
| Chunk text | `agent-source-text` | new |
| Copy button | `agent-source-copy`, modifier `--copied` | new |
| Empty state | `agent-source-empty` | new |
| Reduced-motion guard | inline `@media (prefers-reduced-motion: reduce)` | new |

Component file split (matches the plan's `Files:` block in Task 5.4):
- `src/components/AgentSourcesBadge.tsx` — the inline pill under each assistant bubble.
- `src/components/AgentSourcesDrawer.tsx` — the slide-out drawer (single instance per AgentPanel).
- `src/components/AgentSourcesDrawer.css` — all styles above.
- `src/components/AgentPanel.tsx` — modify to render the badge under each `role === "assistant" && sources?.length` message and own the single drawer instance with `useState<RetrievedChunk[] | null>(null)` for "currently-shown sources".

`AgentSourcesBadge.tsx` should accept:
```ts
{
  count: number;             // sources.length
  isOpen: boolean;           // is THIS message's drawer open?
  onOpen: () => void;
}
```
The parent (AgentPanel) tracks which message ID is currently open in its single drawer state.

`AgentSourcesDrawer.tsx` accepts:
```ts
{
  open: boolean;
  sources: RetrievedChunk[];   // empty array allowed, drawer falls into empty state
  onClose: () => void;
}
```

---

## 6. Micro-interactions (UX notes)

Non-negotiable for the post-impl review checkpoint (Task 5.5):

1. **Badge focus ring matches the RAG tab.** Same `outline: 2px solid #d4a857; outline-offset: 2px;`. Pressing Enter or Space when focused opens the drawer. On open, focus moves into the drawer (first chunk card's Copy button as the natural anchor — see #2 for trap details).

2. **Drawer focus trap.** Mandatory. Same pattern as `RagUploadModal` (the manual `useEffect` + `keydown` Tab/Shift-Tab wrap from Phase 3 fixup `6283df0`). Reuse the helper approach; don't introduce `focus-trap-react`. Initial focus: the close `[×]` button (it's always present, always in DOM order, and gives the user a clear escape route). Tab cycles: `[×]` → first `[Copy]` → second `[Copy]` → … → loops back to `[×]`.

3. **Esc closes; click on chat thread closes.** Esc handler on `keydown` at the drawer root. "Click outside" is implemented by an overlay element that sits *over the chat thread but UNDER the drawer panel* — `agent-sources-overlay` is the click target. Crucially: clicks on the assistant's source chunk text inside the drawer must NOT bubble up and close the drawer (use stopPropagation on the drawer panel's own `onClick`).

4. **Animation.** Drawer slides in via `transform: translateX(0)` from `translateX(360px)`, transition `200ms cubic-bezier(0.2, 0, 0, 1)`. Chat thread fade is a sibling overlay with `opacity 0 → 0.5` and `pointer-events: none`. Honor `prefers-reduced-motion: reduce`: drawer appears instantly (no transform transition), thread fades to opacity 0.5 with `transition: none`.

5. **Aria-live for the source count.** When the `sources` event arrives and the badge appears, announce once via the AgentPanel's existing aria-live region (or add a new `<div role="status" aria-live="polite" className="sr-only">`): `"3 sources cited"` (or `"1 source cited"`). Do NOT announce the chunk titles individually — the drawer surfaces them on demand.

6. **Copy button feedback.** Click `[ Copy ]` → text flashes to `[ Copied ]` in amber `#d4a857` for 1.2s, then reverts. Use `navigator.clipboard.writeText(chunk.text)`. On failure (clipboard unavailable, e.g., insecure context): button text becomes `[ Copy failed ]` in `#e87878` for 1.2s. NO toast — the button itself is the feedback channel.

7. **Similarity, not distance.** The Rust struct exposes `distance: f32` (cosine, 0 = identical, 1 = orthogonal). The user sees `sim N.NN` where `sim = 1.0 - distance`, formatted to 2 decimals. Don't expose raw distance in the UI — it's confusing for engineers used to similarity. If distance comes back negative (vec0 edge case for very-aligned vectors): clamp `sim` to `[0.0, 1.0]` for display only.

8. **Per-chat-message scoping.** Two assistant messages in the same thread can each have a Sources badge. Opening one closes the other (single-drawer-instance rule). The previously-open badge restores its caret and "open" suffix to closed. Track this in AgentPanel state via `openSourcesForMessageId: string | null`.

9. **Sticky drawer header.** Header (`Sources` title + count + `[×]`) is sticky at the top of the drawer body during scroll. Body scrolls within the drawer; the page-level chat thread underneath stays static.

10. **Auto-collapse on new turn.** When the user submits a new message and a new assistant turn starts, any open drawer auto-closes. Reason: a stale citations drawer hovering over an in-progress assistant response is visually noisy and rarely useful.

---

## 7. Out of scope for Phase 5

- Per-chunk thumbs-up / thumbs-down feedback.
- "Open in RAG library" deep-link from a chunk card. (Tabled — Plan 13/14 may add it.)
- Re-running the retrieval with different `k` or tag overrides from the drawer.
- Persisting drawer-open state across app restarts.
- Multi-select / bulk-copy of chunks.
- Diffing chunks against current terminal output. (That belongs in Plan 06's change-verification surface, not here.)

---

## 8. Acceptance criteria (review checklist for Task 5.5)

After Phase 5.4 implementation:

- [ ] Badge appears under assistant messages with `sources.length > 0` ONLY.
- [ ] Badge text is `Sources · N docs` (singular `1 doc` / plural `N docs`).
- [ ] Caret flips `▾` ↔ `▴` based on `isOpen`.
- [ ] Drawer slides in from right edge of AgentPanel, 360px wide, with chat thread fading behind.
- [ ] Drawer focus trap: Tab/Shift-Tab cycles within `[×]` → Copy buttons.
- [ ] Esc closes drawer; focus restores to the originating badge.
- [ ] Click on chat thread (the overlay) closes drawer.
- [ ] Click on drawer body does NOT close (stopPropagation works).
- [ ] Each chunk card shows: doc title (truncated) / tag chips / `Chunk N / TOTAL · sim N.NN` / monospace text with amber left rule / `[ Copy ]` button.
- [ ] Copy button copies the chunk text and flashes `[ Copied ]` for 1.2s in amber.
- [ ] On clipboard failure, button shows `[ Copy failed ]` in danger color for 1.2s.
- [ ] Similarity is `1.0 - distance`, clamped to `[0.0, 1.0]`, formatted with 2 decimals.
- [ ] `prefers-reduced-motion: reduce` disables the slide animation.
- [ ] Aria-live announces `"N sources cited"` once when the badge appears.
- [ ] Opening a different message's badge auto-closes the previously-open drawer.
- [ ] Submitting a new chat message auto-closes any open drawer.
- [ ] Empty-state copy renders when `sources.length === 0` (defensive path).
- [ ] No emoji, no purple gradient, no `framer-motion` import.

---

## 9. Post-implementation review notes (2026-05-19)

Phase 5.4 shipped at commit `6f6f34e`. A full visual review through
`bun run tauri dev` is **deferred** — the agent harness can't run the
Tauri shell headlessly, mirroring the Phase 3.4 caveat in
`docs/design/rag-settings-tab.md`. The acceptance checklist (§8) is
mapped below to its evidence so a controller running the app can
spot-verify each line:

**Test-covered (28 unit tests across `AgentSourcesBadge.test.tsx`,
`AgentSourcesDrawer.test.tsx`, `chatStore.test.ts`):**

- Badge singular `1 doc` vs plural `N docs` — Badge tests #1, #2.
- Caret ▾ ↔ ▴ flip — Badge tests #3, #4.
- aria-pressed truth-mirroring — Badge tests #5, #6.
- Click forwards the button element to the parent — Badge test #7.
- `--open` modifier class — Badge test #8.
- Drawer renders title / tags / chunk text — Drawer test #2.
- Similarity formatting: 2 decimals — Drawer test #3.
- Similarity clamping for negative + >1 distances — Drawer tests
  #4, #5.
- Empty state — Drawer test #6.
- Esc closes — Drawer test #7.
- Overlay click closes — Drawer test #8.
- Drawer panel click does NOT close (stopPropagation) — Drawer test #9.
- Initial focus on close button — Drawer test #10.
- Tab wraps last → first — Drawer test #11.
- Shift+Tab wraps first → last — Drawer test #12.
- Copy success flash `[ Copied ]` + amber + 1.2s revert — Drawer #13.
- Copy failure flash `[ Copy failed ]` + danger — Drawer #14.
- chatStore.attachSourcesToInProgress: attach-or-stash, drain on
  first token, no-clobber idempotence — chatStore tests.

**Needs visual review (controller spot-check):**

- 360px drawer width measured against actual AgentPanel.
- Slide-in animation timing (200ms cubic-bezier(0.2, 0, 0, 1)).
- `prefers-reduced-motion` disables the slide (CSS guard added; visual
  smoke needs a system pref toggle).
- Badge focus ring matches RAG tab (2px solid #d4a857 outline +
  outline-offset 2px) — CSS in place; needs eyeball check.
- Chunk card 1px border, amber 2px left rule on chunk text, ellipsis
  on doc title overflow — CSS in place.
- Aria-live announcement actually fires once per turn for screen
  readers (the `<div role="status" aria-live="polite">` is wired in
  AgentPanel.tsx; AT testing belongs in a future a11y pass).

**Deviations from design spec:**

- `Chunk N / TOTAL` was simplified to `Chunk N` — `RetrievedChunk`
  carries `chunk_idx` but not the document's total chunk count, and
  Phase 5 didn't want to add a join. Post-Phase 5 enhancement: extend
  the retrieve SQL to include `(SELECT COUNT(*) FROM rag_chunks WHERE
  document_id = c.document_id) AS total` so the meta row matches the
  spec literally. Tracked informally; not blocking.
- Vendor/platform plumbing reaches `agentChatStream` via the existing
  `useTabs` store (Tab type already has `vendor` + `platform`
  optional fields, populated by `setTabVendor`). Most terminal tabs
  start with neither set, so RAG won't activate until the user (or a
  future vendor-inference plan) marks the tab. AgentPanel passes
  `undefined` for both in that case and the backend short-circuits.

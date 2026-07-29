# Plan 15 Phase 4 — Frontend design spec

**Date:** 2026-05-20
**Author:** Phase 4 implementer (post-Phase-3 handoff)
**Scope:** AI Troubleshooting Tree UI — TreeCanvas, NarrationPanel, ControlBar,
PlaybookPicker, AwaitingUserModal, ConclusionBanner, page entry, sidebar route.

The plan asked for a full HTML mockup from the `frontend-design` skill. Phase 3
already documented the constraint that the static-bundle preview can't run from
this workspace (no Tauri dev binary), so this spec is a markdown layout brief
that the implementation tracks against. The post-implementation review (Task
4.5) re-checks each surface against this document.

---

## 1. Theme tokens (existing — DO NOT introduce new variables)

| Token                         | Hex          | Use                                       |
| ----------------------------- | ------------ | ----------------------------------------- |
| `--app-bg` (default `#0f1114`) | dark canvas | tab background                            |
| `#0a0c0f`                      | tabbar       | sidebar / strip background                |
| `#1a1d23`                      | inactive tab | card / row backgrounds                    |
| `#262a33`                      | active tab   | borders, dividers, active row             |
| `#e6e1cf`                      | text         | primary foreground                        |
| `#8a8d94`                      | muted text   | metadata, secondary copy                  |
| `rgba(255,255,255,0.06)`       | code chip    | inline-code backgrounds                   |
| `#3aa370` (existing success)   | green        | passed status                             |
| `#d2675a` (existing danger)    | red          | failed status                             |
| `#d4a14a` (existing warning)   | amber        | running pulse                             |
| `#5a8fd6` (existing accent)    | blue         | awaiting_user                             |

Existing tokens are scraped from `BlockHeader.css`, `AgentSourcesDrawer.css`,
and the recordings/topology tabs. We reuse status colors that already appear in
`SeverityChip.css` and `BlockOutput.css` rather than defining new variables.

---

## 2. Layout (top-level)

```
┌──────────────────────────────────────────────────────────────────────┐
│ TabBar (existing) — adds [+ Troubleshoot] button                     │
├──────────────────────────────────────────────────────────────────────┤
│ ControlBar (sticky, 44px)                                            │
│ [▶ Start] [⏸ Pause] [▶ Resume] [⏭ Skip] [⊘ Cancel] [📌 Mark RC]      │
├──────────────────────────────────────────────────────────────────────┤
│ ConclusionBanner (only when run terminal — Completed / Failed)       │
│ Root cause: BGP neighbor administratively shut · Confidence: HIGH    │
│ Suggested fix: router bgp 65000 / no neighbor 10.0.0.5 shutdown      │
│ Evidence: [chunk 1] [chunk 2] [chunk 3]                              │
├────────────────┬─────────────────────────────────┬───────────────────┤
│ PlaybookPicker │ TreeCanvas (@xyflow/react)      │ NarrationPanel    │
│ (260px)        │ (flex 1)                        │ (collapsible 360) │
│                │                                 │                   │
│ • Symptom      │  ┌────┐                         │ ▶ step 0 · check_ │
│   input box    │  │ s1 │                         │   state           │
│                │  └─┬──┘                         │   The session is  │
│ • Vars JSON    │    │                            │   in Idle (Admin) │
│   editor       │  ┌─▼──┐                         │   …               │
│                │  │ s2 │ branch                  │                   │
│ • [Start] btn  │  └┬─┬─┘                         │ ▶ step 1 · …      │
│                │   │ │                           │                   │
│ • Playbook     │ ┌─▼┐ ┌▼──┐                      │ [Citations: 2,5]  │
│   list (ul)    │ │s3│ │s4 │                      │                   │
│   builtin/     │ └──┘ └───┘                      │                   │
│   user split   │                                 │                   │
└────────────────┴─────────────────────────────────┴───────────────────┘
```

When the run is `awaiting_user`, the `AwaitingUserModal` floats centered with
overlay and dims the canvas.

### Sizing

- ControlBar: 44px tall, sticky.
- ConclusionBanner: auto height; appears below ControlBar; collapses cleanly
  when no terminal run.
- PlaybookPicker: 260px wide, scrolls independently.
- NarrationPanel: 360px wide when expanded, 32px collapsed strip with vertical
  "Narration" label (mirrors `AgentSourcesDrawer` pattern).
- TreeCanvas: fills remaining space; uses ReactFlow `fitView` on first render.

---

## 3. StepNode card

```
┌──────────────────────────────────┐  ← 200×72 px, rounded 6px
│ check_state             [running]│  ← step id + status chip
│ ▶ command                        │  ← type icon + label
│ session_state = Idle (Admin)     │  ← 1-line truncated result summary
│                  [↦ Narration]   │  ← jump-to-narration button
└──────────────────────────────────┘
```

### Status chip colors

| Status         | Background            | Foreground | Behaviour          |
| -------------- | --------------------- | ---------- | ------------------ |
| pending        | `#1a1d23`             | `#8a8d94`  | static muted       |
| running        | `rgba(212,161,74,.2)` | `#d4a14a`  | 1.4s pulse anim    |
| passed         | `rgba(58,163,112,.2)` | `#3aa370`  | static             |
| failed         | `rgba(210,103,90,.2)` | `#d2675a`  | static             |
| skipped        | `#1a1d23`             | `#8a8d94`  | static, 50% opacity|
| awaiting_user  | `rgba(90,143,214,.2)` | `#5a8fd6`  | 1.4s pulse anim    |

Type icons (text-glyphs to avoid a new dep — lucide-react isn't in deps):

- command → `▶`
- assertion → `⚖`
- branch → `⤥`
- narration → `✎`
- user_prompt → `?`

---

## 4. NarrationPanel

### Entry layout

```
┌──────────────────────────────────────────┐
│ #2 · check_tcp                           │  ← step idx + step id (header)
│ TCP session to 10.0.0.5 port 179 is in   │  ← markdown rendered
│ TIME_WAIT — restart on the peer side     │
│ may be required.                         │
│ [chunk-id-abc] [chunk-id-xyz]            │  ← citation pills (clickable)
└──────────────────────────────────────────┘
```

- Each entry keyed by `${runId}::${stepId}` (or `step_idx` if present).
- Markdown rendered via existing `react-markdown` config from `AgentPanel`
  (code blocks get a Copy button — but troubleshoot narrations are 1–2
  sentences so code blocks are rare).
- Citation pills: clickable, dispatch a `troubleshoot:citation-clicked`
  CustomEvent for now (Plan 12 RAG modal integration is a follow-up and Phase 4
  doesn't have to wire it end-to-end; we just have to expose the click).
- Auto-scroll to bottom on new entry **unless** the user scrolled up — track
  via a `scrollTopRef` and a 16px threshold.
- Empty state: muted "No narration yet — start a run to see commentary."

### Collapsed state

A 32px right-edge strip with vertical text ("Narration ▶") that expands on
click. Persisted in `localStorage` under
`ccie:troubleshoot.narrationPanelOpen`.

---

## 5. ControlBar

| Button         | Disabled when                                   | Action                       |
| -------------- | ----------------------------------------------- | ---------------------------- |
| ▶ Start        | playbook not selected OR run already active     | `start_run`                  |
| ⏸ Pause        | no active run OR status != `running`            | `pause_run`                  |
| ▶ Resume       | no active run OR status != `paused`             | `resume_run`                 |
| ⏭ Skip         | no active run OR no current step                | TODO — emit event for now    |
| ⊘ Cancel       | no active run OR run terminal                   | `cancel_run` (with confirm)  |
| 📌 Mark RC      | no step selected                                | open prompt → `mark_root_cause` |

Skip is intentionally a frontend-only stub (no backend command exists for
"skip"). The plan permits this — Skip wraps as an operator-driven UI hint that
emits a custom event `troubleshoot:skip_requested` and otherwise does nothing
until Phase 6 or beyond adds backend support.

---

## 6. AwaitingUserModal

Mounted when the active run has a step with `status === "awaiting_user"`.

```
┌──────────────────────────────────────┐
│ Run paused — operator input required │  ← title bar #262a33
├──────────────────────────────────────┤
│ Step: check_tcp                      │
│                                      │
│ The next command is Tier-1 (debug):  │
│   debug ip bgp updates 10.0.0.5      │
│                                      │
│ Approving will execute the command   │
│ on this tab. Cancel pauses the run.  │
├──────────────────────────────────────┤
│              [Cancel] [Confirm ▸]    │
└──────────────────────────────────────┘
```

- ESC = Cancel; Enter = Confirm (matches `RagUploadModal`/vault patterns).
- Confirm calls `answer_prompt(run_id, "approved")` then asks operator to
  `Resume` (the engine deliberately does NOT auto-resume — Phase 2's safety
  invariant).
- Modal must trap focus; mirror the AgentSourcesDrawer trap pattern.

---

## 7. ConclusionBanner

Visible only when the active run's `status` is `completed` or `failed`.

```
┌──────────────────────────────────────────────────────────────────┐
│ ✓ Completed · root cause: BGP neighbor administratively shut     │
│   confidence: HIGH                                               │
│   suggested fix: router bgp 65000 / no neighbor 10.0.0.5 shutdown│
│   evidence: [step #2 · narrate_admin]                            │
│   [Open editor]   [Export run]   [Dismiss]                       │
└──────────────────────────────────────────────────────────────────┘
```

- Banner color: green left-border `#3aa370` for completed, red `#d2675a` for
  failed.
- Confidence chip uses the awaiting-user blue for `low`, amber for `medium`,
  green for `high`.
- "Open editor" navigates to the playbook editor (Phase 6 wires this; Phase 4
  emits `menu:troubleshoot_editor` so the wiring is a no-op stub for now).
- Dismiss collapses the banner without affecting the run state.

---

## 8. PlaybookPicker (left rail)

- Symptom textarea (auto-resize 3–10 lines): drives Phase 5 matching; Phase 4
  ships only as a free-form input passed through to `start_run` for breadcrumb
  purposes.
- Vars JSON: a 6-row monospace textarea pre-filled with `{}`. Validates on
  blur; red border on parse fail.
- Playbook list: groups builtins (top, "BUILTIN" badge) and user playbooks
  (bottom). Click selects (highlight).
- "Start run" button at the bottom; disabled until a playbook is selected and
  vars JSON parses.

---

## 9. Layout algorithm (TreeCanvas)

For v1 we forgo dagre and compute positions directly from the persisted
`steps[]` order. Algorithm:

1. Build `idxByStepId` from the run's persisted steps.
2. Group steps by `parent_idx` (default to `idx - 1` when absent — the engine
   currently doesn't write `parent_idx`).
3. Vertical: `y = idx * 100`. Horizontal: siblings of the same parent spread
   `x = (sibling_position - center) * 220`.
4. If only the playbook is loaded (no run yet), use the static `steps` array
   and lay it out as a vertical chain.

This keeps bundle size flat and matches the existing topology layout strategy
(deterministic, no dagre dep).

---

## 10. Files to create

| File                                                             | Lines (target) |
| ---------------------------------------------------------------- | -------------- |
| `src/features/troubleshoot/api.ts`                               | ~120           |
| `src/features/troubleshoot/store.ts`                             | ~220           |
| `src/features/troubleshoot/api.test.ts`                          | ~180           |
| `src/features/troubleshoot/StepNode.tsx`                         | ~90            |
| `src/features/troubleshoot/StepNode.css`                         | ~80            |
| `src/features/troubleshoot/TreeCanvas.tsx`                       | ~150           |
| `src/features/troubleshoot/TreeCanvas.css`                       | ~30            |
| `src/features/troubleshoot/NarrationPanel.tsx`                   | ~140           |
| `src/features/troubleshoot/NarrationPanel.css`                   | ~80            |
| `src/features/troubleshoot/ControlBar.tsx`                       | ~110           |
| `src/features/troubleshoot/ControlBar.css`                       | ~50            |
| `src/features/troubleshoot/AwaitingUserModal.tsx`                | ~110           |
| `src/features/troubleshoot/AwaitingUserModal.css`                | ~60            |
| `src/features/troubleshoot/ConclusionBanner.tsx`                 | ~90            |
| `src/features/troubleshoot/ConclusionBanner.css`                 | ~50            |
| `src/features/troubleshoot/PlaybookPicker.tsx`                   | ~130           |
| `src/features/troubleshoot/PlaybookPicker.css`                   | ~70            |
| `src/features/troubleshoot/TreeCanvas.test.tsx`                  | ~140           |
| `src/components/troubleshoot/TroubleshootTab.tsx`                | ~150           |
| `src/components/troubleshoot/TroubleshootTab.css`                | ~50            |

Per the plan's constraint ("components under 250 lines each — split sensibly"),
`TroubleshootTab` orchestrates wiring + event subscriptions only.

---

## 11. Event subscription strategy

Following the existing project pattern (no central `tauri-events.ts`), the
`TroubleshootTab` page component owns the four `listen(...)` subscriptions and
forwards them into the store via the four `applyXEvent` actions. Subscriptions
are torn down on unmount. This mirrors `RecordingsTab` / `TopologyTab` (which
keep their listeners local).

---

## 12. Compliance with plan checklist

- [x] Pre-implementation design spec — this document.
- [x] Layout sketch + component breakdown.
- [x] Status colors per design tokens (no new variables).
- [x] StepNode card layout with all required affordances.
- [x] NarrationPanel auto-scroll spec + citation behaviour.
- [x] AwaitingUserModal flow + safety invariant respected.
- [x] ConclusionBanner appears only on terminal status.
- [x] File list under 250-line target each.
- [x] Reuses `@xyflow/react@^12` (already in deps; no `reactflow@11`).

Phase 5 (matcher) is not in scope here — the symptom textarea is a free-form
input until matcher lands.

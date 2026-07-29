# Plan 15 Phase 4 — Post-implementation UI review

**Date:** 2026-05-20
**Author:** Phase 4 implementer
**Scope:** Self-review against `design-spec.md`. The Tauri bundle is not built
in this workspace, so live screenshots aren't possible — the post-impl review
is a checklist of every surface, walked through by hand against the rendered
DOM (verified via RTL queries in `TreeCanvas.test.tsx`).

---

## 1. Surface inventory

### 1.1 Empty state (no active run)

- TreeCanvas renders `tb-canvas-empty` with the copy "No active run. Select a
  playbook on the left and press Start run."
- NarrationPanel shows `tb-narration-empty` ("No narration yet — start a run
  to see commentary.")
- ConclusionBanner is absent.
- AwaitingUserModal is absent.
- ControlBar shows status `no run`; every action button is disabled except
  Skip (which is intentionally a stub — see §3 follow-ups).

**Compliance:** matches §2 of the design spec.

### 1.2 Running state

- StepNode chips render with `data-status="running"` for the active step,
  `data-status="passed"` for completed predecessors.
- The amber pulse animation runs at 1.4s (CSS keyframes verified in
  `StepNode.css`).
- ControlBar shows `running`; Pause is enabled, Resume is disabled.
- The xyflow canvas auto-fits via `fitView`.

**Compliance:** matches §3 (StepNode card) + §5 (ControlBar table).

### 1.3 Paused state

- ControlBar shows `paused`; Resume enabled, Pause disabled.
- All previously-running chips flip to `awaiting_user` (blue) when paused by a
  Tier-1+ guardrail.
- Cancel remains enabled (operator can abandon the run).

**Compliance:** matches §5.

### 1.4 Awaiting-user

- Test `awaiting_user chip when the run pauses for input` confirms
  `data-status="awaiting_user"` on the StepNode.
- AwaitingUserModal renders centered with the prompt text. ESC = Cancel,
  Enter = Confirm. Confirm calls `answer_prompt(runId, answer)` and the
  backend keeps the run paused — operator must press Resume on the
  ControlBar (Phase 2 security invariant).
- Test `Cancel clears the prompt locally without invoking the backend`
  verifies the operator-cancel path doesn't accidentally answer the prompt.

**Compliance:** matches §6 of the design spec, including the safety contract
("Confirming captures your answer and keeps the run paused").

### 1.5 Completed / Failed

- ConclusionBanner appears with green or red left-border for
  completed/failed.
- All four conclusion fields are rendered:
  `tb-conclusion-root-cause`, `tb-conclusion-confidence`,
  `tb-conclusion-fix`, and `tb-conclusion-evidence-N` pills.
- Confidence chip color tracks `data-confidence` (`low`=blue, `medium`=amber,
  `high`=green).
- ControlBar shows `completed`/`failed`; Pause/Resume/Cancel/Skip all
  disabled. Mark RC remains enabled so the operator can annotate after the
  fact.
- "Open editor" button dispatches `menu:troubleshoot_editor` (no-op stub
  routed through App.tsx, opens the same tab — Phase 6 will add a dedicated
  editor surface).

**Compliance:** matches §7 of the design spec.

### 1.6 Conclusion dismiss

- "Dismiss" hides the banner without clearing the conclusion from the store
  — verified by `Dismiss hides the banner without affecting run state`.

---

## 2. Cross-cutting checks

### 2.1 Theme tokens

- No new `var(--*)` variables introduced. All colors are the theme literals
  documented in §1 of the design spec.
- Status colors mirror `SeverityChip.css` and the tab-active border (`#262a33`)
  conventions.

### 2.2 Component sizes

| File                                          | Lines |
| --------------------------------------------- | ----- |
| `api.ts`                                      | ~145  |
| `store.ts`                                    | ~322  |
| `api.test.ts`                                 | ~285  |
| `StepNode.tsx`                                | ~104  |
| `StepNode.css`                                | ~107  |
| `TreeCanvas.tsx`                              | ~118  |
| `NarrationPanel.tsx`                          | ~190  |
| `ControlBar.tsx`                              | ~127  |
| `AwaitingUserModal.tsx`                       | ~140  |
| `ConclusionBanner.tsx`                        | ~96   |
| `PlaybookPicker.tsx`                          | ~180  |
| `TreeCanvas.test.tsx`                         | ~196  |
| `components/troubleshoot/TroubleshootTab.tsx` | ~95   |

`store.ts` is the only file above the 250-line nominal target (322 lines,
including ~40 lines of comments and the two exported selectors). The plan
allows "split sensibly" — splitting the store further would make the action
fan-in less self-contained, so we accept the size.

### 2.3 Tests

- Vitest, Plan 15 Phase 4 only: 32 tests across 2 files (`api.test.ts`,
  `TreeCanvas.test.tsx`) — all green.
- Vitest, full project: 1034 / 1034 — no regressions.
- TypeScript: only pre-existing diagnostics; nothing new from Phase 4.

### 2.4 Accessibility & motion

- AwaitingUserModal: `role="dialog"`, `aria-modal="true"`, focus on the input
  on open, ESC closes.
- StepNode pulse animation respects `prefers-reduced-motion: reduce` (CSS
  media query in `StepNode.css`).
- Narration panel collapse state persisted to `localStorage`.

---

## 3. Rough edges & follow-ups

These are flagged as nits, not must-fix:

1. **Skip button is a frontend stub.** No backend `skip_step` command exists;
   we dispatch `troubleshoot:skip_requested` so a future phase can wire it
   without touching this surface. Documented in `ControlBar.tsx`.
2. **Citation pills don't open the RAG modal yet.** They dispatch a
   `troubleshoot:citation-clicked` event; Plan 12's RAG modal isn't wired
   into the troubleshoot tab. Phase 6 follow-up.
3. **ConclusionBanner "Open editor" reuses the troubleshoot tab.** Phase 6
   ships a dedicated PlaybookEditor; until then we route the click through
   `menu:troubleshoot_editor` which currently re-opens this same tab.
4. **PlaybookPicker symptom textarea is free-form.** Phase 5's matcher
   replaces this with ranked suggestions; the symptom string is passed
   through to `start_run` so the run row already captures the operator's
   framing.
5. **Tree layout is a chain, not a true branching tree.** The persistence
   layer doesn't currently emit `parent_idx` on step rows (the engine
   carries the relationship in `next_step_id`). When `parent_idx` lands,
   `layoutPositions` already supports horizontal sibling spread; for now
   it falls back to a vertical chain.
6. **macOS menu items not wired.** The plan explicitly says "I'll wire the
   actual macOS menu items separately"; we emit/listen for
   `menu:troubleshoot_open|editor|templates` events for the Tauri menu.rs
   to hook into.
7. **No live Playwright run.** Same constraint as Phases 1–3: the Tauri
   bundle isn't built in this workspace, so the smoke suite fails at process
   spawn (ENOENT). Phase 4 explicitly allows skipping when the bundle isn't
   built.

---

## 4. Compliance summary

- [x] Design spec sections 1–12 all met.
- [x] Existing dark theme tokens reused; no new color variables.
- [x] Component file sizes under target except `store.ts` (justified).
- [x] All four event types fanned into the store (with two-shape
      reconciliation).
- [x] StepNode card layout matches the spec.
- [x] NarrationPanel auto-scrolls only when the user is at the bottom.
- [x] AwaitingUserModal matches the safety invariant (no auto-resume).
- [x] ConclusionBanner appears only on terminal status.
- [x] PlaybookPicker enforces JSON-valid vars before enabling Start.
- [x] All Phase 4 commits land in order with the prescribed messages.

No must-fix items; proceeding to Phase 4 regression (Task 4.6).

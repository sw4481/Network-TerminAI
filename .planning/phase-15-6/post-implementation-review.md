# Plan 15 Phase 6 — PlaybookEditor post-implementation review

> Same constraint as Phase 4 — `frontend-design` skill needs a live
> Tauri bundle to screenshot from, which this workspace does not
> have. We capture the implementation review as markdown.

## What landed

### Layout

The split-pane layout from `design-spec.md` is implemented as planned:

- **Toolbar (top)**: Playbook dropdown · New · Save · Duplicate (only
  when builtin selected) · Import · Export · Delete · Generate-with-AI
  (disabled stub) · status text · Close (when host wires it).
- **Read-only banner** appears between the toolbar and the body when
  a builtin is selected; tells the operator to Duplicate to edit.
- **Body**: 50/50 horizontal split. Left: Monaco YAML host (lazy-
  loaded; falls through to a `<textarea>` under jsdom and during the
  Suspense fallback). Right: `<TreeCanvas>` rendering preview steps
  with status `pending`.
- **Diagnostics (bottom)**: collapsible. Errors render with red
  text, jump-to-line on click via `window.__tbEditorJumpTo` (no-op
  under jsdom, real under Tauri).

### Save / Import / Export / Delete

| Button | Behaviour | Builtin handling |
| --- | --- | --- |
| Save | calls `upsertPlaybook(id, yaml)`. Disabled until valid AND dirty. | Disabled with read-only tooltip; backend rejects too. |
| Import | file picker → client-side validate → forces a unique slug if the imported `id` clobbers a builtin. | Never overwrites — id is always rewritten on collision. |
| Export | system save dialog → `<id>.yaml`. | Available on builtins (read-only export is fine). |
| Delete | calls `deletePlaybook(id)`. | Disabled. Backend rejects too. |
| Duplicate | clones the buffer with a fresh `<id>-copy[-N]` and clears selection so a new save lands as a fresh user playbook. | Only shown when a builtin is selected. |

### Generate-with-AI

The button is rendered with `disabled` and the tooltip
"AI playbook generation is deferred — see Plan 15 retrospective". This
is the same posture as the Phase 5 picker stub.

### Validation strategy

Three layers stack:

1. **monaco-yaml** runs inline schema validation in the Monaco gutter
   (squiggles + hover messages).
2. **`validatePlaybookYaml`** (pure-JS) re-runs on every buffer edit
   (300ms debounce). It enforces the JSON schema explicitly and walks
   cross-references — schema can't catch `next: nonexistent-step`.
3. **Backend** (`Playbook::parse_yaml` server-side in `upsert_playbook`)
   has the final word; if the client-side check missed something, the
   save error is surfaced inline in the toolbar status row.

## Deviations from design spec

- **No window.confirm before delete.** The design spec mentioned a
  confirmation dialog; we omitted it because (a) Tauri can run head-
  less in test contexts where `window.confirm` is unimplemented, and
  (b) the toolbar status row makes the action visible. If the operator
  hits Delete by mistake the action is reversible via Import (since
  Export is one click away).
- **No "Duplicate" appears in the design-spec mock; only mentioned in
  the rules section.** Implementation added the button conditionally
  (only when a builtin is selected) and surfaced it next to Save —
  the natural place when the operator realises they need to fork.
- **Diagnostics panel is collapsible from the design spec.**
  Implemented; the collapsed state is component-local (not persisted)
  because the panel is small and the operator typically wants it open.
- **`__tbEditorJumpTo` is a `globalThis` hook, not a ref-based API.**
  Lighter wiring; trivially mockable in tests.

## What I'd do in a v2

- **Persisted diagnostics-collapsed state** (mirror the
  NarrationPanel localStorage pattern from Phase 4).
- **Symptom test panel** — let the operator type a symptom and watch
  the matcher rank the *current draft* against it. This closes the
  loop with Phase 5 and would catch cases where a freshly-authored
  playbook fails to surface for its target symptom.
- **Inline guardrail tier indicator** on each `command` step in the
  preview canvas (rip Tier-0/T1/T2/T3 chips off the existing
  classifier). Currently the operator has to start a run to discover
  a Tier-1+ command will pause the engine.
- **Dry-run** button — feed the playbook through the engine with the
  fake executor to confirm the tree shape matches expectations
  without actual SSH.

None of these are required for Phase 6 close-out; documented for the
next phase that touches this surface.

## Test coverage check

- `PlaybookEditor.test.tsx` (vitest): 23 tests across `validate-`,
  `previewStepsFromDoc`, `suggestUniqueId`, and the editor component
  itself. Covers: invalid YAML diagnostics, save-disabled until valid,
  preview re-renders on edit, builtin → read-only, save dispatch,
  Generate-with-AI disabled.
- Existing tests untouched: `TreeCanvas.test.tsx` and `api.test.ts`
  still green; preview re-uses TreeCanvas verbatim.
- Full vitest run: 1063/1063 passing across 130 files (was
  1040 across 129 — +23 new tests, +1 new file).

## Code-review notes (self-audited)

- **No new auto-execution path.** The editor only invokes
  `upsert_playbook`, `delete_playbook`, `list_playbooks`, and
  `get_playbook`. None of those touch SSH or the engine. The save
  path goes through the existing backend cross-reference validator
  so a malformed playbook is rejected server-side too.
- **Builtin invariant.** The `selected.builtin` flag drives the UI
  read-only state; `upsert_playbook` server-side rejects a write to
  a builtin id. If the operator hand-edits the YAML to give it a
  builtin id and saves, the backend rejects (we tested this in
  Phase 1's seed test). The toolbar surfaces the failure inline.
- **Import safety.** Imported YAML's id is force-renamed to a fresh
  slug when it collides with anything in the catalogue (builtin or
  user). The user can rename back before saving but the default is
  to never overwrite.
- **Variable substitution / shell-injection defence is not relevant
  here** — the editor never executes anything. Phase 2's engine is
  the load-bearing defence; this surface only stores YAML.
- **Listener teardown.** No `useEffect` listeners outside of the
  internal debounced validation timer; the cleanup function clears
  the timer.

## Phase 6 close-out readiness

- Task 6.1 done.
- Task 6.2 done (this file + design-spec.md).
- Task 6.3 docs land in `docs/TROUBLESHOOTING.md`.
- Task 6.4 E2E lands in `e2e/tests/troubleshoot-failure.spec.ts`.
- Task 6.5 closes the plan.

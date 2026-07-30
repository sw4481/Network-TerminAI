### Task 4 — Phase 4: Monaco/editor appearance integration

- [x] **4.1 — SEQUENTIAL:** Move Monaco palette resolution behind
  `src/theme/monacoThemes.ts`; retain `zed-one-dark.ts` as a compatibility
  export until callers and tests are migrated.
- [x] **4.2 — SEQUENTIAL:** Define Grey and Matrix Monaco themes, including
  syntax, gutter, selection, widgets, diagnostics, Git decorations, debugger
  controls, and terminal-panel boundaries.
- [x] **4.3 — SEQUENTIAL:** Update `MonacoEditor` to resolve its theme from
  Appearance + Editor Mode and update live without recreating its model or
  editor instance.
- [x] **4.4 — SEQUENTIAL:** Add **Follow application theme** and explicit theme
  overrides to the existing Editor Settings tab. Preserve the separate Zed
  Mode and Vim controls.
- [x] **4.5 — SEQUENTIAL:** Verify detached editor windows receive the same
  appearance event and render the correct theme before the editor becomes
  interactive.
- [x] **4.6 — Regression:** Exercise classic Monaco and Zed Mode under all
  application themes, including splits, detach/reattach, LSP, Git, and DAP.

Acceptance gate:

- Switching themes does not dispose Monaco models, interrupt LSP/DAP, or lose
  editor view state.
- Zed Mode remains a behavior mode, not a hard-coded color choice.

Completion evidence: resolver and compatibility tests cover every app/theme/mode
combination; semantic Grey/Matrix color contracts include syntax, gutter,
selection, widgets, diagnostics, Git, debugger, and terminal boundaries. The
live apply seam only calls Monaco `defineTheme`/`setTheme`, with lifecycle
assertions proving no editor/model create or dispose calls. Focused detached,
Zed/Vim, split/editor lifecycle, LSP, Git, and DAP regression suites plus the
full frontend suite pass. Native visual observation of a detached window's
first paint and retained live LSP/DAP sessions remains an operator check.

# Task 4 report — Monaco/editor appearance integration

## Delivered

- Added `src/theme/monacoThemes.ts` as the Monaco palette resolver. Explicit
  editor choices take precedence; Follow application resolves Grey and Matrix
  first, then Dark Zed One Dark or classic `vs-dark` exactly as specified.
- Retained `src/components/editor/themes/zed-one-dark.ts` as a compatibility
  facade while moving palette ownership into `src/theme/`.
- Defined Grey and Matrix syntax, editor/gutter/selection/widget, diagnostics,
  Git, debugger, terminal, and panel-boundary colors.
- Updated `MonacoEditor` to update a live Monaco theme with `defineTheme` and
  `setTheme` only. It does not recreate an editor/model or alter LSP, Git, DAP,
  split, or Vim lifecycle dependencies.
- Added labelled radio controls and provider-backed preview/save behavior to
  Editor Settings without coupling the existing Zed Mode or Vim controls to a
  palette.
- Detached windows now wait for the AppearanceProvider's authoritative
  snapshot before mounting their interactive editor pane. The pre-React mirror
  remains responsible for the document's initial application theme.

## RED / GREEN evidence

- RED: `bun run test -- --run src/theme/monacoThemes.test.ts src/components/settings/EditorSettingsTab.test.tsx src/components/editor/DetachedEditorWindow.test.tsx`
  initially failed because `monacoThemes.ts`, editor theme controls, and
  detached appearance hydration gating did not exist.
- GREEN focused: the same command plus
  `src/components/editor/themes/zed-one-dark.test.ts` passed: 4 files, 27
  tests.
- GREEN full frontend: `bun run test -- --dir src` passed: 240 files, 1780
  tests. The two existing jsdom navigation notices remained baseline noise.
- GREEN build: `bun run build:relaxed` passed. Existing Vite dynamic-import and
  chunk-size warnings remained.
- GREEN hygiene: `git diff --check` passed.

## Lifecycle-state evidence

`src/theme/monacoThemes.test.ts` proves the live application seam invokes only
Monaco `defineTheme` and `setTheme`; fake create/dispose lifecycle calls remain
absent. `MonacoEditor` has no appearance-theme dependency in its model lease,
LSP document, Git-awareness, or debug-decoration effects, so a palette update
does not trigger those cleanup/recreation paths. Existing split, LSP, Git, and
DAP test suites pass under the full frontend regression run.

## Assumptions and concerns

- The custom Monaco color IDs are stable Monaco workbench/editor IDs; actual
  rendered contrast and unsupported-color fallback need native observation.
- Native confirmation remains required for detached-window first-frame visuals
  and continued LSP/DAP sessions while changing themes. No native app was
  launched because Task 4 itself does not change the sidecar, Tauri commands,
  packaging, or dependencies.
- Commit: `bcf7139d57420a38f79a00f91f4aae6186a2a4b2` (`feat(editor): apply appearance themes to Monaco`).

## Review repair evidence

- RED/GREEN: provider failure/retry, detached failed/pending/ready gating,
  complete 3x5x2 resolver matrix, provider-driven Monaco lifecycle, and Editor
  Settings rejection tests were added and pass (61 focused tests).
- `authoritativeState` distinguishes a successful stored/event snapshot from
  fallback Dark. Detached editors remain non-interactive on failure and expose
  a retry action; retry is tested against the real provider state.
- `setSettings` now rethrows after recording its non-fatal provider error.
  Appearance and Terminal callers consume that rejection, while Editor Settings
  displays it.
- Final repair verification: full frontend suite 241 files / 1805 tests and
  relaxed build pass; existing Vite warnings remain.

## Round 2 repair evidence

- RED/GREEN: deterministic provider tests prove that an older retry cannot
  overwrite a newer retry or live cross-window event (15 focused tests).
- A single generation counter now invalidates stale initial fetches, retries,
  live events, and saves. `MonacoEditor` uses the public Monaco import again;
  the Vite test alias maps only the test resolver to Monaco's browser entry.

## Final detached provider-to-Monaco recovery evidence

- RED: `bun run test -- --run
  src/components/editor/DetachedEditorWindow.appearance.integration.test.tsx`
  failed before the test resolver repair: `monaco-vim` could not resolve its
  extensionless `monaco-editor/esm/vs/editor/editor.api` browser import under
  Vitest. No test ran, so the real detached provider-to-Monaco boundary was
  not previously executable.
- GREEN focused: `bun run test -- --run
  src/theme/AppearanceProvider.test.tsx
  src/components/editor/DetachedEditorWindow.test.tsx
  src/components/editor/DetachedEditorWindow.appearance.integration.test.tsx
  src/components/editor/MonacoEditor.appearance.test.tsx
  src/components/editor/MonacoEditor.lifecycle.test.ts
  src/components/editor/EditorPane.test.tsx
  src/components/editor/useVimMode.test.tsx
  src/theme/monacoThemes.test.ts
  src/components/editor/themes/zed-one-dark.test.ts` passed: 9 files, 73
  tests.
- The new integration mounts the real `AppearanceProvider`, `ZedModeProvider`,
  `DetachedEditorWindow`, `EditorPane`, and `MonacoEditor`. It delivers the
  captured real `appearance-settings-changed` listener with Matrix settings,
  verifies Monaco receives `defineTheme` and `setTheme` for `ccie-matrix`, and
  verifies no editor/model create or dispose, or LSP start/stop/open/close,
  runs after the event.
- The Vite Monaco aliases and `monaco-vim` transform are now gated by
  `mode === "test"`; production builds retain normal public-package Monaco
  resolution. `bun run build:relaxed` passed with the existing dynamic-import
  and chunk-size warnings.
- GREEN full frontend: `bun run test -- --dir src` passed: 242 files, 1808
  tests. The existing jsdom navigation notices remained; Vitest also reports
  an upstream missing `marked.umd.js.map` source-map file while transforming
  `monaco-vim` for the integration harness.
- GREEN hygiene: `git diff --check` passed.

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

## Round 3 recovery evidence

- RED stale save: `bun run test -- --run
  src/theme/AppearanceProvider.test.tsx` failed 1 of 15 tests. An older failed
  save after a newer Slate Grey cross-window event reverted the provider to
  Dark instead of preserving Slate Grey.
- RED test resolver: `bun run test -- --run src/viteConfig.test.ts` failed 1
  of 1 tests because the portable `monacoTestAliases` resolver did not yet
  exist. The node-environment config test asserts installed-package resolution
  and that production config has no aliases.
- GREEN focused: `bun run test -- --run
  src/theme/AppearanceProvider.test.tsx src/viteConfig.test.ts
  src/components/editor/DetachedEditorWindow.appearance.integration.test.tsx
  src/components/editor/MonacoEditor.appearance.test.tsx
  src/components/editor/MonacoEditor.lifecycle.test.ts
  src/components/editor/EditorPane.test.tsx` passed: 6 files, 26 tests.
- Detached integration now sends real Matrix, Slate Grey, and explicit Zed One
  Dark editor-override snapshots through `appearance-settings-changed`. Each
  resolves the expected Monaco theme and leaves editor/model/LSP lifecycle
  counters unchanged after the event.
- `setSettings` now captures its generation before persistence and ignores a
  stale failure entirely; only the current save failure can apply the Dark
  fallback, error, and rejection behavior.
- Monaco test aliases now use `createRequire(import.meta.url).resolve(...)`
  and are created only for `mode === "test"`; the config test verifies the
  installed package entries and an alias-free production config.
- GREEN full frontend: `bun run test -- --dir src` passed: 243 files, 1812
  tests. GREEN build: `bun run build:relaxed` passed. Existing Vite
  dynamic-import/chunk-size warnings, jsdom navigation notices, and the
  upstream missing Monaco `marked.umd.js.map` source-map warning remain.

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

## Final review recovery

- Scoped Appearance, Editor, and Terminal saves now share one synchronous save
  lock and merge only their owned field against the latest authoritative
  snapshot. Per-field revisions keep older persistence responses from
  overwriting newer previews or cross-window updates.
- A persistence failure restores only the failed scope's prior authoritative
  value. A post-persistence event-emission failure keeps the committed UI and
  mirror, exposes a warning, and does not fabricate a rollback.
- RED provider/tab coverage exposed stale full-snapshot writes, overlapping
  saves, lost unrelated previews, and unreported terminal errors. GREEN focused
  coverage passed 4 files / 44 tests.
- RED terminal coverage proved Follow application and Matrix controls displayed
  stale stored custom colors. GREEN passed 2 files / 17 tests after controls,
  ANSI preview, Custom materialization, and reset behavior all used the resolved
  preset palette.
- RED detached coverage mounted Monaco with transient `vs-dark` before editor
  mode hydrated. GREEN passed 2 files / 15 tests after the interactive pane was
  gated on authoritative appearance plus editor-mode hydration.
- Final frontend regression passed 247 files / 1,917 tests. The relaxed
  production build transformed 2,106 modules and passed with the existing Vite
  import/chunk warnings.
- Commits: `94c3d7b`, `ac83e53`, and `721c840`.

Native first-frame appearance, live split/detach/reattach behavior, and active
Git/LSP/DAP continuity remain intentionally reserved for Shaun's final operator
matrix under Task 4.6.

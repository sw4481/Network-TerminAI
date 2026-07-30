# Design and Implementation Plan: TerminAI Themes and Appearance

**Date:** 2026-07-30
**Status:** In progress — implementation started 2026-07-30
**Default compatibility target:** preserve the current TerminAI dark appearance exactly

---

## 1. Objective

Add a first-class appearance system to TerminAI with:

- **TerminAI Dark** — the current look, retained as the default.
- **Grey Mode** — a neutral charcoal/grey palette with reduced saturation.
- **Matrix** — black surfaces, phosphor-green text and accents, and optional
  restrained scanline/glow effects.
- Live terminal customization for default font color, background, cursor,
  selection, the 16 ANSI colors, font family, size, weight, line height, and
  cursor style.
- Editor colors that follow the application theme by default while preserving
  Zed Mode's layout, Vim, keybinding, LSP, Git, and debugger capabilities.
- Durable preferences that apply to the main window, existing and new terminal
  sessions, and detached editor windows without requiring an app restart.

Grey Mode is defined here as a dark neutral-grey theme, not a light theme. The
theme model must remain extensible so a true light theme can be added later
without another architecture change.

## 2. Current-state findings

The plan is based on the current `main` checkout:

- Global application styling is rooted in `src/App.css` and is almost entirely
  literal dark colors. `src/App.css` alone contains roughly 538 color literals.
- Across `src/**/*.{css,ts,tsx}`, the current inventory is roughly 4,575 color
  literals, 673 unique values, spread across 194 files. A blind one-shot color
  replacement would be unsafe because status, topology, diff, chart, syntax,
  and vendor colors carry meaning.
- The live xterm configuration is duplicated in:
  - `src/lib/terminalRegistry.ts` — the active persistent-terminal path.
  - `src/hooks/usePty.ts` — the retained legacy rollback path.
- The application currently loads xterm **5.5.0 from the CDN** in `index.html`,
  even though `package.json` contains xterm 6.x dependencies. Theme work must
  target the runtime that TerminAI actually loads and must not silently combine
  an xterm upgrade with this feature.
- Monaco visual selection is currently coupled to editor mode through
  `ZedModeProvider` and `themes/zed-one-dark.ts`.
- `main.tsx` already wraps both the main application and detached editor window
  in a shared provider, which is the correct seam for another cross-window
  appearance provider.
- Settings already has separate **Editor** and **Terminal** sections. The
  Terminal section currently contains notifications and diagnostic logs, not
  visual preferences.
- `app_flags` is already the durable key/value persistence mechanism for editor
  mode and other application preferences, so no new SQL migration is required.

## 3. Product decisions

### 3.1 Scope for the first release

In scope:

- Three bundled application presets: Dark, Grey, and Matrix.
- Application-wide semantic color tokens.
- Application-wide terminal appearance settings.
- Live updates to open terminals without restarting their PTYs or losing
  scrollback, selection, shell state, or remote sessions.
- Monaco themes for Dark, Grey, and Matrix.
- A per-editor choice of **Follow application theme** or an explicit editor
  theme override.
- Reset-to-preset and reset-all actions.
- Cross-window synchronization and relaunch persistence.
- Accessibility, reduced-motion behavior, and release validation.

Out of scope for the first release:

- Per-tab or per-host terminal themes.
- Downloading or bundling third-party fonts.
- Arbitrary CSS/theme file import or a public theme-plugin API.
- A light theme.
- Animated Matrix rain. Matrix effects are CSS-only, restrained, optional, and
  disabled under reduced-motion preferences.
- Upgrading or replacing the CDN xterm runtime.

### 3.2 Theme and editor-mode independence

Application appearance and editor behavior are separate concepts:

```text
AppearanceProvider
  ├── application preset: dark | grey | matrix
  ├── terminal appearance: follow app | preset/custom overrides
  └── editor appearance: follow app | explicit override

ZedModeProvider
  └── editor behavior: classic Monaco | Zed-style chrome/Vim/keybindings/features
```

Zed Mode must no longer be the sole owner of Monaco's colors. It continues to
own behavior and chrome. Theme resolution follows these rules:

1. An explicit editor override wins.
2. Otherwise Grey and Matrix use their matching Monaco theme.
3. Otherwise Dark + Zed Mode preserves the existing Zed One Dark theme.
4. Otherwise Dark + classic mode preserves `vs-dark`.

This keeps today's default behavior intact while allowing a whole-application
Matrix or Grey selection to include the editor.

## 4. Appearance contract

Persist one validated, versioned JSON value in
`app_flags.ccie_appearance_settings_v1`:

```ts
type AppThemeId = "terminai-dark" | "slate-grey" | "matrix";
type EditorThemeId =
  | "follow-app"
  | "classic-dark"
  | "zed-one-dark"
  | "slate-grey"
  | "matrix";
type TerminalPresetId =
  | "follow-app"
  | "terminai-dark"
  | "slate-grey"
  | "matrix"
  | "custom";

type AppearanceSettingsV1 = {
  schemaVersion: 1;
  appTheme: AppThemeId;
  editorTheme: EditorThemeId;
  terminal: {
    preset: TerminalPresetId;
    foreground: string;
    background: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    ansi: {
      black: string;
      red: string;
      green: string;
      yellow: string;
      blue: string;
      magenta: string;
      cyan: string;
      white: string;
      brightBlack: string;
      brightRed: string;
      brightGreen: string;
      brightYellow: string;
      brightBlue: string;
      brightMagenta: string;
      brightCyan: string;
      brightWhite: string;
    };
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    lineHeight: number;
    cursorStyle: "block" | "bar" | "underline";
    cursorBlink: boolean;
  };
  effects: {
    matrixScanlines: boolean;
    matrixGlow: boolean;
    motion: "system" | "reduced";
  };
};
```

Validation requirements:

- Unknown schema versions and theme IDs fall back safely to current Dark.
- Colors are normalized to `#RRGGBB` or `#RRGGBBAA`; arbitrary CSS is not
  persisted.
- Numeric values are clamped to documented UI limits.
- The backend rejects malformed values rather than storing them.
- The current Dark preset is the fallback for missing or corrupt data.
- A small, non-sensitive localStorage mirror of the last theme ID is permitted
  only to prevent a dark flash while the authoritative `app_flags` value loads.

## 5. Semantic token system

Create a stable semantic layer instead of naming variables after literal colors.
The initial contract should include:

```text
Canvas and surfaces
  --app-canvas
  --surface-1
  --surface-2
  --surface-3
  --surface-overlay
  --surface-hover
  --surface-selected

Text and borders
  --text-primary
  --text-secondary
  --text-muted
  --text-inverse
  --border-subtle
  --border-default
  --border-strong

Actions and focus
  --accent
  --accent-hover
  --accent-subtle
  --focus-ring
  --selection

Semantic state
  --status-info
  --status-success
  --status-warning
  --status-danger
  --status-neutral

Terminal/editor bridges
  --terminal-background
  --terminal-foreground
  --editor-background
  --editor-foreground
```

Temporary aliases such as `--bg-primary`, `--border-color`, and
`--accent-color` should map to the new tokens so components that already use
fallback variables become theme-aware before their final cleanup.

Do not replace meaningful colors mechanically. Error/warning/success, Git diff,
syntax, topology, charts, and vendor colors must be mapped semantically or kept
on an explicit allowlist. Matrix remains green-forward, but errors and warnings
must still be distinguishable.

## 6. Target file layout

New frontend modules:

```text
src/theme/
  types.ts
  defaults.ts
  presets.ts
  validation.ts
  resolveTheme.ts
  applyDocumentTheme.ts
  terminalTheme.ts
  monacoThemes.ts
  AppearanceProvider.tsx
  themes.css
  *.test.ts

src/components/settings/
  AppearanceSettingsTab.tsx
  AppearanceSettingsTab.css
  AppearanceSettingsTab.test.tsx
```

New backend module:

```text
src-tauri/src/commands/appearance.rs
```

Primary files to modify:

```text
index.html
src/main.tsx
src/App.css
src/windows/Settings.tsx
src/components/TerminalSettingsTab.tsx
src/components/TerminalSettingsTab.css
src/lib/terminalRegistry.ts
src/hooks/usePty.ts
src/components/editor/MonacoEditor.tsx
src/components/editor/themes/zed-one-dark.ts
src/components/editor/ZedModeProvider.tsx
src/lib/tauri.ts
src-tauri/src/commands/mod.rs
src-tauri/src/lib.rs
package.json
```

Additional CSS/TSX files are migrated by feature area in Phase 5.

## 7. Phased implementation

### Task 1 — Phase 1: Contract, presets, persistence, and bootstrap

- [ ] **1.1 — SEQUENTIAL:** Capture baseline screenshots of the current Dark
  theme for the shell, Settings, terminal, editor, API, NETCONF, topology,
  troubleshooting, notifications, and common modals.
- [x] **1.2 — PARALLEL:** Implement typed defaults, preset definitions,
  normalization, clamping, migration, and validation tests under `src/theme/`.
- [x] **1.3 — PARALLEL:** Add Rust `appearance_settings_get` and
  `appearance_settings_set` commands backed by the existing `app_flags` table,
  with Rust tests for defaults, valid round trips, malformed JSON, invalid
  colors, invalid IDs, and future schema versions.
- [x] **1.4 — SEQUENTIAL:** Add Tauri wrappers in `src/lib/tauri.ts`, register
  the commands, and build `AppearanceProvider`.
- [x] **1.5 — SEQUENTIAL:** Add the
  `appearance-settings-changed` Tauri event so main and detached windows update
  from one validated snapshot.
- [x] **1.6 — SEQUENTIAL:** Apply the mirrored theme ID at the beginning of
  `main.tsx` before its xterm wait loop, then reconcile against `app_flags`.
  The app must not render several seconds of Dark before restoring Grey or
  Matrix.
- [x] **1.7 — Regression:** Verify provider hydration, failure fallback,
  cross-window event ordering, persistence, and no first-paint regression.

Acceptance gate:

- Missing settings reproduce the current Dark theme.
- Theme state persists across relaunch and synchronizes across webviews.
- A storage or invoke failure leaves the app usable in Dark and reports a
  non-fatal settings error.

### Task 2 — Phase 2: Theme tokens and core application shell

- [ ] **2.1 — SEQUENTIAL:** Add `themes.css`, set
  `data-theme="terminai-dark|slate-grey|matrix"` on `<html>`, and define the
  semantic contract plus temporary legacy aliases.
- [ ] **2.2 — SEQUENTIAL:** Migrate the root, shell, tab bar, panes, footer,
  settings window, buttons, inputs, menus, popovers, overlays, scrollbars, and
  focus states in `App.css`.
- [ ] **2.3 — PARALLEL:** Migrate common modal and shared-control styles that
  appear across several feature areas.
- [ ] **2.4 — SEQUENTIAL:** Add static optional Matrix scanlines/glow, guard
  them with explicit settings and `prefers-reduced-motion`, and confirm effects
  never intercept pointer events.
- [ ] **2.5 — SEQUENTIAL:** Add an **Appearance** Settings tab with three
  accessible preview cards, immediate live application, Save/Reset semantics,
  and theme descriptions.
- [ ] **2.6 — Regression:** Compare TerminAI Dark to baseline screenshots and
  run keyboard/focus/contrast checks on all three presets.

Acceptance gate:

- Core application chrome changes immediately with no remount.
- TerminAI Dark remains visually equivalent to the current UI.
- Grey and Matrix are readable in Settings itself and across the main shell.

### Task 3 — Phase 3: Live terminal customization

- [ ] **3.1 — SEQUENTIAL:** Record the actual runtime contract for the CDN
  xterm 5.5.0 build. Add adapter tests before relying on mutable options. Do not
  upgrade xterm as part of this phase.
- [ ] **3.2 — SEQUENTIAL:** Extract one `createTerminalOptions()` resolver and
  use it from both `terminalRegistry.ts` and the legacy `usePty.ts` path,
  removing their duplicated literals.
- [ ] **3.3 — SEQUENTIAL:** Add a registry update API that applies theme and
  font options to every live xterm instance, runs fit/refresh after font metric
  changes, and propagates any new rows/columns to `ptyResize`.
- [ ] **3.4 — SEQUENTIAL:** Add the corresponding live update effect to the
  legacy PTY path so the rollback switch remains functional.
- [ ] **3.5 — SEQUENTIAL:** Extend the existing Terminal Settings tab with:
  - Follow application theme.
  - Dark, Grey, Matrix, and Custom terminal presets.
  - Basic colors: font/foreground, background, cursor, and selection.
  - Advanced 16-color ANSI palette.
  - Font family, size, weight, and line height.
  - Cursor block/bar/underline and blink.
  - A live ANSI preview and per-section reset controls.
- [ ] **3.6 — Regression:** Prove that changing any terminal appearance option
  preserves PTY ID, shell process, scrollback, selection, command history,
  remote SSH state, split-pane attachment, and session restoration.

Implementation note:

The current xterm API supports runtime font-family changes; the official
web-font guidance calls for a fit after font metrics change. The implementation
must verify every mutable option against TerminAI's actual CDN 5.5.0 runtime
instead of assuming behavior from the installed 6.x package.

Acceptance gate:

- Existing terminals update live; new terminals start with the saved settings.
- No appearance change recreates, kills, or reconnects a PTY.
- ANSI applications remain legible in every preset.

### Task 4 — Phase 4: Monaco/editor appearance integration

- [ ] **4.1 — SEQUENTIAL:** Move Monaco palette resolution behind
  `src/theme/monacoThemes.ts`; retain `zed-one-dark.ts` as a compatibility
  export until callers and tests are migrated.
- [ ] **4.2 — SEQUENTIAL:** Define Grey and Matrix Monaco themes, including
  syntax, gutter, selection, widgets, diagnostics, Git decorations, debugger
  controls, and terminal-panel boundaries.
- [ ] **4.3 — SEQUENTIAL:** Update `MonacoEditor` to resolve its theme from
  Appearance + Editor Mode and update live without recreating its model or
  editor instance.
- [ ] **4.4 — SEQUENTIAL:** Add **Follow application theme** and explicit theme
  overrides to the existing Editor Settings tab. Preserve the separate Zed
  Mode and Vim controls.
- [ ] **4.5 — SEQUENTIAL:** Verify detached editor windows receive the same
  appearance event and render the correct theme before the editor becomes
  interactive.
- [ ] **4.6 — Regression:** Exercise classic Monaco and Zed Mode under all
  application themes, including splits, detach/reattach, LSP, Git, and DAP.

Acceptance gate:

- Switching themes does not dispose Monaco models, interrupt LSP/DAP, or lose
  editor view state.
- Zed Mode remains a behavior mode, not a hard-coded color choice.

### Task 5 — Phase 5: Feature-area migration and enforcement

- [ ] **5.1 — PARALLEL:** Migrate remaining feature CSS/inline styles in
  independent batches: terminal/blocks, API/NETCONF, editor/IaC, topology,
  troubleshooting, vault/recording, and settings/integrations.
- [ ] **5.2 — SEQUENTIAL:** Review each literal by meaning. Convert structural
  palette colors to tokens; retain domain colors only through named semantic
  tokens or an explicit documented allowlist.
- [ ] **5.3 — SEQUENTIAL:** Add a no-new-structural-color check for CSS and TSX.
  It should report new literal palette colors while allowing approved syntax,
  status, topology, chart, and vendor colors.
- [ ] **5.4 — SEQUENTIAL:** Remove temporary aliases only after their usage
  reaches zero. Do not remove useful semantic aliases merely to chase a count.
- [ ] **5.5 — Regression:** Run screenshot and interaction coverage across all
  major tabs and overlays in all three themes.

Acceptance gate:

- No major surface falls back to the old hard-coded background/text palette.
- Domain colors retain their meaning and are not flattened into Matrix green.
- Future structural UI work has a clear token contract and automated guard.

### Task 6 — Phase 6: Accessibility, release validation, and rollout

- [ ] **6.1:** Verify normal text contrast at 4.5:1 and large/UI text and
  controls at 3:1 where applicable.
- [ ] **6.2:** Verify focus rings, keyboard navigation, color-picker labels,
  screen-reader names, disabled states, and non-color status indicators.
- [ ] **6.3:** Test theme changes during active local shells, SSH sessions,
  split terminals, detached editors, debugging, model activity, and sidecar
  heartbeats.
- [ ] **6.4:** Run frontend tests, Rust tests, the relaxed production build,
  and Playwright smoke coverage:

  ```bash
  bun run test
  cargo test --manifest-path src-tauri/Cargo.toml
  bun run build:relaxed
  bunx playwright test --grep @smoke
  ```

- [ ] **6.5:** Launch through `./run.sh` and verify the repository's release
  invariant:
  - `target/debug/TerminAI` is running.
  - Its child `sidecar/.venv/bin/python -m ccie_sidecar` is running.
  - Sidecar warmup ping succeeds.
  - `sidecar_status.last_seen` receives fresh timestamps.
  - The footer leaves `starting` and displays the sidecar version.
- [ ] **6.6:** Complete the native visual matrix below and attach screenshots
  to the phase completion record.
- [ ] **6.7:** Update this plan's checkboxes and append the completion block
  required by `Plans/README.md`.

## 8. Native visual and behavior matrix

Run every row in Dark, Grey, and Matrix:

| Surface / behavior | Required result |
|---|---|
| Cold launch | Saved theme appears before the main UI; no long Dark flash |
| Main shell + tabs | Surfaces, selection, hover, borders, and focus are legible |
| Existing terminal | Live update; same PTY, scrollback, selection, and prompt |
| New/restored terminal | Saved colors, font metrics, cursor, and ANSI palette |
| SSH session | Theme changes do not reconnect or expose local echo |
| Split terminal panes | All panes update and refit correctly |
| Settings | Theme controls remain usable while previewing each preset |
| Classic Monaco | Correct resolved theme and preserved buffer/view state |
| Zed Mode | Correct theme plus unchanged Zed behavior and Vim state |
| Detached editor | Correct first paint and live cross-window updates |
| Git/LSP/DAP | Decorations, diagnostics, debugger state, and controls remain clear |
| API/NETCONF/topology | Domain and status colors remain distinguishable |
| Troubleshooter/notifications | Success, warning, error, and attention states remain clear |
| Restart | All persisted settings restore correctly |
| Reset | Section reset and full reset return to documented defaults |

## 9. Definition of done

The feature is complete only when:

1. Dark, Grey, and Matrix style the whole application, terminal, and editor.
2. TerminAI Dark is the safe default and matches the pre-feature appearance.
3. Theme changes apply live to every window and open terminal.
4. Terminal changes never restart or replace the PTY.
5. Preferences survive relaunch and corrupt data falls back safely.
6. Zed Mode features remain functional and independent of color selection.
7. Structural UI colors use semantic tokens; meaningful domain colors are
   documented and preserved.
8. Automated tests, production build, smoke tests, native matrix, and sidecar
   release invariant all pass.

## 10. Rollback strategy

- Keep `terminai-dark` as a complete preset and the universal fallback.
- Keep the legacy terminal path theme-aware so `ENABLE_TERMINAL_REGISTRY` remains
  a real rollback switch.
- Gate optional Matrix effects separately from the Matrix palette.
- During migration, retain legacy CSS variable aliases until feature-area
  coverage is proven.
- If hydration fails, apply Dark without blocking application startup.
- Do not delete or replace `sidecar/.venv` or application data during validation.

## Phase 1 — COMPLETED (AUTOMATED FOUNDATION) 2026-07-30

Typed Dark/Grey/Matrix settings, validated `app_flags` persistence, cross-window
appearance snapshots, and the pre-xterm local theme mirror are covered by unit,
library, and production-build validation. Task 1.1's native screenshot matrix is
explicitly deferred for operator acceptance; no screenshots or visual parity claim
have been fabricated here.

# TerminAI Themes — Task 1 Report

Date: 2026-07-30

## Delivered

- A typed, versioned `AppearanceSettingsV1` contract with Dark, Slate Grey, and Matrix presets, complete terminal palettes, strict color normalization, safe current-Dark fallback, and documented numeric bounds.
- `appearance_settings_get` and `appearance_settings_set`, persisted as validated JSON in `app_flags.ccie_appearance_settings_v1`. Missing, corrupt, and future-schema rows return Dark, while malformed set payloads are rejected before they overwrite a valid row.
- Typed Tauri wrappers plus registration, an `appearance-settings-changed` snapshot event, and `AppearanceProvider` hydration/error handling. The listener subscribes before it loads so a live cross-window snapshot cannot be overwritten by delayed hydration.
- A tiny `localStorage` mirror for only the theme id. `main.tsx` applies it synchronously before its xterm CDN wait loop and the provider reconciles it against authoritative `app_flags` after mount.

## Files changed

- `src/theme/types.ts`, `defaults.ts`, `presets.ts`, `validation.ts`, `AppearanceProvider.tsx`
- `src/theme/themeContract.test.ts`, `AppearanceProvider.test.tsx`
- `src-tauri/src/commands/appearance.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- `src/lib/tauri.ts`, `src/main.tsx`, `Plans/THEMES.md`

## TDD evidence

### RED

`bun run test -- --run src/theme/themeContract.test.ts src/theme/AppearanceProvider.test.tsx` failed because `./defaults` and `./AppearanceProvider` did not yet exist.

`CARGO_TARGET_DIR='/Users/shaunwhi/CCIE Terminal/src-tauri/target' cargo test --manifest-path src-tauri/Cargo.toml commands::appearance::tests --lib` failed because the new Rust appearance types, validation, storage helpers, and constants did not yet exist.

### GREEN

`bun run test -- --run src/theme/themeContract.test.ts src/theme/AppearanceProvider.test.tsx` passed: 2 files, 11 tests.

`CARGO_TARGET_DIR='/Users/shaunwhi/CCIE Terminal/src-tauri/target' cargo test --manifest-path src-tauri/Cargo.toml commands::appearance::tests --lib` passed: 5 tests.

### Review remediation — xterm 5.5 Dark parity

The original Task 1 default incorrectly invented an ANSI palette and opaque selection color. The actual legacy constructors in `src/lib/terminalRegistry.ts` and `src/hooks/usePty.ts` only supply background, foreground, cursor, and cursor accent. The authoritative CDN runtime used by `index.html`, `https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js`, defines `DEFAULT_ANSI_COLORS` as the GNOME palette (`#2E3436` through `#EEEEEC`) and the omitted selection default as `rgba(255, 255, 255, 0.3)`, represented exactly by `#FFFFFF4D`.

RED: `bun run test -- --run src/theme/themeContract.test.ts` failed the new exact legacy-xterm assertion, showing the invented palette and `#264F78` selection.

GREEN: `bun run test -- --run src/theme/themeContract.test.ts src/theme/AppearanceProvider.test.tsx` passed: 2 files, 12 tests. `CARGO_TARGET_DIR='/Users/shaunwhi/CCIE Terminal/src-tauri/target' cargo test --manifest-path src-tauri/Cargo.toml commands::appearance::tests --lib` passed: 5 tests. `bun run build:relaxed` passed.

## Regression evidence

- `bun run test -- --dir src` — passed: 235 files, 1,741 tests.
- `CARGO_TARGET_DIR='/Users/shaunwhi/CCIE Terminal/src-tauri/target' cargo test --manifest-path src-tauri/Cargo.toml --lib -q` — passed: 424 passed, 0 failed, 6 ignored.
- `bun run build:relaxed` — passed. Existing Vite dynamic-import/chunk-size warnings remain.
- `rustfmt --check src-tauri/src/commands/appearance.rs` — passed.

`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` reported broad pre-existing formatting drift outside Task 1, so no unrelated files were reformatted.

## Native validation / deferred evidence

Task 1.1 is intentionally left unchecked. No native screenshots were captured for the shell, Settings, terminal, editor, API, NETCONF, topology, troubleshooting, notifications, or common modals. This task only lays the foundation; visual parity and the complete native matrix require the later UI phases and operator acceptance.

`CARGO_TARGET_DIR='/Users/shaunwhi/CCIE Terminal/src-tauri/target' ./run.sh` launched the development app successfully. Evidence captured after launch: `target/debug/TerminAI` was running; its child PID 76913 was `python -m ccie_sidecar`; `sidecar_status` recorded version `0.0.1` and a fresh six-second heartbeat. The native footer's text was not reliably exposed through macOS accessibility, so that visual chip assertion remains operator-facing rather than invented.

## Assumptions

- Font UI bounds are 8–32px, 100–900 weight, and 1–2 line height. They are centralized in frontend and backend validation for later UI reuse.
- Uppercase canonical hex is visually identical to the present lowercase Dark literals and meets the `#RRGGBB` / `#RRGGBBAA` storage contract.
- The existing frontend Tauri event bus pattern, also used by Zed Mode, is the cross-webview transport; settings are persisted before broadcasting.

## Remaining concerns

- Native screenshot/first-paint observation and full sidecar footer inspection are deferred; no claim is made for those manual checks.
- Task 2 must introduce semantic CSS tokens before the stored `data-theme` attribute has visual effect. Task 3 and Task 4 must consume the terminal and Monaco portions of this contract.

## Commit

Foundation commit: `2101940b8477380fc27d539bd4d327add476969a` (`feat: add appearance settings foundation`). The separate review-remediation commit follows it immediately in Git history and is returned in the implementation handoff.

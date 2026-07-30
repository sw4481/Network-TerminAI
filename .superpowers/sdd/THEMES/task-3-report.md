# Task 3 report — Live terminal customization

## Delivered

- Added `src/lib/terminalAppearance.ts`: the sole xterm option resolver for
  registry and legacy terminals. It resolves follow-app, named, and custom
  terminal settings; maps core colors plus all 16 ANSI colors; and identifies
  metric-only changes.
- The registry retains its xterm, PTY id, and registry entry while applying
  options. Metric changes fit, refresh, and resize the existing PTY; color-only
  changes do not resize it. AppearanceProvider publishes every approved preview
  and persisted snapshot to this API, including future terminals.
- The `usePty` rollback route uses the same resolver and updates its existing
  xterm/PTY in place.
- Terminal Settings now offers labelled native preset, color, ANSI, typography,
  and cursor controls, an ANSI preview, section resets, clamping/normalization,
  immediate preview, and provider persistence.

## Runtime contract evidence

TerminAI continues to load `@xterm/xterm@5.5.0` from the CDN. The authoritative
CDN `lib/xterm.js` exposes mutable public `Terminal.options`; its only readonly
public option names are `cols` and `rows`. The 5.5.0 typings and bundle show the
used mutable keys: `theme`, `fontFamily`, `fontSize`, `fontWeight`,
`lineHeight`, `cursorStyle`, and `cursorBlink`. `terminalAppearance.ts` records
this boundary and always replaces the theme object. No xterm dependency was
upgraded or replaced.

## RED/GREEN evidence

- RED adapter/registry: `bun run test -- --run src/lib/terminalAppearance.test.ts src/lib/terminalRegistry.test.ts` failed because the resolver module and live update API did not exist; it also demonstrated the old incomplete theme literal.
- GREEN adapter/registry: the same command passed with 20 tests.
- RED legacy rollback: `bun run test -- --run src/hooks/usePty.test.tsx` failed with the old terminal options (`fontSize: 13`, legacy foreground) after an appearance change.
- GREEN focused: `bun run test -- --run src/hooks/usePty.test.tsx src/components/TerminalSettingsTab.test.tsx src/lib/terminalAppearance.test.ts src/lib/terminalRegistry.test.ts src/theme/AppearanceProvider.test.tsx` passed: 5 files, 37 tests.

## PTY invariant evidence

Registry tests preserve the exact xterm and PTY id after an update and assert no
additional spawn or kill call. The metric test asserts `fit`, `refresh`, and a
`ptyResize` to the original PTY id; the color-only test asserts no resize. The
legacy test keeps one xterm and one spawn while applying font/color updates to
the same legacy PTY. These headless tests cannot observe native renderer state,
so no appearance path calls spawn, kill, or reconnect APIs.

## Regression and build

- `bun run test -- --dir src` — passed: 239 files, 1762 tests. Existing baseline
  diagnostic noise remains: two `Not implemented: navigation to another Document`
  messages.
- `bun run build:relaxed` — passed. Existing Vite dynamic-import/chunk-size
  warnings remain.
- `git diff --check` — passed.

## Files

- `src/lib/terminalAppearance.ts` and its tests
- `src/lib/terminalRegistry.ts` and tests
- `src/hooks/usePty.ts` and tests
- `src/theme/AppearanceProvider.tsx`
- `src/components/TerminalSettingsTab.tsx`, CSS, and tests
- Task-plan/brief completion evidence

## Commit and concerns

This report is included in the single atomic Task 3 commit returned in the
handoff. The only remaining acceptance evidence is native operator observation:
change colors and font metrics in a real Tauri window while preserving visible
scrollback/selection, shell history, an active SSH connection, a split, and a
restored session. Task 3.6 deliberately remains unchecked until that observation
is performed.

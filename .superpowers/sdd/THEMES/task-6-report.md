# Task 6 — Accessibility, release validation, and operator handoff

Date: 2026-07-30

## Delivered

- Added a deterministic WCAG contrast release gate for 41 named semantic
  foreground/background pairs in each of Dark, Grey, and Matrix. Normal text
  requires 4.5:1; focus rings and control boundaries require 3:1.
- Wired the contrast gate into `bun run test`, alongside the existing
  structural-color guard.
- Corrected low-contrast text/control tokens. The deliberate accessibility
  exceptions to exact legacy Dark values are:
  `--text-secondary: #9299a4`, `--text-muted: #8b929e`,
  `--text-recording-muted: #99a0a9`, and `--focus-control: #626a77`.
  Grey uses `--text-muted: #99a0a9` and `--focus-control: #6b7581`.
- Hardened Appearance controls with visible card focus, disabled Matrix-only
  effects outside Matrix, readable reset/control styling, a disabled pending
  Save state, and textual save status.
- Verified all 21 terminal color inputs have unique accessible names and
  keyboard-reachable controls. Terminal boundaries and action text use
  contrast-safe semantic tokens.
- Made fan-out and sidecar state available without color alone. Fan-out chips
  use distinct foregrounds, semantic progress fills, status text, and labelled
  progressbar values. The sidecar chip is a polite status region with textual
  `starting`, version, and `down` states.
- Repaired two stale Rust doctests so the repository's exact full Cargo gate
  reaches a zero exit code.
- Repaired Playwright clean-state setup: the root command now collects only
  `e2e/tests`, local smoke setup builds without release-signing credentials,
  and the launcher resolves the current `TerminAI` executable through
  `E2E_TAURI_BIN` or `CARGO_TARGET_DIR`. Three path-resolution tests pass.

## TDD evidence

### Contrast and accessible controls

RED began with fixture-driven contrast tests before the checker existed and
with current theme pairs below the required thresholds. Focused component tests
also exposed missing disabled/pending semantics, color-only fan-out status,
and insufficiently named/bounded terminal controls.

GREEN:

```text
theme contrast CLI fixtures: passing accessible fixture; failing fixture
correctly identifies the exact semantic pair
terminal color controls: 21 inputs, 21 unique accessible names
bun run test: contrast gate passed for 3 themes x 41 pairs
```

### Rust release gate

The first exact full Cargo run completed every regular unit/integration binary
with zero failures, then exited 101 because two stale doctests no longer
compiled. One prose block was marked as text and `PtyOptions` documentation was
updated for its two current fields.

GREEN:

```text
cargo test --doc: 7 passed, 0 failed
full cargo test: exit 0
core library: 424 passed, 6 ignored, 0 failed
all integration binaries: 0 failed
doctests: 7 passed, 0 failed
```

### Playwright clean-state repair and honest blocker

RED 1: the documented root command collected Vitest files across the
repository and failed on CSS imports/matcher redefinition because there was no
root Playwright configuration.

GREEN collection:

```text
bunx playwright test --grep @smoke --list
18 tests in 11 files
```

RED 2: global setup successfully compiled `TerminAI` but bundling then required
`TAURI_SIGNING_PRIVATE_KEY`. `--no-bundle` now limits local smoke setup to the
debug executable.

RED 3: after the path resolver launched the current shared-target executable,
the first smoke interaction failed at
`change-window.spec.ts:23`:

```text
TypeError: Cannot read properties of undefined (reading 'press')
1 failed, 17 did not run
```

This is the repository's documented infrastructure limitation:
`e2e/tauri-driver.ts` returns a mock Playwright `Page`, not a WebDriver
connection to the native WKWebView. No skip or false-green result was added.
Task 6.4 therefore remains unchecked.

## Final automated release evidence

```text
bun run check:structural-colors -- --inventory
  passed

bun run test
  structural guard passed
  contrast passed: 3 themes, 41 semantic pairs
  247 files / 1,887 tests passed

CARGO_TARGET_DIR='/Users/shaunwhi/CCIE Terminal/src-tauri/target' \
  cargo test --manifest-path src-tauri/Cargo.toml
  exit 0; core 424 passed / 6 ignored; integrations 0 failed;
  doctests 7 passed

bun run build:relaxed
  exit 0; 2,106 modules transformed; built in 5.39s

bun test e2e/unit/tauri-driver.test.ts
  3 passed / 0 failed
```

Existing non-fatal output remains: two jsdom navigation notices, Monaco's
missing upstream `marked.umd.js.map`, Vite dynamic/static import advisories,
large-chunk warnings, and existing Rust unused-import/variable warnings.

## Live `./run.sh` release-invariant evidence

The shared-target development session launched through `./run.sh` remained
healthy during final validation:

- `/Users/shaunwhi/CCIE Terminal/src-tauri/target/debug/TerminAI` ran as PID
  44385.
- Direct child PID 44669 ran `python -m ccie_sidecar`; `CCIE_FORCE_VENV=1` was
  present and `lsof` showed native modules loaded from
  `sidecar/.venv/lib/python3.12/site-packages`.
- The application log recorded `sidecar warmup: ping succeeded` for this
  launch at `2026-07-30T20:19:45Z`.
- Read-only SQLite samples showed `sidecar_status.last_seen` advance from
  `1785443775` to `1785450542`; the latter was 14 seconds old and reported
  version `0.0.1` and PID 44669.
- The component contract renders a running status as `Sidecar: v0.0.1`, and
  its tests pass, but no native footer screenshot/observation is claimed.
  Task 6.5 remains unchecked until Shaun confirms the visible footer leaves
  `starting`.

The preserved `sidecar/.venv` and application data were not deleted or
replaced.

## Operator acceptance still required

Shaun should run every row of the native matrix in Dark, Grey, and Matrix,
including active local shell, SSH, split panes, existing/new/restored xterms,
Classic Monaco, Zed Mode, detached editor, Git/LSP/DAP, model activity,
sidecar heartbeat, restart, and reset. Confirm the footer visibly shows
`Sidecar: v0.0.1` and attach the requested screenshots.

Tasks 6.3, 6.4, 6.5, and 6.6 remain unchecked. `Plans/README.md` remains
`In progress` until native acceptance and a real Tauri WebDriver smoke result
complete the definition of done.

## Commits

- `04e4de2` — `feat(theme): enforce accessible appearance contrast`
- `81e14f6` — `fix(theme): expose accessible status and color controls`
- `87646b8` — `docs(rust): repair release doctests`
- `dc71fa6` — `fix(e2e): target current TerminAI smoke harness`

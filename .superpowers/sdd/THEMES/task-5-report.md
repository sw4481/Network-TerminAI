# Task 5 — Feature-area migration and enforcement

## Scope and inventory

The starting inventory found the current Dark structural palette repeated in
feature CSS and inline TSX styles. The migration covered the requested batches:

- terminal and blocks (including the terminal context menu; no PTY/xterm setup
  or lifecycle logic changed);
- API and NETCONF (22 files);
- editor and IaC (17 files);
- topology (7 files);
- troubleshooting (12 files);
- vault and recording (2 files); and
- settings and integrations (19 files).

The reviewed structural Dark literals (`#0f1114`, `#0b0d10`, `#0a0c0f`,
`#1a1d23`, `#262a33`, `#14171c`, `#161a20`, `#1e1e1e`, `#e6e1cf`,
`#8a8d94`, `#6c7380`, `#5ccfe6`, `#2d5a8c`, `#3e4451`, `#6bd968`,
`#ffb454`, and `#f28779`) have no remaining non-test CSS/TSX occurrences
under `src/components`, `src/features`, or `src/windows`.

Structural backgrounds, inputs, overlays, borders, hover/selected states,
text, focus, and status styling now use `themes.css` tokens. Neutral shadows
and light overlays use the new RGB bridge tokens. Recording retains its exact
Git-style Dark values through named `--surface-recording-*`,
`--text-recording-*`, and `--status-recording-live` tokens; Grey and Matrix
resolve those by semantic role.

## Guard and allowlist

`scripts/check-structural-colors.mjs` is wired as
`bun run check:structural-colors`. It scans the merge-base diff (or a supplied
base) for newly added legacy structural literals in feature CSS/TSX and reports
`file:line value`. It does not grandfather the existing tree and it does not
allow arbitrary new literals.

`docs/THEME_COLOR_ALLOWLIST.md` documents the only literal domain families:
status/severity, syntax/diffs, topology/charts, and vendor identities. Those
values stay local to their named domain and are not used for structural chrome.
This preserves Matrix's green-forward character without flattening warnings,
errors, topology links, chart series, or vendor marks.

## Tests and verification

RED (guard test before its entry-point fix):

```sh
bun run test -- src/theme/structuralColorGuard.test.ts
```

GREEN:

```sh
bun run test -- src/theme/structuralColorGuard.test.ts src/theme/featureThemeMigration.test.ts src/components/BlockNotebook.test.tsx src/components/topology/TopologyTab.test.tsx src/components/RagSettingsTab.test.tsx
bun run test
bun run check:structural-colors -- --base 9572e2dacd53e7b0da0b9d5d0ca2d2f30b12af89
bun run build:relaxed
git diff --check
```

Final repair result: 245 Vitest files / 1,820 tests passed; the full literal
inventory, regular merge-base guard, relaxed production build, workflow YAML
parse, and whitespace check all passed. The build retains pre-existing Vite
chunking advisories and the test run retains the non-fatal jsdom/Monaco source
map notices noted above.

Results: 245 Vitest files / 1,816 tests pass; the relaxed Vite build passes;
`git diff --check` passes. Existing jsdom navigation notices and Monaco's
missing upstream `marked.umd.js.map` notice remain non-fatal test output.
The focused suite exercises BlockNotebook interaction, topology filtering and
inspector interaction, and RAG/vault flow while the new feature-theme test
asserts semantic coverage in all seven Task 5 batches and preserves topology
and troubleshooting domain colors.

## Remaining work and assumptions

Task 5.4 remains unchecked: useful legacy aliases are retained until their
usage is proven zero. Task 5.5's native three-theme screenshot matrix is
intentionally unchecked and reserved for operator acceptance; no screenshots
were fabricated. This task did not launch the application, run the sidecar, or
perform Task 6 release validation.

Commit: `feat(theme): migrate feature colors and guard structural palette`
(the final hash is available from Git history).

## Review repair — 2026-07-30

RED/GREEN guard repair: the original enumerated-literal guard and its
representative fixture failed review because arbitrary colors and older palettes
could pass. The replacement starts RED with arbitrary, domain-misuse, untracked,
and explicit-base fixtures, then GREEN with five guard behavioral tests. It
derives `git merge-base <base> HEAD`, includes committed/staged/unstaged diff
lines plus untracked source files, falls back locally through `origin/main`,
`main`, and `HEAD~1`, and supports `--base` override. `--inventory` scans the
full source CSS/TSX tree; it is clean.

Structural styles across all seven Task 5 batches were reclassified and mapped
to surface/text/border/focus/status tokens, including older component palettes.
`CodeBlock` executing is now `--status-info`, distinct from success, warning,
and danger. `DiagramPanel` now injects resolved Dark/Grey/Matrix variables into
draw.io and Markmap `srcDoc` documents and regenerates them when appearance
changes; focused tests cover all three output themes.

CI repair: the normal `bun run test` verification path invokes the guard, and
both CI and release workflows fetch full history and run an explicit guard step
with an event-derived base SHA. YAML parsing passed locally.

Repair verification:

```sh
bun run check:structural-colors -- --inventory
bun run test -- src/theme/structuralColorGuard.test.ts src/theme/featureThemeMigration.test.ts src/components/DiagramPanel.test.tsx
bun run test
bun run build:relaxed
ruby -e 'require "yaml"; %w[.github/workflows/ci.yml .github/workflows/release.yml].each { |f| YAML.load_file(f) }'
git diff --check
```

## Recovery repair — 2026-07-30

The recovery began with failing tests for malformed token-alpha syntax,
flattened status and domain colors, missing exact Dark values, incomplete
literal detection, permissive allowlisting, diverged-branch/staged/untracked
Git behavior, a zero push-event base SHA, and DiagramPanel theme regeneration.
Those RED fixtures are now GREEN.

The repair restores exact Dark role values for editor/modal chrome, Git and
debugger states, IaC/diff/topology/troubleshooting, gNMI, TFTP, recording
failure, notification, and agent activity treatments. Grey and Matrix receive
role-equivalent values. Common structural fallbacks were also repaired so
surfaces, text, borders, overlays, and integration-button contrast no longer
collapse onto unrelated status or text colors. The malformed
`-colorbackground` declarations and all malformed token-alpha expressions are
gone from the full CSS/TSX tree.

The structural-color guard now recognizes the supported CSS color syntaxes,
including named colors, modern functional forms, `color()` spaces, and
`color-mix()`. Allowlist entries are machine-readable and exact by file, value,
property, context, and role. Tests exercise a real diverged repository with
committed, staged, unstaged, and untracked findings. An all-zero explicit base
falls through to a meaningful local comparison instead of silently accepting
the current tree, covering tag-push behavior without a workflow change.

Final automated verification:

```text
focused recovery suite: 3 files / 40 tests passed
full suite: 246 files / 1,840 tests passed
full structural-color inventory: passed
explicit-base structural-color guard: passed
relaxed production build: passed (2,106 modules)
CI and release workflow YAML parse: passed
git diff --check: passed
live `./run.sh` validation via the shared Cargo target: passed
```

The live check ran
`CARGO_TARGET_DIR='/Users/shaunwhi/CCIE Terminal/src-tauri/target' ./run.sh`
to avoid duplicating build artifacts. The shared `target/debug/TerminAI`
process launched a child `python -m ccie_sidecar` loading modules from the
preserved `sidecar/.venv`; the warmup ping succeeded, `sidecar_status.last_seen`
advanced with version `0.0.1`, and the rendered footer chip showed
`Sidecar: v0.0.1` instead of `starting`.

The native Dark/Grey/Matrix screenshot and operator matrix remains intentionally
deferred to interactive acceptance; no screenshot result is claimed here.

## Guard parser completeness repair — 2026-07-30

Review found that the prior line-local regular expressions could stop a
declaration at its first comma, miss later or multiline gradient stops, omit
`hwb()`, and interpret color-like text in TSX comments or unrelated strings as
real declarations.

RED reproduced six parser failures: `hwb()`, multiline linear and radial
gradients, multiline `color-mix()` with a modern literal input, TSX line
comments, and URL/string false positives. GREEN replaces the line-local path
with a small position-preserving lexical/declaration scanner. It masks CSS,
JSX, and TSX comments without shifting line offsets; scans complete declaration
values with balanced functions, strings, and delimiters; recognizes named,
hex, RGB/HSL/HWB, Lab/LCH/OKLab/OKLCH, `color()`, and literal `color-mix()`
inputs; and masks `url()` plus semantic `var()`/`env()` content. Diff mode now
scans each complete current file and filters findings to added lines, retaining
merge-base, staged, unstaged, untracked, and zero-base behavior. Diagnostics
and allowlisting remain exact by file, line, normalized value, property,
context, and role.

Round verification:

```text
focused structural-color guard: 1 file / 29 tests passed
full suite: 246 files / 1,852 tests passed
full structural-color inventory: passed
explicit-base structural-color guard: passed
relaxed production build: passed (2,106 modules)
CI and release workflow YAML parse: passed
git diff --check: passed
```

## Guard lexer-context repair — 2026-07-30

The follow-up RED pass added ten fixtures while retaining the existing 29:
regex literals containing escaped protocol slashes, character classes, and
comment-like sequences; division followed by a real line comment; CSS
declarations assigned through `.style.cssText` and
`setAttribute("style", ...)`; multiline production-shaped templates; dynamic
template interpolations; and escaped CSS `url()` closing parentheses. All ten
new fixtures initially failed while the existing 29 remained green.

GREEN adds regex-aware TSX comment masking, position-preserving discovery of
CSS-bearing quoted strings and templates, interpolation masking that keeps
source offsets intact, and escape-aware CSS function balancing. Diagnostics
from embedded CSS map back to the original TSX line, property, value, and
context. Color-like text inside regex literals, template expressions, and
escaped `url()` content is ignored, while a real literal after the actual URL
close is still reported.

Final verification:

```text
focused structural-color guard: 1 file / 39 tests passed
production-related focused suite: 2 files / 9 tests passed
full suite: 246 files / 1,862 tests passed
full structural-color inventory: passed
explicit-base structural-color guard: passed
relaxed production build: passed (2,106 modules)
CI and release workflow YAML parse: passed
git diff --check: passed
```

## Guard statement-context and interpolation repair — 2026-07-30

The final re-review identified two remaining lexical contexts. RED added five
tests and failed in exactly three places while 41 cases stayed green: a regex
expression following a nested control-condition closing parenthesis, literal
named-color branches inside a multiline `.cssText` interpolation, and nested
hex/modern-color branches inside a `setAttribute("style", ...)` interpolation.
The new division and identifier/prose exclusions were already green.

GREEN tracks the parenthesis stack while masking TSX comments and regexes, marks
closers introduced by `if`, `while`, `for`, `with`, `switch`, and `catch`, and
permits a regex expression after only those statement-condition closers.
Ordinary call results followed by division retain division semantics.

CSS-bearing templates retain their position-preserving declaration mask, but
their interpolation expressions are now analyzed separately. Exact color
strings in nested expression branches are reported against the containing CSS
property at their original source lines. Quoted hex, named, and modern
functional values are covered; variable identifiers and longer escaped prose
strings are not treated as CSS color values.

Final verification:

```text
focused structural-color guard: 1 file / 44 tests passed
production-related focused suite: 2 files / 46 tests passed
full suite: 246 files / 1,867 tests passed
full structural-color inventory: passed
explicit-base structural-color guard: passed
relaxed production build: passed (2,106 modules)
CI and release workflow YAML parse: passed
git diff --check: passed
```

## Guard control-keyword member boundary repair — 2026-07-30

The final parser review found that a member call whose property name matched a
control keyword, such as `obj.if(x)` or `obj?.while(x)`, marked its closing
parenthesis as a statement-condition closer. A following division slash was
then treated as a regex opener and could mask a structural color later in the
division expression.

RED reproduced exactly two failures for direct and optional member calls while
50 existing and control-statement characterizations stayed green. The
characterization covers genuine `if`, `while`, `for`, `with`, `switch`, and
`catch` statements.

GREEN requires a recognized control keyword to have a non-member lexical
boundary before recording its condition parenthesis. A preceding property
access dot, including the dot in optional chaining, now keeps the closing
parenthesis in ordinary-call/division context. No broader regex or declaration
scanning behavior changed.

Final verification:

```text
focused structural-color guard: 1 file / 52 tests passed
full suite: 246 files / 1,875 tests passed
full structural-color inventory: passed
explicit-base structural-color guard (b8cec825...): passed
relaxed production build: passed (2,106 modules)
git diff --check: passed
```

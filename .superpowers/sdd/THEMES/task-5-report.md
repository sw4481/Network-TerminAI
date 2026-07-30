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

# Mistakes

## 2026-09-06: SDD scratch cleanup rejected by command guard

- Issue: The exact final SDD workspace cleanup command was rejected before execution because the environment blocks `rm -rf`-style commands.
- Root cause analysis: The finishing workflow prescribed recursive deletion of the git-ignored SDD scratch directory, but the command guard rejects that command form even for the narrow validated target.
- How addressed: No files were deleted; I left the plan ledger and review artifacts intact and will not bypass the guard with a destructive alternative.

## 2026-09-06: Shared-pane platform fix initially missed marker ownership

- Issue: The first final-fix audit propagated Cisco mode to every pane but did
  not distinguish an omitted non-focused diagnostic payload from an owned empty
  result, allowing the non-focused pane to replace shared-model markers.
- Root cause analysis: The split-tree test asserted prop routing only, while
  `MonacoEditor` defaulted `undefined` diagnostics to an empty array before its
  marker effect, erasing the ownership signal at the consumer boundary.
- How addressed: Add a failing shared-model regression at the Monaco boundary,
  retain `undefined` as the non-owner signal, and keep explicit empty arrays as
  valid focused-owner results that clear stale diagnostics.

## 2026-09-06: TerminAI window probe enumerated processes too broadly

- Issue: A follow-up AppleScript probe failed with error `-1728` and printed
  an irrelevant list of foreground process names instead of the TerminAI
  window count.
- Root cause analysis: The query combined a two-property aggregate with a
  filtered process collection in an AppleScript form that did not preserve the
  intended process scope.
- How addressed: Stop collection enumeration and use only direct
  `application process "TerminAI"` window properties for bounded footer
  verification.

## 2026-09-06: Footer accessibility query used an invalid nested selector

- Issue: The first read-only System Events query for the Sidecar footer text
  failed with AppleScript error `-1700` and returned no UI content.
- Root cause analysis: AppleScript cannot apply the `whose value starts with`
  filter directly to the `entire contents` element collection in that form.
- How addressed: Avoid broad accessibility output and use the prior bounded
  visual method, capturing only the bottom 40 pixels of the TerminAI window.

## 2026-09-06: Initial mode-off marker condition conflated buffer switches

- Issue: The first marker fix would clear an old shared Cisco model when one
  pane switched to a different non-Cisco buffer.
- Root cause analysis: The clear condition treated every null current profile
  as the old buffer switching Off, even when `modelChanged` showed that the
  pane had moved to a different buffer whose profile was independently Off.
- How addressed: Add a focused shared-model regression, clear unconditionally
  only for same-buffer profile disable, and drop the stale marker association
  when a pane changes to a non-Cisco model.

## 2026-09-06: Split-pane regression widened a Cisco diagnostic source literal

- Issue: The first strict TypeScript check after adding final-review regressions
  reported two new errors in `EditorSplitTree.test.tsx` because the diagnostic
  fixture's `source` was inferred as `string`.
- Root cause analysis: The array had no explicit `CiscoDiagnostic` context, so
  TypeScript widened the otherwise valid `"cisco-structural"` literal before it
  reached the component prop.
- How addressed: Keep the regression fixture narrow by preserving the source as
  a string literal, then rerun strict TypeScript diagnostics and focused tests.

## 2026-09-06: Shared-model cleanup used the wrong post-release threshold

- Issue: The strengthened two-pane switch regression still cleared the shared
  model after one pane switched away.
- Root cause analysis: Model-switch cleanup runs after the switching pane's
  lease is released, so `referenceCount === 1` identifies the remaining pane;
  the earlier shared threshold `<= 1` was only valid for disposal/mode-off
  cleanup before the current lease is released.
- How addressed: Model-switch cleanup now clears only at count zero, while
  disposal and mode-off retain the pre-release `<= 1` threshold.

## 2026-09-06: Initial consumer-aware cleanup dropped disposal tracking on mode-off

- Issue: The first consumer-aware cleanup attempt cleared the marker-model ref
  immediately after Cisco mode was disabled, so the disposal assertion could not
  verify the required final cleanup path.
- Root cause analysis: Mode disable was treated as terminal marker lifecycle
  state instead of retaining the last marker model for idempotent disposal
  cleanup, while still gating every clear by model-consumer count.
- How addressed: Retained the last Cisco marker model/buffer ref through mode
  disable; subsequent mode/model/disposal clears remain guarded by the registry
  reference count.

## 2026-09-06: Monaco model-switch test double omitted the switch side effect

- Issue: The first green Task 5 lifecycle run failed because the test expected
  Cisco markers on the newly selected model, but the fake editor still returned
  the original model after `MonacoPaneModelController.switchTo` was called.
- Root cause analysis: The existing pane-controller fake recorded model switches
  without mirroring the real controller's `editor.setModel(model)` side effect.
- How addressed: Made the focused test double track the active model when
  `switchTo` runs, reset that state between tests, and reran the focused suite.

## 2026-09-06: Fix report retained a pending-commit placeholder

- Issue: After creating the Task 4 fix commit, the appended report section still stated that the commit was pending.
- Root cause analysis: The report was written before the commit hash was available, and the post-commit bookkeeping line was not updated before final inspection.
- How addressed: Replaced the placeholder with the verified `ce563ee` commit and checked the report tail again.

## 2026-09-06: Fake-timer hook tests waited with real-time polling

- Issue: The first green run of the new `useCiscoLint` tests timed out in three `waitFor` calls even though the debounce timer and classifier promises had been advanced inside `act`.
- Root cause analysis: The tests enabled Vitest fake timers, then used Testing Library's polling helper after the state-changing work had already been flushed. The polling helper could not advance on the held fake clock and waited until each test timeout.
- How addressed: Replace the redundant polling assertions with direct state assertions after `advanceTimersByTimeAsync` and `act`, then rerun the focused tests.

## 2026-09-06: Task 3 review package omitted the plan filename suffix

- Issue: The first Task 3 review-package command failed because I passed the plan stem without its `.md` suffix.
- Root cause analysis: I copied the directory-style path from the surrounding command instead of the exact plan file path required by the helper.
- How addressed: The command changed nothing; I will pass the exact `docs/superpowers/plans/2026-09-06-cisco-offline-linting.md` path.

## 2026-09-06: Task 2 fix review package used an unverified full hash

- Issue: The first scoped review-package command failed because I supplied a fabricated full revision for the Task 2 fix head instead of resolving the short hash returned by the worker.
- Root cause analysis: I expanded the worker's short commit hash manually without verifying it against the repository.
- How addressed: The command changed nothing; I resolved the actual hash with `git rev-parse` and will use that pattern for later review packages.

## 2026-09-06: Repeated unquoted optional glob in package-config probe

- Issue: A read-only search for Vitest configuration stopped with zsh's
  `no matches found: vitest.config.*` error.
- Root cause analysis: I repeated the repository's documented unmatched-glob
  mistake by passing an optional filename glob unquoted to zsh.
- How addressed: No source files changed; I will use `rg --files` or explicit
  quoted paths for optional configuration files and keep this log change out
  of the Task 2 commit.

## 2026-09-06: Multi-hunk plan correction context mismatch

- Issue: A corrective patch for the implementation plan was rejected before
  applying because one combined hunk did not match the document context.
- Root cause analysis: I combined unrelated plan corrections and assumed the
  surrounding file-map lines would match the hunk order exactly.
- How addressed: No plan content changed; I will apply each correction as an
  independently verified patch with narrower context.

## 2026-09-06: Implementation-plan wrapper retained unescaped code ticks

- Issue: The first implementation-plan patch failed before applying with a
  JavaScript syntax error near an exported TypeScript signature.
- Root cause analysis: The safe raw-template payload still contained Markdown
  backticks around code signatures, which terminated the JavaScript template.
- How addressed: No plan file was created; I will use indented code/signature
  blocks without backticks and split the plan into smaller patches.

## 2026-09-05: Large Markdown patch wrapper parse failure

- Issue: The first attempt to add the Cisco linting design was rejected before
  applying because the JavaScript tool wrapper could not parse the payload.
- Root cause analysis: The large array of JavaScript string literals contained
  an unescaped Markdown quote/backslash combination, so the wrapper failed
  before `apply_patch` received any patch.
- How addressed: No spec file was created; I will split the design into
  smaller patches and use a payload form that avoids embedded string syntax.

## 2026-09-05: Unquoted optional glob expanded under zsh

- Issue: A read-only inspection command failed before execution because the
  shell expanded `src/components/TabCreate*` and found no matching path.
- Root cause analysis: The optional glob was unquoted in zsh, which treats an
  unmatched glob as an error instead of passing it to the search tool.
- How addressed: No repository files were changed; I reran the inspection with
  explicit paths and quoted patterns, and will avoid unmatched shell globs.

## 2026-09-05: PTY probe included an unnecessary temporary-file deletion

- Issue: A read-only shell probe was rejected before execution because it
  included an explicit `rm -f` cleanup command.
- Root cause analysis: I added cleanup for a temporary capture file even
  though the probe did not require destructive cleanup and the command policy
  rejects that form.
- How addressed: The probe was not run; I will rerun it without deletion and
  avoid destructive cleanup for diagnostic artifacts.

## 2026-09-05: Broad Rust format check was chained with diff inspection

- Issue: I combined diff inspection and a repository-wide `cargo fmt --check`
  with a shell separator, producing a very large report of unrelated existing
  formatting drift.
- Root cause analysis: I used the workspace formatter gate when only the edited
  Rust file required a formatting check, and bundled independent commands into
  one shell invocation.
- How addressed: The command was read-only and changed no files; I switched to
  separate commands and a file-scoped `rustfmt --check` for the authorized Rust
  file.

## 2026-09-05: Rust red-test wrapper omitted the running session identifier

- Issue: The first bounded-preview red-test invocation was still compiling when
  the wrapper returned, but the formatted tool output omitted its session ID.
- Root cause analysis: I selected only `exit_code` and `output` from the command
  result instead of preserving `session_id` whenever the process had not exited.
- How addressed: Checked for the active Cargo process and reran the exact focused
  regression to capture a definitive exit code and failure output; future
  long-running command wrappers retain the complete result object.

## 2026-09-05: CSS token search used invalid ripgrep option ordering

- Issue: A read-only search for existing CSS error tokens passed `--glob` after
  the search paths, so ripgrep treated the option and pattern as file paths and
  emitted `No such file or directory` errors.
- Root cause analysis: I composed the command without keeping ripgrep options
  before positional path arguments.
- How addressed: Re-ran the search with a simpler valid command, verified the
  repository token is `--status-danger`, and corrected the new WorkspaceFind
  stylesheet to use that existing token.

## 2026-09-05: Task 6 reproduction wrapper used zsh's read-only status variable

- Issue: The first reproduction wrapper stopped before running TypeScript or
  the build because it assigned to `status`.
- Root cause analysis: zsh reserves `status` as a read-only shell variable.
- How addressed: Re-ran the wrapper using the task-specific variable
  `task6_rc`.

## 2026-09-05: Initial skill path lookup was incorrect

- Issue: The first attempt to read the required skills used incorrect filesystem paths and returned `No such file or directory`.
- Root cause analysis: The available-skill aliases pointed into versioned plugin cache directories, but I initially treated them as direct unversioned paths.
- How addressed: Located the installed skill files with `find`/`rg --files`, then read the correct versioned paths before continuing.

## 2026-09-04: Initial plan artifact patch failed

- Issue: The first attempt to create the two Markdown artifacts failed before
  writing because the JavaScript tool wrapper interpreted Markdown backticks
  inside a template literal.
- Root cause analysis: The patch payload was passed through a JavaScript
  template literal containing unescaped backticks, so the payload ended early
  and the wrapper evaluated later Markdown as JavaScript.
- How addressed: Split the artifact creation into smaller apply_patch calls,
  used safer payload construction, verified both files afterward, and scanned
  them for leftover escape characters and placeholders.

## 2026-09-05: SDD workspace script invoked with Python

- Issue: The shell-based SDD workspace helper was first invoked with
  `python3`, producing a syntax error instead of resolving the workspace.
- Root cause analysis: The helper has no Python entry point; its source begins
  with shell syntax and must be run by a shell interpreter.
- How addressed: Re-run the helper with `bash` and use its reported workspace
  path for the implementation ledger.

## 2026-09-05: Reviewer dispatch payload interpolation failed

- Issue: The first Task 1 reviewer dispatch failed with a JavaScript syntax
  error before the reviewer was created.
- Root cause analysis: The dispatch message used a JavaScript template literal
  containing unescaped Markdown backticks from the review instructions.
- How addressed: Record the failed pre-dispatch attempt and retry using safe
  string construction without embedded template-literal delimiters.

## 2026-09-05: Completed reviewer threads left open

- Issue: Task 3 dispatch initially failed because the subagent thread limit was
  reached.
- Root cause analysis: Completed Task 1 and Task 2 reviewer agents were not
  closed after returning their verdicts, even though completed agents continue
  to count toward the concurrency limit.
- How addressed: Close completed reviewer agents before dispatching the next
  implementation worker, and close each completed reviewer immediately after
  its verdict going forward.

## 2026-09-05: Cisco coordinator mocks widened during production build

- Issue: The new Cisco selection tests passed in Vitest but caused TypeScript
  build errors because mock callback return values were inferred as generic
  strings instead of the coordinator's literal unions.
- Root cause analysis: The async Vitest mock callbacks lacked explicit return
  annotations, so contextual typing did not preserve ClassifyResponse and
  approval-result literal types at those call sites.
- How addressed: Added explicit Promise<ClassifyResponse> and
  Promise<"cancel" | "proceed"> annotations to the affected test callbacks;
  targeted diagnostics were removed while unrelated baseline diagnostics
  remained unchanged.

## 2026-09-05: Combined bookkeeping patch malformed

- Issue: A combined patch for the mistakes log and SDD ledger was rejected
  before applying.
- Root cause analysis: The patch payload was malformed at its final marker,
  so the patch verifier could not parse the second update.
- How addressed: Split the updates into two independently validated patches
  and confirmed each applied successfully.

## 2026-09-05: Launcher suppression did not preserve stale bundle artifact

- Issue: The validation wrapper attempted to suppress `run.sh` cleanup, but
  the script boundary did not preserve the exported shell function and the
  stale `src-tauri/target/debug/python` bundle is no longer present.
- Root cause analysis: `run.sh` invokes its own Bash process and explicitly
  executes `rm -rf` for stale debug/release Python bundles; an exported shell
  function was not a reliable interception mechanism for this validation.
- How addressed: Recorded the discrepancy, verified the live sidecar is using
  `sidecar/.venv`, and will not recreate or commit the generated stale bundle.

## 2026-09-06: Parallel inspection wrapper had a JavaScript syntax error

- Issue: The first parallel read-only inspection wrapper failed before running
  because its result-formatting expression had an unmatched parenthesis.
- Root cause analysis: I composed the wrapper inline without validating the
  closing delimiters around `JSON.stringify`.
- How addressed: Corrected the expression, reran the same read-only inspection,
  and retained complete tool results for subsequent calls.

## 2026-09-06: Referenced test guidance path was resolved incorrectly

- Issue: A read-only attempt to open `writing-good-tests.md` used the skill root
  instead of its referenced relative location and returned `No such file`.
- Root cause analysis: I assumed the referenced file lived beside `SKILL.md`
  without first resolving the installed skill package layout.
- How addressed: Continued with the fully read TDD requirements already
  available and avoided relying on the missing reference for implementation.

## 2026-09-06: Runtime log search scope was too broad

- Issue: A read-only recursive search under the full TerminAI application-data
  directory traversed unrelated archived agent-session logs and produced a
  very large, irrelevant result.
- Root cause analysis: I searched by filename glob from the application-data
  root instead of first resolving the exact live sidecar log and state files.
- How addressed: Stopped using the broad result, switched to exact process and
  top-level runtime-file inspection, and did not use any archived content.

# Offline Cisco Linting for the TerminAI Editor

## Goal

Replace the editor-slice Cisco selection handoff with an editor-native,
offline-only Cisco configuration experience:

1. explicit Cisco IOS-XE and NX-OS editor modes;
2. Cisco-aware syntax highlighting, comments, indentation, and folding;
3. conservative inline diagnostics for malformed or suspicious configuration;
4. existing local guardrail findings surfaced as editor warnings/errors; and
5. a clickable Problems panel that navigates to diagnostic locations.

This design covers validation and presentation only. It does not execute,
preview, approve, audit, or send configuration to a device.

## Current-state facts

These facts were verified from the current checkout and Graphify graph:

- MonacoEditor.tsx owns Monaco creation, model-language changes,
  model-content events, editor registration/disposal, and the existing
  language-provider lifecycle.
- editorStore.ts owns editor buffers and already carries buffer metadata
  through the attached and detached editor synchronization path.
- EditorTab.tsx owns the editor toolbar, focused pane, editor references,
  and clickable location routing.
- DetachedEditorWindow.tsx reuses EditorPane and the same MonacoEditor path,
  so a buffer-level profile can behave consistently in both windows.
- src/components/editor/lsp/hclLanguage.ts is the existing pattern for an
  idempotent custom Monaco language registration.
- src/features/troubleshoot/playbook-validate.ts is an existing pure
  TypeScript validator with line-aware diagnostics and focused unit tests.
- IacProblemsPanel.tsx already demonstrates the desired collapsed summary,
  severity rows, and jump-to-line interaction.
- guardrail_classify is a local Tauri command backed by the in-process
  ruleset. classifyCommand exposes it to the frontend; it does not itself
  write an audit row.
- The current checkout already contains the earlier SendSelectionToCisco
  implementation and its coordinator. This design supersedes that editor
  feature; source removal is an implementation task, not part of this
  design-only change.
- monaco-editor is pinned to 0.52.2. No Cisco language server or Cisco
  parser is currently present.

Graphify is used for the seam map only. It is not runtime proof of linter
correctness or device compatibility.

## Scope and non-goals

### In scope

- IOS-XE and NX-OS modes selected explicitly for the active editor buffer.
- Monaco syntax configuration shared by attached and detached editors.
- Debounced, deterministic, local diagnostics for the current buffer.
- Local guardrail classification of non-empty configuration lines.
- Monaco markers and a Problems panel with line/column navigation.
- Honest unavailable/error states when local guardrail classification fails.
- Tests for the pure validator, language registration, marker lifecycle,
  mode selection, stale-result protection, and Problems navigation.

### Out of scope

- SendSelectionToCisco, selected-text handoff, PTY writes, terminal target
  selection, approval dialogs, or audit records.
- SSH creation, terminal lifecycle, workflow execution, NETCONF, PyATS,
  device command execution, configuration deployment, or live validation.
- Sidecar, model, network, or credential dependencies.
- A complete Cisco grammar, command-reference database, schema validator,
  formatter, auto-remediation, or save blocking.
- Guessing a device platform from file contents or a filename.
- Treating an unknown Cisco command as invalid. The first linter must be
  conservative because IOS-XE/NX-OS feature sets and releases vary.

## User experience

Add a compact Cisco mode selector to the existing editor toolbar:

- Off — preserve the current file language and existing LSP behavior.
- IOS-XE — activate Cisco IOS-XE syntax and offline validation.
- NX-OS — activate Cisco NX-OS syntax and offline validation.

The selection is stored on the active buffer in memory and carried through
the existing detached-buffer snapshot. It is not persisted to the editor
database in this first version; reopening a file returns to Off unless
the operator selects a profile again. This prevents a stale platform choice
from silently applying to a different file or device family.

When Cisco mode is active:

- the status area identifies the selected profile and validation state;
- syntax highlighting, folding, indentation, and ! line comments use the
  Cisco language configuration;
- diagnostics update after a short quiet period rather than on every keystroke;
- errors and warnings appear as Monaco gutter/overview markers;
- the Problems panel shows counts, source, severity, message, and location;
- clicking a problem reveals the line, positions the cursor, and focuses
  the editor; and
- no diagnostic action writes to a file, terminal, audit log, or device.

The panel must not say No issues found if structural validation succeeded
but guardrail classification was unavailable. It should show the unavailable
reason alongside any structural findings.

## Architecture

### 1. Buffer profile

Add a nullable buffer field:

    cisco_platform: null | "iosxe" | "nxos"

Default it to null in createEditorBuffer, include it in the local buffer
snapshot/update contract, and add the smallest focused setter or patch path
needed by the toolbar. Keep it out of persisted layout/database serialization.

The profile is independent of the existing detected file language. Cisco
configuration is frequently stored as .cfg, .txt, or extensionless text,
so file extension detection cannot be the authority. When the profile is
non-null, Monaco receives the corresponding Cisco language id and the Cisco
validator runs. When it is null, existing language/LSP behavior remains.

### 2. Cisco language registration

Add an idempotent registration module alongside hclLanguage.ts with two
language ids, for example cisco-iosxe and cisco-nxos. The tokenization rules
may share implementation, but the ids remain distinct so platform-specific
rules and future providers have an explicit boundary.

The initial Monarch/configuration surface should cover only high-confidence
editor behavior:

- ! line comments;
- quoted strings, variables, numbers, IPv4/IPv6-looking literals,
  interface names, command verbs, and mode keywords;
- brackets/quotes and comment auto-closing behavior where appropriate;
- indentation-based folding for configuration blocks;
- indentation rules that preserve the operator's existing style; and
- no claim that token colors prove command validity.

Do not register a Cisco LSP. Cisco mode disables the current generic LSP
session for that buffer until a verified Cisco language server exists.

### 3. Pure offline structural validator

Create a Monaco-independent module, preferably src/lib/ciscoLint.ts, with
a contract shaped like:

- CiscoPlatform = "iosxe" | "nxos";
- CiscoDiagnostic = { line, column, endColumn, severity, message, source, code };
- CiscoLintResult = { diagnostics, structuralStatus }; and
- lintCiscoConfig(text, platform): CiscoLintResult.

The validator must be synchronous, deterministic, side-effect free, and
usable in Vitest without Tauri, React, Monaco, a network, or a device.
Diagnostics use one-based locations and stable rule codes so the Problems
panel and tests do not depend on message text alone.

The first rules are deliberately narrow:

- flag likely CLI prompts or captured command output embedded in a config;
- flag control characters and malformed line-level constructs that the
  validator can identify without a release-specific command database;
- track recognized configuration contexts such as interface, router, line,
  vlan, vrf, policy-map, and NX-OS feature contexts;
- warn when a recognized child command appears outside its required context;
- warn on context exits that cannot match the tracked context;
- identify clear IOS-XE/NX-OS mode mismatches only where the rule is
  high-confidence; and
- emit advisory warnings for suspicious but not provably invalid patterns.

Unknown commands, indentation differences, and uncommon release-specific
features must not become errors. Cisco indentation is presentation rather
than the complete semantic grammar, so indentation is used for folding and
targeted suspicion checks, not as a universal validity test. A missing final
end is not an error because saved configurations and command snippets have
different valid forms.

### 4. Local guardrail findings

Add a debounced useCiscoLint orchestration hook or equivalent controller
that combines structural results with local guardrail classification:

1. run lintCiscoConfig immediately for the current content/profile;
2. after the debounce, classify each non-empty line through the existing
   classifyCommand("cisco", platform, line) path;
3. discard stale asynchronous results when the buffer/profile changes;
4. map non-T0/Ambiguous results into CiscoDiagnostic entries anchored to
   the source line; and
5. expose structural and guardrail status separately to the UI.

Guardrail findings are editor diagnostics, not execution decisions:

- do not call recordDecision;
- do not enqueue PendingDecision entries;
- do not call ptyWrite;
- do not require a connected terminal; and
- do not block save solely because a finding exists.

Use errors for structural conditions that are locally malformed. Use
warnings for ordinary T1/T2 risk findings and a clearly labeled error-level
marker for T3/high-impact findings if the existing tier semantics require
operator attention. Ambiguous results remain visibly distinct in the source
or message. These severity mappings are presentation semantics, not a new
guardrail policy.

If classification fails, retain structural diagnostics and show
Guardrails unavailable: <reason> in the Problems/status surface. An empty
structural list plus a failed guardrail run is not a clean result.

### 5. Monaco markers and Problems panel

Add an optional diagnostics input to the existing MonacoEditor path or a
small adjacent marker controller. It owns a dedicated marker owner such as
cisco-lint, replaces only that owner's markers, and clears them when Cisco
mode is disabled, the model changes, or the component is disposed. Existing
LSP/power-editing/bookmark markers and decorations must remain independent.

Extract the generic behavior from IacProblemsPanel into a reusable
ProblemsPanel contract, preserving the IaC panel's current behavior and
tests. The generic panel receives diagnostics, status entries, and an
onJumpTo(line, column) callback. EditorTab supplies the callback using
the focused editor reference and existing pane routing. The panel must be
keyboard accessible; rows should be buttons or otherwise provide an
equivalent keyboard activation path.

For detached editors, the same buffer profile and Monaco marker lifecycle
apply in the detached webview. The source-window Problems panel remains the
authoritative navigation surface for the attached focused pane; the detached
window may show the inline markers/status but does not invent a second
cross-window diagnostic store.

## Removal of the previous editor handoff

The implementation plan following this spec must remove the Cisco handoff
from the editor slice:

- remove the Cisco/Send Selection to Cisco toolbar entry point and panel;
- remove SendSelectionToCisco.tsx, its stylesheet, and its UI tests;
- remove ciscoSelectionBridge.ts and its tests if no other consumer exists;
- leave terminalConnectionStore, terminalRegistry, guardrails, workflow
  execution, and ptyWrite unchanged; and
- do not reinterpret removal as deleting or weakening terminal safety paths.

The earlier search/macros/selection plan remains historical evidence of what
was implemented on the branch. This spec is the replacement plan for the
Cisco portion; workspace search and runtime-local macros are not redesigned.

## Future device-aware extension

Device-aware validation is a separate feature. The offline result contract
should reserve source/code fields and keep the orchestrator independent
of transport. A future provider may add live capabilities only behind an
explicit operator action and a separate status such as device validation,
with its own connection, timeout, authorization, and safety design. No live
validation behavior is implied by this first slice.

## Testing and acceptance

Focused tests must prove:

- IOS-XE and NX-OS language registration is idempotent and configures !
  comments/folding behavior;
- structural rules produce stable one-based locations and do not flag unknown
  commands as invalid;
- platform-specific high-confidence rules distinguish the two modes;
- guardrail findings are merged without audit, approval, or PTY calls;
- a failed guardrail classification leaves structural results intact and
  reports an unavailable status;
- stale debounce results cannot overwrite a newer buffer/profile result;
- Monaco markers replace and clear only the Cisco marker owner;
- Problems rows are clickable and keyboard activatable at exact locations;
- switching to Off removes Cisco markers and restores the prior language/LSP
  path; and
- the editor no longer renders or imports the Cisco handoff surface.

The implementation acceptance gate is the focused suite, existing frontend
suite, TypeScript/build checks, Rust tests for unchanged editor/guardrail
boundaries, and git diff --check. Because the editor app lifecycle is
affected, final validation must also launch through ./run.sh and verify
the TerminAI sidecar release invariant from AGENTS.md.

## Decision

Proceed with this offline-only Cisco linting slice after review. No source
implementation, device validation, or terminal handoff is authorized by this
design document alone; implementation starts only from its reviewed plan.

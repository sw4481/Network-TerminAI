# IaC Studio — Phase C: In-editor AI Guidance — Design

**Date:** 2026-06-16
**Status:** Design — pending review
**Author:** brainstormed with operator (sw4481)
**Parent spec:** `docs/superpowers/specs/2026-06-15-iac-studio-design.md`
**Predecessor:** Phase A (editor+workspace, merged `8f27800`), Phase B (linting, merged `84c6d62`)

## Context

IaC Studio is a full-screen mini-IDE (tab opened via ⌘⇧E) for authoring
Terraform/Ansible inside CCIE Terminal. Phase A shipped the editor + workspace;
Phase B shipped live linting/diagnostics. **Phase C adds in-editor AI guidance:**
deterministic, reviewable code generation scoped to the active file, with a
diff-preview accept/reject gate, reusing the existing codegen backend and apply
approval flow.

### What already exists (reuse — do NOT rebuild)

| Asset | Path | Used for |
|-------|------|----------|
| `IacStudioTab` | `src/components/iac/IacStudioTab.tsx` | Host tab: FileExplorer + MonacoEditor + IacProblemsPanel. Phase C mounts the AI panel as the right pane. |
| `iacStudioStore` | `src/state/iacStudioStore.ts` | Per-tab state (root_path, file_path, content, language, is_dirty, diagnostics, linters). Phase C adds a transient `ai` slice. |
| `MonacoEditor` + `dispatchAskAi` | `src/components/editor/MonacoEditor.tsx`, `src/components/editor/askAi.ts` | ⌘L Ask-AI (Explain/Fix/Refactor/Ask) stays as-is for free-form chat. Phase C reuses `dispatchAskAi` for the panel's "Explain" action. |
| `generate_terraform_code` / `generate_ansible_playbook` | `sidecar/src/ccie_sidecar/agents/iac_codegen.py` | NL → HCL/YAML. Never raises; returns `{tool, code, filename, explanation, estimated_apply_time_seconds, validation, unavailable}`. Model resolved via `get_saved_config()` + `build_chat_model()` = **Settings-page LLM**. |
| `iac_apply` + `IaCApprovalModal` | `sidecar/.../agents/iac_tools.py`, `src/components/IaCApprovalModal.tsx` | The ONLY mutating path. Phase C never bypasses it. |
| Phase B RPC pattern | `server.py` `iac.lint_file`, `src-tauri/.../commands/iac.rs` `iac_lint_file`, `tauri.ts` `iacLintFile` | Exact template for the new codegen RPC. |
| Monaco `DiffEditor` | bundled with `@monaco-editor/react` | Diff-preview rendering (no new dependency). |

### What does NOT exist yet

- No `iac.generate_*` RPC endpoint — codegen lives only as LangChain
  StructuredTools the ReACT agent calls. Phase C adds direct RPC endpoints.
- No code-diff React component (`StructuredDiff` is for show-command snapshots,
  not code). Phase C uses Monaco's built-in `DiffEditor`.
- No AI side panel inside the Studio.

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| AI surface | **Dedicated Studio panel** (right pane of `IacStudioTab`) | Deterministic generate→diff→accept flow; chat-stream doesn't cleanly produce an accept/reject buffer diff. Matches parent-spec mockup. |
| LLM config | **Settings-page LLM** in both panel + ⌘L paths | User constraint. Verified: codegen resolves via `get_saved_config()`. |
| Codegen invocation | **New direct RPC** (`iac.generate_terraform_code` / `iac.generate_ansible_playbook`) | Deterministic, easy to drive a diff preview; mirrors Phase B's `iac.lint_file`. |
| Diff preview | **Monaco `DiffEditor`** in an overlay | Native, syntax-highlighted, zero new deps. |
| Apply safety | All mutation routes through existing `iac_apply` → `IaCApprovalModal` | No new bypass. Accepting a diff only edits the buffer. |

Out of scope: streaming generation, multi-file generation in one action, AI
auto-apply, wizards (Phase D), git auto-commit.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ IaC Studio   [workspace ▾] [Browse…]              [Save ●]    │
├──────────────┬─────────────────────────────┬─────────────────┤
│ FileExplorer │     MonacoEditor            │  IacAiPanel     │
│              │                             │  ┌───────────┐  │
│              │                             │  │ prompt box│  │
│              │                             │  └───────────┘  │
│              │                             │  [Generate]     │
│              │                             │  [Scaffold]     │
│              │                             │  [Explain]      │
├──────────────┴─────────────────────────────┴─────────────────┤
│ IacProblemsPanel (lint diagnostics)                           │
└──────────────────────────────────────────────────────────────┘
   Generate/Scaffold → RPC → proposal → IacDiffPreview overlay:
┌──────────────────────────────────────────────────────────────┐
│ AI Diff Preview (Monaco DiffEditor)       [Reject] [Accept]   │
│ current buffer   ║   proposed code                            │
└──────────────────────────────────────────────────────────────┘
```

### Data flow (Generate / Scaffold)

1. User types intent in `IacAiPanel`, clicks **Generate**.
2. Panel picks tool from active file language (`.tf`/`.hcl`→terraform,
   `.yml`/`.yaml`→ansible), calls `iacGenerateTerraform/Ansible(intent,
   workingDir, gitBranch?, existingCode?)`.
3. `tauri.ts` `invoke` → Rust `iac_generate_*` (AgentBridge passthrough) →
   sidecar RPC `iac.generate_*` → `generate_*_code(intent, context)`.
4. Result dict returned verbatim. If `unavailable: true`, panel shows an explicit
   "Generation unavailable — <reason>" message and does NOT open the diff.
5. Otherwise store `ai.proposal = {code, filename, explanation, validation}`;
   `IacDiffPreview` overlay mounts (original = current buffer, modified = code).
6. **Accept** → `setContent(tabId, proposal.code)` (marks dirty); overlay closes;
   user ⌘S to persist. **Reject** → `clearAiProposal`; overlay closes; buffer
   untouched.

### Data flow (Explain)
Panel "Explain" reuses `dispatchAskAi({tabId, action:'explain', selection,
language, filePath})` — fires the existing `ccie:prefill-agent-input` event to
the global AgentPanel. No new path; no diff.

## Components

### New
- **`sidecar/.../server.py`** — two branches in `handle_request()`:
  `iac.generate_terraform_code`, `iac.generate_ansible_playbook`. Params
  `{intent, working_dir, git_branch?, existing_code?}`. Build `context` dict
  (`project_path=working_dir`, `git_branch`, `existing_resources=existing_code`),
  call the codegen fn, return the dict. Never raises (codegen never raises).
- **`src-tauri/src/commands/iac.rs`** — `iac_generate_terraform`,
  `iac_generate_ansible`: AgentBridge passthroughs mirroring `iac_lint_file`.
  Registered in `lib.rs` `invoke_handler`.
- **`src/lib/tauri.ts`** — `CodegenResult` type + `iacGenerateTerraform(...)` /
  `iacGenerateAnsible(...)` (`invoke<CodegenResult>`).
- **`src/components/iac/IacAiPanel.tsx`** — prompt textarea + buttons (Generate
  into file, Scaffold resource, Explain selection); language auto-detect;
  loading/unavailable/error states.
- **`src/components/iac/IacDiffPreview.tsx`** — Monaco `DiffEditor` overlay;
  Accept/Reject; empty-buffer (new file) → original `""`; shows a "syntax not
  validated (<reason>)" note when `validation.skipped`.

### Extended
- **`src/state/iacStudioStore.ts`** — transient per-tab `ai` slice:
  `{ generating: boolean, proposal: {code, filename, explanation, validation} | null, error: string | null }`
  + setters `setAiGenerating`, `setAiProposal`, `clearAiProposal`. No persistence.
- **`src/components/iac/IacStudioTab.tsx`** — mount `IacAiPanel` (right pane);
  render `IacDiffPreview` overlay when `ai.proposal` is set.

## Error handling & honesty (mirrors Phase B)

- `unavailable: true` → explicit panel message; never an empty/fake diff.
- `validation.skipped` (terraform/ansible off PATH) → diff shows "syntax not
  validated (<reason>)"; never claims validity.
- **Accept ≠ apply** — accepting only edits the buffer. Mutation still goes
  through `iac_apply` → `IaCApprovalModal`. Panel has no gate-bypassing apply.
- RPC/transport failure → caught, surfaced as `ai.error` string in the panel.

## Testing (TDD)

- **pytest (sidecar):** new RPC branches — happy path returns dict; injected
  failing-LLM returns `unavailable: true`; param validation. Reuse codegen's
  injectable-LLM seam (no network).
- **vitest (frontend):** `IacAiPanel` (language detect, button→RPC dispatch,
  unavailable/loading/error states); `IacDiffPreview` (accept writes buffer +
  marks dirty; reject discards; empty-buffer case); store `ai` slice setters.
- **Rust:** command registration / passthrough (mirror `iac_lint_file`).
- **E2E (manual):** ⌘⇧E → intent → Generate → diff appears → Accept → buffer
  updates → ⌘S → file on disk changed. RPC verified against the real terraform
  binary before any "done" claim. Live GUI eyeballed before merge
  (per `verify_before_claiming_done`).

## Risks & mitigations

- **Apply bypass (security crux):** the only mutation path stays `iac_apply` +
  `IaCApprovalModal`; the AI panel writes to the buffer only. Verified no apply
  affordance is added to the panel.
- **LLM latency/down:** RPC is non-streaming; show a clear loading state; honest
  `unavailable` on failure (codegen never raises).
- **Wrong language detection:** drive tool choice off the active file's
  extension/language; if unknown, disable Generate/Scaffold with a hint.
- **Scope creep:** no streaming, no multi-file, no wizards (Phase D), no
  auto-apply.

## No DB migration

Phase C adds no persistence; the `ai` slice is transient. (Next free migration
remains V0051, untouched.)

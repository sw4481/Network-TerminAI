# IaC Studio Phase D — Guided Wizards — Design

**Date:** 2026-06-17
**Status:** Design — approved by operator (sw4481)
**Author:** brainstormed with operator
**Parent design:** `docs/superpowers/specs/2026-06-15-iac-studio-design.md` (Phase D)

## Context

IaC Studio Phases A (editor + workspace, ⌘⇧E), B (linting), and C (in-editor AI
guidance) are merged to `origin/main`. Phase C shipped the `IacAiPanel`
(free-form NL → HCL/playbook via the Settings-page LLM) and the `IacDiffPreview`
overlay (accept/reject a generated diff against the active buffer), plus the
`iacGenerateTerraform` / `iacGenerateAnsible` codegen RPCs and the
workspace-scoped `iacStudioWriteFile` command.

Phase C deliberately **dropped** its thin "Scaffold resource" button so that
guided scaffolding lives here, in Phase D, as a single real experience.

**Goal (Phase D):** two modal **wizards** that turn structured inputs into an
NL intent, run that intent through the **existing Phase C codegen RPC**, preview
the result via the **existing `IacDiffPreview`** overlay, and on Accept write a
**new file** into the workspace via the **existing** `iacStudioWriteFile`
command. No new generation backend, no new Rust file logic, no DB migration.

1. **Resource-scaffolding wizard** — provider/resource → guided fields → a
   `.tf`/playbook written into the workspace.
2. **CI/CD pipeline wizard** — generates **GitHub Actions**
   (`.github/workflows/terraform.yml`) and/or **GitLab CI** (`.gitlab-ci.yml`)
   for plan-on-PR / apply-on-merge.

## Decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Launch surface | Native **IaC menu** items `New Resource…` / `New Pipeline…` (no shortcuts) — follows the existing GUI-wiring rule (lib.rs → App.tsx) |
| Resource wizard fields | **Light structured form**: Provider dropdown, Resource type (free text), Name, Details textarea → composed NL intent. No provider-schema introspection. |
| CI/CD wizard fields | **Platform + trigger + tool + env**: Platform checkboxes (GitHub Actions / GitLab CI), Tool radio (Terraform/Ansible), Flow dropdown (plan-on-PR + apply-on-merge default), optional Auth/env free-text. Workspace layout auto-detected to preselect Tool. |
| Write behavior | **New file via diff-preview** → `iacStudioWriteFile` (path-scoped to workspace root). Not into the active buffer. |
| Generation backend | **Reuse** `iacGenerateTerraform` / `iacGenerateAnsible` (Phase C). No new RPC. |
| Diff surface | **Reuse** `IacDiffPreview` against `original=""` (new file). |

Out of scope (consistent with the master design): tflint / checkov / tfsec,
Jenkins / Azure pipelines, `terraform providers schema -json` introspection,
remote state backends, git auto-commit, multi-file resource modules.

## Architecture

All new code is **frontend + menu wiring**. The generation, validation, and
file-write backends already exist and are reused unchanged.

### 1. Menu wiring (`src-tauri/src/lib.rs` + `src/App.tsx`)

- Add two `MenuItem`s to the existing IaC `Submenu` (alongside
  `iac_studio_open` and `iac_state_open`):
  - `iac_new_resource` → "New Resource…" (no accelerator)
  - `iac_new_pipeline` → "New Pipeline…" (no accelerator)
- In the `on_menu_event` match, emit `menu:iac_new_resource` /
  `menu:iac_new_pipeline` (mirrors the existing `iac_studio_open` arm).
- In `App.tsx`, add two `listen(...)` handlers that:
  1. Resolve the live cwd and ensure an IaC Studio tab exists — **reuse the
     exact cwd-resolution block** from the `menu:iac_studio_open` handler
     (resolveRecordingTerminalId → cwdByTerminal). If no Studio tab is open,
     add one; otherwise focus the existing one.
  2. Call `setPendingWizard(tabId, "resource" | "pipeline")` so the Studio tab
     opens the correct modal on its next render.

### 2. Store (`src/state/iacStudioStore.ts`)

- Add `pending_wizard: "resource" | "pipeline" | null` to `IacStudioTabState`
  (default `null` in `freshIacStudioState`).
- Add `setPendingWizard(tabId, w)` and a clear (set to `null`) path.
- **Reuse** the existing `ai` slice (`AiProposal`, `setAiProposal`,
  `clearAiProposal`) for the generated diff. Wizards produce an `AiProposal`
  exactly like the AI panel does.
- Extend `AiProposal` with an optional `target_path?: string`. When set, the
  Studio's accept handler writes a new file at that path instead of editing the
  active buffer. When absent (Phase C path), behavior is unchanged.

### 3. Components (`src/components/iac/`)

**`IacResourceWizard.tsx`** — modal form:
- Provider dropdown: `aws | azure | gcp | cisco | other`.
- Resource type: free text (e.g. `aws_instance`).
- Name: free text (e.g. `web_server`).
- Details: textarea (e.g. "t3.micro in the prod VPC").
- Tool is derived from provider/intent: default Terraform; if the active file or
  workspace is Ansible-oriented the user may toggle (kept minimal — a Tool radio
  defaulting to Terraform).
- Composes an NL intent string, e.g.:
  `Create a {provider} {resourceType} named "{name}". {details}`
- Calls `iacGenerateTerraform`/`iacGenerateAnsible` with `rootPath` and empty
  `existingCode` (new file). On success builds an `AiProposal` whose
  `target_path` = `{name}.tf` (or `{name}.yml`) under the workspace root, then
  hands it to `setAiProposal`.

**`IacPipelineWizard.tsx`** — modal form:
- Platform checkboxes: GitHub Actions, GitLab CI (at least one required).
- Tool radio: Terraform / Ansible — **preselected** by auto-detecting workspace
  layout (presence of `.tf` files → Terraform; `.yml/.yaml` playbooks →
  Ansible). Detection uses the already-loaded file tree / a directory listing;
  no new backend.
- Flow dropdown: `plan-on-PR + apply-on-merge` (default), `plan-on-PR only`.
- Auth/env: optional free-text folded into the intent (e.g. "AWS via OIDC,
  region us-east-1").
- For **each** selected platform, composes a platform-specific intent and calls
  the codegen RPC, producing one `AiProposal` per platform with `target_path`:
  - GitHub Actions → `.github/workflows/terraform.yml` (or `ansible.yml`)
  - GitLab CI → `.gitlab-ci.yml`
- Multiple platforms are presented as a **sequence** of diff previews (accept or
  reject each independently). The wizard advances to the next platform's diff
  after the current one is accepted/rejected.

Both wizards reuse **`IacDiffPreview`** with `original=""` and the returned
`validation` note (honest "syntax not validated" when binaries absent).

### 4. New-file write path (the one genuinely new behavior)

Phase C's `onAcceptProposal` only edits the active buffer. Extend it:

```
onAcceptProposal:
  if proposal.target_path:
     await iacStudioWriteFile(target_path, proposal.code, root_path)  // scoped write
     refresh file tree (re-expand to reveal the new file)
     openFileInStore(tabId, target_path, proposal.code, language)     // open it
  else:
     setContent(tabId, proposal.code)   // unchanged Phase C buffer edit
  clearAiProposal(tabId)
```

`iac_studio_write_file`'s existing canonicalize + workspace-prefix guard rejects
any `target_path` resolving outside the root (e.g. a malicious `../../etc`).
For pipeline files the wizard creates parent dirs as needed — the Rust write
command already creates missing parent directories within the scoped root
(verify during implementation; add if missing, still scoped).

## Honesty & safety (carried from Phases B & C)

- **No faked validation.** `IacDiffPreview` already renders "syntax not
  validated (terraform/ansible not available)" when the binary is absent. The
  wizards inherit this verbatim — never imply a generated file is valid.
- **LLM unavailable → no write.** If `CodegenResult.unavailable` is true or
  `code` is empty, the wizard shows the same honest error the AI panel shows and
  writes nothing.
- **Writes are workspace-scoped.** Every write goes through the existing
  `iac_studio_write_file` path-traversal guard. No writes outside the chosen
  folder.
- **Authoring ≠ applying.** Wizards only write files. Any subsequent
  `terraform apply` / `ansible-playbook` still routes through `iac_apply` →
  `IaCApprovalModal`. No bypass is introduced.

## Testing (vitest, per project convention)

- **Resource wizard:** composes the expected NL intent from the fields; on a
  mocked successful `CodegenResult`, produces an `AiProposal` with
  `target_path = <name>.tf`; Accept calls `iacStudioWriteFile` with that path
  and opens the file. Mocked `unavailable: true` → honest error, no write.
- **Pipeline wizard:** one selected platform → one proposal at the correct
  `target_path`; **both platforms selected → two sequential proposals** writing
  `.github/workflows/*.yml` and `.gitlab-ci.yml`; Tool preselection follows the
  detected layout; Auth/env text is folded into the intent.
- **Accept write path:** `onAcceptProposal` with `target_path` writes a new file
  and leaves the buffer-edit branch untouched when `target_path` is absent
  (Phase C regression guard).
- **Menu wiring:** `menu:iac_new_resource` / `menu:iac_new_pipeline` ensure a
  Studio tab and set `pending_wizard` correctly.

## End-to-end verification

Launch the app (`npm run tauri dev`), open the IaC menu:
- **Resource:** New Resource… → fill provider=aws, type=aws_instance,
  name=web_server, details → Generate → confirm a diff preview → Accept →
  confirm `web_server.tf` exists on disk in the workspace and is open in the
  editor.
- **Pipeline:** New Pipeline… → check both platforms, Tool=Terraform, flow=
  plan-on-PR + apply-on-merge → Generate → accept the GitHub Actions diff, then
  the GitLab diff → confirm `.github/workflows/terraform.yml` and
  `.gitlab-ci.yml` exist and are valid YAML.
- **Binary-absent honesty:** with `terraform` off PATH, confirm the diff note
  reads "syntax not validated", not "valid".

No DB migration is required for Phase D (next free migration remains V0051).

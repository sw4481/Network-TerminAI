# IaC Studio — Design

**Date:** 2026-06-15
**Status:** Design — pending review
**Author:** brainstormed with operator (sw4481)

## Context

The CCIE Terminal already has a working IaC integration built over four phases:
command interception/parsing (Phase 1), blast-radius classification + approval
gates (Phase 2), a Terraform **state browser + drift detection** drawer (Phase 3,
⌘⇧S), and natural-language → Terraform/Ansible **code generation** as agent tools
(Phase 4). See `docs/features/iac-integration.md` and the per-phase specs/plans.

What does **not** exist anywhere in those plans:

1. A real **IaC menu** beyond a single "Open Terraform State" item.
2. An **editor / project workspace** for authoring `.tf` and `.yml` files.
3. **Real linting** (only one-shot `terraform fmt` syntax checks inside codegen).
4. **Guided wizards** (resource scaffolding, CI/CD pipeline generation).

Today the Phase-4 agent generates code into the chat transcript and writes files
via `execute_python_code` — there is no editing surface, no file tree, no live
diagnostics, and no guided authoring. Operators cannot see, edit, or iterate on
their IaC files inside the terminal.

**Goal:** an **IaC Studio** — a full-screen mini-IDE that turns the existing
backend capabilities (codegen, apply-gating, state/drift) into a real authoring
workspace: a file tree, a Monaco editor wired to disk, live linting, in-editor AI
guidance, and guided wizards including a CI/CD pipeline generator.

This is a large vision, so it is structured as **one master design with four
phased sub-projects**, each of which gets its own implementation plan and build
cycle. Phase A is the foundation that B/C/D depend on.

## Decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Scope | Full IaC Studio (Editor + Lint + AI + Wizards) |
| UI surface | Full-screen tab (mini-IDE), like `TopologyTab` |
| Open shortcut | IaC menu → "Open IaC Studio" (⌘⇧E) |
| Linters | `terraform validate` + `terraform fmt`, `ansible-lint` (no tflint / security scanners) |
| CI/CD targets | GitHub Actions + GitLab CI (no Jenkins / Azure DevOps) |
| Workspace root | Focused terminal's live OSC-7 cwd, with "Browse…" picker fallback |
| File I/O | **Native Tauri Rust commands**, scoped to workspace root (editing works even if sidecar is down) |
| AI-into-editor | **Diff-preview before apply** (accept/reject), reusing the diff pattern |

Out of scope (consistent with the existing IaC future-work list): tflint,
checkov/tfsec, Jenkins/Azure pipelines, remote state backends, git auto-commit,
module-registry browser, multi-project simultaneous workspaces.

## Architecture

A new full-screen tab with a VS Code-style layout:

```
┌─────────────────────────────────────────────────────────┐
│  IaC Studio   [workspace: ~/net/prod-tf ▾] [Browse…]  ⚙  │
├──────────┬──────────────────────────────────┬───────────┤
│ File tree│        Monaco editor (tabs)       │  AI panel │
│ main.tf  │   resource "aws_..." { ... }      │  generate │
│ vars.tf  │                                   │  scaffold │
│ play.yml │                                   │  explain  │
│ ▸ roles/ │                                   │           │
├──────────┴──────────────────────────────────┴───────────┤
│ Problems (lint diagnostics)  •  3 warnings  1 error      │
└──────────────────────────────────────────────────────────┘
```

### Reused components (do NOT rebuild)

| Asset | Path | Used for |
|-------|------|----------|
| `MonacoEditor` | `src/components/editor/MonacoEditor.tsx` | Editing surface; already has LSP, ⌘L Ask-AI (Explain/Fix/Refactor/Ask), `onSave`, YAML via `monaco-yaml` |
| `iacStateStore.cwdByTerminal` | `src/state/iacStateStore.ts` | Live OSC-7 cwd → default workspace root |
| `iac_codegen` / `iac_codegen_tools` | `sidecar/src/ccie_sidecar/agents/iac_codegen*.py` | NL → Terraform/Ansible generation + syntax validation |
| `iac_apply` + `IaCApprovalModal` | `sidecar/.../iac_tools.py`, `src/components/IaCApprovalModal.tsx` | Gated execution path for any apply |
| Menu → event → store pattern | `src-tauri/src/lib.rs`, `src/App.tsx` | Adding the IaC Studio menu entry |
| Diff-preview pattern | `diff_snapshots` (Plan 05) / `similar` crate | Accept/reject AI-generated code into a buffer |

### New seams

- **Rust file-I/O commands** (`src-tauri/src/`): `iac_studio_list_dir`,
  `iac_studio_read_file`, `iac_studio_write_file` — all **hard-scoped to the
  workspace root** with path-traversal guards. No sidecar dependency for editing.
- **Sidecar lint RPC** (`sidecar/.../`): `iac.lint_file` running
  `terraform validate`/`fmt` for HCL and `ansible-lint` for YAML, returning
  structured `{ line, col, severity, message, source }` diagnostics. Degrades
  gracefully (returns `{ unavailable: true, reason }`) when a binary is absent.
- **`iacStudioStore.ts`** (`src/state/`): workspace root, file tree, open editor
  tabs, per-tab dirty state, active diagnostics.
- **HCL Monarch grammar**: Monaco has no built-in HCL language; register a
  lightweight tokenizer for `.tf`/`.hcl` (YAML already supported).

## Phases (each → its own implementation plan)

### Phase A — Editor + Workspace (FOUNDATION)
The minimum that makes everything else possible.
- IaC menu item "Open IaC Studio" (⌘⇧E), wired `lib.rs` → `App.tsx` → store.
- `IacStudioTab.tsx` full-screen view + `iacStudioStore.ts`.
- Rust file-I/O commands, workspace-root-scoped, path-traversal guarded.
- File-tree component; multi-tab Monaco editing with dirty markers and ⌘S save.
- Workspace root defaults to focused terminal's live cwd; "Browse…" fallback.
- HCL Monarch grammar registration for `.tf` highlighting.
- **Ships:** open a folder, browse the tree, edit and save `.tf`/`.yml` files.

### Phase B — Linting / diagnostics
- Sidecar `iac.lint_file` RPC (`terraform validate` + `fmt`, `ansible-lint`).
- Debounced lint-on-change + lint-on-save.
- Diagnostics in Monaco gutter/squigglies **and** a bottom "Problems" panel.
- Missing-binary states surfaced as info (never a silent/fake "clean").
- **Ships:** live, actionable diagnostics as you edit.

### Phase C — In-editor AI guidance ✅ DELIVERED (merged to main 2026-06-16)
- AI side panel + existing ⌘L Ask-AI actions scoped to the Studio's active file.
- "Generate into file" via `iac_codegen` tools (free-form NL → HCL/playbook).
- AI output shown as a **diff against the current buffer** (accept/reject).
- "Apply" routes through `iac_apply` → `IaCApprovalModal` — no bypass.
- **Ships:** intelligent, reviewable, in-context code authoring.
- **Deviation:** the planned in-panel "Scaffold resource" button was **removed**
  during live verification — it was a thin prompt-wrapper around the same codegen
  path as Generate and added no distinct value. Real scaffolding (provider/resource
  → guided fields) is owned by Phase D's resource wizard below; do NOT re-add a
  Scaffold button to the AI panel. "Explain" was relabeled "Explain in chat ↗" and
  visually separated to signal it routes to the global agent chat, not a diff.

### Phase D — Guided wizards ✅ DELIVERED (merged to main 2026-06-17)
- **Resource scaffolding wizard**: provider/resource → guided fields → generates a
  `.tf`/playbook into the workspace (diff-preview before write). NOTE: this is the
  home for "scaffolding" — Phase C deliberately dropped its thin Scaffold button so
  this wizard is the single, guided scaffolding experience (not a duplicate). Reuse
  the Phase C codegen RPC (`iac.generate_terraform_code`/`iac.generate_ansible_playbook`)
  and the `IacDiffPreview` overlay for the diff-before-write step.
- **CI/CD pipeline wizard**: generates **GitHub Actions** (`.github/workflows/*.yml`)
  and **GitLab CI** (`.gitlab-ci.yml`) for plan-on-PR / apply-on-merge, driven by
  the LLM with the workspace's detected layout, written via the diff-preview path.
- **Ships:** step-by-step guided authoring from zero to a working pipeline.
- **As built:** both wizards launch from native IaC menu items ("New Resource…" /
  "New Pipeline…", no accelerators) → `pending_wizard` store flag → modal in
  `IacStudioTab`. They reuse the Phase C codegen RPCs and `IacDiffPreview` and write
  NEW files via the existing workspace-scoped `iac_studio_write_file` (extended to
  `create_dir_all` parents so `.github/workflows/*.yml` works in a fresh repo). The
  one new store seam is `AiProposal.target_path` — when present, accepting a diff
  writes a new file instead of editing the buffer. The pipeline wizard generates one
  proposal per selected platform, shown as sequential diffs. **Deviations:** the
  resource wizard uses a light structured form (provider/type/name/details → NL
  intent), not provider-schema introspection (out of scope); GitHub Actions is
  pre-checked by default per the approved mockup. No DB migration (next free V0051).

## Risks & mitigations

- **File write safety (security crux):** all Rust file commands hard-scoped to the
  workspace root; reject any path resolving outside it (canonicalize + prefix
  check). No writes outside the chosen folder.
- **HCL highlighting:** Monaco has no built-in HCL; Phase A ships a lightweight
  Monarch grammar. YAML already works via `monaco-yaml`.
- **Binary availability:** `terraform` / `ansible-lint` may be absent. Every
  lint/validate path degrades to an explicit "unavailable" state, never a faked
  clean result (mirrors the existing drift-check honesty rule).
- **Scope creep:** linters and CI/CD targets are explicitly bounded; no
  tflint/security scanners, no Jenkins/Azure.

## Verification (end-to-end, per phase)

- **A:** Launch app (`npm run tauri dev`), open IaC Studio via ⌘⇧E, confirm the
  tree shows the focused terminal's cwd, open a `.tf` file, edit, ⌘S, confirm the
  file changed on disk. Rust unit test for the path-traversal guard.
- **B:** Introduce a known Terraform/Ansible error, confirm a squiggle + Problems
  entry appears; rename `terraform` off PATH, confirm "unavailable" (not "clean").
- **C:** Ask the AI to add a resource, confirm a diff preview, accept it, confirm
  the buffer/file updated; trigger Apply, confirm `IaCApprovalModal` appears.
- **D:** Run the resource wizard end-to-end; run the CI/CD wizard and confirm a
  valid `.github/workflows/*.yml` and `.gitlab-ci.yml` are written.

Each phase also follows the project's TDD + vitest/pytest conventions and adds a
DB migration only if it needs persistence (none currently anticipated before
Phase D workspace-memory, if added).

## Post-D future candidates (NOT planned — captured 2026-06-17)

Phases A–D are all merged to `main` and verified by the operator. The original
four-phase vision is **complete**; there is no Phase E in scope. The following are
candidate capabilities for a *future* milestone, captured so they aren't lost.
None is committed or scheduled. (Recommended-for-live-testing first.)

1. **Security / policy scanning** — add `tflint` + `checkov`/`tfsec` as additional
   linters feeding the existing Phase B Problems panel. Highest synergy with the
   linting infra; trivially testable end-to-end with real binaries on real `.tf`.
2. **Remote state backends** — S3/GCS/Terraform Cloud support in the state browser
   + a backend-config wizard. Meaningful live testing needs real cloud creds.
3. **Module-registry browser** — browse + insert Terraform Registry modules into
   the editor (real registry API; mostly read-only, lower risk).
4. **More CI/CD targets** — Jenkins + Azure DevOps generators added to the Phase D
   wizard (live testing limited to generated YAML/Groovy syntax validation).
5. **git auto-commit** of generated files; **workspace memory / multi-project**
   simultaneous workspaces.

When picking one up, start with `superpowers:brainstorming` → design → plan, same
as A–D.

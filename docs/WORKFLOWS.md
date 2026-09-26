# Workflows — Parameterized Commands

> **Status:** shipped 2026-05-17 (Plan 02). Linked from `/Plans/02-workflows-parameterized.md`.

A **workflow** is a saved command template that takes named parameters. Press **⌘ ⇧ W** anywhere in the app to open the workflow picker, fuzzy-find one, fill any parameters, and either inject the rendered command into the active editor (single-step) or run an ordered list of commands as a tagged group (multi-step).

## TL;DR

| Action | Shortcut |
|---|---|
| Open workflow picker | `⌘ ⇧ W` |
| Run highlighted workflow | `Enter` |
| Open parameter form (skip auto-run) | `⌘ Enter` |
| Cycle highlight | `↑` / `↓` |
| Close picker / cancel form | `Esc` |

## Single-step vs. multi-step

| Shape | Behavior |
|---|---|
| 1 step, 0 params | Picker → `Enter` → command appears in the editor immediately. |
| 1 step, ≥1 params | Picker → `Enter` → parameter form. Submit → rendered command goes into the editor. While typing, `useWorkflowTypeahead` previews the live substitution. |
| ≥2 steps, 0 params | Picker → `Enter` → all commands are dispatched sequentially through PTY write with a 250 ms inter-command spacing. |
| ≥2 steps, ≥1 params | Picker → `Enter` → parameter form. Submit → all commands are dispatched as above; each spawned block is tagged with `workflow:<name>` (Plan 01 `block_tags`). |

## Placeholder syntax

```
{{ name }}
```

* Braces are doubled (`{{ }}`).
* Whitespace inside the braces is tolerant: `{{intf}}`, `{{ intf }}`, `{{  intf  }}` all match the same `intf` parameter.
* Names match `[A-Za-z_][A-Za-z0-9_]*` (Python-like identifier).
* The same placeholder may appear multiple times in one template — it's substituted with the same value everywhere.
* User-supplied values are **never** re-expanded — if you put `{{evil}}` into a value, it stays literal in the output.

## Param types and validation

| Type | Widget | Validation |
|---|---|---|
| `string` | `<input type="text">` | required-only |
| `int` | `<input type="number">` | required + integer-shape `^-?\d+$` |
| `ip` | `<input type="text">` | required + IPv4 shape `a.b.c.d` or `a.b.c.d/m` |
| `interface` | `<input type="text">` | required-only (free text — datalist is a future Plan 02 follow-up) |
| `enum` | `<select>` populated from `enum_values` | required + value-must-be-in-list |

Each param can specify `default_value` (used when the field is empty), `required` (boolean — defaults to `true`), and a `description` line shown above the input.

## Vendor / platform scoping

The picker filters by the active tab's `vendor` and `platform`. The scope chip in the top-right of the picker shows the current scope (e.g. `cisco/iosxe`). The **all** toggle disables scoping for cross-vendor browsing.

* Vendor enum: `cisco`, `juniper`, `arista`, `meraki`, `generic`.
* Platform is free-form text (e.g. `iosxe`, `nxos`, `junos`, `eos`, `dashboard`, `generic`).
* `'generic'` workflows are always returned, regardless of vendor filter.
* Platform filtering also includes empty/`'generic'` platform rows so cross-platform builtins still surface.

`Tab.vendor` / `Tab.platform` are in-memory only (not persisted) — set them with `setTabVendor(tabId, vendor, platform)` from the tabs store.

## Multi-step block grouping

When a multi-step workflow runs, the backend records a row in `workflow_runs` (uuid). Each command spawned through that run shares the same `block_group_id`, and Plan 01's `block_tag_add(block_id, "workflow:<name>")` tags every block with the workflow name. Filtering blocks by tag (Plan 01) groups them visually.

> **Caveat (TODO).** `Terminal.tsx` currently uses a 250 ms delay between commands as a sequencing fallback. Once Plan 01 exposes a block-end signal, swap the timer for an `await waitForBlockEnd(tabId)`. Tracking issue: see the comment in `src/components/Terminal.tsx` around the `ccie:workflow-execute` handler.

## YAML schema (`ccie-workflow/v1`)

Workflows can be exported and imported as YAML files via the picker footer.

```yaml
schema: ccie-workflow/v1
id: cisco-iosxe-show-interface-counters    # optional on import — leave blank to allocate a new uuid
name: "Show interface counters"
description: "Per-interface TX/RX counters"
vendor: cisco                                # one of: cisco | juniper | arista | meraki | generic
platform: iosxe                              # free text
tags: [interfaces, counters]
params:
  - name: intf
    type: interface                          # one of: string | enum | ip | int | interface
    default_value: null                      # nullable
    required: true                           # default: true
    description: "Interface (e.g. Gi0/0/0)"
    enum_values: null                        # required iff type=enum
steps:
  - idx: 0
    command_template: "show interface {{ intf }} counters"
```

Import behavior:
* Unknown `schema` → reject (`unknown schema`).
* Unknown vendor → reject.
* Unknown param type → reject.
* Empty `command_template` → reject.
* Imported workflows always get a fresh uuid (the YAML's `id` is overwritten) so a builtin is never silently replaced.

## Authoring builtins

The seed pack lives at `sidecar/data/workflows_seed.yaml` and is embedded into the binary via `include_str!` in `src-tauri/src/commands/workflows_seed.rs`. The seeder runs once per database (gated by an `app_flags.workflows.seeded.v1` row) so user edits are never overwritten on subsequent boots.

To add a new builtin:

1. Append a workflow entry to `sidecar/data/workflows_seed.yaml` following the schema above. Pick a stable `id` (kebab-case, prefixed by vendor + platform).
2. Run `cd sidecar && python -m pytest tests/data/test_workflows_seed.py -v`. The validator enforces vendor/type enums, unique ids, contiguous step indices, and placeholder/param parity.
3. Run `cargo test --manifest-path src-tauri/Cargo.toml --test workflows_seed_test` to confirm the loader still parses the file end-to-end.
4. (Optional) Bump the seed flag from `workflows.seeded.v1` to `workflows.seeded.v2` in `workflows_seed.rs` if you want existing installs to re-seed and pick up the new entries.

## File map

| File | Purpose |
|---|---|
| `src-tauri/migrations/V0029__workflows.sql` | Schema (`workflows`, `workflow_steps`, `workflow_params`, `workflow_runs`, `command_blocks.block_group_id`). |
| `src-tauri/src/commands/workflows.rs` | CRUD + render + run impl + 6 Tauri commands. |
| `src-tauri/src/commands/workflows_seed.rs` | Embedded YAML seed loader (idempotent). |
| `sidecar/data/workflows_seed.yaml` | Authoritative seed pack (30 workflows). |
| `sidecar/tests/data/test_workflows_seed.py` | YAML schema validator (pytest). |
| `src/lib/workflows.ts` | Typed Tauri command wrappers. |
| `src/lib/workflowsYaml.ts` | YAML import/export with schema validation. |
| `src/state/workflowsStore.ts` | Zustand store (load / save / remove / getById). |
| `src/components/WorkflowPicker.tsx` | ⌘⇧W modal with fuse.js fuzzy search. |
| `src/components/WorkflowParamForm.tsx` | Per-type widgets + validation. |
| `src/components/WorkflowRunner.tsx` | Picker → form → dispatch orchestration. |
| `src/components/WorkflowExportImport.tsx` | Picker-footer YAML buttons. |
| `src/hooks/useWorkflowTypeahead.ts` | Live `{{name}}` substitution preview. |

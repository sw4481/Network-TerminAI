# Plan 15 Phase 6 — PlaybookEditor design spec (pre-implementation)

> Pre-review note: same constraint as Phase 4 — there is no live Tauri
> bundle to screenshot from this workspace, and the `frontend-design`
> skill output ends up as markdown anyway. We capture the layout + UX
> intent here, implement, then revisit in `post-implementation-review.md`.

## Layout — split pane

```
+--------------------------------------------------------------------+
| Toolbar:  [Playbook ▾]  [Save]  [Import] [Export] [Delete]  status |
+----------------------------------+---------------------------------+
|                                  |                                 |
|         Monaco YAML              |        Live preview             |
|         (left, 50%)              |        TreeCanvas (right, 50%)  |
|         schema-validated         |        all steps "pending"      |
|         line numbers gutter      |        debounced 300ms          |
|                                  |                                 |
|         error squiggles in-line  |                                 |
|         hover for problem text   |                                 |
|                                  |                                 |
+----------------------------------+---------------------------------+
| Diagnostics panel (collapsible, full width):                       |
|  - YAML parse errors (line/col + message)                          |
|  - JSON Schema violations (path + message)                         |
|  - Cross-reference errors (next/on_pass/on_fail referencing        |
|    missing step ids; surfaced after a successful YAML parse)       |
+--------------------------------------------------------------------+
```

## UX rules

1. **Save is disabled until valid.** "Valid" = (a) YAML parses, (b)
   schema passes, (c) cross-references resolve. The button shows the
   current invalid count when disabled (`Save (3 errors)`).
2. **Builtin playbooks are read-only.** When the operator selects a
   builtin from the dropdown:
   - Monaco enters `readOnly: true`.
   - Save and Delete are disabled with a tooltip
     `Builtin playbooks are read-only — duplicate to edit`.
   - A "Duplicate" button appears next to the dropdown to clone the
     YAML into a fresh user playbook (id is suggested as
     `<original>-copy`).
3. **Live preview never blocks the editor.** Parse errors freeze the
   preview at its last good state and overlay a translucent banner
   ("Preview frozen — fix errors below").
4. **Import** prompts for a `.yaml`/`.yml` file, validates client-side
   against the schema, then opens the editor with the imported text.
   The id is forced to a fresh unique slug to avoid clobbering builtins
   on save. The user is shown the suggested id and can rename before
   saving.
5. **Export** writes `<id>.yaml` via the system save dialog.
6. **Generate with AI** stays disabled — the Phase 5 stub
   `tb-picker-generate-ai` semantics. Tooltip:
   `AI playbook generation is deferred — see Plan 15 retrospective`.

## Error display strategy

- **Inline (Monaco):** monaco-yaml provides squiggles directly. We
  configure `validate: true`, `enableSchemaRequest: false`, and feed
  `playbook-schema.json` as an in-memory schema bound to `*` so every
  buffer in the editor instance gets validated.
- **Below the editor:** a collapsible Diagnostics panel summarises
  errors. Click a row to jump the cursor to the offending line. This
  matches the IntentEditor "Body" tab pattern operators are already
  used to.
- **Cross-reference errors:** schema validation cannot catch
  `next: nonexistent-step`. We run a tiny client-side cross-reference
  pass post-parse and emit those into the diagnostics panel under a
  separate "References" header. Save is gated on this passing too.

## Component contract

```ts
// PlaybookEditor.tsx
export interface PlaybookEditorProps {
  /** Currently-open playbook id; null = new playbook (blank YAML). */
  playbookId: string | null;
  /** When the user picks a different playbook from the dropdown. */
  onSelect: (id: string | null) => void;
  /** Optional close hook for the host tab. */
  onClose?: () => void;
}
```

The component is fully self-contained; it owns its YAML buffer, its
Monaco instance, and its monaco-yaml configuration. Any persistence
goes through the existing `troubleshootApi.{listPlaybooks, getPlaybook,
upsertPlaybook, deletePlaybook}` helpers — no new Tauri commands.

## Tab integration

We add a new `TabType = "troubleshoot-editor"` and an
`<EditorTab tabId>` page. Opening it goes through
`handleOpenTroubleshootEditor` in `App.tsx`, mirroring the existing
`handleOpenTroubleshoot`. The Phase 4 `menu:troubleshoot_editor` event
listener (currently re-opens the troubleshoot tab) is rewired to call
the new opener.

The Troubleshoot tab gets a "📝 Edit Playbooks" button in the picker
header that fires `menu:troubleshoot_editor` so operators can flow from
"this builtin almost matches" → "let me edit it" without leaving the
troubleshoot surface.

## Testing strategy

The MonacoEditor is lazy-imported (`() => import("@monaco-editor/react")`)
and never resolves under jsdom. We follow the established
`IntentEditor.test.tsx` pattern: stub `@monaco-editor/react` with a
`<textarea>` so the test exercises validation, save-disabled, and
preview re-render without loading 3MB of editor JS. Schema/parse
validation is pure-JS code we test directly against a few known-bad
YAML strings.

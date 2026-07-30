/**
 * Plan 15 Phase 6 — PlaybookEditor.
 *
 * Split-pane Monaco YAML editor (left) + live TreeCanvas preview
 * (right). Uses `monaco-yaml` for inline schema validation against
 * the bundled `playbook-schema.json`. The Save button is gated on
 * three pure-JS checks (`validatePlaybookYaml`):
 *   1. YAML parses.
 *   2. Schema passes.
 *   3. Cross-references resolve (next / on_pass / on_fail / cases.next
 *      all point to real step ids).
 *
 * Builtin playbooks are read-only — the editor enforces this client-
 * side (Save / Delete disabled, Monaco set to readOnly) AND the
 * backend `upsert_playbook` / `delete_playbook` commands reject them
 * server-side. Operators can "Duplicate" a builtin into a fresh user
 * playbook to fork it.
 *
 * Import → file picker → client-side validation → opens the buffer
 * with a fresh suggested id. Export → downloads `<id>.yaml`.
 *
 * The "Generate with AI" button stays disabled — Phase 5 reserved
 * `tb-picker-generate-ai` and the same convention applies here under
 * `tb-editor-generate-ai`. AI generation is deferred.
 *
 * Test strategy: `@monaco-editor/react` is lazy-imported so under
 * jsdom it never resolves; we render a `<textarea>` fallback so unit
 * tests can drive the editor without loading 3MB of Monaco. Schema +
 * preview behaviour is tested directly off the buffer state.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import yaml from "js-yaml";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";

import { TreeCanvas } from "./TreeCanvas";
import { troubleshootApi } from "./api";
import { useTroubleshootStore } from "./store";
import {
  BLANK_PLAYBOOK_YAML,
  previewStepsFromDoc,
  suggestUniqueId,
  validatePlaybookYaml,
  type Diagnostic,
} from "./playbook-validate";
import playbookSchema from "./playbook-schema.json";
import "./PlaybookEditor.css";

const MonacoYamlEditor = lazy(() => import("./PlaybookEditorMonaco"));

const PREVIEW_DEBOUNCE_MS = 300;

export interface PlaybookEditorProps {
  /** Optional pre-selected playbook id. */
  initialPlaybookId?: string | null;
  /** Optional close hook the host tab can wire. */
  onClose?: () => void;
}

interface ToolbarStatus {
  kind: "idle" | "saving" | "saved" | "error";
  message: string;
}

export function PlaybookEditor({ initialPlaybookId, onClose }: PlaybookEditorProps) {
  const playbooks = useTroubleshootStore((s) => s.playbooks);
  const refreshPlaybooks = useTroubleshootStore((s) => s.refreshPlaybooks);

  const [selectedId, setSelectedId] = useState<string | null>(initialPlaybookId ?? null);
  const [buffer, setBuffer] = useState<string>(BLANK_PLAYBOOK_YAML);
  const [originalBuffer, setOriginalBuffer] = useState<string>(BLANK_PLAYBOOK_YAML);
  const [loading, setLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [parsedDoc, setParsedDoc] = useState<unknown>(null);
  const [toolbarStatus, setToolbarStatus] = useState<ToolbarStatus>({
    kind: "idle",
    message: "",
  });
  const [diagnosticsCollapsed, setDiagnosticsCollapsed] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genElapsed, setGenElapsed] = useState(0);
  // Free-text "what do you want this playbook to diagnose?" prompt. When
  // filled it drives AI generation directly; when blank we fall back to
  // the name/description fields in the buffer.
  const [genPrompt, setGenPrompt] = useState("");
  // One-shot guard: set true right before we programmatically populate the
  // buffer (AI generation) so the selectedId→null effect doesn't reset it
  // to the blank template.
  const skipBlankResetRef = useRef(false);

  // Tick an elapsed-seconds counter while generating so a slow (30-120s)
  // LLM call clearly looks like work-in-progress, not a hang.
  useEffect(() => {
    if (!generating) {
      setGenElapsed(0);
      return;
    }
    const started = Date.now();
    const h = window.setInterval(() => {
      setGenElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(h);
  }, [generating]);

  const selected = useMemo(
    () => playbooks.find((p) => p.id === selectedId) ?? null,
    [playbooks, selectedId],
  );

  const isReadOnly = !!selected?.builtin;

  // Initial catalogue load.
  useEffect(() => {
    void refreshPlaybooks();
  }, [refreshPlaybooks]);

  // When the dropdown selection changes, fetch the YAML body.
  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      // Skip the blank-reset exactly once when the buffer was just set
      // programmatically (AI generation) while selectedId is already
      // null — otherwise this effect would clobber the generated YAML
      // back to the blank template.
      if (skipBlankResetRef.current) {
        skipBlankResetRef.current = false;
        return;
      }
      setBuffer(BLANK_PLAYBOOK_YAML);
      setOriginalBuffer(BLANK_PLAYBOOK_YAML);
      return;
    }
    setLoading(true);
    troubleshootApi
      .getPlaybook(selectedId)
      .then((body) => {
        if (cancelled) return;
        setBuffer(body);
        setOriginalBuffer(body);
        setToolbarStatus({ kind: "idle", message: "" });
      })
      .catch((e) => {
        if (cancelled) return;
        setToolbarStatus({
          kind: "error",
          message: `Failed to load playbook: ${String(e)}`,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Debounced validation + preview computation. We use real timers
  // and a ref of the last buffer to avoid stale closures.
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const { doc, diagnostics: diags } = validatePlaybookYaml(bufferRef.current);
      setParsedDoc(doc);
      setDiagnostics(diags);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [buffer]);

  const errors = diagnostics.filter((d) => d.severity === "error");
  const isValid = errors.length === 0;
  const isDirty = buffer !== originalBuffer;
  const canSave = isValid && isDirty && !isReadOnly && !loading;
  const canDelete = !!selected && !selected.builtin && !loading;

  const previewSteps = useMemo(() => previewStepsFromDoc(parsedDoc), [parsedDoc]);

  const handleSelectPlaybook = useCallback(
    (id: string) => {
      // Empty option is "new playbook"
      if (id === "__new__") {
        setSelectedId(null);
        setBuffer(BLANK_PLAYBOOK_YAML);
        setOriginalBuffer(BLANK_PLAYBOOK_YAML);
        setToolbarStatus({ kind: "idle", message: "" });
        return;
      }
      setSelectedId(id);
    },
    [],
  );

  const handleNew = useCallback(() => {
    setSelectedId(null);
    setBuffer(BLANK_PLAYBOOK_YAML);
    setOriginalBuffer(BLANK_PLAYBOOK_YAML);
    setToolbarStatus({ kind: "idle", message: "" });
  }, []);

  const handleGenerate = useCallback(async () => {
    if (generating) return;

    // Derive the symptom + target from what the operator has already typed
    // in the buffer (name / description / keywords), rather than popping a
    // separate prompt. window.prompt() is also blocked in the Tauri
    // WKWebview, so it would silently no-op anyway.
    let name = "";
    let description = "";
    let keywords: string[] = [];
    let vendor: string | null = null;
    let platform: string | null = null;
    try {
      const { doc } = validatePlaybookYaml(buffer);
      const d = doc as {
        name?: string;
        description?: string;
        symptom_keywords?: unknown;
        vendor?: string;
        platform?: string;
      } | null;
      name = (d?.name ?? "").trim();
      description = (d?.description ?? "").trim();
      vendor = d?.vendor ?? null;
      platform = d?.platform ?? null;
      if (Array.isArray(d?.symptom_keywords)) {
        keywords = (d!.symptom_keywords as unknown[])
          .filter((k): k is string => typeof k === "string")
          // Drop the blank-template placeholder keywords.
          .filter((k) => !["replace", "with", "your", "keywords"].includes(k));
      }
    } catch {
      /* fall through to the empty-symptom guard below */
    }

    // The free-text prompt wins when the operator typed one — that's the
    // clearest expression of intent. Otherwise fall back to composing a
    // symptom from the buffer's name + description + keywords.
    let symptom: string;
    const typedPrompt = genPrompt.trim();
    if (typedPrompt) {
      symptom = typedPrompt;
    } else {
      const symptomParts = [name, description].filter(Boolean);
      if (keywords.length) symptomParts.push(`Keywords: ${keywords.join(", ")}`);
      symptom = symptomParts.join(". ").trim();
    }

    if (!symptom) {
      setToolbarStatus({
        kind: "error",
        message:
          "Describe what to diagnose in the prompt box (or fill in the playbook name/description) — that's what the AI generates steps from.",
      });
      return;
    }

    setGenerating(true);
    setToolbarStatus({
      kind: "saving",
      message: "Generating steps with AI… (may take ~30-60s)",
    });
    try {
      const result = await troubleshootApi.generatePlaybook(symptom, vendor, platform);
      // Replace the buffer with the generated playbook. Keep it as an
      // unsaved doc so the operator reviews before Save.
      // If a playbook was selected, clearing it to null will trigger the
      // selection effect — arm the one-shot guard so that effect doesn't
      // wipe the generated buffer back to the blank template.
      setSelectedId((prev) => {
        if (prev !== null) skipBlankResetRef.current = true;
        return null;
      });
      setBuffer(result.yaml);
      setOriginalBuffer(BLANK_PLAYBOOK_YAML);
      if (result.error) {
        setToolbarStatus({
          kind: "error",
          message: `Generated with a warning: ${result.error}`,
        });
      } else {
        setToolbarStatus({
          kind: "saved",
          message: "Generated. Review, then Save.",
        });
      }
    } catch (e) {
      setToolbarStatus({
        kind: "error",
        message: `Generation failed: ${String(e)}`,
      });
    } finally {
      setGenerating(false);
    }
  }, [buffer, generating, genPrompt]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    // Recompute against current buffer to be safe; the debounced
    // pass might be stale.
    const { doc, diagnostics: diags } = validatePlaybookYaml(buffer);
    if (diags.some((d) => d.severity === "error")) {
      setDiagnostics(diags);
      setToolbarStatus({
        kind: "error",
        message: "Cannot save — fix errors below.",
      });
      return;
    }
    const id = (doc as { id?: string } | null)?.id;
    if (!id) {
      setToolbarStatus({ kind: "error", message: "Playbook has no id." });
      return;
    }
    setToolbarStatus({ kind: "saving", message: "Saving…" });
    try {
      await troubleshootApi.upsertPlaybook(id, buffer);
      setOriginalBuffer(buffer);
      setSelectedId(id);
      await refreshPlaybooks();
      setToolbarStatus({ kind: "saved", message: `Saved ${id}.` });
    } catch (e) {
      // Backend rejects builtins; surface inline.
      setToolbarStatus({
        kind: "error",
        message: `Save failed: ${String(e)}`,
      });
    }
  }, [buffer, canSave, refreshPlaybooks]);

  const handleDelete = useCallback(async () => {
    if (!canDelete || !selected) return;
    // We don't pop a window.confirm because the Tauri host can run
    // headless; the toolbar status message conveys the action.
    setToolbarStatus({ kind: "saving", message: "Deleting…" });
    try {
      await troubleshootApi.deletePlaybook(selected.id);
      await refreshPlaybooks();
      setSelectedId(null);
      setBuffer(BLANK_PLAYBOOK_YAML);
      setOriginalBuffer(BLANK_PLAYBOOK_YAML);
      setToolbarStatus({ kind: "saved", message: `Deleted ${selected.id}.` });
    } catch (e) {
      setToolbarStatus({
        kind: "error",
        message: `Delete failed: ${String(e)}`,
      });
    }
  }, [canDelete, refreshPlaybooks, selected]);

  const handleExport = useCallback(async () => {
    const { doc, diagnostics: diags } = validatePlaybookYaml(buffer);
    if (diags.some((d) => d.severity === "error")) {
      setToolbarStatus({
        kind: "error",
        message: "Cannot export invalid YAML.",
      });
      return;
    }
    const id = (doc as { id?: string } | null)?.id ?? "playbook";
    try {
      const path = await saveDialog({
        defaultPath: `${id}.yaml`,
        filters: [{ name: "Playbook YAML", extensions: ["yaml", "yml"] }],
      });
      if (!path) return;
      await writeTextFile(path as string, buffer);
      setToolbarStatus({ kind: "saved", message: `Exported to ${path}` });
    } catch (e) {
      setToolbarStatus({ kind: "error", message: `Export failed: ${String(e)}` });
    }
  }, [buffer]);

  const handleImport = useCallback(async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "Playbook YAML", extensions: ["yaml", "yml"] }],
      });
      if (!path) return;
      const text = await readTextFile(path as string);
      const { doc, diagnostics: diags } = validatePlaybookYaml(text);
      if (diags.some((d) => d.severity === "error")) {
        setBuffer(text);
        setOriginalBuffer(text);
        setSelectedId(null);
        setDiagnostics(diags);
        setToolbarStatus({
          kind: "error",
          message: "Imported file has validation errors — review below.",
        });
        return;
      }
      // Force a fresh slug so we never overwrite a builtin.
      const taken = new Set(playbooks.map((p) => p.id));
      const incomingId = (doc as { id?: string } | null)?.id ?? "imported";
      const freshId = taken.has(incomingId)
        ? suggestUniqueId(incomingId, taken)
        : incomingId;
      const rewritten =
        freshId === incomingId
          ? text
          : rewriteIdInYaml(text, freshId);
      setBuffer(rewritten);
      setOriginalBuffer(rewritten);
      setSelectedId(null);
      setToolbarStatus({
        kind: "saved",
        message:
          freshId === incomingId
            ? `Imported ${incomingId}.`
            : `Imported as ${freshId} (renamed to avoid clobbering ${incomingId}).`,
      });
    } catch (e) {
      setToolbarStatus({
        kind: "error",
        message: `Import failed: ${String(e)}`,
      });
    }
  }, [playbooks]);

  const handleDuplicate = useCallback(() => {
    if (!selected) return;
    const taken = new Set(playbooks.map((p) => p.id));
    const freshId = suggestUniqueId(`${selected.id}-copy`, taken);
    const rewritten = rewriteIdInYaml(buffer, freshId);
    setBuffer(rewritten);
    setOriginalBuffer(rewritten);
    setSelectedId(null);
    setToolbarStatus({
      kind: "saved",
      message: `Duplicated as ${freshId} — review and Save.`,
    });
  }, [buffer, playbooks, selected]);

  const handleJumpTo = useCallback((d: Diagnostic) => {
    // The Monaco lazy module exposes a setter on window for tests +
    // host integration; in jsdom this is a no-op.
    const setter = (
      window as { __tbEditorJumpTo?: (line: number, column: number) => void }
    ).__tbEditorJumpTo;
    if (d.line && setter) setter(d.line, d.column ?? 1);
  }, []);

  return (
    <div className="tb-editor" data-testid="tb-editor">
      <div className="tb-editor-toolbar">
        <span className="tb-editor-toolbar-label">Playbook</span>
        <select
          className="tb-editor-select"
          value={selectedId ?? "__new__"}
          onChange={(e) => handleSelectPlaybook(e.target.value)}
          data-testid="tb-editor-select"
        >
          <option value="__new__">— New playbook —</option>
          <optgroup label="Builtin (read-only)">
            {playbooks.filter((p) => p.builtin).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="User">
            {playbooks.filter((p) => !p.builtin).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>

        <button
          type="button"
          className="tb-editor-btn"
          onClick={handleNew}
          data-testid="tb-editor-new"
        >
          New
        </button>
        <button
          type="button"
          className="tb-editor-btn primary"
          onClick={() => void handleSave()}
          disabled={!canSave}
          data-testid="tb-editor-save"
          title={
            isReadOnly
              ? "Builtin playbooks are read-only — duplicate to edit"
              : !isValid
                ? `Save (${errors.length} error${errors.length === 1 ? "" : "s"})`
                : !isDirty
                  ? "No changes to save"
                  : "Save playbook"
          }
        >
          {toolbarStatus.kind === "saving" ? "Saving…" : "Save"}
        </button>
        {selected?.builtin && (
          <button
            type="button"
            className="tb-editor-btn"
            onClick={handleDuplicate}
            data-testid="tb-editor-duplicate"
            title="Duplicate this builtin into a new user playbook"
          >
            Duplicate
          </button>
        )}
        <button
          type="button"
          className="tb-editor-btn"
          onClick={() => void handleImport()}
          data-testid="tb-editor-import"
        >
          Import
        </button>
        <button
          type="button"
          className="tb-editor-btn"
          onClick={() => void handleExport()}
          data-testid="tb-editor-export"
          disabled={!isValid}
          title={isValid ? "Export YAML to disk" : "Cannot export — fix errors first"}
        >
          Export
        </button>
        <button
          type="button"
          className="tb-editor-btn danger"
          onClick={() => void handleDelete()}
          disabled={!canDelete}
          data-testid="tb-editor-delete"
          title={
            !selected
              ? "Select a user playbook to delete"
              : selected.builtin
                ? "Builtin playbooks cannot be deleted"
                : "Delete playbook"
          }
        >
          Delete
        </button>
        <input
          type="text"
          className="tb-editor-gen-prompt"
          value={genPrompt}
          onChange={(e) => setGenPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !generating) void handleGenerate();
          }}
          placeholder="Describe what to diagnose (e.g. OSPF stuck in EXSTART on {{interface}})"
          disabled={generating}
          data-testid="tb-editor-gen-prompt"
          title="Free-text: tell the AI what this playbook should troubleshoot. Leave blank to use the name/description fields instead."
        />
        <button
          type="button"
          className="tb-editor-btn"
          onClick={() => void handleGenerate()}
          disabled={generating}
          data-testid="tb-editor-generate-ai"
          title="Generate a playbook from the prompt (or the name/description) using the configured AI provider"
        >
          {generating ? `Generating… ${genElapsed}s` : "Generate with AI"}
        </button>
        <span className="tb-editor-toolbar-spacer" />
        <span
          className={`tb-editor-toolbar-status ${toolbarStatus.kind === "error" ? "error" : toolbarStatus.kind === "saved" ? "ok" : ""}`}
          data-testid="tb-editor-status"
        >
          {toolbarStatus.message ||
            (isValid ? "Valid" : `${errors.length} error${errors.length === 1 ? "" : "s"}`)}
        </span>
        {onClose && (
          <button
            type="button"
            className="tb-editor-btn"
            onClick={onClose}
            data-testid="tb-editor-close"
          >
            Close
          </button>
        )}
      </div>

      {isReadOnly && (
        <div className="tb-editor-readonly-banner" data-testid="tb-editor-readonly-banner">
          Builtin playbook — read-only. Click <strong>Duplicate</strong> to fork
          it into an editable user playbook.
        </div>
      )}

      <div className="tb-editor-body">
        <div className="tb-editor-pane-left">
          <div className="tb-editor-pane-label">Source (YAML)</div>
          <div className="tb-editor-monaco-host" data-testid="tb-editor-monaco-host">
            <Suspense
              fallback={
                <textarea
                  className="tb-editor-textarea-fallback"
                  value={buffer}
                  onChange={(e) => setBuffer(e.target.value)}
                  readOnly={isReadOnly}
                  spellCheck={false}
                  data-testid="tb-editor-textarea"
                  aria-label="Playbook YAML source"
                />
              }
            >
              <MonacoYamlEditor
                value={buffer}
                onChange={(v) => setBuffer(v)}
                readOnly={isReadOnly}
                schema={playbookSchema}
              />
            </Suspense>
          </div>
        </div>

        <div className="tb-editor-pane-right" data-testid="tb-editor-preview">
          <div className="tb-editor-pane-label">Live preview</div>
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            <TreeCanvas steps={previewSteps} />
            {!isValid && previewSteps.length === 0 && (
              <div className="tb-editor-preview-frozen">
                Preview frozen — fix errors below to see the tree.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="tb-editor-diagnostics" data-testid="tb-editor-diagnostics">
        <div
          className={`tb-editor-diagnostics-header ${errors.length > 0 ? "has-errors" : ""}`}
          onClick={() => setDiagnosticsCollapsed((v) => !v)}
        >
          <span>{diagnosticsCollapsed ? "▸" : "▾"}</span>
          <span>
            Diagnostics ({errors.length} error{errors.length === 1 ? "" : "s"})
          </span>
        </div>
        {!diagnosticsCollapsed && (
          <div className="tb-editor-diagnostics-list">
            {diagnostics.length === 0 ? (
              <div className="tb-editor-diagnostic-row" style={{ color: "var(--text-primary)" }}>
                No issues — playbook is valid.
              </div>
            ) : (
              diagnostics.map((d, i) => (
                <div
                  key={i}
                  className={`tb-editor-diagnostic-row ${d.severity}`}
                  onClick={() => handleJumpTo(d)}
                  data-testid={`tb-editor-diagnostic-${i}`}
                >
                  <span className="tb-editor-diagnostic-where">
                    {d.line ? `L${d.line}` : d.path ?? ""}
                  </span>
                  {d.message}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Replace the top-level `id:` line in the YAML buffer. We avoid round-
 * tripping through `js-yaml` to preserve comments/spacing/key order.
 * If no top-level `id:` line is found we prepend one.
 */
function rewriteIdInYaml(text: string, newId: string): string {
  const lines = text.split(/\r?\n/);
  let replaced = false;
  // Find the first non-indented line beginning with `id:`.
  for (let i = 0; i < lines.length; i++) {
    if (/^id\s*:/.test(lines[i])) {
      lines[i] = `id: ${newId}`;
      replaced = true;
      break;
    }
  }
  if (replaced) return lines.join("\n");
  return `id: ${newId}\n${text}`;
}

/* Re-export yaml so test fixtures can round-trip without a separate
 * import path. */
export { yaml };

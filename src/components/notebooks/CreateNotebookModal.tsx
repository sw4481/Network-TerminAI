import { useMemo, useState } from "react";
import {
  type AssertionOp,
  type ParameterSpec,
} from "../../lib/runnableNotebook";
import { importRunnableNotebookMarkdown } from "../../lib/runnableNotebook";
import {
  ASSERTION_OPS,
  VENDOR_OPTIONS,
  blankDraft,
  emitMarkdown,
  newCell,
  validateDraft,
  type DraftCell,
  type NotebookDraft,
} from "../../lib/notebookAuthoring";
import "./CreateNotebookModal.css";

type Mode = "wizard" | "raw";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function CreateNotebookModal({ open, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<Mode>("wizard");
  const [draft, setDraft] = useState<NotebookDraft>(blankDraft);
  const [rawMd, setRawMd] = useState<string>(() => emitMarkdown(blankDraft()));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const wizardErrors = useMemo(() => validateDraft(draft), [draft]);
  const generatedMd = useMemo(() => emitMarkdown(draft), [draft]);

  if (!open) return null;

  function reset() {
    const fresh = blankDraft();
    setDraft(fresh);
    setRawMd(emitMarkdown(fresh));
    setError(null);
  }

  function switchMode(next: Mode) {
    if (next === "raw") {
      // Going wizard → raw: serialise current draft as the seed.
      setRawMd(generatedMd);
    }
    // Going raw → wizard intentionally drops back to the LAST wizard draft;
    // we don't try to parse markdown back into a draft here (lossy and the
    // Rust parser is the source of truth).
    setMode(next);
  }

  async function onSave() {
    setError(null);
    setBusy(true);
    try {
      let md: string;
      if (mode === "wizard") {
        if (wizardErrors.length > 0) {
          setError(wizardErrors.join(" · "));
          setBusy(false);
          return;
        }
        md = generatedMd;
      } else {
        md = rawMd;
      }
      const id = await importRunnableNotebookMarkdown(md);
      onCreated(id);
      reset();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="create-mop-backdrop"
      onClick={onClose}
      data-testid="create-mop-modal"
    >
      <div
        className="create-mop-modal"
        role="dialog"
        aria-label="Create new MOP"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="create-mop-header">
          <h2>New MOP</h2>
          <div className="create-mop-modes" role="tablist" aria-label="Editor mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "wizard"}
              className={`mode-toggle ${mode === "wizard" ? "is-active" : ""}`}
              onClick={() => switchMode("wizard")}
              data-testid="mode-wizard"
            >
              Wizard
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "raw"}
              className={`mode-toggle ${mode === "raw" ? "is-active" : ""}`}
              onClick={() => switchMode("raw")}
              data-testid="mode-raw"
            >
              Raw markdown
            </button>
          </div>
          <button
            type="button"
            className="create-mop-close"
            onClick={onClose}
            aria-label="Close create modal"
            data-testid="create-mop-close"
          >
            ×
          </button>
        </header>

        {mode === "wizard" ? (
          <WizardForm draft={draft} setDraft={setDraft} />
        ) : (
          <RawEditor value={rawMd} onChange={setRawMd} preview={generatedMd} />
        )}

        <footer className="create-mop-footer">
          {error && (
            <div className="create-mop-error" role="alert">
              {error}
            </div>
          )}
          {mode === "wizard" && wizardErrors.length > 0 && !error && (
            <div className="create-mop-warning">
              {wizardErrors.length} issue{wizardErrors.length === 1 ? "" : "s"} to fix
              before save: {wizardErrors[0]}
            </div>
          )}
          <div className="create-mop-actions">
            <button
              type="button"
              className="library-action"
              onClick={onClose}
              disabled={busy}
              data-testid="create-mop-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="library-action primary"
              onClick={onSave}
              disabled={busy || (mode === "wizard" && wizardErrors.length > 0)}
              data-testid="create-mop-save"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

interface WizardFormProps {
  draft: NotebookDraft;
  setDraft: (next: NotebookDraft) => void;
}

function WizardForm({ draft, setDraft }: WizardFormProps) {
  const update = (patch: Partial<NotebookDraft>) =>
    setDraft({ ...draft, ...patch });

  const updateParam = (idx: number, patch: Partial<ParameterSpec>) => {
    const params = draft.parameters.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    update({ parameters: params });
  };
  const addParam = () =>
    update({
      parameters: [...draft.parameters, { name: "", prompt: "", default: "" }],
    });
  const removeParam = (idx: number) =>
    update({ parameters: draft.parameters.filter((_, i) => i !== idx) });

  const updateCell = (idx: number, next: DraftCell) =>
    update({ cells: draft.cells.map((c, i) => (i === idx ? next : c)) });
  const addCell = (kind: DraftCell["kind"]) =>
    update({ cells: [...draft.cells, newCell(kind)] });
  const removeCell = (idx: number) =>
    update({ cells: draft.cells.filter((_, i) => i !== idx) });
  const moveCell = (idx: number, direction: -1 | 1) => {
    const j = idx + direction;
    if (j < 0 || j >= draft.cells.length) return;
    const cells = draft.cells.slice();
    [cells[idx], cells[j]] = [cells[j]!, cells[idx]!];
    update({ cells });
  };

  return (
    <div className="create-mop-body create-mop-wizard">
      <section>
        <h3>Metadata</h3>
        <label className="field">
          <span>Title</span>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => update({ title: e.target.value })}
            data-testid="wizard-title"
          />
        </label>
        <label className="field">
          <span>Description</span>
          <input
            type="text"
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            data-testid="wizard-description"
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Vendor</span>
            <select
              value={draft.vendor}
              onChange={(e) => update({ vendor: e.target.value })}
              data-testid="wizard-vendor"
            >
              {VENDOR_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Platform</span>
            <input
              type="text"
              value={draft.platform}
              onChange={(e) => update({ platform: e.target.value })}
              placeholder="iosxe / nxos / junos / eos"
              data-testid="wizard-platform"
            />
          </label>
        </div>
      </section>

      <section>
        <header className="section-header">
          <h3>Parameters</h3>
          <button
            type="button"
            className="library-action"
            onClick={addParam}
            data-testid="wizard-add-param"
          >
            + Add parameter
          </button>
        </header>
        {draft.parameters.length === 0 && (
          <p className="hint">
            Optional. Add parameters to substitute <code>{`{{var}}`}</code> in
            command and assertion cells at run time.
          </p>
        )}
        {draft.parameters.map((p, idx) => (
          <div key={idx} className="param-grid" data-testid={`wizard-param-row-${idx}`}>
            <input
              type="text"
              placeholder="name"
              value={p.name}
              onChange={(e) => updateParam(idx, { name: e.target.value })}
              data-testid={`wizard-param-name-${idx}`}
            />
            <input
              type="text"
              placeholder="prompt"
              value={p.prompt}
              onChange={(e) => updateParam(idx, { prompt: e.target.value })}
            />
            <input
              type="text"
              placeholder="default (optional)"
              value={p.default ?? ""}
              onChange={(e) => updateParam(idx, { default: e.target.value })}
            />
            <button
              type="button"
              className="library-action danger"
              onClick={() => removeParam(idx)}
              aria-label={`Remove parameter ${p.name || idx}`}
              data-testid={`wizard-remove-param-${idx}`}
            >
              ×
            </button>
          </div>
        ))}
      </section>

      <section>
        <header className="section-header">
          <h3>Cells</h3>
          <div className="cell-add-buttons">
            <button
              type="button"
              className="library-action"
              onClick={() => addCell("markdown")}
              data-testid="wizard-add-markdown"
            >
              + Markdown
            </button>
            <button
              type="button"
              className="library-action"
              onClick={() => addCell("command")}
              data-testid="wizard-add-command"
            >
              + Command
            </button>
            <button
              type="button"
              className="library-action"
              onClick={() => addCell("approval")}
              data-testid="wizard-add-approval"
            >
              + Approval
            </button>
            <button
              type="button"
              className="library-action"
              onClick={() => addCell("assertion")}
              data-testid="wizard-add-assertion"
            >
              + Assertion
            </button>
          </div>
        </header>
        <ol className="wizard-cells">
          {draft.cells.map((cell, idx) => (
            <li key={idx} className="wizard-cell-row" data-testid={`wizard-cell-${idx}`}>
              <div className="wizard-cell-controls">
                <span className="wizard-cell-tag">{cell.kind}</span>
                <button
                  type="button"
                  onClick={() => moveCell(idx, -1)}
                  disabled={idx === 0}
                  aria-label="Move cell up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveCell(idx, 1)}
                  disabled={idx === draft.cells.length - 1}
                  aria-label="Move cell down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="library-action danger"
                  onClick={() => removeCell(idx)}
                  aria-label="Remove cell"
                  data-testid={`wizard-remove-cell-${idx}`}
                >
                  Remove
                </button>
              </div>
              <CellEditor
                cell={cell}
                onChange={(next) => updateCell(idx, next)}
                idx={idx}
              />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function CellEditor({
  cell,
  onChange,
  idx,
}: {
  cell: DraftCell;
  onChange: (next: DraftCell) => void;
  idx: number;
}) {
  switch (cell.kind) {
    case "markdown":
      return (
        <textarea
          className="wizard-textarea"
          value={cell.body}
          onChange={(e) => onChange({ kind: "markdown", body: e.target.value })}
          rows={3}
          placeholder="Prose explaining this step…"
          data-testid={`wizard-cell-body-${idx}`}
        />
      );
    case "command":
      return (
        <textarea
          className="wizard-textarea mono"
          value={cell.body}
          onChange={(e) => onChange({ kind: "command", body: e.target.value })}
          rows={4}
          placeholder={"show ip bgp summary\n# multi-line commands ok"}
          data-testid={`wizard-cell-body-${idx}`}
        />
      );
    case "approval":
      return (
        <textarea
          className="wizard-textarea"
          value={cell.body}
          onChange={(e) => onChange({ kind: "approval", body: e.target.value })}
          rows={2}
          placeholder="Operator-facing prompt explaining what's about to happen."
          data-testid={`wizard-cell-body-${idx}`}
        />
      );
    case "assertion": {
      const expectedAsString =
        typeof cell.spec.expected === "string"
          ? cell.spec.expected
          : JSON.stringify(cell.spec.expected);
      return (
        <div className="wizard-assertion">
          <label className="field">
            <span>Command</span>
            <input
              type="text"
              value={cell.spec.command}
              onChange={(e) =>
                onChange({
                  kind: "assertion",
                  spec: { ...cell.spec, command: e.target.value },
                })
              }
              placeholder="show ip bgp summary"
              data-testid={`wizard-assertion-command-${idx}`}
            />
          </label>
          <label className="field">
            <span>JSONPath</span>
            <input
              type="text"
              value={cell.spec.jsonpath}
              onChange={(e) =>
                onChange({
                  kind: "assertion",
                  spec: { ...cell.spec, jsonpath: e.target.value },
                })
              }
              placeholder="$.vrf.default.neighbor['10.0.0.1'].session_state"
              data-testid={`wizard-assertion-jsonpath-${idx}`}
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Operator</span>
              <select
                value={cell.spec.op}
                onChange={(e) =>
                  onChange({
                    kind: "assertion",
                    spec: { ...cell.spec, op: e.target.value as AssertionOp },
                  })
                }
                data-testid={`wizard-assertion-op-${idx}`}
              >
                {ASSERTION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Expected</span>
              <input
                type="text"
                value={expectedAsString}
                onChange={(e) =>
                  onChange({
                    kind: "assertion",
                    spec: { ...cell.spec, expected: e.target.value },
                  })
                }
                placeholder='"Established" or 100 or true'
                data-testid={`wizard-assertion-expected-${idx}`}
              />
            </label>
          </div>
        </div>
      );
    }
  }
}

function RawEditor({
  value,
  onChange,
  preview,
}: {
  value: string;
  onChange: (v: string) => void;
  preview: string;
}) {
  return (
    <div className="create-mop-body create-mop-raw">
      <textarea
        className="wizard-textarea mono raw-md"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={24}
        spellCheck={false}
        data-testid="raw-md-textarea"
      />
      <details className="raw-preview">
        <summary>Preview from wizard state (does not auto-sync)</summary>
        <pre>{preview}</pre>
      </details>
    </div>
  );
}

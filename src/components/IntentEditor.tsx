import { Suspense, lazy, useEffect, useState } from "react";
import { useIntentStore } from "../state/intentStore";
import type { IntentTemplate } from "../lib/drift";
import { intentUpdateMatchMode } from "../lib/drift";
import { SelectorEditor } from "./SelectorEditor";
import "./IntentEditor.css";
import { DEVICE_VENDORS, PLATFORMS_BY_VENDOR } from "../lib/deviceProfiles";

const MonacoEditor = lazy(() =>
  import("./editor/MonacoEditor").then((m) => ({ default: m.MonacoEditor })),
);

type DetailTab = "body" | "vars" | "selector";

const VENDOR_OPTIONS = DEVICE_VENDORS.map((value) => ({
  value,
  label: value[0].toUpperCase() + value.slice(1),
}));

interface Props {
  onClose?: () => void;
}

export function IntentEditor({ onClose: _onClose }: Props = {}) {
  const {
    templates,
    selectedId,
    loading,
    error,
    refresh,
    select,
    create,
    updateBody,
    updateVars,
    updateSelector,
    rename,
    remove,
  } = useIntentStore();
  const [tab, setTab] = useState<DetailTab>("body");
  // window.prompt is blocked in the Tauri webview (returns null), so create
  // and rename use inline inputs instead of native dialogs.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selected: IntentTemplate | undefined = templates.find(
    (t) => t.id === selectedId,
  );

  const handleSubmitNew = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    await create({
      name,
      vendor: "cisco",
      platform: "iosxe",
      kind: "golden",
      body: "! intent body — replace with your golden config\n",
      vars_yaml: "",
      selector: { device_ids: [], tags: [] },
      match_mode: "partial",
    });
    setNewName("");
    setCreating(false);
  };

  const cancelNew = () => {
    setNewName("");
    setCreating(false);
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete "${selected.name}"? This cascades drift_reports.`))
      return;
    await remove(selected.id);
  };

  const startRename = () => {
    if (!selected) return;
    setRenameText(selected.name);
    setRenaming(true);
  };

  const handleSubmitRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const next = renameText.trim();
    if (!next || next === selected.name) {
      setRenaming(false);
      return;
    }
    await rename(selected.id, next);
    setRenaming(false);
  };

  return (
    <div className="intent-editor" data-testid="intent-editor">
      <div className="intent-list">
        <div className="intent-list-header">
          <span>INTENTS ({templates.length})</span>
          <button
            onClick={() => setCreating((c) => !c)}
            data-testid="intent-new"
          >
            + New
          </button>
        </div>
        {creating && (
          <form className="intent-new-form" onSubmit={handleSubmitNew}>
            <input
              autoFocus
              type="text"
              placeholder="Template name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelNew();
              }}
              data-testid="intent-new-input"
            />
            <button type="submit" data-testid="intent-new-save">
              Create
            </button>
            <button type="button" onClick={cancelNew}>
              Cancel
            </button>
          </form>
        )}
        {loading && templates.length === 0 ? (
          <div className="intent-empty">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="intent-empty">
            No intent templates yet. Create one to declare a device's expected
            config.
          </div>
        ) : (
          templates.map((t) => (
            <div
              key={t.id}
              className={`intent-row ${selectedId === t.id ? "selected" : ""}`}
              onClick={() => select(t.id)}
              data-testid={`intent-row-${t.id}`}
            >
              <div className="intent-name">{t.name}</div>
              <div className="intent-meta">
                <span className={`intent-kind-badge ${t.kind}`}>
                  {t.kind.toUpperCase()}
                </span>
                <span>
                  {t.vendor}/{t.platform}
                </span>
                {t.selector.tags.length > 0 && (
                  <span>· tags: {t.selector.tags.join(",")}</span>
                )}
              </div>
            </div>
          ))
        )}
        {error && (
          <div className="intent-empty" style={{ color: "var(--text-primary)" }}>
            {error}
          </div>
        )}
      </div>

      <div className="intent-detail">
        {!selected ? (
          <div className="intent-empty">
            Select an intent to view its body, vars, and selector.
          </div>
        ) : (
          <>
            <div className="intent-detail-header">
              {renaming ? (
                <form
                  className="intent-rename-form"
                  onSubmit={handleSubmitRename}
                >
                  <input
                    autoFocus
                    className="name"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRenaming(false);
                    }}
                    data-testid="intent-rename-input"
                  />
                  <button type="submit" data-testid="intent-rename-save">
                    Save
                  </button>
                  <button type="button" onClick={() => setRenaming(false)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <input
                    className="name"
                    value={selected.name}
                    readOnly
                    onClick={startRename}
                    data-testid="intent-name"
                  />
                  <div className="intent-detail-actions">
                    <button onClick={startRename} data-testid="intent-rename">
                      Rename
                    </button>
                    <button className="danger" onClick={handleDelete}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="intent-meta-grid">
              {/* Kind / vendor / platform are immutable after creation — make
                  a new template to change them. Disabled (not alert-gated,
                  since native dialogs are blocked in the Tauri webview). */}
              <label>Kind</label>
              <select value={selected.kind} disabled data-testid="intent-kind">
                <option value="golden">Golden</option>
                <option value="jinja">Jinja</option>
              </select>
              <label>Vendor</label>
              <select value={selected.vendor} disabled>
                {VENDOR_OPTIONS.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
              <label>Platform</label>
              <select value={selected.platform} disabled>
                {(PLATFORMS_BY_VENDOR[selected.vendor as keyof typeof PLATFORMS_BY_VENDOR] ?? ["generic"]).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <label>Match mode</label>
              <select
                value={selected.match_mode ?? "baseline"}
                onChange={async (e) => {
                  const mode = e.target.value as "baseline" | "partial";
                  await intentUpdateMatchMode(selected.id, mode);
                  await refresh();
                }}
                data-testid="intent-match-mode"
              >
                <option value="partial">Partial — only check the lines in this intent</option>
                <option value="baseline">Baseline — intent is the full device config</option>
              </select>
              <span className="intent-immutable-note">
                Kind, vendor, and platform are fixed after creation.
              </span>
            </div>

            <div className="intent-tab-bar">
              <div
                className={`intent-tab ${tab === "body" ? "active" : ""}`}
                onClick={() => setTab("body")}
                data-testid="intent-tab-body"
              >
                Body
              </div>
              {selected.kind === "jinja" && (
                <div
                  className={`intent-tab ${tab === "vars" ? "active" : ""}`}
                  onClick={() => setTab("vars")}
                  data-testid="intent-tab-vars"
                >
                  Vars (YAML)
                </div>
              )}
              <div
                className={`intent-tab ${tab === "selector" ? "active" : ""}`}
                onClick={() => setTab("selector")}
                data-testid="intent-tab-selector"
              >
                Selector
              </div>
            </div>

            <div className="intent-editor-area">
              <Suspense fallback={<div className="intent-empty">Loading editor…</div>}>
                {tab === "body" && (
                  <MonacoEditor
                    value={selected.body}
                    language={
                      selected.kind === "jinja"
                        ? "django"
                        : monacoLanguageForVendor(selected.vendor)
                    }
                    onChange={(v) => {
                      void updateBody(selected.id, v);
                    }}
                  />
                )}
                {tab === "vars" && selected.kind === "jinja" && (
                  <MonacoEditor
                    value={selected.vars_yaml}
                    language="yaml"
                    onChange={(v) => {
                      void updateVars(selected.id, v);
                    }}
                  />
                )}
                {tab === "selector" && (
                  <SelectorEditor
                    value={selected.selector}
                    onChange={(s) => {
                      void updateSelector(selected.id, s);
                    }}
                  />
                )}
              </Suspense>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function monacoLanguageForVendor(vendor: string): string {
  // Monaco doesn't ship a Cisco config language; fall back to plaintext but
  // still use the editor for syntax structure (folding, search).
  switch (vendor) {
    case "juniper":
      return "json"; // Junos curly-brace config — closest approximation
    default:
      return "plaintext";
  }
}

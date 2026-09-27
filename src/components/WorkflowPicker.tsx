import { useEffect, useMemo, useRef, useState, KeyboardEvent } from "react";
import Fuse from "fuse.js";
import { Workflow, Vendor, workflowUpsert } from "../lib/workflows";
import { useWorkflowsStore } from "../state/workflowsStore";
import { WorkflowExportImport } from "./WorkflowExportImport";
import { WorkflowEditor } from "./WorkflowEditor";
import "./WorkflowPicker.css";

export interface WorkflowPickerProps {
  vendor: Vendor;
  platform: string;
  onSelect: (wf: Workflow, editParamsFirst: boolean) => void;
  onClose: () => void;
  initialAllVendors?: boolean;
}

export function WorkflowPicker({
  vendor,
  platform,
  onSelect,
  onClose,
  initialAllVendors = false,
}: WorkflowPickerProps) {
  const { workflows, loadFor } = useWorkflowsStore();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [allVendors, setAllVendors] = useState(initialAllVendors);
  const [editorOpen, setEditorOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadFor(allVendors ? undefined : vendor, allVendors ? undefined : platform);
  }, [allVendors, vendor, platform, loadFor]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const fuse = useMemo(
    () =>
      new Fuse(workflows, {
        keys: [
          { name: "name", weight: 0.6 },
          { name: "description", weight: 0.2 },
          { name: "tags", weight: 0.2 },
        ],
        threshold: 0.35,
        includeScore: false,
      }),
    [workflows],
  );

  const results = useMemo(() => {
    if (!query.trim()) return workflows;
    return fuse.search(query).map((r) => r.item);
  }, [query, fuse, workflows]);

  useEffect(() => {
    setHighlight(0);
  }, [query, allVendors]);

  // Window-level keyboard handling so the picker responds to keys regardless
  // of where focus lands. Tests dispatch keydown on `window` directly.
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "ArrowDown":
          e.preventDefault();
          setHighlight((h) => Math.min(results.length - 1, h + 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlight((h) => Math.max(0, h - 1));
          break;
        case "Enter": {
          e.preventDefault();
          const wf = results[highlight];
          if (wf) onSelect(wf, e.metaKey === true || e.ctrlKey === true);
          break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [results, highlight, onSelect, onClose]);

  // Stop the input's own keydown from re-bubbling so we don't double-handle.
  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Window listener already handles these; just prevent the input's
    // default behavior for Enter so a parent <form> doesn't submit.
    if (e.key === "Enter") e.preventDefault();
  };

  const handleSaveWorkflow = async (workflow: Workflow) => {
    try {
      await workflowUpsert(workflow);
      setEditorOpen(false);
      // Reload workflows
      loadFor(allVendors ? undefined : vendor, allVendors ? undefined : platform);
    } catch (err) {
      console.error('[WorkflowPicker] failed to save workflow:', err);
      alert(`Failed to save workflow: ${err}`);
    }
  };

  if (editorOpen) {
    return (
      <WorkflowEditor
        workflow={null}
        onSave={handleSaveWorkflow}
        onCancel={() => setEditorOpen(false)}
      />
    );
  }

  return (
    <div
      className="wf-picker-overlay"
      role="dialog"
      aria-label="Workflow picker"
      onClick={onClose}
    >
      <div className="wf-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wf-picker-header">
          <input
            ref={inputRef}
            className="wf-picker-search"
            placeholder="Search workflows…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <div className="wf-picker-scope">
            <span className="wf-picker-scope-chip">
              {allVendors ? "all vendors" : `${vendor}/${platform || "*"}`}
            </span>
            <button
              type="button"
              className="wf-picker-scope-toggle"
              onClick={() => setAllVendors((v) => !v)}
            >
              {allVendors ? "scope" : "all"}
            </button>
          </div>
        </div>
        <div ref={listRef} className="wf-picker-list" role="listbox">
          {results.length === 0 && (
            <div className="wf-picker-empty">No workflows match "{query}"</div>
          )}
          {results.map((wf, i) => (
            <button
              key={wf.id}
              role="option"
              aria-selected={i === highlight}
              className={`wf-picker-item ${i === highlight ? "active" : ""}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => onSelect(wf, false)}
            >
              <div className="wf-picker-item-main">
                <div className="wf-picker-item-name">{wf.name}</div>
                <div className="wf-picker-item-desc">{wf.description}</div>
              </div>
              <div className="wf-picker-item-meta">
                {wf.tags.map((t) => (
                  <span key={t} className="wf-picker-tag">
                    {t}
                  </span>
                ))}
                <span className="wf-picker-steps">
                  {wf.steps.length} step{wf.steps.length === 1 ? "" : "s"}
                </span>
              </div>
            </button>
          ))}
        </div>
        <div className="wf-picker-footer">
          <span>Enter: run</span>
          <span>Cmd+Enter: edit params</span>
          <span>Esc: close</span>
          <span className="wf-picker-footer-spacer" />
          <button
            type="button"
            className="wf-picker-new-btn"
            onClick={() => setEditorOpen(true)}
          >
            + New Workflow
          </button>
          <WorkflowExportImport
            workflow={results[highlight] ?? null}
            onExported={() => {
              /* status banner is owned by App.tsx in a future iteration */
            }}
            onImported={() => {
              loadFor(
                allVendors ? undefined : vendor,
                allVendors ? undefined : platform,
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}

import { useMemo } from "react";
import { useIacStateStore } from "../state/iacStateStore";
import { DriftDetailModal } from "./DriftDetailModal";
import type { StateResource } from "../lib/iacState";
import "./StateDrawer.css";

function groupByType(resources: StateResource[]): Record<string, StateResource[]> {
  const groups: Record<string, StateResource[]> = {};
  for (const r of resources) {
    (groups[r.resourceType] ||= []).push(r);
  }
  return groups;
}

export function StateDrawer() {
  const {
    open, resources, query, loading, error, driftLoading,
    pathDraft, projectPath,
    closeDrawer, setQuery, checkDrift, drift, setPathDraft, setProjectPath,
  } = useIacStateStore();

  const groups = useMemo(() => groupByType(resources), [resources]);

  if (!open) return null;

  const submitPath = () => {
    if (pathDraft.trim() && pathDraft.trim() !== projectPath) {
      void setProjectPath(pathDraft);
    }
  };

  const browse = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: projectPath ?? undefined,
        title: "Select a Terraform project directory",
      });
      if (typeof picked === "string") {
        setPathDraft(picked);
        void setProjectPath(picked);
      }
    } catch {
      // Dialog plugin unavailable (e.g. in tests) — the text field still works.
    }
  };

  return (
    <div className="iac-state-drawer" role="dialog" aria-label="Terraform State">
      <header className="iac-state-drawer__header">
        <span className="iac-state-drawer__title">Terraform State</span>
        <button onClick={() => checkDrift()} disabled={driftLoading}>
          {driftLoading ? "Checking…" : "Check Drift"}
        </button>
        <button aria-label="Close" onClick={closeDrawer}>×</button>
      </header>

      <div className="iac-state-drawer__dir">
        <input
          className="iac-state-drawer__dir-input"
          aria-label="Project directory"
          placeholder="Project directory…"
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitPath(); }}
          onBlur={submitPath}
          spellCheck={false}
        />
        <button className="iac-state-drawer__browse" onClick={() => void browse()}>
          Browse…
        </button>
      </div>

      <input
        className="iac-state-drawer__search"
        placeholder="Search resources…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && <div className="iac-state-drawer__error">{error}</div>}

      {loading ? (
        <div className="iac-state-drawer__loading">Loading…</div>
      ) : resources.length === 0 ? (
        <div className="iac-state-drawer__empty">
          No Terraform state found in <code>{projectPath ?? "this directory"}</code>.
          <br />Edit the path above or click Browse… to pick a project.
        </div>
      ) : (
        <div className="iac-state-drawer__tree">
          {Object.entries(groups).map(([type, items]) => (
            <section key={type}>
              <h4>{type} ({items.length})</h4>
              <ul>
                {items.map((r) => (
                  <li key={r.address} title={r.resourceId ?? ""}>
                    <code>{r.address}</code>
                    {r.resourceId && <span className="iac-state-drawer__id">{r.resourceId}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {drift && drift.hasDrift && <DriftDetailModal />}
    </div>
  );
}

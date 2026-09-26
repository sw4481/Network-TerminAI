import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type RunnableNotebookSummaryDto,
  deleteRunnableNotebook,
  downloadRunnableNotebook,
  exportRunnableNotebookMarkdown,
  importRunnableNotebookMarkdown,
  listRunnableNotebooks,
} from "../../lib/runnableNotebook";
import { CreateNotebookModal } from "./CreateNotebookModal";
import "./NotebookLibrary.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
}

const VENDOR_FILTERS = ["all", "cisco", "juniper", "arista", "generic"] as const;
type VendorFilter = (typeof VENDOR_FILTERS)[number];

export function NotebookLibrary({ open, onClose, onOpen }: Props) {
  const [items, setItems] = useState<RunnableNotebookSummaryDto[]>([]);
  const [filter, setFilter] = useState<VendorFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function refresh() {
    try {
      const list = await listRunnableNotebooks();
      setItems(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((i) => i.vendor === filter);
  }, [items, filter]);

  async function onImportFile() {
    setBusy(true);
    setError(null);
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".md,.mop.md,text/markdown";
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        const text = await f.text();
        await importRunnableNotebookMarkdown(text);
        await refresh();
      };
      input.click();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImportUrl() {
    if (!importUrl) return;
    setBusy(true);
    setError(null);
    try {
      await invoke<string>("notebook_import_url", { url: importUrl });
      setImportUrl("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setBusy(true);
    try {
      await deleteRunnableNotebook(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onExport(item: RunnableNotebookSummaryDto) {
    try {
      const md = await exportRunnableNotebookMarkdown(item.id);
      const safe = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      downloadRunnableNotebook(safe, md);
    } catch (e) {
      setError(String(e));
    }
  }

  if (!open) return null;

  return (
    <div className="notebook-library-backdrop" onClick={onClose} data-testid="notebook-library">
      <div
        className="notebook-library-modal"
        role="dialog"
        aria-label="Notebook Library"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="library-header">
          <h2>Notebook Library</h2>
          <button
            type="button"
            className="library-close"
            onClick={onClose}
            aria-label="Close library"
            data-testid="library-close"
          >
            ×
          </button>
        </header>

        <div className="library-toolbar">
          <div className="vendor-filters" role="tablist" aria-label="Vendor filter">
            {VENDOR_FILTERS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={filter === v}
                className={`filter-chip ${filter === v ? "is-active" : ""}`}
                onClick={() => setFilter(v)}
                data-testid={`filter-${v}`}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="library-import">
            <button
              type="button"
              className="library-action primary"
              onClick={() => setCreateOpen(true)}
              disabled={busy}
              data-testid="new-mop"
            >
              + New MOP
            </button>
            <button
              type="button"
              className="library-action"
              onClick={onImportFile}
              disabled={busy}
              data-testid="import-file"
            >
              Import from file
            </button>
            <input
              type="url"
              placeholder="https://…/notebook.mop.md"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              data-testid="import-url-input"
            />
            <button
              type="button"
              className="library-action"
              onClick={onImportUrl}
              disabled={busy || !importUrl}
              data-testid="import-url-go"
            >
              Import URL
            </button>
          </div>
        </div>

        {error && (
          <div className="library-error" role="alert">
            {error}
          </div>
        )}

        <ul className="library-list" data-testid="library-list">
          {filtered.length === 0 && (
            <li className="library-empty">No notebooks. Import one to get started.</li>
          )}
          {filtered.map((item) => (
            <li key={item.id} className="library-row" data-testid={`library-row-${item.id}`}>
              <div className="library-row-info">
                <div className="library-row-title">{item.title}</div>
                <div className="library-row-meta">
                  {item.vendor ?? "any"}
                  {item.platform ? ` · ${item.platform}` : ""}
                  {` · ${item.cell_count} cells`}
                </div>
                {item.description && (
                  <div className="library-row-desc">{item.description}</div>
                )}
              </div>
              <div className="library-row-actions">
                <button
                  type="button"
                  className="library-action"
                  onClick={() => onOpen(item.id)}
                  data-testid={`open-${item.id}`}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="library-action"
                  onClick={() => onExport(item)}
                  data-testid={`export-${item.id}`}
                >
                  Export
                </button>
                <button
                  type="button"
                  className="library-action danger"
                  onClick={() => onDelete(item.id)}
                  data-testid={`delete-${item.id}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        <CreateNotebookModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => {
            await refresh();
            onOpen(id);
          }}
        />
      </div>
    </div>
  );
}

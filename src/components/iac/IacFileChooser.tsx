import { useCallback, useEffect, useState } from "react";
import { editorListDirectory, editorDeleteFile } from "../../lib/tauri";
import "./IacWizards.css";
import "./IacFileChooser.css";

export type ChooserKind = "resource" | "pipeline";

/**
 * Shown first when the user picks IaC menu → New Resource / New Pipeline. Lets
 * them either create a new one (falls through to the generation wizard) or pick
 * an existing file to Edit (open in the editor) or Delete. This makes the two
 * menu items manage existing IaC, not only create.
 *
 * "resource" lists .tf/.yml at the workspace root; "pipeline" lists CI files
 * (.github/workflows/*.yml and .gitlab-ci.yml) since those live in known spots.
 */
export function IacFileChooser({
  kind,
  rootPath,
  onCreateNew,
  onEdit,
  onClose,
}: {
  kind: ChooserKind;
  rootPath: string | null;
  onCreateNew: () => void;
  onEdit: (filePath: string) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const noun = kind === "pipeline" ? "Pipeline" : "Resource";

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const root = rootPath ?? ".";
      const found: { path: string; name: string }[] = [];
      if (kind === "resource") {
        // .tf / .yml (but not the CI pipeline files) at the workspace root.
        const nodes = await editorListDirectory(root);
        for (const n of nodes) {
          if (n.node_type !== "file") continue;
          if (/\.(tf|ya?ml)$/.test(n.name) && !/^\.gitlab-ci\.ya?ml$/.test(n.name)) {
            found.push({ path: n.path, name: n.name });
          }
        }
      } else {
        // Pipelines: .github/workflows/*.yml and a root .gitlab-ci.yml.
        const nodes = await editorListDirectory(root);
        const gitlab = nodes.find(
          (n) => n.node_type === "file" && /^\.gitlab-ci\.ya?ml$/.test(n.name),
        );
        if (gitlab) found.push({ path: gitlab.path, name: gitlab.name });
        try {
          const wf = await editorListDirectory(`${root.replace(/\/+$/, "")}/.github/workflows`);
          for (const n of wf) {
            if (n.node_type === "file" && /\.ya?ml$/.test(n.name)) {
              found.push({ path: n.path, name: `.github/workflows/${n.name}` });
            }
          }
        } catch {
          /* no .github/workflows dir — fine */
        }
      }
      setFiles(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [kind, rootPath]);

  useEffect(() => {
    void scan();
  }, [scan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleDelete(path: string, name: string) {
    const ok = confirm(`Delete "${name}"?\n\nThis removes it from your local workspace. It stays on GitHub until your next push.`);
    if (!ok) return;
    try {
      await editorDeleteFile(path, rootPath);
      await scan(); // refresh the list
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      className="iac-wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Manage ${noun}s`}
      data-testid="iac-file-chooser"
    >
      <div className="iac-wizard-modal">
        <div className="iac-wizard-title">{noun}s</div>
        <p className="iac-chooser-sub">
          Create a new {noun.toLowerCase()}, or edit / delete an existing one.
        </p>

        <button
          className="iac-chooser-create"
          onClick={onCreateNew}
          data-testid="iac-chooser-create"
        >
          ＋ Create new {noun.toLowerCase()}
        </button>

        <div className="iac-chooser-listwrap">
          {loading && <div className="iac-chooser-empty">Scanning workspace…</div>}
          {error && (
            <div className="iac-wizard-error" data-testid="iac-chooser-error">
              {error}
            </div>
          )}
          {!loading && !error && files.length === 0 && (
            <div className="iac-chooser-empty">
              No existing {noun.toLowerCase()}s found in this workspace.
            </div>
          )}
          {files.map((f) => (
            <div key={f.path} className="iac-chooser-row" data-testid="iac-chooser-row">
              <span className="iac-chooser-name" title={f.path}>
                {f.name}
              </span>
              <div className="iac-chooser-rowactions">
                <button
                  className="iac-chooser-edit"
                  onClick={() => onEdit(f.path)}
                  data-testid="iac-chooser-edit"
                >
                  Edit
                </button>
                <button
                  className="iac-chooser-delete"
                  onClick={() => handleDelete(f.path, f.name)}
                  data-testid="iac-chooser-delete"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="iac-wizard-actions">
          <button className="iac-wizard-cancel" onClick={onClose} data-testid="iac-chooser-close">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

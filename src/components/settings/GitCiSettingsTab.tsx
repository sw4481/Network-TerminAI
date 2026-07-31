import { useState, useEffect } from "react";
import { gitConfigGet, gitConfigSet, type GitConfig } from "../../lib/tauri";
import "./GitCiSettingsTab.css";

type StatusKind = "ok" | "err" | "info";

/**
 * Git / CI defaults used by the IaC Studio "Push to Git" flow. These are
 * app-wide defaults the Push modal prefills — a per-repo remote already set on
 * the workspace (read via git_get_remote) still takes precedence.
 */
export default function GitCiSettingsTab() {
  const [cfg, setCfg] = useState<GitConfig>({
    remote: "",
    branch: "main",
    authorName: "",
    authorEmail: "",
  });
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    gitConfigGet().then((c) => {
      // Keep the sensible default branch if none stored yet.
      setCfg({ branch: "main", ...c });
    });
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await gitConfigSet({
        remote: cfg.remote?.trim() || undefined,
        branch: cfg.branch?.trim() || undefined,
        authorName: cfg.authorName?.trim() || undefined,
        authorEmail: cfg.authorEmail?.trim() || undefined,
      });
      setStatus({ kind: "ok", text: "Git defaults saved." });
    } catch (e) {
      setStatus({ kind: "err", text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="gitci-tab">
      <div className="gitci-header">
        <h2>Git / CI</h2>
        <p className="gitci-subtitle">
          Defaults for the IaC Studio <strong>Push to Git</strong> flow. When you
          push a pipeline, these prefill the confirm dialog. A self-hosted runner
          picks up the job once your code lands on the remote — so pushing is what
          triggers a self-hosted CI run.
        </p>
      </div>

      <div className="gitci-section">
        <h3>Remote</h3>
        <div className="gitci-grid">
          <label htmlFor="gitci-remote">Default remote URL</label>
          <input
            id="gitci-remote"
            type="text"
            value={cfg.remote ?? ""}
            onChange={(e) => setCfg({ ...cfg, remote: e.target.value })}
            placeholder="git@github.com:you/your-repo.git"
          />
          <div className="gitci-field-desc gitci-field--full">
            Where <code>Push to Git</code> sends commits by default. Leave blank to
            use whatever remote the workspace already has.
          </div>

          <label htmlFor="gitci-branch">Default branch</label>
          <input
            id="gitci-branch"
            type="text"
            value={cfg.branch ?? ""}
            onChange={(e) => setCfg({ ...cfg, branch: e.target.value })}
            placeholder="main"
          />
        </div>
      </div>

      <div className="gitci-section">
        <h3>Commit author</h3>
        <div className="gitci-grid">
          <label htmlFor="gitci-author-name">Name</label>
          <input
            id="gitci-author-name"
            type="text"
            value={cfg.authorName ?? ""}
            onChange={(e) => setCfg({ ...cfg, authorName: e.target.value })}
            placeholder="Jane Engineer"
          />

          <label htmlFor="gitci-author-email">Email</label>
          <input
            id="gitci-author-email"
            type="text"
            value={cfg.authorEmail ?? ""}
            onChange={(e) => setCfg({ ...cfg, authorEmail: e.target.value })}
            placeholder="jane@example.com"
          />
          <div className="gitci-field-desc gitci-field--full">
            Used for commits made from the app. If blank, your global git config
            (<code>user.name</code> / <code>user.email</code>) is used.
          </div>
        </div>
      </div>

      <div className="gitci-section">
        <h3>GitHub Actions</h3>
        <div className="gitci-field-desc">
          Connect your GitHub account from the Zed Mode Git panel. TerminAI uses
          GitHub&apos;s device login and keeps the credential in the platform keyring;
          tokens are never returned to this settings page or stored in Git defaults.
        </div>
        {cfg.legacyTokenNeedsReconnect && (
          <div className="gitci-status gitci-status--err">
            A legacy token is quarantined because secure migration was unavailable.
            Reconnect GitHub from the Git panel; the token is not exposed or used.
          </div>
        )}
      </div>

      <div className="gitci-actions">
        <button onClick={save} disabled={saving} className="gitci-btn-primary">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {status && (
        <div className={`gitci-status gitci-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}

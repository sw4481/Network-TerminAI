import { useCallback, useEffect, useState } from "react";
import { githubListRuns, type GhWorkflowRun } from "../../lib/tauri";
import { createBrowserWindow } from "../../lib/browser";
import "./GitHubRunsPanel.css";

const POLL_MS = 15_000;

/** Map a run's status/conclusion to an icon + css modifier. */
function runVisual(run: GhWorkflowRun): { icon: string; kind: string; label: string } {
  if (run.status !== "completed") {
    return { icon: "◐", kind: "running", label: run.status.replace("_", " ") };
  }
  switch (run.conclusion) {
    case "success":
      return { icon: "✓", kind: "ok", label: "success" };
    case "failure":
      return { icon: "✗", kind: "fail", label: "failure" };
    case "cancelled":
      return { icon: "⊘", kind: "cancelled", label: "cancelled" };
    default:
      return { icon: "•", kind: "other", label: run.conclusion ?? "done" };
  }
}

/** Compact relative time from an ISO timestamp (no external dep). */
function relTime(iso: string, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * IaC Studio "Runs" panel — lists recent GitHub Actions workflow runs for the
 * workspace's origin remote. Auto-refreshes every 15s. Clicking a run opens its
 * full log on GitHub in a browser pane. Rust resolves credentials from the
 * secure GitHub connection established in the Zed Mode Git panel.
 */
export function GitHubRunsPanel({
  rootPath,
  onClose,
}: {
  rootPath: string;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<GhWorkflowRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // now is stamped on each fetch so relative times refresh with the list.
  const [now, setNow] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const list = await githubListRuns(rootPath, 20);
      setRuns(list);
      setError(null);
      setNow(Date.parse(new Date().toISOString()) || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const openRun = (url: string) => {
    if (!url) return;
    // Open the run's full log in a standalone browser window.
    void createBrowserWindow(url).catch((e) =>
      setError(`Could not open browser: ${e}`),
    );
  };

  return (
    <div className="ghruns-panel" data-testid="github-runs-panel">
      <div className="ghruns-header">
        <span className="ghruns-title">Pipeline Runs</span>
        <button
          className="ghruns-refresh"
          onClick={() => void refresh()}
          title="Refresh now (auto-refreshes every 15s)"
          data-testid="ghruns-refresh"
        >
          ↻
        </button>
        <button className="ghruns-close" onClick={onClose} title="Close" data-testid="ghruns-close">
          ✕
        </button>
      </div>

      {loading && runs.length === 0 && (
        <div className="ghruns-empty">Loading runs…</div>
      )}

      {error && (
        <div className="ghruns-error" data-testid="ghruns-error">
          {error}
        </div>
      )}

      {!error && !loading && runs.length === 0 && (
        <div className="ghruns-empty">
          No workflow runs yet. Push a pipeline to trigger one.
        </div>
      )}

      <div className="ghruns-list">
        {runs.map((run) => {
          const v = runVisual(run);
          return (
            <button
              key={run.id}
              className="ghruns-row"
              onClick={() => openRun(run.html_url)}
              title="Open this run's full log on GitHub"
              data-testid="ghruns-row"
            >
              <span className={`ghruns-icon ghruns-icon--${v.kind}`}>{v.icon}</span>
              <span className="ghruns-main">
                <span className="ghruns-name">{run.name}</span>
                <span className="ghruns-sub">
                  {run.title || run.event} · {run.branch}
                </span>
              </span>
              <span className="ghruns-time">{relTime(run.created_at, now)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

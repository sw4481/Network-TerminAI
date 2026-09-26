import { useEffect, useState } from "react";
import {
  gitInit,
  gitCommitPaths,
  gitGetRemote,
  gitSetRemote,
  gitPush,
  gitConfigGet,
  type GitCmdResult,
} from "../../lib/tauri";
import "./PushToGitModal.css";

type PushState =
  | { status: "idle" }
  | { status: "working"; note: string }
  | { status: "done"; note: string }
  | { status: "error"; note: string };

/**
 * Confirm-before-push dialog for the IaC Studio. Prefills the remote (from the
 * workspace's existing remote, falling back to the saved Git/CI default), the
 * branch, and an editable commit message. On confirm it runs the same proven
 * sequence the onboarding wizard uses: init → commit → set-remote → push.
 *
 * Pushing is what triggers a self-hosted CI run — the runner picks the job up
 * from the remote once the pipeline file lands there.
 */
export function PushToGitModal({
  rootPath,
  onClose,
}: {
  rootPath: string;
  onClose: () => void;
}) {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [message, setMessage] = useState("Update IaC pipeline");
  const [push, setPush] = useState<PushState>({ status: "idle" });
  const [loaded, setLoaded] = useState(false);

  // Prefill remote: prefer the workspace's configured remote, else the saved
  // Git/CI default from Settings.
  useEffect(() => {
    void (async () => {
      try {
        const existing = await gitGetRemote(rootPath);
        if (existing) {
          setRemoteUrl(existing);
        } else {
          const cfg = await gitConfigGet();
          if (cfg.remote) setRemoteUrl(cfg.remote);
        }
      } catch {
        /* best-effort prefill */
      } finally {
        setLoaded(true);
      }
    })();
  }, [rootPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && push.status !== "working") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, push.status]);

  async function runPush() {
    const fail = (r: GitCmdResult, verb: string) =>
      setPush({
        status: "error",
        note: `${verb} failed: ${r.stderr || r.stdout || "unknown error"}`,
      });
    try {
      setPush({ status: "working", note: "Initializing repository…" });
      const init = await gitInit(rootPath);
      if (!init.ok) return fail(init, "git init");

      setPush({ status: "working", note: "Committing your files…" });
      const commit = await gitCommitPaths(rootPath, [], message.trim() || "Update IaC pipeline");
      if (!commit.ok) return fail(commit, "git commit");

      if (remoteUrl.trim()) {
        setPush({ status: "working", note: "Setting the remote…" });
        const setRemote = await gitSetRemote(rootPath, remoteUrl.trim());
        if (!setRemote.ok) return fail(setRemote, "git remote");
      }

      setPush({ status: "working", note: "Pushing to your Git host…" });
      const pushed = await gitPush(rootPath);
      if (!pushed.ok) return fail(pushed, "git push");

      setPush({
        status: "done",
        note: "Pushed. Your Git host will now run the pipeline on your next PR (a self-hosted runner picks it up automatically).",
      });
    } catch (e) {
      setPush({ status: "error", note: e instanceof Error ? e.message : String(e) });
    }
  }

  const working = push.status === "working";
  const done = push.status === "done";

  return (
    <div className="push-modal-overlay" role="dialog" aria-modal="true" aria-label="Push to Git">
      <div className="push-modal" data-testid="push-to-git-modal">
        <div className="push-modal-title">Push to Git</div>
        <p className="push-modal-sub">
          Commit everything in this workspace and push it. Nothing else changes
          on your devices — this just gets your pipeline onto the Git host.
        </p>

        <div className="push-modal-field">
          <label htmlFor="push-remote">Remote URL</label>
          <input
            id="push-remote"
            data-testid="push-remote"
            value={remoteUrl}
            placeholder="git@github.com:you/your-repo.git"
            onChange={(e) => setRemoteUrl(e.target.value)}
            disabled={working || done}
          />
          <div className="push-modal-hint">
            Leave blank to push to the remote already configured on this folder.
          </div>
        </div>

        <div className="push-modal-field">
          <label htmlFor="push-message">Commit message</label>
          <input
            id="push-message"
            data-testid="push-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={working || done}
          />
        </div>

        {push.status !== "idle" && (
          <div
            className={push.status === "error" ? "push-modal-err" : "push-modal-ok"}
            data-testid="push-status"
          >
            {push.note}
          </div>
        )}

        <div className="push-modal-actions">
          <button
            className="push-modal-cancel"
            onClick={onClose}
            disabled={working}
            data-testid="push-cancel"
          >
            {done ? "Close" : "Cancel"}
          </button>
          {!done && (
            <button
              className="push-modal-confirm"
              onClick={runPush}
              disabled={working || !loaded}
              data-testid="push-confirm"
            >
              {working ? "Pushing…" : "Push ▸"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

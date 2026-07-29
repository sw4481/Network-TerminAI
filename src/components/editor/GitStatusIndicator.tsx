import type { GitRepositorySummary } from "../../lib/tauri";
import "./GitStatusIndicator.css";

export type GitStatusIndicatorProps = {
  summary: GitRepositorySummary | null;
  bufferDirty?: boolean;
};

export function GitStatusIndicator({
  summary,
  bufferDirty = false,
}: GitStatusIndicatorProps) {
  if (!summary) return null;

  const shortHead = summary.headOid?.slice(0, 7) ?? null;
  const branch = summary.branch ?? shortHead ?? "No commits";
  const dirty = summary.dirty || bufferDirty;
  const changedFiles = Math.max(summary.changedFiles, bufferDirty ? 1 : 0);
  const state = !summary.headOid
    ? dirty
      ? `No commits · ${changedFiles} changed`
      : "No commits"
    : dirty
      ? `${changedFiles} changed`
      : "Clean";
  const title = [
    summary.branch ? `Branch ${summary.branch}` : "Detached HEAD",
    `${summary.stagedFiles} staged`,
    `${summary.unstagedFiles} unstaged`,
    `${summary.untrackedFiles} untracked`,
  ].join(" · ");

  return (
    <span
      className="editor-git-status"
      data-testid="editor-git-status"
      data-dirty={String(dirty)}
      title={title}
      aria-label={`Git ${branch}, ${state}`}
    >
      <span aria-hidden="true">⎇</span>
      <span className="editor-git-branch">{branch}</span>
      <span
        className={`editor-git-state${
          dirty ? " editor-git-state--dirty" : ""
        }`}
      >
        {state}
      </span>
    </span>
  );
}

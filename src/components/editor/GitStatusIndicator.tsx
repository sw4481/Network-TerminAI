import type { GitRepositorySummary } from "../../lib/tauri";
import "./GitStatusIndicator.css";

export type GitStatusIndicatorProps = {
  summary: GitRepositorySummary | null;
  bufferDirty?: boolean;
  onToggle?: () => void;
  panelOpen?: boolean;
};

export function GitStatusIndicator({
  summary,
  bufferDirty = false,
  onToggle,
  panelOpen = false,
}: GitStatusIndicatorProps) {
  if (!summary && !onToggle) return null;

  const shortHead = summary?.headOid?.slice(0, 7) ?? null;
  const branch = summary?.branch ?? shortHead ?? (summary ? "No commits" : "Git");
  const dirty = Boolean(summary?.dirty || bufferDirty);
  const changedFiles = Math.max(summary?.changedFiles ?? 0, bufferDirty ? 1 : 0);
  const state = !summary
    ? "No repository"
    : !summary.headOid
    ? dirty
      ? `No commits · ${changedFiles} changed`
      : "No commits"
    : dirty
      ? `${changedFiles} changed`
      : "Clean";
  const title = [
    summary?.branch ? `Branch ${summary.branch}` : summary ? "Detached HEAD" : "Open Git panel",
    `${summary?.stagedFiles ?? 0} staged`,
    `${summary?.unstagedFiles ?? 0} unstaged`,
    `${summary?.untrackedFiles ?? 0} untracked`,
  ].join(" · ");

  const content = (
    <>
      <span aria-hidden="true">⎇</span>
      <span className="editor-git-branch">{branch}</span>
      <span
        className={`editor-git-state${
          dirty ? " editor-git-state--dirty" : ""
        }`}
      >
        {state}
      </span>
    </>
  );

  const shared = {
    className: "editor-git-status",
    "data-testid": "editor-git-status",
    "data-dirty": String(dirty),
    title,
    "aria-label": summary
      ? `Git ${branch}, ${state}`
      : "Git panel, No repository",
  } as const;

  return onToggle ? (
    <button
      type="button"
      {...shared}
      onClick={onToggle}
      aria-pressed={panelOpen}
    >
      {content}
    </button>
  ) : (
    <span
      {...shared}
    >
      {content}
    </span>
  );
}

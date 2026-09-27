import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gitAddRemote,
  gitCloneRepository,
  gitCommitDetail,
  gitHistoricalDiff,
  gitInitializeRepository,
  gitListBranches,
  gitRemoveRemote,
  gitRepositoryCommit,
  gitRepositoryFetch,
  gitRepositoryHistory,
  gitRepositoryPull,
  gitRepositoryPush,
  gitStagePaths,
  gitStagedDiff,
  gitSwitchBranch,
  gitUnstagePaths,
  gitUnstagedDiff,
  gitUpdateRemote,
  githubAccountStatus,
  githubAuthCancel,
  githubAuthPoll,
  githubAuthStart,
  githubDisconnect,
  githubListRepositories,
  type GitBranch,
  type GitChangeEntry,
  type GitCommitDetail,
  type GitCommitSummary,
  type GitDiffPayload,
  type GitHubAccount,
  type GitHubDeviceAuthorization,
  type GitHubRepository,
  type GitOperationResult,
} from "../../lib/tauri";
import {
  clampGitPanelWidth,
  repositoryRelativePath,
  type GitPanelTab,
} from "./gitPanelState";
import type { GitPanelController } from "./useGitPanel";
import "./GitPanel.css";

type OpenDiff = (review: { path: string; payload: GitDiffPayload }) => void;

export function GitPanel({
  controller,
  workspaceRoot,
  focusedFile,
  getBufferContents,
  onOpenDiff,
  onOpenWorkspace,
  onRepositoryChanged,
}: {
  controller: GitPanelController;
  workspaceRoot: string;
  focusedFile: string | null;
  getBufferContents: (absolutePath: string) => string | undefined;
  onOpenDiff: OpenDiff;
  onOpenWorkspace: (root: string) => void;
  onRepositoryChanged: () => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const active = controller.activeRepository;
  const state = controller.repositoryState;
  const busy = controller.operation !== null;
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [selectedRemote, setSelectedRemote] = useState("");

  useEffect(() => {
    if (!active) {
      setBranches([]);
      setSelectedRemote("");
      return;
    }
    void gitListBranches(active.root)
      .then(setBranches)
      .catch((error) => controller.setError(String(error)));
    const upstreamRemote = active.upstream?.split("/", 1)[0];
    setSelectedRemote(
      upstreamRemote ??
        active.remotes.find((remote) => remote.name === "origin")?.name ??
        active.remotes[0]?.name ??
        "",
    );
  }, [active?.root, active?.head]);

  const run = useCallback(
    async (
      label: string,
      action: () => Promise<GitOperationResult>,
      options?: { rescan?: boolean },
    ) => {
      const result = await controller.perform(label, action, options);
      if (result?.ok) onRepositoryChanged();
      return result;
    },
    [controller, onRepositoryChanged],
  );

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const panel = panelRef.current;
    const host = panel?.parentElement;
    if (!panel || !host) return;
    const right = panel.getBoundingClientRect().right;
    const hostWidth = host.getBoundingClientRect().width;
    const move = (pointer: PointerEvent) => {
      controller.setWidth(clampGitPanelWidth(right - pointer.clientX, hostWidth));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const openStagedDiff = async (change: GitChangeEntry) => {
    if (!active) return;
    try {
      onOpenDiff({
        path: change.path,
        payload: await gitStagedDiff(active.root, change.path),
      });
    } catch (error) {
      controller.setError(String(error));
    }
  };

  const openUnstagedDiff = async (change: GitChangeEntry) => {
    if (!active) return;
    const absolutePath = `${active.root.replace(/\/$/, "")}/${change.path}`;
    try {
      onOpenDiff({
        path: change.path,
        payload: await gitUnstagedDiff(
          active.root,
          change.path,
          getBufferContents(absolutePath),
        ),
      });
    } catch (error) {
      controller.setError(String(error));
    }
  };

  const switchBranch = async (name: string) => {
    if (!active) return;
    const branch = branches.find(
      (candidate) => `${candidate.kind}:${candidate.name}` === name,
    );
    if (!branch || branch.current) return;
    const result = await run("Switching branch", () =>
      gitSwitchBranch(active.root, branch),
    );
    if (result?.ok) setBranches(await gitListBranches(active.root));
  };

  return (
    <aside
      ref={panelRef}
      className="git-panel"
      style={{ width: controller.preferences.width }}
      aria-label="Git panel"
      data-testid="git-panel"
    >
      <div
        className="git-panel-resize-handle"
        onPointerDown={beginResize}
        data-testid="git-panel-resize-handle"
      />
      <header className="git-panel-header">
        <div className="git-panel-repository-row">
          <span className="git-tree-icon" aria-hidden="true">
            ⎇
          </span>
          <select
            value={active?.root ?? ""}
            onChange={(event) =>
              controller.setActiveRepository(event.target.value || null)
            }
            aria-label="Active Git repository"
            disabled={controller.repositories.length === 0 || busy}
          >
            {controller.repositories.length === 0 && (
              <option value="">No repository</option>
            )}
            {controller.repositories.map((repository) => (
              <option key={repository.root} value={repository.root}>
                {repository.name} — {repository.branch ?? "detached"}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void controller.rescan()}
            disabled={controller.loading || busy || !workspaceRoot}
            title="Rescan repositories"
            aria-label="Rescan repositories"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={() => controller.setOpen(false)}
            aria-label="Close Git panel"
          >
            ✕
          </button>
        </div>

        {active && (
          <div className="git-panel-network-row">
            <select
              value={
                branches.find((branch) => branch.current)
                  ? `local:${branches.find((branch) => branch.current)!.name}`
                  : ""
              }
              onChange={(event) => void switchBranch(event.target.value)}
              disabled={busy}
              aria-label="Switch Git branch"
            >
              {!branches.some((branch) => branch.current) && (
                <option value="">Detached HEAD</option>
              )}
              {branches.map((branch) => (
                <option
                  key={`${branch.kind}:${branch.name}`}
                  value={`${branch.kind}:${branch.name}`}
                >
                  {branch.kind === "remote" ? "remote/" : ""}
                  {branch.name}
                </option>
              ))}
            </select>
            <select
              value={selectedRemote}
              onChange={(event) => setSelectedRemote(event.target.value)}
              disabled={busy || active.remotes.length === 0}
              aria-label="Git remote"
            >
              {active.remotes.length === 0 && <option value="">No remote</option>}
              {active.remotes.map((remote) => (
                <option key={remote.name} value={remote.name}>
                  {remote.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !selectedRemote}
              onClick={() =>
                void run("Fetching", () =>
                  gitRepositoryFetch(active.root, selectedRemote),
                )
              }
            >
              Fetch
            </button>
            <button
              type="button"
              disabled={busy || !selectedRemote}
              onClick={() =>
                void run("Pulling", () =>
                  gitRepositoryPull(active.root, selectedRemote),
                )
              }
            >
              Pull
            </button>
            <button
              type="button"
              disabled={busy || !selectedRemote}
              onClick={() =>
                void run("Pushing", () =>
                  gitRepositoryPush(active.root, selectedRemote),
                )
              }
            >
              Push
            </button>
          </div>
        )}
      </header>

      <nav className="git-panel-tabs" aria-label="Git panel tabs">
        {(["changes", "history", "setup"] as GitPanelTab[]).map((tab) => (
          <button
            type="button"
            key={tab}
            className={controller.preferences.selectedTab === tab ? "active" : ""}
            onClick={() => controller.setSelectedTab(tab)}
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>

      {controller.operation && (
        <div className="git-panel-operation" role="status">
          {controller.operation}…
        </div>
      )}
      {controller.error && (
        <div className="git-panel-error" role="alert">
          <span>{controller.error}</span>
          <button type="button" onClick={() => controller.setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="git-panel-body">
        {!active || !state ? (
          <RepositorySetup
            controller={controller}
            workspaceRoot={workspaceRoot}
            busy={busy}
            run={run}
            onOpenWorkspace={onOpenWorkspace}
          />
        ) : controller.preferences.selectedTab === "changes" ? (
          <ChangesView
            repoRoot={active.root}
            changes={state.changes}
            busy={busy}
            run={run}
            onOpenStagedDiff={openStagedDiff}
            onOpenUnstagedDiff={openUnstagedDiff}
          />
        ) : controller.preferences.selectedTab === "history" ? (
          <HistoryView
            repoRoot={active.root}
            focusedFile={focusedFile}
            busy={busy}
            onOpenDiff={onOpenDiff}
            onError={controller.setError}
          />
        ) : (
          <RepositorySetup
            controller={controller}
            workspaceRoot={workspaceRoot}
            busy={busy}
            run={run}
            onOpenWorkspace={onOpenWorkspace}
          />
        )}
      </div>
    </aside>
  );
}

function ChangesView({
  repoRoot,
  changes,
  busy,
  run,
  onOpenStagedDiff,
  onOpenUnstagedDiff,
}: {
  repoRoot: string;
  changes: GitChangeEntry[];
  busy: boolean;
  run: (
    label: string,
    action: () => Promise<GitOperationResult>,
  ) => Promise<GitOperationResult | null>;
  onOpenStagedDiff: (change: GitChangeEntry) => Promise<void>;
  onOpenUnstagedDiff: (change: GitChangeEntry) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const staged = changes.filter((change) => change.indexStatus !== null);
  const unstaged = changes.filter((change) => change.worktreeStatus !== null);
  const commit = async () => {
    const result = await run("Committing", () =>
      gitRepositoryCommit(repoRoot, message),
    );
    if (result?.ok) setMessage("");
  };

  return (
    <div className="git-changes-view">
      <ChangeGroup
        title="Staged"
        changes={staged}
        checked
        busy={busy}
        actionLabel="Unstage All"
        onAction={() => void run("Unstaging all", () => gitUnstagePaths(repoRoot, []))}
        onToggle={(change) =>
          void run("Unstaging file", () => gitUnstagePaths(repoRoot, [change.path]))
        }
        onOpen={onOpenStagedDiff}
      />
      <ChangeGroup
        title="Changes"
        changes={unstaged}
        checked={false}
        busy={busy}
        actionLabel="Stage All"
        onAction={() => void run("Staging all", () => gitStagePaths(repoRoot, []))}
        onToggle={(change) =>
          void run("Staging file", () => gitStagePaths(repoRoot, [change.path]))
        }
        onOpen={onOpenUnstagedDiff}
      />
      {changes.length === 0 && (
        <div className="git-panel-empty">Working tree is clean.</div>
      )}
      <div className="git-commit-box">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              if (!busy && message.trim()) void commit();
            }
          }}
          placeholder="Commit message"
          aria-label="Commit message"
          disabled={busy}
        />
        <button
          type="button"
          disabled={busy || !message.trim()}
          onClick={() => void commit()}
        >
          Commit
        </button>
        <small>
          With an empty index, only modified/deleted tracked files are staged.
          Untracked files are never auto-staged.
        </small>
      </div>
    </div>
  );
}

function ChangeGroup({
  title,
  changes,
  checked,
  busy,
  actionLabel,
  onAction,
  onToggle,
  onOpen,
}: {
  title: string;
  changes: GitChangeEntry[];
  checked: boolean;
  busy: boolean;
  actionLabel: string;
  onAction: () => void;
  onToggle: (change: GitChangeEntry) => void;
  onOpen: (change: GitChangeEntry) => Promise<void>;
}) {
  return (
    <section className="git-change-group">
      <header>
        <strong>
          {title} <span>{changes.length}</span>
        </strong>
        <button type="button" disabled={busy || changes.length === 0} onClick={onAction}>
          {actionLabel}
        </button>
      </header>
      {changes.map((change) => {
        const status = checked ? change.indexStatus : change.worktreeStatus;
        return (
          <div
            className={`git-change-row${change.conflict ? " git-change-row--conflict" : ""}`}
            key={`${title}:${change.path}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={() => onToggle(change)}
              aria-label={`${checked ? "Unstage" : "Stage"} ${change.path}`}
            />
            <button
              type="button"
              className="git-change-open"
              disabled={busy}
              onClick={() => void onOpen(change)}
              title={change.previousPath ? `${change.previousPath} → ${change.path}` : change.path}
            >
              <span className={`git-change-status git-change-status--${status}`}>
                {change.conflict ? "!" : statusCode(status)}
              </span>
              <span>{change.path}</span>
              {change.conflict && <em>Conflict</em>}
            </button>
          </div>
        );
      })}
    </section>
  );
}

function HistoryView({
  repoRoot,
  focusedFile,
  busy,
  onOpenDiff,
  onError,
}: {
  repoRoot: string;
  focusedFile: string | null;
  busy: boolean;
  onOpenDiff: OpenDiff;
  onError: (error: string | null) => void;
}) {
  const filePath = repositoryRelativePath(focusedFile, repoRoot);
  const [scope, setScope] = useState<"repository" | "file">("repository");
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);

  const load = useCallback(
    async (append: boolean) => {
      setLoading(true);
      try {
        const skip = append ? commits.length : 0;
        const next = await gitRepositoryHistory(
          repoRoot,
          scope === "file" ? filePath : null,
          skip,
          100,
        );
        setCommits((current) => (append ? [...current, ...next] : next));
        setHasMore(next.length === 100);
        if (!append) {
          setSelectedSha(null);
          setDetail(null);
        }
      } catch (error) {
        onError(String(error));
      } finally {
        setLoading(false);
      }
    },
    [commits.length, filePath, onError, repoRoot, scope],
  );

  useEffect(() => {
    if (scope === "file" && !filePath) setScope("repository");
  }, [filePath, scope]);

  useEffect(() => {
    void load(false);
    // Reset history only when repository/scope/current file changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, scope, filePath]);

  const selectCommit = async (commit: GitCommitSummary) => {
    setSelectedSha(commit.sha);
    try {
      setDetail(await gitCommitDetail(repoRoot, commit.sha));
    } catch (error) {
      onError(String(error));
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commits;
    return commits.filter((commit) =>
      [commit.message, commit.author, commit.authorEmail ?? "", commit.sha, commit.shortSha]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [commits, query]);

  return (
    <div className="git-history-view">
      <div className="git-history-controls">
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as "repository" | "file")}
          disabled={busy || loading}
          aria-label="Git history scope"
        >
          <option value="repository">Repository</option>
          <option value="file" disabled={!filePath}>
            Current File
          </option>
        </select>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search history"
          aria-label="Search Git history"
        />
      </div>
      <div className="git-history-list">
        {visible.map((commit) => (
          <button
            type="button"
            key={commit.sha}
            className={selectedSha === commit.sha ? "active" : ""}
            onClick={() => void selectCommit(commit)}
          >
            <strong>{commit.message}</strong>
            <span>
              {commit.author} ·{" "}
              <time
                dateTime={new Date(commit.timestamp * 1000).toISOString()}
                title={new Date(commit.timestamp * 1000).toLocaleString()}
              >
                {relativeTime(commit.timestamp)}
              </time>
            </span>
            <code>{commit.shortSha}</code>
          </button>
        ))}
        {!loading && visible.length === 0 && (
          <div className="git-panel-empty">No commits match this view.</div>
        )}
      </div>
      {hasMore && (
        <button
          type="button"
          className="git-history-load-more"
          disabled={loading}
          onClick={() => void load(true)}
        >
          {loading ? "Loading…" : "Load More"}
        </button>
      )}
      {detail && (
        <section className="git-commit-files">
          <header>
            <strong>{detail.commit.shortSha}</strong> changed files
          </header>
          {detail.files.map((file) => (
            <button
              type="button"
              key={`${detail.commit.sha}:${file.path}`}
              onClick={async () => {
                try {
                  onOpenDiff({
                    path: file.path,
                    payload: await gitHistoricalDiff(
                      repoRoot,
                      detail.commit.sha,
                      file.path,
                      file.previousPath,
                    ),
                  });
                } catch (error) {
                  onError(String(error));
                }
              }}
            >
              <span>{statusCode(file.status)}</span>
              {file.path}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function RepositorySetup({
  controller,
  workspaceRoot,
  busy,
  run,
  onOpenWorkspace,
}: {
  controller: GitPanelController;
  workspaceRoot: string;
  busy: boolean;
  run: (
    label: string,
    action: () => Promise<GitOperationResult>,
    options?: { rescan?: boolean },
  ) => Promise<GitOperationResult | null>;
  onOpenWorkspace: (root: string) => void;
}) {
  const active = controller.activeRepository;
  const [cloneUrl, setCloneUrl] = useState("");
  const [remoteName, setRemoteName] = useState("origin");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteDrafts, setRemoteDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setRemoteDrafts(
      Object.fromEntries(
        (active?.remotes ?? []).map((remote) => [
          remote.name,
          remote.fetchUrl ?? "",
        ]),
      ),
    );
  }, [active?.root, active?.remotes]);

  const addLocal = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Add Local Git Repository",
    });
    if (typeof selected === "string") controller.addLocalRepository(selected);
  };

  const cloneToPickedWorkspace = async (url: string) => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose an empty clone destination",
    });
    if (typeof selected !== "string") return;
    const result = await run(
      "Cloning repository",
      () => gitCloneRepository(url, selected, true),
      { rescan: false },
    );
    if (result?.ok && result.repository) {
      onOpenWorkspace(result.repository.repository.root);
    }
  };

  return (
    <div className="git-setup-view">
      <section>
        <header>
          <strong>Local Repositories</strong>
          <div>
            <button type="button" onClick={() => void controller.rescan()} disabled={busy}>
              Rescan
            </button>
            <button type="button" onClick={() => void addLocal()} disabled={busy}>
              Add Local
            </button>
          </div>
        </header>
        {controller.repositories.map((repository) => (
          <div className="git-setup-repository" key={repository.root}>
            <button
              type="button"
              onClick={() => controller.setActiveRepository(repository.root)}
            >
              <strong>{repository.name}</strong>
              <span>{repository.root}</span>
            </button>
            {controller.preferences.additionalRepositories.includes(repository.root) && (
              <button
                type="button"
                onClick={() => controller.removeLocalRepository(repository.root)}
                aria-label={`Remove ${repository.name} from Git panel`}
              >
                −
              </button>
            )}
          </div>
        ))}
        {controller.preferences.additionalRepositories
          .filter(
            (root) =>
              !controller.repositories.some(
                (repository) => repository.root === root,
              ),
          )
          .map((root) => (
            <div className="git-setup-repository" key={`unavailable:${root}`}>
              <span className="git-setup-unavailable">
                <strong>Unavailable repository</strong>
                <span>{root}</span>
              </span>
              <button
                type="button"
                onClick={() => controller.removeLocalRepository(root)}
                aria-label={`Remove unavailable repository ${root}`}
              >
                −
              </button>
            </div>
          ))}
        {controller.repositories.length === 0 && (
          <div className="git-panel-empty">
            <p>This workspace is not inside a Git repository.</p>
            <button
              type="button"
              disabled={busy || !workspaceRoot}
              onClick={() =>
                void run(
                  "Initializing repository",
                  () => gitInitializeRepository(workspaceRoot),
                  { rescan: true },
                )
              }
            >
              Initialize Workspace
            </button>
          </div>
        )}
      </section>

      <section>
        <header>
          <strong>Clone</strong>
        </header>
        <input
          type="url"
          value={cloneUrl}
          onChange={(event) => setCloneUrl(event.target.value)}
          placeholder="https://github.com/owner/repository.git"
          aria-label="Repository clone URL"
        />
        <div className="git-setup-actions">
          <button
            type="button"
            disabled={busy || !workspaceRoot || !cloneUrl.trim()}
            onClick={() =>
              void run(
                "Cloning into workspace",
                () => gitCloneRepository(cloneUrl.trim(), workspaceRoot, true),
                { rescan: true },
              )
            }
          >
            Clone Here
          </button>
          <button
            type="button"
            disabled={busy || !cloneUrl.trim()}
            onClick={() => void cloneToPickedWorkspace(cloneUrl.trim())}
          >
            Clone as Workspace
          </button>
        </div>
      </section>

      {active && (
        <section>
          <header>
            <strong>Remotes</strong>
          </header>
          {active.remotes.map((remote) => (
            <div className="git-remote-row" key={remote.name}>
              <code>{remote.name}</code>
              <input
                value={remoteDrafts[remote.name] ?? ""}
                onChange={(event) =>
                  setRemoteDrafts((current) => ({
                    ...current,
                    [remote.name]: event.target.value,
                  }))
                }
                aria-label={`${remote.name} remote URL`}
              />
              <button
                type="button"
                disabled={busy || !remoteDrafts[remote.name]?.trim()}
                onClick={() =>
                  void run(
                    "Updating remote",
                    () =>
                      gitUpdateRemote(
                        active.root,
                        remote.name,
                        remoteDrafts[remote.name].trim(),
                      ),
                    { rescan: true },
                  )
                }
              >
                Save
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Remove remote “${remote.name}”?`)) {
                    void run(
                      "Removing remote",
                      () => gitRemoveRemote(active.root, remote.name),
                      { rescan: true },
                    );
                  }
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="git-remote-add">
            <input
              value={remoteName}
              onChange={(event) => setRemoteName(event.target.value)}
              placeholder="origin"
              aria-label="New remote name"
            />
            <input
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              placeholder="git@github.com:owner/repo.git"
              aria-label="New remote URL"
            />
            <button
              type="button"
              disabled={busy || !remoteName.trim() || !remoteUrl.trim()}
              onClick={async () => {
                const result = await run(
                  "Adding remote",
                  () =>
                    gitAddRemote(active.root, remoteName.trim(), remoteUrl.trim()),
                  { rescan: true },
                );
                if (result?.ok) setRemoteUrl("");
              }}
            >
              Add
            </button>
          </div>
        </section>
      )}

      <GitHubSection
        busy={busy}
        workspaceRoot={workspaceRoot}
        run={run}
        onOpenWorkspace={onOpenWorkspace}
        onError={controller.setError}
      />
    </div>
  );
}

function GitHubSection({
  busy,
  workspaceRoot,
  run,
  onOpenWorkspace,
  onError,
}: {
  busy: boolean;
  workspaceRoot: string;
  run: (
    label: string,
    action: () => Promise<GitOperationResult>,
    options?: { rescan?: boolean },
  ) => Promise<GitOperationResult | null>;
  onOpenWorkspace: (root: string) => void;
  onError: (error: string | null) => void;
}) {
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [authorization, setAuthorization] =
    useState<GitHubDeviceAuthorization | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);

  useEffect(() => {
    void githubAccountStatus()
      .then(setAccount)
      .catch((error) => setAuthMessage(String(error)));
  }, []);

  useEffect(() => {
    if (!authorization) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await githubAuthPoll(authorization.authorizationId);
        if (cancelled) return;
        setAuthMessage(result.message);
        if (result.status === "connected" && result.account) {
          setAccount(result.account);
          setAuthorization(null);
          return;
        }
        if (["denied", "expired", "cancelled"].includes(result.status)) {
          setAuthorization(null);
          return;
        }
        timer = setTimeout(
          () => void poll(),
          Math.max(1, result.retryAfter ?? authorization.interval) * 1000,
        );
      } catch (error) {
        if (!cancelled) {
          setAuthMessage(String(error));
          setAuthorization(null);
        }
      }
    };
    timer = setTimeout(() => void poll(), authorization.interval * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [authorization]);

  const connect = async (sessionOnly: boolean) => {
    setAuthMessage(null);
    try {
      setAuthorization(await githubAuthStart(sessionOnly));
    } catch (error) {
      setAuthMessage(String(error));
    }
  };

  const loadRepositories = useCallback(
    async (nextPage: number, append: boolean) => {
      setLoadingRepos(true);
      try {
        const result = await githubListRepositories(nextPage, query);
        setRepositories((current) =>
          append ? [...current, ...result.repositories] : result.repositories,
        );
        setPage(result.page);
        setHasMore(result.hasMore);
      } catch (error) {
        onError(String(error));
      } finally {
        setLoadingRepos(false);
      }
    },
    [onError, query],
  );

  useEffect(() => {
    if (account) void loadRepositories(1, false);
  }, [account?.login]);

  const cloneAsWorkspace = async (repository: GitHubRepository) => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: `Choose an empty destination for ${repository.name}`,
    });
    if (typeof selected !== "string") return;
    const result = await run(
      "Cloning GitHub repository",
      () => gitCloneRepository(repository.cloneUrl, selected, true),
      { rescan: false },
    );
    if (result?.ok && result.repository) {
      onOpenWorkspace(result.repository.repository.root);
    }
  };

  return (
    <section className="github-connect-section">
      <header>
        <strong>GitHub</strong>
      </header>
      {!account ? (
        <div className="github-connect-actions">
          <p>
            Connect with GitHub&apos;s device flow. No client secret or token enters
            the webview.
          </p>
          <button type="button" disabled={busy} onClick={() => void connect(false)}>
            Connect Securely
          </button>
          <button type="button" disabled={busy} onClick={() => void connect(true)}>
            Connect for This Session
          </button>
          {authorization && (
            <div className="github-device-code" role="status">
              <span>Enter this code on the GitHub page that opened:</span>
              <code>{authorization.userCode}</code>
              <button
                type="button"
                onClick={() => {
                  void githubAuthCancel(authorization.authorizationId);
                  setAuthorization(null);
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {authMessage && <div className="git-panel-note">{authMessage}</div>}
        </div>
      ) : (
        <>
          <div className="github-account-row">
            <span>
              <strong>{account.name ?? account.login}</strong>
              <small>
                @{account.login} ·{" "}
                {account.storage === "session" ? "session only" : "platform keyring"}
              </small>
            </span>
            <button
              type="button"
              onClick={async () => {
                try {
                  await githubDisconnect();
                  setAccount(null);
                  setRepositories([]);
                } catch (error) {
                  onError(String(error));
                }
              }}
            >
              Disconnect
            </button>
          </div>
          {account.storageWarning && (
            <div className="git-panel-note">{account.storageWarning}</div>
          )}
          <div className="github-repository-search">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadRepositories(1, false);
              }}
              placeholder="Search your repositories"
              aria-label="Search GitHub repositories"
            />
            <button
              type="button"
              disabled={loadingRepos}
              onClick={() => void loadRepositories(1, false)}
            >
              Search
            </button>
          </div>
          <div className="github-repository-list">
            {repositories.map((repository) => (
              <article key={repository.id}>
                <div>
                  <strong>{repository.fullName}</strong>
                  <span>{repository.private ? "Private" : "Public"}</span>
                  {repository.description && <p>{repository.description}</p>}
                </div>
                <div>
                  <button
                    type="button"
                    disabled={busy || !workspaceRoot}
                    onClick={() =>
                      void run(
                        "Cloning GitHub repository",
                        () =>
                          gitCloneRepository(
                            repository.cloneUrl,
                            workspaceRoot,
                            true,
                          ),
                        { rescan: true },
                      )
                    }
                  >
                    Clone Here
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void cloneAsWorkspace(repository)}
                  >
                    Open Clone
                  </button>
                </div>
              </article>
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              disabled={loadingRepos}
              onClick={() => void loadRepositories(page + 1, true)}
            >
              {loadingRepos ? "Loading…" : "Load More Repositories"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function statusCode(status: string | null): string {
  switch (status) {
    case "added":
    case "untracked":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "typechange":
      return "T";
    default:
      return "M";
  }
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

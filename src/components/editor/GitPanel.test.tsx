import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitCommitSummary,
  GitDiffPayload,
  GitOperationResult,
  GitRepositoryDescriptor,
  GitRepositoryState,
} from "../../lib/tauri";
import { GitPanel } from "./GitPanel";
import type { GitPanelController } from "./useGitPanel";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  gitAddRemote: vi.fn(),
  gitCloneRepository: vi.fn(),
  gitCommitDetail: vi.fn(),
  gitHistoricalDiff: vi.fn(),
  gitInitializeRepository: vi.fn(),
  gitListBranches: vi.fn(),
  gitRemoveRemote: vi.fn(),
  gitRepositoryCommit: vi.fn(),
  gitRepositoryFetch: vi.fn(),
  gitRepositoryHistory: vi.fn(),
  gitRepositoryPull: vi.fn(),
  gitRepositoryPush: vi.fn(),
  gitStagePaths: vi.fn(),
  gitStagedDiff: vi.fn(),
  gitSwitchBranch: vi.fn(),
  gitUnstagePaths: vi.fn(),
  gitUnstagedDiff: vi.fn(),
  gitUpdateRemote: vi.fn(),
  githubAccountStatus: vi.fn(),
  githubAuthCancel: vi.fn(),
  githubAuthPoll: vi.fn(),
  githubAuthStart: vi.fn(),
  githubDisconnect: vi.fn(),
  githubListRepositories: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../../lib/tauri", () => mocks);

const repository: GitRepositoryDescriptor = {
  root: "/repo",
  name: "repo",
  branch: "main",
  head: "abcdef",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  remotes: [
    {
      name: "origin",
      fetchUrl: "https://github.com/org/repo.git",
      pushUrl: "https://github.com/org/repo.git",
    },
  ],
};

const repositoryState: GitRepositoryState = {
  repository,
  changes: [
    {
      path: "src/a.ts",
      previousPath: null,
      indexStatus: "modified",
      worktreeStatus: "modified",
      conflict: false,
    },
    {
      path: "new.ts",
      previousPath: null,
      indexStatus: null,
      worktreeStatus: "untracked",
      conflict: false,
    },
  ],
};

const diffPayload: GitDiffPayload = {
  originalLabel: "old",
  modifiedLabel: "new",
  original: "old",
  modified: "new",
  language: "typescript",
  binary: false,
  oversized: false,
  originalSize: 3,
  modifiedSize: 3,
};

function result(
  state: GitRepositoryState | null = repositoryState,
): GitOperationResult {
  return {
    ok: true,
    message: "ok",
    stdout: "",
    stderr: "",
    repository: state,
  };
}

function controller(
  overrides: Partial<GitPanelController> & {
    selectedTab?: "changes" | "history" | "setup";
  } = {},
): GitPanelController {
  const selectedTab = overrides.selectedTab ?? "changes";
  const perform = vi.fn(
    async (_label: string, action: () => Promise<GitOperationResult>) =>
      action(),
  );
  return {
    preferences: {
      open: true,
      width: 360,
      selectedTab,
      diffStyle: "split",
      activeRepository: repository.root,
      additionalRepositories: [],
    },
    repositories: [repository],
    activeRepository: repository,
    repositoryState,
    loading: false,
    error: null,
    operation: null,
    setOpen: vi.fn(),
    setWidth: vi.fn(),
    setSelectedTab: vi.fn(),
    setDiffStyle: vi.fn(),
    setActiveRepository: vi.fn(),
    setError: vi.fn(),
    rescan: vi.fn().mockResolvedValue([repository]),
    refreshState: vi.fn().mockResolvedValue(repositoryState),
    perform,
    addLocalRepository: vi.fn(),
    removeLocalRepository: vi.fn(),
    ...overrides,
  } as unknown as GitPanelController;
}

function renderPanel(
  value = controller(),
  onOpenDiff = vi.fn(),
  onRepositoryChanged = vi.fn(),
) {
  return {
    onOpenDiff,
    onRepositoryChanged,
    ...render(
      <GitPanel
        controller={value}
        workspaceRoot="/repo"
        focusedFile="/repo/src/a.ts"
        getBufferContents={() => "unsaved buffer"}
        onOpenDiff={onOpenDiff}
        onOpenWorkspace={vi.fn()}
        onRepositoryChanged={onRepositoryChanged}
      />,
    ),
  };
}

describe("GitPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const successful = result();
    for (const mock of [
      mocks.gitAddRemote,
      mocks.gitCloneRepository,
      mocks.gitInitializeRepository,
      mocks.gitRemoveRemote,
      mocks.gitRepositoryCommit,
      mocks.gitRepositoryFetch,
      mocks.gitRepositoryPull,
      mocks.gitRepositoryPush,
      mocks.gitStagePaths,
      mocks.gitSwitchBranch,
      mocks.gitUnstagePaths,
      mocks.gitUpdateRemote,
    ]) {
      mock.mockResolvedValue(successful);
    }
    mocks.gitListBranches.mockResolvedValue([
      {
        name: "main",
        fullName: "refs/heads/main",
        kind: "local",
        current: true,
        target: "abcdef",
        upstream: "origin/main",
      },
    ]);
    mocks.gitStagedDiff.mockResolvedValue(diffPayload);
    mocks.gitUnstagedDiff.mockResolvedValue(diffPayload);
    mocks.gitHistoricalDiff.mockResolvedValue(diffPayload);
    mocks.githubAccountStatus.mockResolvedValue(null);
    mocks.githubListRepositories.mockResolvedValue({
      repositories: [],
      page: 1,
      hasMore: false,
    });
  });

  it("shows index and worktree edits in both groups and stages whole files", async () => {
    const { onOpenDiff } = renderPanel();

    expect(screen.getAllByText("src/a.ts")).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "Stage src/a.ts" }));
    await waitFor(() =>
      expect(mocks.gitStagePaths).toHaveBeenCalledWith("/repo", ["src/a.ts"]),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Unstage src/a.ts" }));
    await waitFor(() =>
      expect(mocks.gitUnstagePaths).toHaveBeenCalledWith("/repo", ["src/a.ts"]),
    );

    const pathRows = screen.getAllByText("src/a.ts");
    fireEvent.click(pathRows[0].closest("button")!);
    await waitFor(() =>
      expect(onOpenDiff).toHaveBeenCalledWith({
        path: "src/a.ts",
        payload: diffPayload,
      }),
    );
    fireEvent.click(pathRows[1].closest("button")!);
    await waitFor(() =>
      expect(mocks.gitUnstagedDiff).toHaveBeenCalledWith(
        "/repo",
        "src/a.ts",
        "unsaved buffer",
      ),
    );
  });

  it("commits through the repository service and disables mutations while busy", async () => {
    const value = controller();
    const { rerender } = renderPanel(value);
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "Ship phase six" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() =>
      expect(mocks.gitRepositoryCommit).toHaveBeenCalledWith(
        "/repo",
        "Ship phase six",
      ),
    );

    const busy = controller({ operation: "Fetching" });
    rerender(
      <GitPanel
        controller={busy}
        workspaceRoot="/repo"
        focusedFile="/repo/src/a.ts"
        getBufferContents={() => undefined}
        onOpenDiff={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onRepositoryChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Fetch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });

  it("offers initialize and clone recovery when the workspace has no repository", async () => {
    const empty = controller({
      repositories: [],
      activeRepository: null,
      repositoryState: null,
      preferences: {
        ...controller().preferences,
        activeRepository: null,
      },
    });
    const { onRepositoryChanged } = renderPanel(empty);

    fireEvent.click(
      screen.getByRole("button", { name: "Initialize Workspace" }),
    );
    await waitFor(() =>
      expect(mocks.gitInitializeRepository).toHaveBeenCalledWith("/repo"),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Repository clone URL" }),
      {
        target: { value: "https://github.com/org/repo.git" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Clone Here" }));
    await waitFor(() =>
      expect(mocks.gitCloneRepository).toHaveBeenCalledWith(
        "https://github.com/org/repo.git",
        "/repo",
        true,
      ),
    );
    await waitFor(() => expect(onRepositoryChanged).toHaveBeenCalled());
  });

  it("lets an unavailable manually added repository be removed after a rescan error", () => {
    const empty = controller({
      repositories: [],
      activeRepository: null,
      repositoryState: null,
      error: "The selected folder is not a Git repository",
      preferences: {
        ...controller().preferences,
        activeRepository: null,
        additionalRepositories: ["/missing/repo"],
      },
    });
    renderPanel(empty);

    expect(screen.getByText("Unavailable repository")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove unavailable repository /missing/repo",
      }),
    );
    expect(empty.removeLocalRepository).toHaveBeenCalledWith("/missing/repo");
  });

  it("loads current-file history in pages of 100 and filters it locally", async () => {
    const commits: GitCommitSummary[] = Array.from(
      { length: 100 },
      (_, index) => ({
        sha: `sha-${index}`,
        shortSha: `s${index}`,
        message: index === 42 ? "Needle commit" : `Commit ${index}`,
        author: "Alice",
        authorEmail: "alice@example.com",
        timestamp: 1_700_000_000 + index,
        parents: [],
      }),
    );
    mocks.gitRepositoryHistory.mockResolvedValue(commits);
    const value = controller({ selectedTab: "history" });
    renderPanel(value);

    fireEvent.change(
      screen.getByRole("combobox", { name: "Git history scope" }),
      {
        target: { value: "file" },
      },
    );
    await waitFor(() =>
      expect(mocks.gitRepositoryHistory).toHaveBeenLastCalledWith(
        "/repo",
        "src/a.ts",
        0,
        100,
      ),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search Git history" }),
      {
        target: { value: "needle" },
      },
    );
    expect(screen.getByText("Needle commit")).toBeInTheDocument();
    expect(screen.queryByText("Commit 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await waitFor(() =>
      expect(mocks.gitRepositoryHistory).toHaveBeenLastCalledWith(
        "/repo",
        "src/a.ts",
        100,
        100,
      ),
    );
  });
});

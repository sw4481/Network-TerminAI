import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: invokeMock,
}));

import {
  gitCloneRepository,
  gitDiscoverRepositories,
  gitHistoricalDiff,
  gitRepositoryCommit,
  gitRepositoryFetch,
  gitRepositoryHistory,
  gitRepositoryPull,
  gitRepositoryPush,
  gitStagePaths,
  gitSwitchBranch,
  gitUnstagePaths,
  gitUnstagedDiff,
  githubAuthPoll,
  githubAuthStart,
  githubListRepositories,
  githubListRuns,
  type GitBranch,
} from "./tauri";

describe("Zed Git panel Tauri bridge", () => {
  beforeEach(() => invokeMock.mockReset().mockResolvedValue(undefined));

  it("uses typed repository mutation and review payloads", async () => {
    const branch: GitBranch = {
      name: "main",
      fullName: "refs/heads/main",
      kind: "local",
      current: false,
      target: "abc",
      upstream: "origin/main",
    };

    await gitDiscoverRepositories("/workspace", ["/outside/repo"]);
    await gitStagePaths("/repo", ["src/a.ts"]);
    await gitUnstagePaths("/repo", []);
    await gitRepositoryCommit("/repo", "message");
    await gitCloneRepository("https://github.com/org/repo.git", "/clone", true);
    await gitSwitchBranch("/repo", branch);
    await gitRepositoryFetch("/repo", "origin");
    await gitRepositoryPull("/repo");
    await gitRepositoryPush("/repo", "origin");
    await gitRepositoryHistory("/repo", "src/a.ts", 100);
    await gitUnstagedDiff("/repo", "src/a.ts", "unsaved buffer");
    await gitHistoricalDiff("/repo", "abc", "new.ts", "old.ts");

    expect(invokeMock.mock.calls).toEqual([
      ["git_discover_repositories", {
        workspacePath: "/workspace",
        additionalPaths: ["/outside/repo"],
      }],
      ["git_stage_paths", { repoPath: "/repo", paths: ["src/a.ts"] }],
      ["git_unstage_paths", { repoPath: "/repo", paths: [] }],
      ["git_repository_commit", { repoPath: "/repo", message: "message" }],
      ["git_clone_repository", {
        url: "https://github.com/org/repo.git",
        target: "/clone",
        intoExisting: true,
      }],
      ["git_switch_branch", { repoPath: "/repo", branch }],
      ["git_repository_fetch", { repoPath: "/repo", remote: "origin" }],
      ["git_repository_pull", { repoPath: "/repo", remote: null }],
      ["git_repository_push", { repoPath: "/repo", remote: "origin" }],
      ["git_repository_history", {
        repoPath: "/repo",
        filePath: "src/a.ts",
        skip: 100,
        limit: 100,
      }],
      ["git_unstaged_diff", {
        repoPath: "/repo",
        filePath: "src/a.ts",
        bufferContents: "unsaved buffer",
      }],
      ["git_historical_diff", {
        repoPath: "/repo",
        sha: "abc",
        filePath: "new.ts",
        previousPath: "old.ts",
      }],
    ]);
  });

  it("never accepts or returns a frontend GitHub token argument", async () => {
    await githubAuthStart(false);
    await githubAuthPoll("authorization-1");
    await githubListRepositories(2, "network");
    await githubListRuns("/repo", 20);

    expect(invokeMock.mock.calls).toEqual([
      ["github_auth_start", { sessionOnly: false }],
      ["github_auth_poll", { authorizationId: "authorization-1" }],
      ["github_list_repositories", { page: 2, query: "network" }],
      ["github_list_runs", { cwd: "/repo", limit: 20 }],
    ]);
    expect(JSON.stringify(invokeMock.mock.calls).toLowerCase()).not.toContain(
      '"token"',
    );
  });
});

import { describe, expect, it } from "vitest";
import type { GitRepositoryDescriptor } from "../../lib/tauri";
import {
  chooseActiveRepository,
  clampGitPanelWidth,
  isGitPanelToggleShortcut,
  loadGitPanelPreferences,
  pathInsideRepository,
  repositoryRelativePath,
  saveGitPanelPreferences,
} from "./gitPanelState";

function repository(root: string): GitRepositoryDescriptor {
  const segments = root.split("/");
  return {
    root,
    name: segments[segments.length - 1] ?? "repo",
    branch: "main",
    head: "abcdef0",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    remotes: [],
  };
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("Zed Git panel preferences", () => {
  it("persists panel layout and review choices per workspace", () => {
    const memory = storage();
    const expected = {
      open: true,
      width: 444,
      selectedTab: "history" as const,
      diffStyle: "unified" as const,
      activeRepository: "/workspace/nested",
      additionalRepositories: ["/outside/repo"],
    };

    saveGitPanelPreferences("/workspace", expected, memory);

    expect(loadGitPanelPreferences("/workspace", memory)).toEqual(expected);
    expect(loadGitPanelPreferences("/other", memory).open).toBe(false);
  });

  it("constrains resize to 280px through 55 percent of the editor", () => {
    expect(clampGitPanelWidth(100, 1_000)).toBe(280);
    expect(clampGitPanelWidth(420, 1_000)).toBe(420);
    expect(clampGitPanelWidth(900, 1_000)).toBe(550);
  });

  it("owns Cmd/Ctrl+Shift+G only in Zed Mode", () => {
    const shortcut = {
      key: "G",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      repeat: false,
    };
    expect(isGitPanelToggleShortcut(shortcut, "zed")).toBe(true);
    expect(isGitPanelToggleShortcut(shortcut, "classic")).toBe(false);
    expect(
      isGitPanelToggleShortcut({ ...shortcut, metaKey: false, ctrlKey: true }, "zed"),
    ).toBe(true);
    expect(isGitPanelToggleShortcut({ ...shortcut, shiftKey: false }, "zed"))
      .toBe(false);
  });
});

describe("Zed Git active repository selection", () => {
  const repositories = [
    repository("/workspace"),
    repository("/workspace/packages/nested"),
    repository("/outside/repo"),
  ];

  it("prefers the deepest repository containing the focused file", () => {
    expect(
      chooseActiveRepository(
        repositories,
        "/workspace/packages/nested/src/index.ts",
        "/outside/repo",
        "/workspace",
      ),
    ).toBe("/workspace/packages/nested");
  });

  it("falls back through remembered repository and workspace root", () => {
    expect(
      chooseActiveRepository(repositories, null, "/outside/repo", "/workspace"),
    ).toBe("/outside/repo");
    expect(
      chooseActiveRepository(repositories, null, "/missing", "/workspace"),
    ).toBe("/workspace");
  });

  it("normalizes separators without accepting sibling path prefixes", () => {
    expect(pathInsideRepository("/repo/src/a.ts", "/repo")).toBe(true);
    expect(pathInsideRepository("/repository/a.ts", "/repo")).toBe(false);
    expect(repositoryRelativePath("C:\\repo\\src\\a.ts", "C:\\repo")).toBe(
      "src/a.ts",
    );
  });
});

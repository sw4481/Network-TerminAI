import type { GitRepositoryDescriptor } from "../../lib/tauri";

export type GitPanelTab = "changes" | "history" | "setup";
export type GitDiffStyle = "split" | "unified";

export type GitPanelPreferences = {
  open: boolean;
  width: number;
  selectedTab: GitPanelTab;
  diffStyle: GitDiffStyle;
  activeRepository: string | null;
  additionalRepositories: string[];
};

export const DEFAULT_GIT_PANEL_PREFERENCES: GitPanelPreferences = {
  open: false,
  width: 360,
  selectedTab: "changes",
  diffStyle: "split",
  activeRepository: null,
  additionalRepositories: [],
};

const STORAGE_PREFIX = "terminai.zed.git-panel.v1:";

function storageKey(workspaceRoot: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(workspaceRoot || "untitled")}`;
}

export function clampGitPanelWidth(width: number, editorWidth: number): number {
  const max = Math.max(280, Math.floor(editorWidth * 0.55));
  return Math.min(max, Math.max(280, Math.round(width)));
}

export function isGitPanelToggleShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat"
  >,
  mode: string,
): boolean {
  return (
    mode === "zed" &&
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    !event.repeat &&
    event.key.toLowerCase() === "g"
  );
}

export function loadGitPanelPreferences(
  workspaceRoot: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): GitPanelPreferences {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(workspaceRoot)) ?? "{}") as
      | Partial<GitPanelPreferences>
      | null;
    const selectedTab = ["changes", "history", "setup"].includes(
      parsed?.selectedTab ?? "",
    )
      ? parsed!.selectedTab!
      : DEFAULT_GIT_PANEL_PREFERENCES.selectedTab;
    const diffStyle = parsed?.diffStyle === "unified" ? "unified" : "split";
    return {
      ...DEFAULT_GIT_PANEL_PREFERENCES,
      ...parsed,
      open: Boolean(parsed?.open),
      width: Math.max(280, Number(parsed?.width) || 360),
      selectedTab,
      diffStyle,
      activeRepository:
        typeof parsed?.activeRepository === "string"
          ? parsed.activeRepository
          : null,
      additionalRepositories: Array.isArray(parsed?.additionalRepositories)
        ? parsed.additionalRepositories.filter(
            (path): path is string => typeof path === "string" && path.length > 0,
          )
        : [],
    };
  } catch {
    return { ...DEFAULT_GIT_PANEL_PREFERENCES };
  }
}

export function saveGitPanelPreferences(
  workspaceRoot: string,
  preferences: GitPanelPreferences,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(storageKey(workspaceRoot), JSON.stringify(preferences));
}

function normalized(path: string): string {
  const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return navigator.userAgent.includes("Windows") ? value.toLowerCase() : value;
}

export function pathInsideRepository(path: string, repositoryRoot: string): boolean {
  const candidate = normalized(path);
  const root = normalized(repositoryRoot);
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function repositoryRelativePath(
  path: string | null | undefined,
  repositoryRoot: string,
): string | null {
  if (!path || !pathInsideRepository(path, repositoryRoot)) return null;
  const candidate = path.replace(/\\/g, "/");
  const root = repositoryRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return candidate === root ? "" : candidate.slice(root.length + 1);
}

/**
 * Focused file wins, then remembered selection, then the repository containing
 * the workspace root, then the first deterministic discovery result.
 */
export function chooseActiveRepository(
  repositories: GitRepositoryDescriptor[],
  focusedFile: string | null,
  rememberedRoot: string | null,
  workspaceRoot: string,
): string | null {
  const focused = focusedFile
    ? repositories
        .filter((repository) => pathInsideRepository(focusedFile, repository.root))
        .sort((left, right) => right.root.length - left.root.length)[0]
    : undefined;
  if (focused) return focused.root;

  if (rememberedRoot && repositories.some((repo) => repo.root === rememberedRoot)) {
    return rememberedRoot;
  }

  const containingWorkspace = repositories
    .filter((repository) => pathInsideRepository(workspaceRoot, repository.root))
    .sort((left, right) => right.root.length - left.root.length)[0];
  return containingWorkspace?.root ?? repositories[0]?.root ?? null;
}

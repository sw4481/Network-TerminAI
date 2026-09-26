export const EDITOR_LSP_OPEN_LOCATION_EVENT = "editor-lsp-open-location";
export const EDITOR_WORKSPACE_SYMBOL_SEARCH_EVENT =
  "ccie:open-workspace-symbol-search";

export type EditorLspOpenLocation = {
  tabId: string;
  uri: string;
  position: { line: number; column: number };
};

export function fileUriToPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return null;
    let path = decodeURIComponent(url.pathname);
    if (url.hostname) path = `//${url.hostname}${path}`;
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

export function pathIsWithinWorkspace(
  filePath: string,
  workspaceRoot: string,
): boolean {
  const file = normalizePath(filePath);
  const root = normalizePath(workspaceRoot);
  return file === root || file.startsWith(`${root}/`);
}

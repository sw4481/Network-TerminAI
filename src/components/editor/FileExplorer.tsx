import React, { useState, useEffect, useMemo } from "react";
import {
  FileNode,
  editorListDirectory,
  editorCreateFile,
  editorCreateDirectory,
  type GitFileStatus,
  type GitStatusKind,
} from "../../lib/tauri";
import { FileContextMenu } from "./FileContextMenu";
import "./FileExplorer.css";

type FileExplorerProps = {
  rootPath: string | null;
  /** Bump to force the root tree to reload (e.g. after a wizard writes a file). */
  refreshKey?: number;
  expandedDirs: Set<string>;
  onSelectFile: (path: string) => void | Promise<void>;
  onToggleDir: (path: string) => void;
  onSelectWorkspace?: () => void;
  gitStatus?: GitFileStatus[];
};

function parentDirectory(path: string): string {
  const withoutTrailingSeparator = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(
    withoutTrailingSeparator.lastIndexOf("/"),
    withoutTrailingSeparator.lastIndexOf("\\"),
  );
  return separatorIndex > 0
    ? withoutTrailingSeparator.slice(0, separatorIndex)
    : withoutTrailingSeparator;
}

function joinPath(directory: string, name: string): string {
  const withoutTrailingSeparator = directory.replace(/[\\/]+$/, "");
  const separator =
    directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${withoutTrailingSeparator}${separator}${name}`;
}

function updateNodeChildren(
  nodes: FileNode[],
  targetPath: string,
  children: FileNode[],
): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children };
    }
    if (node.children) {
      return {
        ...node,
        children: updateNodeChildren(node.children, targetPath, children),
      };
    }
    return node;
  });
}

export function FileExplorer({
  rootPath,
  refreshKey,
  expandedDirs,
  onSelectFile,
  onToggleDir,
  onSelectWorkspace,
  gitStatus,
}: FileExplorerProps) {
  const [rootTree, setRootTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    targetPath: string;
    targetType: "file" | "directory";
    position: { x: number; y: number };
  } | null>(null);
  // Inline creation row targeting the selected directory. window.prompt() is
  // blocked in Tauri's WKWebView, so we render an input.
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [newName, setNewName] = useState("");
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);
  const [selectedDirectoryPath, setSelectedDirectoryPath] = useState<
    string | null
  >(rootPath);
  const [createParentPath, setCreateParentPath] = useState<string | null>(null);

  useEffect(() => {
    setSelectedNodePath(null);
    setSelectedDirectoryPath(rootPath);
    setCreateParentPath(null);
    setCreating(null);
    setNewName("");
  }, [rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    void loadDirectory(rootPath);
  }, [rootPath, refreshKey]);

  // Close context menu on outside click
  useEffect(() => {
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handler);
      return () => document.removeEventListener("click", handler);
    }
  }, [contextMenu]);

  const loadDirectory = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const nodes = await editorListDirectory(path);
      setRootTree(nodes);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  // Open the inline creation row. window.prompt() is unavailable in the
  // Tauri webview, so name entry happens in a rendered input instead.
  const startCreate = (kind: "file" | "folder") => {
    if (!rootPath) return;
    setNewName("");
    setCreateParentPath(selectedDirectoryPath ?? rootPath);
    setCreating(kind);
  };

  const cancelCreate = () => {
    setCreating(null);
    setNewName("");
    setCreateParentPath(null);
  };

  const refreshDirectory = async (path: string) => {
    if (path === rootPath) {
      await loadDirectory(path);
      return;
    }
    const children = await editorListDirectory(path);
    setRootTree((tree) => updateNodeChildren(tree, path, children));
  };

  // Commit under the selected directory, refresh that directory, and open a
  // newly-created file in the focused editor pane.
  const commitCreate = async () => {
    const name = newName.trim();
    const parentPath = createParentPath ?? selectedDirectoryPath ?? rootPath;
    if (!rootPath || !parentPath || !creating || !name) {
      cancelCreate();
      return;
    }
    const path = joinPath(parentPath, name);
    try {
      if (creating === "file") {
        await editorCreateFile(path, rootPath);
      } else {
        await editorCreateDirectory(path, rootPath);
      }
      await refreshDirectory(parentPath);
      setSelectedNodePath(path);
      if (creating === "file") {
        setSelectedDirectoryPath(parentPath);
        await onSelectFile(path);
      } else {
        setSelectedDirectoryPath(path);
      }
      cancelCreate();
    } catch (err) {
      alert(`Failed to create ${creating}: ${err}`);
    }
  };

  const loadDirectoryChildren = async (node: FileNode): Promise<FileNode[]> => {
    try {
      return await editorListDirectory(node.path);
    } catch {
      return [];
    }
  };

  const handleNodeClick = async (node: FileNode) => {
    setSelectedNodePath(node.path);
    if (node.node_type === "file") {
      setSelectedDirectoryPath(parentDirectory(node.path));
      await onSelectFile(node.path);
    } else {
      setSelectedDirectoryPath(node.path);
      onToggleDir(node.path);
      // Lazy load children if expanding
      if (!expandedDirs.has(node.path) && !node.children) {
        const children = await loadDirectoryChildren(node);
        // Update the tree with loaded children
        setRootTree((tree) => updateNodeChildren(tree, node.path, children));
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      targetPath: node.path,
      targetType: node.node_type,
      position: { x: e.clientX, y: e.clientY },
    });
  };

  // Git statuses arrive as repo-relative paths. Rebuild as a Map keyed by the
  // absolute path (prefixing with rootPath) so node lookup is O(1).
  const gitStatusByAbsPath = useMemo(() => {
    const map = new Map<string, GitStatusKind>();
    if (!gitStatus || !rootPath) return map;
    for (const entry of gitStatus) {
      map.set(`${rootPath.replace(/\/$/, "")}/${entry.path}`, entry.status);
    }
    return map;
  }, [gitStatus, rootPath]);

  const renderNode = (node: FileNode, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedDirs.has(node.path);
    const isDirectory = node.node_type === "directory";
    const git = gitStatusByAbsPath.get(node.path);

    return (
      <div key={node.path}>
        <div
          className={`file-node${selectedNodePath === node.path ? " selected" : ""}${git ? ` git-${git}` : ""}`}
          style={{ paddingLeft: `${depth * 16}px` }}
          onClick={() => handleNodeClick(node)}
          onContextMenu={(e) => handleContextMenu(e, node)}
          data-testid={`file-node-${node.node_type}`}
          aria-selected={selectedNodePath === node.path}
        >
          <span className="file-icon">{getFileIcon(node)}</span>
          <span className="file-name">{node.name}</span>
          {git && (
            <span className="git-status-badge" title={git}>
              {git[0].toUpperCase()}
            </span>
          )}
        </div>
        {isDirectory && isExpanded && node.children && (
          <div className="file-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return <div className="file-explorer-loading">Loading...</div>;
  }

  if (error) {
    return <div className="file-explorer-error">Error: {error}</div>;
  }

  if (!rootPath) {
    return (
      <div className="file-explorer-empty">
        <span>No workspace folder selected</span>
        {onSelectWorkspace && (
          <button type="button" onClick={onSelectWorkspace}>
            Select Workspace Folder
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span className="explorer-title">Explorer</span>
        <div className="explorer-actions">
          <button
            onClick={() => startCreate("file")}
            title="New File"
            data-testid="explorer-new-file"
          >
            +📄
          </button>
          <button
            onClick={() => startCreate("folder")}
            title="New Folder"
            data-testid="explorer-new-folder"
          >
            +📁
          </button>
        </div>
      </div>
      {creating && (
        <div className="explorer-create-row" data-testid="explorer-create-row">
          <span className="file-icon">
            {creating === "folder" ? "📁" : "📄"}
          </span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void commitCreate();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelCreate();
              }
            }}
            onBlur={cancelCreate}
            placeholder={creating === "folder" ? "folder name" : "file name"}
            title={`Create in ${createParentPath ?? selectedDirectoryPath ?? rootPath}`}
            autoFocus
            data-testid="explorer-create-input"
          />
        </div>
      )}
      <div className="file-tree">
        {rootTree.map((node) => renderNode(node))}
      </div>

      {contextMenu && (
        <FileContextMenu
          targetPath={contextMenu.targetPath}
          targetType={contextMenu.targetType}
          position={contextMenu.position}
          workspaceRoot={rootPath}
          onClose={() => setContextMenu(null)}
          onRefresh={() => rootPath && loadDirectory(rootPath)}
        />
      )}
    </div>
  );
}

function getFileIcon(node: FileNode): string {
  if (node.node_type === "directory") {
    return "📁";
  }

  // File extension to icon mapping
  const ext = node.name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "py":
      return "🐍";
    case "js":
    case "jsx":
      return "📜";
    case "ts":
    case "tsx":
      return "🔷";
    case "json":
      return "📋";
    case "md":
      return "📝";
    case "html":
      return "🌐";
    case "css":
      return "🎨";
    case "rs":
      return "🦀";
    case "go":
      return "🐹";
    case "yaml":
    case "yml":
      return "⚙️";
    case "xml":
      return "📄";
    case "sh":
    case "bash":
    case "zsh":
      return "🐚";
    case "sql":
      return "🗄️";
    case "toml":
      return "⚙️";
    default:
      return "📄";
  }
}

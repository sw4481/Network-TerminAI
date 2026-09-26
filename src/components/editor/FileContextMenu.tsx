import { useState } from "react";
import {
  editorCreateFile,
  editorDeleteFile,
  editorRenameFile,
  editorCreateDirectory,
} from "../../lib/tauri";
import "./FileContextMenu.css";

type FileContextMenuProps = {
  targetPath: string;
  targetType: "file" | "directory";
  position: { x: number; y: number };
  /**
   * Workspace root the editor tab was opened against. Forwarded to the
   * backend so it can validate that file-mutation paths stay inside the
   * workspace (final security review — Finding 2).
   */
  workspaceRoot?: string | null;
  onClose: () => void;
  onRefresh: () => void;
};

export function FileContextMenu({
  targetPath,
  targetType,
  position,
  workspaceRoot,
  onClose,
  onRefresh,
}: FileContextMenuProps) {
  const [showRename, setShowRename] = useState(false);
  const [newName, setNewName] = useState("");

  const handleDelete = async () => {
    const confirmed = confirm(
      `Delete ${targetType} "${targetPath.split("/").pop()}"?\n\nThis action cannot be undone.`
    );
    if (!confirmed) return;

    try {
      await editorDeleteFile(targetPath, workspaceRoot);
      onRefresh();
      onClose();
    } catch (err) {
      alert(`Failed to delete: ${err}`);
    }
  };

  const handleRename = async () => {
    if (!newName.trim()) return;

    const dir = targetPath.split("/").slice(0, -1).join("/");
    const newPath = `${dir}/${newName}`;

    try {
      await editorRenameFile(targetPath, newPath, workspaceRoot);
      onRefresh();
      onClose();
    } catch (err) {
      alert(`Failed to rename: ${err}`);
    }
  };

  const handleNewFile = async () => {
    const fileName = prompt("New file name:");
    if (!fileName) return;

    const basePath =
      targetType === "directory"
        ? targetPath
        : targetPath.split("/").slice(0, -1).join("/");
    const newPath = `${basePath}/${fileName}`;

    try {
      await editorCreateFile(newPath, workspaceRoot);
      onRefresh();
      onClose();
    } catch (err) {
      alert(`Failed to create file: ${err}`);
    }
  };

  const handleNewFolder = async () => {
    const folderName = prompt("New folder name:");
    if (!folderName) return;

    const basePath =
      targetType === "directory"
        ? targetPath
        : targetPath.split("/").slice(0, -1).join("/");
    const newPath = `${basePath}/${folderName}`;

    try {
      await editorCreateDirectory(newPath, workspaceRoot);
      onRefresh();
      onClose();
    } catch (err) {
      alert(`Failed to create folder: ${err}`);
    }
  };

  return (
    <div
      className="file-context-menu"
      style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()}
      data-testid="file-context-menu"
    >
      {showRename ? (
        <div className="rename-input-container">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
              if (e.key === "Escape") {
                setShowRename(false);
                setNewName("");
              }
            }}
            placeholder="New name"
            autoFocus
            data-testid="rename-input"
          />
          <button onClick={handleRename} data-testid="rename-confirm">
            ✓
          </button>
          <button
            onClick={() => {
              setShowRename(false);
              setNewName("");
            }}
            data-testid="rename-cancel"
          >
            ✕
          </button>
        </div>
      ) : (
        <>
          {targetType === "directory" && (
            <>
              <button onClick={handleNewFile} data-testid="menu-new-file">
                📄 New File
              </button>
              <button onClick={handleNewFolder} data-testid="menu-new-folder">
                📁 New Folder
              </button>
              <div className="menu-separator"></div>
            </>
          )}
          <button
            onClick={() => {
              setShowRename(true);
              setNewName(targetPath.split("/").pop() || "");
            }}
            data-testid="menu-rename"
          >
            ✏️ Rename
          </button>
          <div className="menu-separator"></div>
          <button
            onClick={handleDelete}
            className="danger"
            data-testid="menu-delete"
          >
            🗑️ Delete
          </button>
        </>
      )}
    </div>
  );
}

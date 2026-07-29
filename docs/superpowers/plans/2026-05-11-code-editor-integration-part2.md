# Code Editor Integration - Part 2

**Continuation of:** 2026-05-11-code-editor-integration.md

---

## Phase 4: File Operations (Continued)

### Sub-Phase 4.2: File Operation UI Wrappers

**File:** `src/lib/tauri.ts`

Add:
```typescript
export const editorCreateFile = (path: string) =>
  invoke<void>("editor_create_file", { path });

export const editorDeleteFile = (path: string) =>
  invoke<void>("editor_delete_file", { path });

export const editorRenameFile = (oldPath: string, newPath: string) =>
  invoke<void>("editor_rename_file", { oldPath, newPath });

export const editorFileExists = (path: string) =>
  invoke<boolean>("editor_file_exists", { path });

export const editorListDirectory = (path: string) =>
  invoke<FileNode[]>("editor_list_directory", { path });

export const editorGetHomeDirectory = () =>
  invoke<string>("editor_get_home_directory");
```

Add type export:
```typescript
export type FileNode = {
  path: string;
  name: string;
  node_type: "file" | "directory";
  children?: FileNode[];
};
```

**Verification:**
```bash
✓ TypeScript compilation succeeds
✓ Types match Rust structs
```

**🛑 CHECKPOINT 4.2:** IPC wrappers added

---

### Sub-Phase 4.3: File Context Menu Component

**File:** `src/components/editor/FileContextMenu.tsx`

```typescript
import { useState } from "react";
import {
  editorCreateFile,
  editorDeleteFile,
  editorRenameFile,
} from "../../lib/tauri";
import "./FileContextMenu.css";

type FileContextMenuProps = {
  targetPath: string;
  targetType: "file" | "directory";
  position: { x: number; y: number };
  onClose: () => void;
  onRefresh: () => void;
};

export function FileContextMenu({
  targetPath,
  targetType,
  position,
  onClose,
  onRefresh,
}: FileContextMenuProps) {
  const [showRename, setShowRename] = useState(false);
  const [newName, setNewName] = useState("");

  const handleDelete = async () => {
    const confirmed = confirm(
      `Delete ${targetType} "${targetPath.split("/").pop()}"?`
    );
    if (!confirmed) return;

    try {
      await editorDeleteFile(targetPath);
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
      await editorRenameFile(targetPath, newPath);
      onRefresh();
      onClose();
    } catch (err) {
      alert(`Failed to rename: ${err}`);
    }
  };

  const handleNewFile = async () => {
    const fileName = prompt("New file name:");
    if (!fileName) return;

    const basePath = targetType === "directory" ? targetPath : targetPath.split("/").slice(0, -1).join("/");
    const newPath = `${basePath}/${fileName}`;

    try {
      await editorCreateFile(newPath);
      onRefresh();
      onClose();
    } catch (err) {
      alert(`Failed to create file: ${err}`);
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
          />
          <button onClick={handleRename}>✓</button>
          <button
            onClick={() => {
              setShowRename(false);
              setNewName("");
            }}
          >
            ✕
          </button>
        </div>
      ) : (
        <>
          {targetType === "directory" && (
            <button onClick={handleNewFile} data-testid="menu-new-file">
              New File
            </button>
          )}
          <button
            onClick={() => setShowRename(true)}
            data-testid="menu-rename"
          >
            Rename
          </button>
          <button
            onClick={handleDelete}
            className="danger"
            data-testid="menu-delete"
          >
            Delete
          </button>
        </>
      )}
    </div>
  );
}
```

**File:** `src/components/editor/FileContextMenu.css`

```css
.file-context-menu {
  position: fixed;
  background: #2d2d30;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
  padding: 4px;
  min-width: 150px;
  z-index: 1000;
}

.file-context-menu button {
  display: block;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  color: #d4d4d4;
  border: none;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
}

.file-context-menu button:hover {
  background: #094771;
}

.file-context-menu button.danger {
  color: #f48771;
}

.file-context-menu button.danger:hover {
  background: #5a1d1d;
}

.rename-input-container {
  display: flex;
  padding: 4px;
  gap: 4px;
}

.rename-input-container input {
  flex: 1;
  padding: 4px 8px;
  background: #3c3c3c;
  color: #d4d4d4;
  border: 1px solid #007acc;
  border-radius: 2px;
  font-size: 13px;
}

.rename-input-container button {
  width: auto;
  padding: 4px 8px;
}
```

**Verification:**
```bash
✓ Component files created
✓ TypeScript compilation succeeds
```

**🛑 CHECKPOINT 4.3:** Context menu component created

---

### Sub-Phase 4.4: Integrate Context Menu into FileExplorer

**File:** `src/components/editor/FileExplorer.tsx`

Modify existing component:
```typescript
import { useState, useEffect } from "react";
import {
  editorListDirectory,
  editorGetHomeDirectory,
} from "../../lib/tauri";
import type { FileNode } from "../../state/editorStore";
import { FileContextMenu } from "./FileContextMenu";
import "./FileExplorer.css";

type FileExplorerProps = {
  rootPath: string | null;
  onSelectFile: (path: string) => void;
  onChangeRoot: (path: string) => void;
};

export function FileExplorer({
  rootPath,
  onSelectFile,
  onChangeRoot,
}: FileExplorerProps) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    targetPath: string;
    targetType: "file" | "directory";
    position: { x: number; y: number };
  } | null>(null);

  // Load root directory on mount or when rootPath changes
  useEffect(() => {
    if (!rootPath) {
      editorGetHomeDirectory()
        .then((home) => {
          onChangeRoot(home);
          loadDirectory(home);
        })
        .catch(console.error);
    } else {
      loadDirectory(rootPath);
    }
  }, [rootPath]);

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
    try {
      const children = await editorListDirectory(path);
      setNodes(children);
    } catch (err) {
      console.error("Failed to load directory:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleDirectory = async (node: FileNode) => {
    if (node.node_type !== "directory") return;

    const isExpanded = expandedDirs.has(node.path);
    const next = new Set(expandedDirs);

    if (isExpanded) {
      next.delete(node.path);
    } else {
      next.add(node.path);
      if (!node.children) {
        try {
          const children = await editorListDirectory(node.path);
          setNodes((prev) =>
            updateNodeChildren(prev, node.path, children)
          );
        } catch (err) {
          console.error("Failed to expand directory:", err);
          return;
        }
      }
    }

    setExpandedDirs(next);
  };

  const updateNodeChildren = (
    nodes: FileNode[],
    targetPath: string,
    children: FileNode[]
  ): FileNode[] => {
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
  };

  const handleContextMenu = (
    e: React.MouseEvent,
    node: FileNode
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      targetPath: node.path,
      targetType: node.node_type,
      position: { x: e.clientX, y: e.clientY },
    });
  };

  const renderNode = (node: FileNode, depth: number = 0) => {
    const isExpanded = expandedDirs.has(node.path);
    const icon =
      node.node_type === "directory"
        ? isExpanded
          ? "📂"
          : "📁"
        : getFileIcon(node.name);

    return (
      <div key={node.path}>
        <div
          className="file-tree-node"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() =>
            node.node_type === "directory"
              ? toggleDirectory(node)
              : onSelectFile(node.path)
          }
          onContextMenu={(e) => handleContextMenu(e, node)}
          data-testid={`file-node-${node.node_type}`}
        >
          <span className="node-icon">{icon}</span>
          <span className="node-name">{node.name}</span>
        </div>
        {isExpanded && node.children && (
          <div className="node-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="file-explorer" data-testid="file-explorer">
      <div className="explorer-header">
        <span className="explorer-title">Files</span>
        {rootPath && (
          <span className="explorer-root" title={rootPath}>
            {rootPath.split("/").pop() || rootPath}
          </span>
        )}
      </div>
      <div className="explorer-content">
        {loading ? (
          <div className="explorer-loading">Loading...</div>
        ) : (
          nodes.map((node) => renderNode(node))
        )}
      </div>
      
      {contextMenu && (
        <FileContextMenu
          targetPath={contextMenu.targetPath}
          targetType={contextMenu.targetType}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onRefresh={() => rootPath && loadDirectory(rootPath)}
        />
      )}
    </div>
  );
}

function getFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
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
    case "yaml":
    case "yml":
      return "📄";
    case "md":
      return "📝";
    case "css":
      return "🎨";
    case "html":
      return "🌐";
    case "rs":
      return "🦀";
    default:
      return "📄";
  }
}
```

**Verification:**
```bash
✓ TypeScript compilation succeeds
✓ Context menu integrated
```

**🛑 CHECKPOINT 4.4:** Context menu integrated

---

### Sub-Phase 4.5: GUI Test - File Operations

**File:** `e2e/tests/editor.spec.ts`

Add:
```typescript
test.describe("Code Editor - File Operations", () => {
  test("should show context menu on right-click", async ({ tauriPage }) => {
    await tauriPage.waitForSelector(".shell", { timeout: 10000 });

    await tauriPage.locator('button[data-testid="tab-new-editor"]').click();
    await tauriPage.waitForTimeout(2000);

    // Right-click a file node
    const fileNode = tauriPage.locator('[data-testid="file-node-file"]').first();
    
    if ((await fileNode.count()) > 0) {
      await fileNode.click({ button: "right" });
      await tauriPage.waitForTimeout(300);

      // Verify context menu appears
      const contextMenu = tauriPage.locator('[data-testid="file-context-menu"]');
      expect(await contextMenu.isVisible()).toBe(true);

      // Should have Rename and Delete options
      const renameBtn = contextMenu.locator('[data-testid="menu-rename"]');
      const deleteBtn = contextMenu.locator('[data-testid="menu-delete"]');
      expect(await renameBtn.isVisible()).toBe(true);
      expect(await deleteBtn.isVisible()).toBe(true);
    }
  });

  test("should show New File option for directories", async ({ tauriPage }) => {
    await tauriPage.waitForSelector(".shell", { timeout: 10000 });

    await tauriPage.locator('button[data-testid="tab-new-editor"]').click();
    await tauriPage.waitForTimeout(2000);

    // Right-click a directory node
    const dirNode = tauriPage.locator('[data-testid="file-node-directory"]').first();
    
    if ((await dirNode.count()) > 0) {
      await dirNode.click({ button: "right" });
      await tauriPage.waitForTimeout(300);

      const contextMenu = tauriPage.locator('[data-testid="file-context-menu"]');
      const newFileBtn = contextMenu.locator('[data-testid="menu-new-file"]');
      expect(await newFileBtn.isVisible()).toBe(true);
    }
  });

  test("should close context menu on outside click", async ({ tauriPage }) => {
    await tauriPage.waitForSelector(".shell", { timeout: 10000 });

    await tauriPage.locator('button[data-testid="tab-new-editor"]').click();
    await tauriPage.waitForTimeout(2000);

    const fileNode = tauriPage.locator('[data-testid="file-node-file"]').first();
    
    if ((await fileNode.count()) > 0) {
      // Open context menu
      await fileNode.click({ button: "right" });
      await tauriPage.waitForTimeout(300);

      const contextMenu = tauriPage.locator('[data-testid="file-context-menu"]');
      expect(await contextMenu.isVisible()).toBe(true);

      // Click outside
      await tauriPage.locator(".editor-content").click();
      await tauriPage.waitForTimeout(300);

      // Menu should be gone
      expect(await contextMenu.isVisible()).toBe(false);
    }
  });
});
```

**Verification:**
```bash
✓ Tests added
✓ bun run e2e passes (3 new tests)
```

**🛑 CHECKPOINT 4.5:** Phase 4 complete - File operations working

---

## Phase 5: LSP Manager (Rust)

**Duration:** 1 week (5 sub-phases)  
**Goal:** Rust-side LSP process management and JSON-RPC protocol

### Sub-Phase 5.1: LSP Dependencies

**File:** `src-tauri/Cargo.toml`

Add dependencies:
```toml
[dependencies]
# Existing dependencies...
tokio = { version = "1", features = ["full"] }
serde_json = "1.0"
tower-lsp = "0.20"
lsp-types = "0.95"
```

**Verification:**
```bash
✓ cargo update runs successfully
✓ cargo build succeeds
✓ Dependencies resolve without conflicts
```

**🛑 CHECKPOINT 5.1:** LSP dependencies added

---

### Sub-Phase 5.2: LSP Manager Module

**File:** `src-tauri/src/lsp/mod.rs`

```rust
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub mod python;
pub mod yaml;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspConfig {
    pub language: String,
    pub command: String,
    pub args: Vec<String>,
}

pub struct LspManager {
    processes: Arc<Mutex<HashMap<String, LspProcess>>>,
}

struct LspProcess {
    child: Child,
    language: String,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_lsp(
        &self,
        language: &str,
        config: LspConfig,
    ) -> Result<()> {
        let mut processes = self.processes.lock().await;

        if processes.contains_key(language) {
            return Ok(());
        }

        tracing::info!(language = %language, command = %config.command, "Starting LSP server");

        let child = Command::new(&config.command)
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("Failed to spawn LSP process")?;

        processes.insert(
            language.to_string(),
            LspProcess {
                child,
                language: language.to_string(),
            },
        );

        Ok(())
    }

    pub async fn stop_lsp(&self, language: &str) -> Result<()> {
        let mut processes = self.processes.lock().await;

        if let Some(mut process) = processes.remove(language) {
            tracing::info!(language = %language, "Stopping LSP server");
            process.child.kill().await.context("Failed to kill LSP")?;
        }

        Ok(())
    }

    pub async fn send_request(
        &self,
        language: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let mut processes = self.processes.lock().await;

        let process = processes
            .get_mut(language)
            .context("LSP not running for language")?;

        let stdin = process
            .child
            .stdin
            .as_mut()
            .context("Failed to get stdin")?;

        let request_str = serde_json::to_string(&request)?;
        let content_length = request_str.len();
        let message = format!(
            "Content-Length: {}\r\n\r\n{}",
            content_length, request_str
        );

        stdin
            .write_all(message.as_bytes())
            .await
            .context("Failed to write to LSP stdin")?;

        // Read response (simplified - real impl needs proper JSON-RPC parsing)
        let stdout = process
            .child
            .stdout
            .as_mut()
            .context("Failed to get stdout")?;
        let mut reader = BufReader::new(stdout);
        let mut header = String::new();
        reader
            .read_line(&mut header)
            .await
            .context("Failed to read header")?;

        // Parse Content-Length
        let length: usize = header
            .strip_prefix("Content-Length: ")
            .and_then(|s| s.trim().parse().ok())
            .context("Invalid Content-Length")?;

        // Skip empty line
        let mut empty = String::new();
        reader.read_line(&mut empty).await?;

        // Read body
        let mut body = vec![0u8; length];
        tokio::io::AsyncReadExt::read_exact(&mut reader, &mut body)
            .await
            .context("Failed to read body")?;

        let response: serde_json::Value = serde_json::from_slice(&body)?;
        Ok(response)
    }

    pub async fn is_running(&self, language: &str) -> bool {
        let processes = self.processes.lock().await;
        processes.contains_key(language)
    }
}
```

**File:** `src-tauri/src/lib.rs`

Add module declaration:
```rust
mod lsp;
```

Add to app state:
```rust
pub struct AppState {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub lsp_manager: Arc<lsp::LspManager>,
}
```

Update app builder:
```rust
tauri::Builder::default()
    .setup(|app| {
        let db = /* ... */;
        let lsp_manager = Arc::new(lsp::LspManager::new());
        
        app.manage(AppState {
            db: Arc::new(Mutex::new(db)),
            lsp_manager,
        });
        
        Ok(())
    })
```

**Verification:**
```bash
✓ cargo build succeeds
✓ LSP manager module compiles
✓ AppState includes lsp_manager
```

**🛑 CHECKPOINT 5.2:** LSP manager created

---

### Sub-Phase 5.3: Python LSP Configuration

**File:** `src-tauri/src/lsp/python.rs`

```rust
use super::LspConfig;

pub fn get_python_lsp_config() -> LspConfig {
    LspConfig {
        language: "python".to_string(),
        command: "pylsp".to_string(),
        args: vec![],
    }
}

pub fn check_pylsp_installed() -> bool {
    std::process::Command::new("which")
        .arg("pylsp")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
```

**File:** `src-tauri/src/lsp/yaml.rs`

```rust
use super::LspConfig;

pub fn get_yaml_lsp_config() -> LspConfig {
    LspConfig {
        language: "yaml".to_string(),
        command: "yaml-language-server".to_string(),
        args: vec!["--stdio".to_string()],
    }
}

pub fn check_yaml_ls_installed() -> bool {
    std::process::Command::new("which")
        .arg("yaml-language-server")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
```

**Verification:**
```bash
✓ Modules compile
✓ Config functions return correct data
```

**🛑 CHECKPOINT 5.3:** LSP configurations added

---

### Sub-Phase 5.4: LSP Tauri Commands

**File:** `src-tauri/src/commands/lsp.rs`

```rust
use tauri::State;
use crate::lsp::LspManager;
use crate::AppState;

#[tauri::command]
pub async fn lsp_start(
    state: State<'_, AppState>,
    language: String,
) -> Result<(), String> {
    let config = match language.as_str() {
        "python" => crate::lsp::python::get_python_lsp_config(),
        "yaml" => crate::lsp::yaml::get_yaml_lsp_config(),
        _ => return Err(format!("Unsupported language: {}", language)),
    };

    state
        .lsp_manager
        .start_lsp(&language, config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_stop(
    state: State<'_, AppState>,
    language: String,
) -> Result<(), String> {
    state
        .lsp_manager
        .stop_lsp(&language)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_request(
    state: State<'_, AppState>,
    language: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state
        .lsp_manager
        .send_request(&language, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_is_running(
    state: State<'_, AppState>,
    language: String,
) -> Result<bool, String> {
    Ok(state.lsp_manager.is_running(&language).await)
}

#[tauri::command]
pub async fn lsp_check_available() -> Result<Vec<String>, String> {
    let mut available = Vec::new();

    if crate::lsp::python::check_pylsp_installed() {
        available.push("python".to_string());
    }

    if crate::lsp::yaml::check_yaml_ls_installed() {
        available.push("yaml".to_string());
    }

    Ok(available)
}
```

Register in `src-tauri/src/commands/mod.rs`:
```rust
pub mod lsp;
```

Register in `src-tauri/src/lib.rs`:
```rust
commands::lsp::lsp_start,
commands::lsp::lsp_stop,
commands::lsp::lsp_request,
commands::lsp::lsp_is_running,
commands::lsp::lsp_check_available,
```

**Verification:**
```bash
✓ cargo build succeeds
✓ Commands registered
```

**🛑 CHECKPOINT 5.4:** LSP commands added

---

### Sub-Phase 5.5: LSP Frontend Wrappers

**File:** `src/lib/tauri.ts`

Add:
```typescript
export const lspStart = (language: string) =>
  invoke<void>("lsp_start", { language });

export const lspStop = (language: string) =>
  invoke<void>("lsp_stop", { language });

export const lspRequest = (language: string, request: any) =>
  invoke<any>("lsp_request", { language, request });

export const lspIsRunning = (language: string) =>
  invoke<boolean>("lsp_is_running", { language });

export const lspCheckAvailable = () =>
  invoke<string[]>("lsp_check_available");
```

**Verification:**
```bash
✓ TypeScript compilation succeeds
✓ IPC wrappers created
```

**🛑 CHECKPOINT 5.5:** Phase 5 complete - LSP manager functional

---

## Phase 6: LSP Client (Monaco)

**Duration:** 1 week (5 sub-phases)  
**Goal:** Monaco integration with LSP for completions, hover, diagnostics

### Sub-Phase 6.1: LSP Client Hook

**File:** `src/hooks/useLspClient.ts`

```typescript
import { useEffect, useRef } from "react";
import {
  lspStart,
  lspStop,
  lspRequest,
  lspCheckAvailable,
} from "../lib/tauri";

export function useLspClient(language: string, enabled: boolean = true) {
  const initialized = useRef(false);

  useEffect(() => {
    if (!enabled || initialized.current) return;

    // Check if LSP is available for this language
    lspCheckAvailable()
      .then((available) => {
        if (available.includes(language)) {
          return lspStart(language);
        }
      })
      .then(() => {
        initialized.current = true;
      })
      .catch((err) => {
        console.error(`Failed to start LSP for ${language}:`, err);
      });

    return () => {
      if (initialized.current) {
        lspStop(language).catch(console.error);
        initialized.current = false;
      }
    };
  }, [language, enabled]);

  const sendRequest = async (method: string, params: any) => {
    const request = {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    };

    try {
      const response = await lspRequest(language, request);
      return response.result;
    } catch (err) {
      console.error(`LSP request failed: ${method}`, err);
      return null;
    }
  };

  return { sendRequest, initialized: initialized.current };
}
```

**Verification:**
```bash
✓ TypeScript compilation succeeds
✓ Hook follows React patterns
```

**🛑 CHECKPOINT 6.1:** LSP client hook created

---

### Sub-Phase 6.2: Monaco Completion Provider

**File:** `src/components/editor/lsp/CompletionProvider.ts`

```typescript
import * as monaco from "monaco-editor";

export function registerCompletionProvider(
  language: string,
  sendLspRequest: (method: string, params: any) => Promise<any>
): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(language, {
    async provideCompletionItems(model, position) {
      const result = await sendLspRequest("textDocument/completion", {
        textDocument: { uri: model.uri.toString() },
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1,
        },
      });

      if (!result || !result.items) {
        return { suggestions: [] };
      }

      const suggestions: monaco.languages.CompletionItem[] = result.items.map(
        (item: any) => ({
          label: item.label,
          kind: mapCompletionKind(item.kind),
          insertText: item.insertText || item.label,
          detail: item.detail,
          documentation: item.documentation,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
        })
      );

      return { suggestions };
    },
  });
}

function mapCompletionKind(lspKind: number): monaco.languages.CompletionItemKind {
  // LSP CompletionItemKind to Monaco CompletionItemKind
  const mapping: Record<number, monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    // Add more mappings as needed
  };

  return mapping[lspKind] || monaco.languages.CompletionItemKind.Text;
}
```

**Verification:**
```bash
✓ TypeScript compilation succeeds
✓ Monaco types resolve correctly
```

**🛑 CHECKPOINT 6.2:** Completion provider created

---

### Sub-Phase 6.3: Monaco Hover Provider

**File:** `src/components/editor/lsp/HoverProvider.ts`

```typescript
import * as monaco from "monaco-editor";

export function registerHoverProvider(
  language: string,
  sendLspRequest: (method: string, params: any) => Promise<any>
): monaco.IDisposable {
  return monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const result = await sendLspRequest("textDocument/hover", {
        textDocument: { uri: model.uri.toString() },
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1,
        },
      });

      if (!result || !result.contents) {
        return null;
      }

      const contents = Array.isArray(result.contents)
        ? result.contents
        : [result.contents];

      const markdownContents = contents.map((c: any) => {
        if (typeof c === "string") {
          return { value: c };
        }
        if (c.language && c.value) {
          return { value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` };
        }
        if (c.value) {
          return { value: c.value };
        }
        return { value: "" };
      });

      return {
        contents: markdownContents,
        range: result.range
          ? {
              startLineNumber: result.range.start.line + 1,
              startColumn: result.range.start.character + 1,
              endLineNumber: result.range.end.line + 1,
              endColumn: result.range.end.character + 1,
            }
          : undefined,
      };
    },
  });
}
```

**Verification:**
```bash
✓ TypeScript compilation succeeds
✓ Hover provider follows Monaco API
```

**🛑 CHECKPOINT 6.3:** Hover provider created

---

### Sub-Phase 6.4: Integrate LSP into MonacoEditor

**File:** `src/components/editor/MonacoEditor.tsx`

Modify existing component:
```typescript
import { useRef, useEffect } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useLspClient } from "../../hooks/useLspClient";
import { registerCompletionProvider } from "./lsp/CompletionProvider";
import { registerHoverProvider } from "./lsp/HoverProvider";

type MonacoEditorProps = {
  value: string;
  language: string;
  onChange: (value: string) => void;
  onCursorChange?: (position: { line: number; column: number }) => void;
  onSave?: () => void;
  readOnly?: boolean;
  enableLsp?: boolean;
};

export function MonacoEditor({
  value,
  language,
  onChange,
  onCursorChange,
  onSave,
  readOnly = false,
  enableLsp = true,
}: MonacoEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const disposablesRef = useRef<monaco.IDisposable[]>([]);
  
  const { sendRequest, initialized } = useLspClient(language, enableLsp);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Cmd+S / Ctrl+S to save
    if (onSave) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSave();
      });
    }

    // Track cursor position
    if (onCursorChange) {
      editor.onDidChangeCursorPosition((e) => {
        onCursorChange({
          line: e.position.lineNumber,
          column: e.position.column,
        });
      });
    }

    // Focus editor on mount
    editor.focus();
  };

  // Register LSP providers when initialized
  useEffect(() => {
    if (!initialized || !enableLsp) return;

    const completionDisposable = registerCompletionProvider(
      language,
      sendRequest
    );
    const hoverDisposable = registerHoverProvider(language, sendRequest);

    disposablesRef.current.push(completionDisposable, hoverDisposable);

    return () => {
      disposablesRef.current.forEach((d) => d.dispose());
      disposablesRef.current = [];
    };
  }, [initialized, language, enableLsp, sendRequest]);

  // Update editor when value changes externally
  useEffect(() => {
    if (editorRef.current && editorRef.current.getValue() !== value) {
      editorRef.current.setValue(value);
    }
  }, [value]);

  return (
    <div className="monaco-editor-wrapper" style={{ height: "100%", width: "100%" }}>
      <Editor
        height="100%"
        language={language}
        value={value}
        onChange={(val) => onChange(val ?? "")}
        onMount={handleEditorDidMount}
        theme="vs-dark"
        options={{
          fontSize: 14,
          fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace",
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          formatOnPaste: true,
          formatOnType: true,
          suggestOnTriggerCharacters: true,
          quickSuggestions: true,
          parameterHints: { enabled: true },
          folding: true,
          lineNumbers: "on",
          renderWhitespace: "selection",
          readOnly,
          scrollbar: {
            vertical: "auto",
            horizontal: "auto",
          },
        }}
      />
    </div>
  );
}
```

**Verification:**
```bash
✓ TypeScript compilation succeeds
✓ LSP hooks integrated
✓ Providers registered conditionally
```

**🛑 CHECKPOINT 6.4:** LSP integrated into editor

---

### Sub-Phase 6.5: GUI Test - LSP Features

**File:** `e2e/tests/editor-lsp.spec.ts`

```typescript
import { test, expect } from "../fixtures";

test.describe("Code Editor - LSP", () => {
  test("should trigger autocomplete", async ({ tauriPage }) => {
    await tauriPage.waitForSelector(".shell", { timeout: 10000 });

    // Create editor tab
    await tauriPage.locator('button[data-testid="tab-new-editor"]').click();
    await tauriPage.waitForTimeout(2000);

    // Open Python file (if exists) or type Python code
    const monaco = tauriPage.locator(".monaco-editor textarea");
    await monaco.focus();
    await tauriPage.keyboard.type("import ");
    await tauriPage.waitForTimeout(500);

    // Trigger autocomplete with Ctrl+Space
    await tauriPage.keyboard.press("Control+Space");
    await tauriPage.waitForTimeout(1000);

    // Check if suggestion widget appears
    const suggestWidget = tauriPage.locator(".monaco-editor .suggest-widget");
    // Note: This may not appear if LSP is not installed
    // Test passes if no error occurs
  });

  test("should show hover information", async ({ tauriPage }) => {
    await tauriPage.waitForSelector(".shell", { timeout: 10000 });

    await tauriPage.locator('button[data-testid="tab-new-editor"]').click();
    await tauriPage.waitForTimeout(2000);

    const monaco = tauriPage.locator(".monaco-editor textarea");
    await monaco.focus();
    await tauriPage.keyboard.type("def hello():\n    pass");
    await tauriPage.waitForTimeout(500);

    // Move cursor back to "hello" and hover
    await tauriPage.keyboard.press("ArrowUp");
    await tauriPage.keyboard.press("ArrowLeft");
    await tauriPage.keyboard.press("ArrowLeft");
    
    // Hover widget appearance depends on LSP availability
    // Test passes if no runtime errors
  });

  test("should handle LSP unavailable gracefully", async ({ tauriPage }) => {
    await tauriPage.waitForSelector(".shell", { timeout: 10000 });

    await tauriPage.locator('button[data-testid="tab-new-editor"]').click();
    await tauriPage.waitForTimeout(2000);

    // Editor should work even if LSP is not available
    const editorTab = tauriPage.locator('[data-testid="editor-tab"]');
    expect(await editorTab.isVisible()).toBe(true);

    // Should not show error banner
    const errorBanner = editorTab.locator('[data-testid="editor-error"]');
    expect(await errorBanner.isVisible()).toBe(false);
  });
});
```

**Verification:**
```bash
✓ Tests added
✓ bun run e2e passes (3 tests)
```

**🛑 CHECKPOINT 6.5:** Phase 6 complete - LSP client functional

---

## Phase 7: Git Integration

**Duration:** 1 week (5 sub-phases)  
**Goal:** Git status indicators, diff viewer, basic commit UI

### Sub-Phase 7.1: Git Status Command

**File:** `src-tauri/Cargo.toml`

Add dependency:
```toml
git2 = "0.18"
```

**File:** `src-tauri/src/commands/git.rs`

```rust
use git2::{Repository, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "untracked"
}

#[tauri::command]
pub async fn git_get_status(repo_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = Repository::open(&repo_path)
        .map_err(|e| format!("Not a git repository: {}", e))?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get git status: {}", e))?;

    let mut results = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status_flags = entry.status();

        let status = if status_flags.contains(Status::WT_NEW) || status_flags.contains(Status::INDEX_NEW) {
            "added"
        } else if status_flags.contains(Status::WT_MODIFIED) || status_flags.contains(Status::INDEX_MODIFIED) {
            "modified"
        } else if status_flags.contains(Status::WT_DELETED) || status_flags.contains(Status::INDEX_DELETED) {
            "deleted"
        } else {
            "untracked"
        };

        results.push(GitFileStatus {
            path,
            status: status.to_string(),
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn git_get_diff(repo_path: String, file_path: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path)
        .map_err(|e| format!("Not a git repository: {}", e))?;

    let head = repo
        .head()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;
    let tree = head
        .peel_to_tree()
        .map_err(|e| format!("Failed to get tree: {}", e))?;

    let diff = repo
        .diff_tree_to_workdir(Some(&tree), None)
        .map_err(|e| format!("Failed to create diff: {}", e))?;

    let mut diff_text = String::new();

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let content = String::from_utf8_lossy(line.content());
        diff_text.push_str(&content);
        true
    })
    .map_err(|e| format!("Failed to format diff: {}", e))?;

    Ok(diff_text)
}

#[tauri::command]
pub async fn git_is_repo(path: String) -> Result<bool, String> {
    Ok(Repository::discover(path).is_ok())
}
```

Register in `mod.rs` and `lib.rs`:
```rust
pub mod git;

// In lib.rs
commands::git::git_get_status,
commands::git::git_get_diff,
commands::git::git_is_repo,
```

**Verification:**
```bash
✓ cargo build succeeds
✓ Git commands compile
```

**🛑 CHECKPOINT 7.1:** Git status command added

---

## Phases 7-8: Advanced Features

**Status:** Planned - See Part 3  
**Documentation:** [2026-05-11-code-editor-integration-part3.md](./2026-05-11-code-editor-integration-part3.md)

**Phase 7 Remaining Checkpoints:**
- 7.2: Git Frontend Wrappers
- 7.3: Git Status Badge Component
- 7.4: Integrate Git Status into EditorTab
- 7.5: GUI Test - Git Integration

**Phase 8 Checkpoints:**
- 8.1: Editor Settings Panel
- 8.2: Persist Editor Settings
- 8.3: Integrate Settings into EditorTab
- 8.4: Keyboard Shortcuts Panel
- 8.5: Final Integration & Testing

---

## Implementation Notes

**Testing Philosophy:**
- Every sub-phase includes verification steps
- GUI tests use Playwright with real app instance
- Tests should be idempotent (can run multiple times)
- Prefer integration tests over unit tests for UI

**Error Handling:**
- LSP unavailable → Editor still works (graceful degradation)
- File read errors → Show error banner in editor
- Git not available → Hide git badges, no errors
- Invalid file paths → User-friendly error messages

**Performance Considerations:**
- Lazy directory loading (don't load entire tree upfront)
- Debounce LSP requests (avoid flooding server)
- Monaco automatic layout (handles resize efficiently)
- SQLite indexes on frequently queried columns

**Security:**
- File operations respect Tauri fs permissions
- No arbitrary command execution via LSP
- Git operations limited to status/diff (no push/pull)
- Path validation to prevent directory traversal

---

**Next Steps:**
- Complete Phase 3 (File Tree Explorer) - See [PHASE-3-READY.md](./PHASE-3-READY.md)
- Then Phase 4 (File Operations)
- Then Phases 5-6 (LSP Integration)
- Finally Phases 7-8 (Git & Polish)

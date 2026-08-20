import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  buildSshCommand,
  sshCreateFolder,
  sshDecryptPassword,
  sshDeleteConnection,
  sshDeleteFolder,
  sshListConnections,
  sshListFolders,
  sshImportCommit,
  sshImportPreview,
  sshMarkUsed,
  sshSaveConnection,
  sshUpdateConnection,
  sshUpdateFolder,
  type SshConnection,
  type SshFolder,
  type SshImportPreview,
  type SshImportResult,
  type SshImportSourceType,
} from "../lib/sshConnections";
import {
  DEVICE_ACCENT_COLORS,
  DEVICE_VENDORS,
  PLATFORMS_BY_VENDOR,
  SYNTAX_PROFILES,
  type DeviceAccentColor,
  type SyntaxProfile,
  type Vendor,
} from "../lib/deviceProfiles";
import { useTerminalConnectionStore } from "../state/terminalConnectionStore";
import "./SavedSSHConnectionsModal.css";

export interface SavedSSHConnectionsModalProps {
  onConnect: (connection: SshConnection, password: string | null) => void;
  onClose: () => void;
}

interface FormState {
  name: string;
  host: string;
  user: string;
  port: string;
  identity_file: string;
  password: string;
  folder_id: string;
  tags: string;
  accent_color: DeviceAccentColor | "";
  vendor: Vendor;
  platform: string;
  syntax_highlighting_enabled: boolean;
  syntax_profile: SyntaxProfile;
}

const ROOT_FOLDER: SshFolder = {
  id: "root",
  parent_id: null,
  name: "All Devices",
  position: 0,
  created_at: 0,
  updated_at: 0,
};

const EMPTY_FORM: FormState = {
  name: "",
  host: "",
  user: "",
  port: "22",
  identity_file: "",
  password: "",
  folder_id: "root",
  tags: "",
  accent_color: "",
  vendor: "generic",
  platform: "generic",
  syntax_highlighting_enabled: true,
  syntax_profile: "auto",
};

function withDefaults(connection: SshConnection): SshConnection {
  return {
    ...connection,
    folder_id: connection.folder_id || "root",
    tags: Array.isArray(connection.tags) ? connection.tags : [],
    accent_color: connection.accent_color ?? null,
    vendor: connection.vendor ?? "generic",
    platform: connection.platform || "generic",
    syntax_highlighting_enabled: connection.syntax_highlighting_enabled ?? false,
    syntax_profile: connection.syntax_profile ?? "auto",
  };
}

function FolderTree({
  folders,
  parentId,
  selectedId,
  onSelect,
  depth = 0,
}: {
  folders: SshFolder[];
  parentId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  const children = folders
    .filter((folder) => folder.parent_id === parentId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  return (
    <>
      {children.map((folder) => (
        <div key={folder.id}>
          <button
            type="button"
            className={`ssh-folder-row ${selectedId === folder.id ? "active" : ""}`}
            style={{ paddingLeft: `${12 + depth * 14}px` }}
            onClick={() => onSelect(folder.id)}
          >
            <span aria-hidden="true">▸</span> {folder.name}
          </button>
          <FolderTree
            folders={folders}
            parentId={folder.id}
            selectedId={selectedId}
            onSelect={onSelect}
            depth={depth + 1}
          />
        </div>
      ))}
    </>
  );
}

export function SavedSSHConnectionsModal({ onConnect, onClose }: SavedSSHConnectionsModalProps) {
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [folders, setFolders] = useState<SshFolder[]>([ROOT_FOLDER]);
  const [selectedFolderId, setSelectedFolderId] = useState("root");
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [hadPassword, setHadPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [folderMode, setFolderMode] = useState<"create" | "rename" | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderParentId, setFolderParentId] = useState("root");
  const [importOpen, setImportOpen] = useState(false);
  const [importSourceType, setImportSourceType] = useState<SshImportSourceType>("openssh");
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<SshImportPreview | null>(null);
  const [importResult, setImportResult] = useState<SshImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const loadInventory = async () => {
    setLoading(true);
    try {
      const [connectionRows, folderRows] = await Promise.all([
        sshListConnections(),
        sshListFolders(),
      ]);
      setConnections((Array.isArray(connectionRows) ? connectionRows : []).map(withDefaults));
      const loadedFolders = Array.isArray(folderRows) ? folderRows : [];
      setFolders(loadedFolders.some((folder) => folder.id === "root") ? loadedFolders : [ROOT_FOLDER, ...loadedFolders]);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadInventory();
  }, []);

  const allTags = useMemo(
    () => Array.from(new Set(connections.flatMap((connection) => connection.tags))).sort((a, b) => a.localeCompare(b)),
    [connections],
  );
  const visibleConnections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return connections.filter((connection) => {
      if (selectedFolderId !== "root" && connection.folder_id !== selectedFolderId) return false;
      if (selectedTags.length > 0 && !selectedTags.every((tag) =>
        connection.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase()))) return false;
      return !needle || [connection.name, connection.host, connection.user ?? "", ...connection.tags]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [connections, query, selectedFolderId, selectedTags]);
  const folderParentOptions = useMemo(() => {
    if (folderMode !== "rename") return folders;
    const blocked = new Set([selectedFolderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        if (folder.parent_id && blocked.has(folder.parent_id) && !blocked.has(folder.id)) {
          blocked.add(folder.id);
          changed = true;
        }
      }
    }
    return folders.filter((folder) => !blocked.has(folder.id));
  }, [folderMode, folders, selectedFolderId]);

  const handleConnect = async (connection: SshConnection) => {
    let password: string | null = null;
    if (connection.password_encrypted) {
      try {
        password = await sshDecryptPassword(connection.password_encrypted);
      } catch (cause) {
        console.error("Failed to decrypt saved password:", cause);
      }
    }
    try {
      await sshMarkUsed(connection.id);
    } catch (cause) {
      console.error("Failed to mark connection used:", cause);
    }
    onConnect(connection, password);
  };

  const openAddForm = () => {
    setEditingId(null);
    setHadPassword(false);
    setForm({ ...EMPTY_FORM, folder_id: selectedFolderId });
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (connection: SshConnection) => {
    setEditingId(connection.id);
    setHadPassword(!!connection.password_encrypted);
    setForm({
      name: connection.name,
      host: connection.host,
      user: connection.user ?? "",
      port: String(connection.port ?? 22),
      identity_file: connection.identity_file ?? "",
      password: "",
      folder_id: connection.folder_id,
      tags: connection.tags.join(", "),
      accent_color: connection.accent_color ?? "",
      vendor: connection.vendor,
      platform: connection.platform,
      syntax_highlighting_enabled: connection.syntax_highlighting_enabled,
      syntax_profile: connection.syntax_profile,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const handleSave = async () => {
    const port = form.port.trim() ? Number(form.port) : 22;
    if (!form.name.trim()) return setFormError("Name is required");
    if (!form.host.trim()) return setFormError("Host is required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return setFormError("Port must be a number between 1 and 65535");
    }
    setSaving(true);
    setFormError(null);
    try {
      const request = {
        name: form.name.trim(),
        host: form.host.trim(),
        user: form.user.trim() || null,
        port,
        identity_file: form.identity_file.trim() || null,
        password: editingId ? (form.password || null) : (form.password || null),
        folder_id: form.folder_id,
        tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        accent_color: form.accent_color,
        vendor: form.vendor,
        platform: form.platform,
        syntax_highlighting_enabled: form.syntax_highlighting_enabled,
        syntax_profile: form.syntax_profile,
      };
      const saved = editingId
        ? await sshUpdateConnection(editingId, request)
        : await sshSaveConnection(request);
      useTerminalConnectionStore.getState().updateConnectionMetadata(saved.id, {
        display_name: saved.name,
        vendor: saved.vendor,
        platform: saved.platform,
        accent_color: saved.accent_color,
        syntax_highlighting_enabled: saved.syntax_highlighting_enabled,
        syntax_profile: saved.syntax_profile,
      });
      await loadInventory();
      closeForm();
    } catch (cause) {
      setFormError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveFolder = async () => {
    try {
      if (folderMode === "create") {
        await sshCreateFolder({ parent_id: folderParentId, name: folderName.trim() });
      } else if (folderMode === "rename" && selectedFolderId !== "root") {
        const current = folders.find((folder) => folder.id === selectedFolderId);
        if (current) {
          await sshUpdateFolder(current.id, {
            parent_id: folderParentId,
            name: folderName.trim(),
            position: current.position,
          });
        }
      }
      setFolderMode(null);
      setFolderName("");
      setFolderParentId("root");
      await loadInventory();
    } catch (cause) {
      setError(String(cause));
    }
  };

  const deleteSelectedFolder = async () => {
    if (selectedFolderId === "root") return;
    const current = folders.find((folder) => folder.id === selectedFolderId);
    if (!current || !confirm(`Delete folder "${current.name}"? Devices and child folders will move to its parent.`)) return;
    try {
      await sshDeleteFolder(current.id);
      setSelectedFolderId(current.parent_id ?? "root");
      await loadInventory();
    } catch (cause) {
      setError(String(cause));
    }
  };

  const closeImport = () => {
    setImportOpen(false);
    setImportPath(null);
    setImportPreview(null);
    setImportResult(null);
    setImportError(null);
  };

  const chooseImportSource = async () => {
    setImportError(null);
    setImportResult(null);
    const filters = importSourceType === "csv"
      ? [{ name: "CSV inventory", extensions: ["csv"] }]
      : importSourceType === "mtputty"
        ? [{ name: "MTPuTTY XML", extensions: ["xml"] }]
        : importSourceType === "mobaxterm"
          ? [{ name: "MobaXterm sessions", extensions: ["ini", "mxtsessions"] }]
          : undefined;
    const selected = await open({
      multiple: false,
      directory: importSourceType === "securecrt",
      ...(filters ? { filters } : {}),
    });
    if (typeof selected !== "string") return;
    setImporting(true);
    setImportPath(null);
    setImportPreview(null);
    try {
      const preview = await sshImportPreview(importSourceType, selected);
      setImportPath(selected);
      setImportPreview(preview);
    } catch (cause) {
      setImportError(String(cause));
    } finally {
      setImporting(false);
    }
  };

  const commitImport = async () => {
    if (!importPath || !importPreview) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await sshImportCommit(
        importSourceType,
        importPath,
        importPreview.fingerprint,
      );
      setImportResult(result);
      setImportPath(null);
      setImportPreview(null);
      await loadInventory();
    } catch (cause) {
      setImportError(String(cause));
    } finally {
      setImporting(false);
    }
  };

  const importCounts = importPreview?.rows.reduce(
    (counts, row) => ({ ...counts, [row.action]: counts[row.action] + 1 }),
    { create: 0, update: 0, skip: 0 },
  );

  return (
    <div className="ssh-modal-overlay" onClick={onClose}>
      <div className="ssh-modal" role="dialog" aria-label="Saved SSH Connections" onClick={(event) => event.stopPropagation()}>
        <header className="ssh-modal-header">
          <h2>Saved SSH Connections</h2>
          <div className="ssh-modal-header-actions">
            {!formOpen && !importOpen && <button type="button" onClick={() => { setImportOpen(true); setImportResult(null); }}>Import…</button>}
            {!formOpen && !importOpen && <button type="button" className="ssh-btn-add" onClick={openAddForm}>+ New Device</button>}
            <button type="button" className="ssh-modal-close" aria-label="Close" onClick={onClose}>✕</button>
          </div>
        </header>

        <div className="ssh-inventory-browser">
          <aside className="ssh-folder-pane" aria-label="SSH folders">
            <button
              type="button"
              className={`ssh-folder-row ssh-folder-root ${selectedFolderId === "root" ? "active" : ""}`}
              onClick={() => setSelectedFolderId("root")}
            >
              All Devices
            </button>
            <FolderTree folders={folders} parentId="root" selectedId={selectedFolderId} onSelect={setSelectedFolderId} />
            <div className="ssh-folder-actions">
              <button type="button" onClick={() => { setFolderMode("create"); setFolderName(""); setFolderParentId(selectedFolderId); }}>+ Folder</button>
              <button type="button" disabled={selectedFolderId === "root"} onClick={() => {
                setFolderMode("rename");
                const selected = folders.find((folder) => folder.id === selectedFolderId);
                setFolderName(selected?.name ?? "");
                setFolderParentId(selected?.parent_id ?? "root");
              }}>Edit</button>
              <button type="button" disabled={selectedFolderId === "root"} onClick={() => void deleteSelectedFolder()}>Delete</button>
            </div>
            {folderMode && (
              <div className="ssh-folder-editor">
                <input aria-label="Folder name" maxLength={64} value={folderName} onChange={(event) => setFolderName(event.target.value)} />
                <select aria-label="Parent folder" value={folderParentId} onChange={(event) => setFolderParentId(event.target.value)}>
                  {folderParentOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </select>
                <button type="button" disabled={!folderName.trim()} onClick={() => void saveFolder()}>Save</button>
                <button type="button" onClick={() => { setFolderMode(null); setFolderParentId("root"); }}>Cancel</button>
              </div>
            )}
          </aside>

          <main className="ssh-device-pane">
            {importOpen ? (
              <div className="ssh-import-panel" data-testid="ssh-import-panel">
                <div className="ssh-import-heading">
                  <div>
                    <h3>Import SSH Inventory</h3>
                    <p>Preview is read-only and never displays credential values.</p>
                  </div>
                  <button type="button" disabled={importing} onClick={closeImport}>Close</button>
                </div>
                <div className="ssh-import-picker">
                  <label>
                    <span>Import format</span>
                    <select
                      aria-label="Import format"
                      value={importSourceType}
                      disabled={importing}
                      onChange={(event) => {
                        setImportSourceType(event.target.value as SshImportSourceType);
                        setImportPath(null);
                        setImportPreview(null);
                        setImportResult(null);
                        setImportError(null);
                      }}
                    >
                      <option value="securecrt">SecureCRT session directory</option>
                      <option value="mtputty">MTPuTTY XML</option>
                      <option value="mobaxterm">MobaXterm export</option>
                      <option value="openssh">OpenSSH config</option>
                      <option value="csv">CSV inventory</option>
                    </select>
                  </label>
                  <button type="button" disabled={importing} onClick={() => void chooseImportSource()}>
                    {importing && !importPreview ? "Reading…" : "Choose source…"}
                  </button>
                </div>
                {importSourceType === "csv" && (
                  <p className="ssh-import-hint">
                    Columns: name, host, user, port, identity_file, password, folder, tags
                  </p>
                )}
                {importError && <div className="ssh-form-error" role="alert">{importError}</div>}
                {importResult && (
                  <div className="ssh-import-result" role="status">
                    Imported {importResult.created} new and updated {importResult.updated}; {importResult.skipped} skipped.
                    {importResult.credential_skipped > 0 && ` ${importResult.credential_skipped} protected credential${importResult.credential_skipped === 1 ? " was" : "s were"} not imported.`}
                  </div>
                )}
                {importPreview && importCounts && (
                  <div className="ssh-import-review" data-testid="ssh-import-preview">
                    <div className="ssh-import-summary">
                      <strong>{importPreview.rows.length} parsed row{importPreview.rows.length === 1 ? "" : "s"}</strong>
                      <span>{importCounts.create} create · {importCounts.update} update · {importCounts.skip} skip</span>
                      <span className="ssh-import-path" title={importPreview.source_path}>{importPreview.source_path}</span>
                    </div>
                    <div className="ssh-import-actions">
                      <button
                        type="button"
                        disabled={importing || importCounts.create + importCounts.update === 0}
                        onClick={() => void commitImport()}
                      >
                        {importing ? "Importing…" : "Commit Import"}
                      </button>
                      <button type="button" disabled={importing} onClick={() => { setImportPath(null); setImportPreview(null); }}>Cancel Preview</button>
                    </div>
                    <div className="ssh-import-rows">
                      {importPreview.rows.map((row, index) => (
                        <div className="ssh-import-row" data-action={row.action} key={`${row.source}-${index}`}>
                          <div className="ssh-import-row-title">
                            <span className="ssh-import-action">{row.action}</span>
                            <strong>{row.name || "Unnamed row"}</strong>
                            <span>{row.user ? `${row.user}@` : ""}{row.host || "missing host"}:{row.port}</span>
                          </div>
                          <div className="ssh-import-row-meta">
                            {row.folder && <span>Folder: {row.folder}</span>}
                            {row.identity_file && <span>Identity: {row.identity_file}</span>}
                            {row.tags.length > 0 && <span>Tags: {row.tags.join(", ")}</span>}
                            {row.credential_state === "plaintext" && <span>Credential: plaintext value will be encrypted</span>}
                            {row.credential_state === "unsupported" && <span>Credential: protected value skipped</span>}
                          </div>
                          {row.warnings.length > 0 && <ul>{row.warnings.map((warning, warningIndex) => <li key={warningIndex}>{warning}</li>)}</ul>}
                          <small>{row.source}</small>
                        </div>
                      ))}
                    </div>
                    {importPreview.warnings.length > 0 && <ul className="ssh-import-global-warnings">{importPreview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
                  </div>
                )}
              </div>
            ) : formOpen ? (
              <div className="ssh-form">
                <h3>{editingId ? "Edit Connection" : "New Connection"}</h3>
                <div className="ssh-form-grid">
                  <label><span>Name</span><input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                  <label><span>Host</span><input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></label>
                  <label><span>User</span><input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} /></label>
                  <label><span>Port</span><input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} /></label>
                  <label className="ssh-form-field-wide"><span>Identity file (optional)</span><input value={form.identity_file} onChange={(e) => setForm({ ...form, identity_file: e.target.value })} /></label>
                  <label className="ssh-form-field-wide"><span>Password {editingId && hadPassword ? "(leave blank to keep existing)" : ""}</span><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
                  <label><span>Folder</span><select value={form.folder_id} onChange={(e) => setForm({ ...form, folder_id: e.target.value })}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
                  <label><span>Tags</span><input value={form.tags} placeholder="core, wan" onChange={(e) => setForm({ ...form, tags: e.target.value })} /></label>
                  <label><span>Accent</span><select value={form.accent_color} onChange={(e) => setForm({ ...form, accent_color: e.target.value as FormState["accent_color"] })}><option value="">None</option>{DEVICE_ACCENT_COLORS.map((color) => <option key={color} value={color}>{color}</option>)}</select></label>
                  <label><span>Vendor</span><select value={form.vendor} onChange={(e) => {
                    const vendor = e.target.value as Vendor;
                    setForm({ ...form, vendor, platform: PLATFORMS_BY_VENDOR[vendor][0] ?? "generic" });
                  }}>{DEVICE_VENDORS.map((vendor) => <option key={vendor} value={vendor}>{vendor}</option>)}</select></label>
                  <label><span>Platform</span><select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>{PLATFORMS_BY_VENDOR[form.vendor].map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label>
                  <label><span>Syntax highlighting</span><select value={form.syntax_highlighting_enabled ? form.syntax_profile : "off"} onChange={(e) => {
                    const value = e.target.value;
                    setForm(value === "off"
                      ? { ...form, syntax_highlighting_enabled: false }
                      : { ...form, syntax_highlighting_enabled: true, syntax_profile: value as SyntaxProfile });
                  }}><option value="off">Off</option>{SYNTAX_PROFILES.map((profile) => <option key={profile} value={profile}>{profile === "auto" ? "Auto" : profile}</option>)}</select></label>
                </div>
                {formError && <div className="ssh-form-error" role="alert">{formError}</div>}
                <div className="ssh-form-actions"><button type="button" disabled={saving} onClick={closeForm}>Cancel</button><button type="button" disabled={saving} onClick={() => void handleSave()}>{saving ? "Saving…" : "Save Connection"}</button></div>
              </div>
            ) : (
              <>
                <div className="ssh-inventory-filters">
                  <input aria-label="Search saved devices" placeholder="Search devices…" value={query} onChange={(event) => setQuery(event.target.value)} />
                  <div className="ssh-tag-filters">{allTags.map((tag) => <button type="button" key={tag} className={selectedTags.includes(tag) ? "active" : ""} onClick={() => setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])}>{tag}</button>)}</div>
                </div>
                {loading ? <div className="ssh-modal-loading">Loading…</div> : error ? <div className="ssh-modal-error">{error}</div> : visibleConnections.length === 0 ? <div className="ssh-modal-empty">No saved devices match this view.</div> : (
                  <div className="ssh-connections-list">
                    {visibleConnections.map((connection) => (
                      <div key={connection.id} className="ssh-connection-item" data-accent={connection.accent_color ?? undefined}>
                        <span className="ssh-inventory-accent" aria-hidden="true" />
                        <div className="ssh-connection-info">
                          <div className="ssh-connection-name">{connection.name}</div>
                          <div className="ssh-connection-details">{connection.user ? `${connection.user}@` : ""}{connection.host}:{connection.port ?? 22}</div>
                          <div className="ssh-connection-meta"><span>{connection.vendor}/{connection.platform}</span>{connection.tags.map((tag) => <span key={tag} className="ssh-tag">{tag}</span>)}</div>
                          <code className="ssh-connection-command">{buildSshCommand(connection)}</code>
                        </div>
                        <div className="ssh-connection-actions">
                          <button type="button" className="ssh-btn-connect" title="Connect" onClick={() => void handleConnect(connection)}>Connect</button>
                          <button type="button" className="ssh-btn-edit" title="Edit" onClick={() => openEditForm(connection)}>Edit</button>
                          <button type="button" className="ssh-btn-delete" title="Delete" onClick={async () => {
                            if (!confirm(`Delete connection "${connection.name}"?`)) return;
                            await sshDeleteConnection(connection.id);
                            await loadInventory();
                          }}>Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

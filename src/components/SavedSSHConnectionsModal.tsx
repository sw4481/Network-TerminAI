import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './SavedSSHConnectionsModal.css';

interface SshConnection {
  id: string;
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  password_encrypted?: string | null;
  created_at: number;
  last_used_at: number | null;
}

interface SavedSSHConnectionsModalProps {
  onConnect: (connection: SshConnection, password: string | null) => void;
  onClose: () => void;
}

/** Form state for the add/edit connection form. */
interface FormState {
  name: string;
  host: string;
  user: string;
  port: string;
  identity_file: string;
  password: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  host: '',
  user: '',
  port: '22',
  identity_file: '',
  password: '',
};

export function SavedSSHConnectionsModal({ onConnect, onClose }: SavedSSHConnectionsModalProps) {
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // When set, the form is open. editingId === null means "add new"; a string
  // means "editing that connection".
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // Tracks whether the connection being edited already had a saved password,
  // so we can show "leave blank to keep existing" instead of forcing re-entry.
  const [hadPassword, setHadPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      setLoading(true);
      const result = await invoke<SshConnection[]>('ssh_list_connections');
      setConnections(result);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async (connection: SshConnection) => {
    // Decrypt the saved password if there is one. The backend command takes
    // the *encrypted blob* (not the connection id) — passing the wrong arg
    // silently threw and dropped the password, so auto-fill never fired.
    let password: string | null = null;
    if (connection.password_encrypted) {
      try {
        password = await invoke<string | null>('ssh_decrypt_password', {
          encrypted: connection.password_encrypted,
        });
      } catch (err) {
        console.error('Failed to decrypt saved password:', err);
      }
    }

    try {
      // Mark as used (best-effort; don't block the connect on it).
      await invoke('ssh_mark_used', { id: connection.id });
    } catch (err) {
      console.error('Failed to mark connection used:', err);
    }

    onConnect(connection, password);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete connection "${name}"?`)) {
      return;
    }

    try {
      await invoke('ssh_delete_connection', { id });
      await loadConnections();
    } catch (err) {
      alert(`Failed to delete connection: ${err}`);
    }
  };

  const openAddForm = () => {
    setEditingId(null);
    setHadPassword(false);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (conn: SshConnection) => {
    setEditingId(conn.id);
    setHadPassword(!!conn.password_encrypted);
    setForm({
      name: conn.name,
      host: conn.host,
      user: conn.user ?? '',
      port: conn.port != null ? String(conn.port) : '22',
      identity_file: conn.identity_file ?? '',
      password: '', // never prefill; blank = keep existing on edit
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

  const updateField = (field: keyof FormState, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required');
      return;
    }
    if (!form.host.trim()) {
      setFormError('Host is required');
      return;
    }
    const portNum = form.port.trim() ? Number(form.port) : 22;
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setFormError('Port must be a number between 1 and 65535');
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const base = {
        name: form.name.trim(),
        host: form.host.trim(),
        user: form.user.trim() || null,
        port: portNum,
        identity_file: form.identity_file.trim() || null,
      };

      if (editingId) {
        // On edit, a blank password field means "keep the existing one":
        // send password: null so the backend leaves it untouched.
        await invoke('ssh_update_connection', {
          id: editingId,
          request: { ...base, password: form.password ? form.password : null },
        });
      } else {
        await invoke('ssh_save_connection', {
          request: { ...base, password: form.password || null },
        });
      }
      await loadConnections();
      closeForm();
    } catch (err) {
      setFormError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const buildCommandPreview = (conn: SshConnection): string => {
    let cmd = 'ssh';
    if (conn.port && conn.port !== 22) cmd += ` -p ${conn.port}`;
    if (conn.identity_file) cmd += ` -i ${conn.identity_file}`;
    if (conn.user && conn.host) cmd += ` ${conn.user}@${conn.host}`;
    else if (conn.host) cmd += ` ${conn.host}`;
    return cmd;
  };

  return (
    <div className="ssh-modal-overlay" onClick={onClose}>
      <div className="ssh-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ssh-modal-header">
          <h2>Saved SSH Connections</h2>
          <div className="ssh-modal-header-actions">
            {!formOpen && (
              <button className="ssh-btn-add" onClick={openAddForm}>
                + New
              </button>
            )}
            <button className="ssh-modal-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="ssh-modal-content">
          {formOpen && (
            <div className="ssh-form">
              <h3 className="ssh-form-title">
                {editingId ? 'Edit Connection' : 'New Connection'}
              </h3>
              <div className="ssh-form-grid">
                <label className="ssh-form-field">
                  <span>Name</span>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => updateField('name', e.target.value)}
                    placeholder="e.g. core-sw1"
                    autoFocus
                  />
                </label>
                <label className="ssh-form-field">
                  <span>Host</span>
                  <input
                    type="text"
                    value={form.host}
                    onChange={(e) => updateField('host', e.target.value)}
                    placeholder="192.168.1.1 or hostname"
                  />
                </label>
                <label className="ssh-form-field">
                  <span>User</span>
                  <input
                    type="text"
                    value={form.user}
                    onChange={(e) => updateField('user', e.target.value)}
                    placeholder="admin"
                  />
                </label>
                <label className="ssh-form-field">
                  <span>Port</span>
                  <input
                    type="text"
                    value={form.port}
                    onChange={(e) => updateField('port', e.target.value)}
                    placeholder="22"
                  />
                </label>
                <label className="ssh-form-field ssh-form-field-wide">
                  <span>Identity file (optional)</span>
                  <input
                    type="text"
                    value={form.identity_file}
                    onChange={(e) => updateField('identity_file', e.target.value)}
                    placeholder="~/.ssh/id_rsa"
                  />
                </label>
                <label className="ssh-form-field ssh-form-field-wide">
                  <span>
                    Password{' '}
                    {editingId && hadPassword && (
                      <em className="ssh-form-hint-inline">
                        (leave blank to keep existing)
                      </em>
                    )}
                  </span>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => updateField('password', e.target.value)}
                    placeholder={
                      editingId && hadPassword ? '••••••••' : 'password (optional)'
                    }
                  />
                </label>
              </div>

              {formError && <div className="ssh-form-error">{formError}</div>}

              <div className="ssh-form-actions">
                <button
                  className="ssh-btn-cancel"
                  onClick={closeForm}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  className="ssh-btn-save"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add Connection'}
                </button>
              </div>
            </div>
          )}

          {loading && <div className="ssh-modal-loading">Loading connections...</div>}

          {error && <div className="ssh-modal-error">Error: {error}</div>}

          {!loading && !error && connections.length === 0 && !formOpen && (
            <div className="ssh-modal-empty">
              <p>No saved connections yet.</p>
              <p className="ssh-modal-hint">
                Click <strong>+ New</strong> above to add one, or type{' '}
                <code>ssh </code> in the terminal and click "Save Connection".
              </p>
            </div>
          )}

          {!loading && !error && connections.length > 0 && (
            <div className="ssh-connections-list">
              {connections.map((conn) => (
                <div key={conn.id} className="ssh-connection-item">
                  <div className="ssh-connection-info">
                    <div className="ssh-connection-name">{conn.name}</div>
                    <div className="ssh-connection-details">
                      {conn.user && <span className="ssh-detail-user">{conn.user}@</span>}
                      <span className="ssh-detail-host">{conn.host}</span>
                      {conn.port && conn.port !== 22 && (
                        <span className="ssh-detail-port">:{conn.port}</span>
                      )}
                    </div>
                    <div className="ssh-connection-command">{buildCommandPreview(conn)}</div>
                  </div>
                  <div className="ssh-connection-actions">
                    <button
                      className="ssh-btn-connect"
                      onClick={() => handleConnect(conn)}
                      title="Connect"
                    >
                      Connect
                    </button>
                    <button
                      className="ssh-btn-edit"
                      onClick={() => openEditForm(conn)}
                      title="Edit"
                    >
                      Edit
                    </button>
                    <button
                      className="ssh-btn-delete"
                      onClick={() => handleDelete(conn.id, conn.name)}
                      title="Delete"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// DEPRECATED: this modal is the legacy "snapshot of executed blocks" model
// (V0021 `block_notebooks`). For runnable MOPs (parameters, approvals,
// assertions, audit trail) use `NotebookLibrary` + `NotebookPanel` from
// `./notebooks/`. Kept for back-compat — see Plan 03 Phase 4.
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { parseNotebookFile, type BlockNotebook as NotebookType } from '../lib/notebook';
import './BlockNotebook.css';

interface BlockNotebookProps {
  onSave: (name: string, description?: string) => void;
  onLoad: (notebook: NotebookType) => void;
  onClose: () => void;
}

interface SavedNotebook {
  id: string;
  name: string;
  description: string | null;
  blocks_json: string;
  created_at: number;
  updated_at: number;
}

export function BlockNotebook({ onSave, onLoad, onClose }: BlockNotebookProps) {
  const [activeTab, setActiveTab] = useState<'save' | 'load' | 'saved'>('save');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [savedNotebooks, setSavedNotebooks] = useState<SavedNotebook[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeTab === 'saved') {
      loadSavedNotebooks();
    }
  }, [activeTab]);

  const loadSavedNotebooks = async () => {
    try {
      setLoading(true);
      const notebooks = await invoke<SavedNotebook[]>('notebooks_list', { limit: 50 });
      setSavedNotebooks(notebooks);
    } catch (error) {
      console.error('Failed to load notebooks:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = () => {
    if (!name.trim()) {
      alert('Please enter a notebook name');
      return;
    }

    onSave(name.trim(), description.trim() || undefined);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const notebook = await parseNotebookFile(file);
      onLoad(notebook);
    } catch (error) {
      console.error('Failed to parse notebook:', error);
      alert('Invalid notebook file');
    }
  };

  const handleLoadSaved = async (notebookId: string) => {
    try {
      const notebook = await invoke<SavedNotebook>('notebooks_get', { notebookId });
      const parsed = JSON.parse(notebook.blocks_json) as NotebookType;
      onLoad(parsed);
    } catch (error) {
      console.error('Failed to load notebook:', error);
      alert('Failed to load notebook');
    }
  };

  const handleDeleteSaved = async (notebookId: string) => {
    if (!confirm('Delete this notebook?')) return;

    try {
      await invoke('notebooks_delete', { notebookId });
      loadSavedNotebooks();
    } catch (error) {
      console.error('Failed to delete notebook:', error);
      alert('Failed to delete notebook');
    }
  };

  return (
    <div className="block-notebook-overlay" onClick={onClose}>
      <div className="block-notebook-modal" onClick={(e) => e.stopPropagation()}>
        <div className="block-notebook-header">
          <h2>Block Notebooks</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="block-notebook-tabs">
          <button
            className={activeTab === 'save' ? 'active' : ''}
            onClick={() => setActiveTab('save')}
          >
            Save Notebook
          </button>
          <button
            className={activeTab === 'load' ? 'active' : ''}
            onClick={() => setActiveTab('load')}
          >
            Load Notebook
          </button>
          <button
            className={activeTab === 'saved' ? 'active' : ''}
            onClick={() => setActiveTab('saved')}
          >
            Saved Notebooks
          </button>
        </div>

        <div className="block-notebook-content">
          {activeTab === 'save' && (
            <div className="notebook-save-tab">
              <div className="form-group">
                <label htmlFor="notebook-name">Notebook Name</label>
                <input
                  id="notebook-name"
                  type="text"
                  placeholder="Enter notebook name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="notebook-description">Description (optional)</label>
                <textarea
                  id="notebook-description"
                  placeholder="Enter description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </div>

              <button className="save-btn" onClick={handleSave}>
                Save
              </button>
            </div>
          )}

          {activeTab === 'load' && (
            <div className="notebook-load-tab">
              <p>Choose a .ccienb file to import:</p>
              <input
                type="file"
                accept=".ccienb"
                onChange={handleFileUpload}
              />
            </div>
          )}

          {activeTab === 'saved' && (
            <div className="notebook-saved-tab">
              {loading ? (
                <p>Loading notebooks...</p>
              ) : savedNotebooks.length === 0 ? (
                <p>No saved notebooks</p>
              ) : (
                <div className="notebooks-list">
                  {savedNotebooks.map((notebook) => (
                    <div key={notebook.id} className="notebook-item">
                      <div className="notebook-info">
                        <h3>{notebook.name}</h3>
                        {notebook.description && (
                          <p className="notebook-description">{notebook.description}</p>
                        )}
                        <span className="notebook-date">
                          {new Date(notebook.created_at * 1000).toLocaleString()}
                        </span>
                      </div>
                      <div className="notebook-actions">
                        <button onClick={() => handleLoadSaved(notebook.id)}>
                          Load
                        </button>
                        <button onClick={() => handleDeleteSaved(notebook.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

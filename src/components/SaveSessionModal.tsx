import { useState } from "react";
import { sessionSaveNamed } from "../lib/tauri";
import { useSessionsStore } from "../state/sessionsStore";

type SaveSessionModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function SaveSessionModal({ isOpen, onClose }: SaveSessionModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const addSession = useSessionsStore((s) => s.addSession);

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Session name is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const sessionId = await sessionSaveNamed(name.trim(), description.trim() || null);

      // Add to store
      addSession({
        id: sessionId,
        name: name.trim(),
        description: description.trim() || null,
        tab_count: 0, // Will be updated when list is refreshed
        created_at: Math.floor(Date.now() / 1000),
      });

      setSuccess(true);
      setTimeout(() => {
        handleClose();
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save session");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setName("");
    setDescription("");
    setError(null);
    setSuccess(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Save Session</h2>
          <button className="close-btn" onClick={handleClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {success ? (
            <div className="success-message">
              Session saved successfully!
            </div>
          ) : (
            <div className="save-session-form">
              <div className="field">
                <label htmlFor="session-name">Session Name *</label>
                <input
                  id="session-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., CCIE Lab Environment"
                  disabled={saving}
                  autoFocus
                />
              </div>

              <div className="field">
                <label htmlFor="session-description">Description (optional)</label>
                <textarea
                  id="session-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of this session..."
                  rows={3}
                  disabled={saving}
                />
              </div>

              {error && (
                <div className="error-message">
                  <strong>Error:</strong> {error}
                </div>
              )}

              <div className="button-row">
                <button className="secondary" onClick={handleClose} disabled={saving}>
                  Cancel
                </button>
                <button className="primary" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : "Save Session"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

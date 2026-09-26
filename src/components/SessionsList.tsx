import { useState } from "react";
import { sessionDeleteSaved, sessionExportJson } from "../lib/tauri";
// import { save } from "@tauri-apps/plugin-dialog";
import { useSessionsStore } from "../state/sessionsStore";

type SessionsListProps = {
  onLoadSession: (sessionId: string, sessionName: string, tabCount: number) => void;
};

export function SessionsList({ onLoadSession }: SessionsListProps) {
  const { sessions, removeSession } = useSessionsStore();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleDelete = async (sessionId: string, sessionName: string) => {
    if (!confirm(`Are you sure you want to delete session "${sessionName}"?`)) {
      return;
    }

    setLoading(sessionId);
    setError(null);

    try {
      await sessionDeleteSaved(sessionId);
      removeSession(sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete session");
    } finally {
      setLoading(null);
    }
  };

  const handleExport = async (sessionId: string, _sessionName: string) => {
    setLoading(sessionId);
    setError(null);

    try {
      const jsonData = await sessionExportJson(sessionId);

      // Download JSON directly via browser (fallback since Tauri plugins not installed yet)
      const blob = new Blob([jsonData], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `session_${sessionId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to export session");
    } finally {
      setLoading(null);
    }
  };

  if (sessions.length === 0) {
    return (
      <div className="empty-state">
        <p className="muted">No saved sessions yet.</p>
        <p className="muted">Click "Save Session" to create one.</p>
      </div>
    );
  }

  return (
    <div className="sessions-list-container">
      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="sessions-list">
        {sessions.map((session) => (
          <div key={session.id} className="session-card">
            <div className="session-card-header">
              <div>
                <h3 className="session-card-name">{session.name}</h3>
                {session.description && (
                  <p className="session-card-description">{session.description}</p>
                )}
              </div>
            </div>

            <div className="session-card-meta">
              <span>{session.tab_count} tabs</span>
              <span>{formatDate(session.created_at)}</span>
            </div>

            <div className="session-card-actions">
              <button
                className="primary"
                onClick={() => onLoadSession(session.id, session.name, session.tab_count)}
                disabled={loading === session.id}
              >
                Load
              </button>
              <button
                className="secondary"
                onClick={() => handleExport(session.id, session.name)}
                disabled={loading === session.id}
              >
                Export
              </button>
              <button
                className="delete-btn"
                onClick={() => handleDelete(session.id, session.name)}
                disabled={loading === session.id}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

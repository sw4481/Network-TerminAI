import { useEffect, useState, useCallback } from "react";
import {
  listSnapshots,
  deleteSnapshot,
  renameSnapshot,
  type ParsedSnapshot,
} from "../lib/structured";
import "./SnapshotList.css";

interface Props {
  tabId: string;
  /** Optional command filter — when provided, only snapshots for that command are shown. */
  command?: string;
  onSelect?: (snapshot: ParsedSnapshot) => void;
}

export function SnapshotList({ tabId, command, onSelect }: Props) {
  const [items, setItems] = useState<ParsedSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const refresh = useCallback(() => {
    listSnapshots(tabId)
      .then((all) => {
        setItems(command ? all.filter((s) => s.command === command) : all);
      })
      .catch((e) => setError(String(e)));
  }, [tabId, command]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = async (id: number) => {
    await deleteSnapshot(id);
    refresh();
  };

  const handleRename = async (id: number) => {
    if (!editName.trim()) return;
    await renameSnapshot(id, editName.trim());
    setEditingId(null);
    refresh();
  };

  if (error) {
    return <div className="snapshot-list error">{error}</div>;
  }
  if (items.length === 0) {
    return (
      <div className="snapshot-list empty">
        No snapshots {command ? <>for <code>{command}</code></> : "yet"}.
      </div>
    );
  }

  return (
    <ul className="snapshot-list" data-testid="snapshot-list">
      {items.map((s) => (
        <li key={s.id} className="snapshot-list-item">
          <button
            type="button"
            className="snapshot-list-link"
            onClick={() => onSelect?.(s)}
            data-testid={`snapshot-${s.id}`}
          >
            {editingId === s.id ? (
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename(s.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
              />
            ) : (
              <span className="snapshot-name">{s.name}</span>
            )}
            <span className="snapshot-meta">
              {s.command} · {new Date(s.capturedAt * 1000).toLocaleString()}
            </span>
          </button>
          <div className="snapshot-actions">
            <button
              type="button"
              className="snapshot-btn"
              onClick={(e) => {
                e.stopPropagation();
                setEditingId(s.id);
                setEditName(s.name);
              }}
              aria-label="Rename"
            >
              ✎
            </button>
            <button
              type="button"
              className="snapshot-btn danger"
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(s.id);
              }}
              aria-label="Delete"
              data-testid={`snapshot-delete-${s.id}`}
            >
              ×
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

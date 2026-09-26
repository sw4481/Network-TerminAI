import { useEffect, useState } from "react";
import {
  netconfSavedRpcList,
  netconfSavedRpcUpsert,
  netconfSavedRpcDelete,
  type SavedNetconfRpc,
} from "../../lib/tauri";
import { useNetconfRunner } from "../../state/netconfRunnerStore";

type Props = {
  tabId: string;
  onClose: () => void;
  onLoad: (rpc: SavedNetconfRpc) => void;
};

export function SavedRpcsPanel({ tabId, onClose, onLoad }: Props) {
  const [rpcs, setRpcs] = useState<SavedNetconfRpc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editXml, setEditXml] = useState("");

  useEffect(() => {
    loadRpcs();
  }, []);

  const loadRpcs = () => {
    setLoading(true);
    netconfSavedRpcList()
      .then(setRpcs)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  const handleSave = async () => {
    if (!editName.trim() || !editXml.trim()) {
      setError("Name and RPC XML are required");
      return;
    }

    try {
      await netconfSavedRpcUpsert(
        editingId === "new" ? null : (editingId as number),
        editName.trim(),
        editXml.trim()
      );
      setEditingId(null);
      setEditName("");
      setEditXml("");
      setError(null);
      loadRpcs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this saved RPC?")) return;
    try {
      await netconfSavedRpcDelete(id);
      loadRpcs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleEdit = (rpc: SavedNetconfRpc) => {
    setEditingId(rpc.id);
    setEditName(rpc.name);
    setEditXml(rpc.rpc_xml);
    setError(null);
  };

  const handleNew = () => {
    setEditingId("new");
    setEditName("");
    setEditXml("");
    setError(null);
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditName("");
    setEditXml("");
    setError(null);
  };

  return (
    <div
      data-testid="netconf-saved-rpcs-panel"
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        width: 500,
        background: "var(--surface-2)",
        borderLeft: "1px solid var(--border-default)",
        display: "flex",
        flexDirection: "column",
        zIndex: 10,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
          Saved RPCs
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!editingId && (
            <button
              data-testid="netconf-saved-rpcs-new"
              onClick={handleNew}
              style={{
                background: "var(--accent-subtle)",
                color: "var(--text-primary)",
                border: "none",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              New
            </button>
          )}
          <button
            data-testid="netconf-saved-rpcs-close"
            onClick={onClose}
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "4px 8px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Close
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: 12,
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border-default)",
            color: "var(--status-danger)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {loading && (
          <div style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)" }}>
            Loading...
          </div>
        )}

        {/* Editor form */}
        {editingId && (
          <div
            data-testid="netconf-saved-rpcs-editor"
            style={{
              background: "var(--app-canvas)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: 12,
              marginBottom: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
              {editingId === "new" ? "New RPC" : "Edit RPC"}
            </div>

            <input
              data-testid="netconf-saved-rpc-name"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="RPC name"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "Menlo, monospace",
              }}
            />

            <textarea
              data-testid="netconf-saved-rpc-xml"
              value={editXml}
              onChange={(e) => setEditXml(e.target.value)}
              placeholder="<get-config>...</get-config>"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "8px 10px",
                fontSize: 11,
                fontFamily: "Menlo, monospace",
                minHeight: 200,
                resize: "vertical",
              }}
            />

            <div style={{ display: "flex", gap: 6 }}>
              <button
                data-testid="netconf-saved-rpc-save"
                onClick={handleSave}
                style={{
                  background: "var(--accent-subtle)",
                  color: "var(--text-primary)",
                  border: "none",
                  borderRadius: 4,
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Save
              </button>
              <button
                data-testid="netconf-saved-rpc-cancel"
                onClick={handleCancel}
                style={{
                  background: "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* RPC list */}
        {!loading && !editingId && rpcs.length === 0 && (
          <div
            style={{
              padding: 16,
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            No saved RPCs yet
          </div>
        )}

        {!editingId &&
          rpcs.map((rpc) => (
            <SavedRpcItem
              key={rpc.id}
              rpc={rpc}
              onLoad={() => onLoad(rpc)}
              onEdit={() => handleEdit(rpc)}
              onDelete={() => handleDelete(rpc.id)}
            />
          ))}
      </div>
    </div>
  );
}

function SavedRpcItem({
  rpc,
  onLoad,
  onEdit,
  onDelete,
}: {
  rpc: SavedNetconfRpc;
  onLoad: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const preview = rpc.rpc_xml.slice(0, 100);

  return (
    <div
      data-testid={`netconf-saved-rpc-item-${rpc.id}`}
      style={{
        background: "var(--app-canvas)",
        border: "1px solid var(--border-default)",
        borderRadius: 4,
        marginBottom: 8,
        padding: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {rpc.name}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            data-testid={`netconf-saved-rpc-load-${rpc.id}`}
            onClick={onLoad}
            style={{
              background: "var(--accent-subtle)",
              color: "var(--text-primary)",
              border: "none",
              borderRadius: 4,
              padding: "3px 8px",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            Load
          </button>
          <button
            data-testid={`netconf-saved-rpc-edit-${rpc.id}`}
            onClick={onEdit}
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "3px 8px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            Edit
          </button>
          <button
            data-testid={`netconf-saved-rpc-delete-${rpc.id}`}
            onClick={onDelete}
            style={{
              background: "transparent",
              color: "var(--status-danger)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "3px 8px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <div
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: "Menlo, monospace",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {preview}...
      </div>
    </div>
  );
}

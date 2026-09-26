import { useEffect, useState } from "react";
import {
  netconfHistoryList,
  netconfHistoryDetail,
  type NetconfHistoryItem,
  type NetconfHistoryDetail,
} from "../../lib/tauri";
import { useNetconfRunner } from "../../state/netconfRunnerStore";

type Props = {
  tabId: string;
  onClose: () => void;
  onLoad: (detail: NetconfHistoryDetail) => void;
};

export function HistoryPanel({ tabId, onClose, onLoad }: Props) {
  const [items, setItems] = useState<NetconfHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    netconfHistoryList(tabId, 50, 0)
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [tabId]);

  const handleLoad = async (id: string) => {
    try {
      const detail = await netconfHistoryDetail(id);
      onLoad(detail);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      data-testid="netconf-history-panel"
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        width: 400,
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
          History
        </div>
        <button
          data-testid="netconf-history-close"
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

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {loading && (
          <div style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)" }}>
            Loading...
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 12,
              background: "var(--surface-2)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              color: "var(--status-danger)",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div
            style={{
              padding: 16,
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            No history yet
          </div>
        )}

        {items.map((item) => (
          <HistoryItem key={item.id} item={item} onLoad={handleLoad} />
        ))}
      </div>
    </div>
  );
}

function HistoryItem({
  item,
  onLoad,
}: {
  item: NetconfHistoryItem;
  onLoad: (id: string) => void;
}) {
  const isSuccess = item.status === "success";
  const time = new Date(item.sent_at).toLocaleTimeString();

  return (
    <div
      data-testid={`netconf-history-item-${item.id}`}
      onClick={() => onLoad(item.id)}
      style={{
        padding: 10,
        background: "var(--app-canvas)",
        border: "1px solid var(--border-default)",
        borderRadius: 4,
        marginBottom: 6,
        cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-selected)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--app-canvas)")}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-primary)",
            fontFamily: "Menlo, monospace",
          }}
        >
          {item.operation}
        </div>
        <div
          style={{
            fontSize: 10,
            color: isSuccess ? "var(--status-success)" : "var(--status-danger)",
            fontWeight: 600,
          }}
        >
          {isSuccess ? "✓" : "✗"}
        </div>
      </div>

      <div
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          marginBottom: 4,
        }}
      >
        {item.host || "Unknown host"}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--text-muted)",
        }}
      >
        <span>{time}</span>
        {item.duration_ms !== null && <span>{item.duration_ms}ms</span>}
      </div>
    </div>
  );
}

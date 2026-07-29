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
        background: "#14161a",
        borderLeft: "1px solid #262a33",
        display: "flex",
        flexDirection: "column",
        zIndex: 10,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #262a33",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "#e6e1cf" }}>
          History
        </div>
        <button
          data-testid="netconf-history-close"
          onClick={onClose}
          style={{
            background: "transparent",
            color: "#8a8d94",
            border: "1px solid #262a33",
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
          <div style={{ padding: 16, textAlign: "center", color: "#8a8d94" }}>
            Loading...
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 12,
              background: "#2a1a1a",
              border: "1px solid #3d2626",
              borderRadius: 4,
              color: "#f28779",
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
              color: "#6c7380",
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
        background: "#0f1114",
        border: "1px solid #262a33",
        borderRadius: 4,
        marginBottom: 6,
        cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#1a1c20")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "#0f1114")}
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
            color: "#e6e1cf",
            fontFamily: "Menlo, monospace",
          }}
        >
          {item.operation}
        </div>
        <div
          style={{
            fontSize: 10,
            color: isSuccess ? "#6bd968" : "#f28779",
            fontWeight: 600,
          }}
        >
          {isSuccess ? "✓" : "✗"}
        </div>
      </div>

      <div
        style={{
          fontSize: 11,
          color: "#8a8d94",
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
          color: "#6c7380",
        }}
      >
        <span>{time}</span>
        {item.duration_ms !== null && <span>{item.duration_ms}ms</span>}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  aiConversationsList,
  aiMessagesByTabAgent,
  type ConversationSummary,
  type AiMessage,
} from "../lib/tauri";
import { useAgentsStore } from "../state/agentsStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

/**
 * Read-only global chat-history browser. Lists every distinct
 * (tab, agent) conversation with preview + filters. Click one to see
 * the full transcript in a side drawer.
 */
export function ChatHistoryBrowser({ isOpen, onClose }: Props) {
  const agents = useAgentsStore((s) => s.agents);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all"); // "all" | "general" | <agent-id>
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    aiConversationsList()
      .then((list) => {
        setConversations(list);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // Reset transient state each time the dialog opens
    setSelected(null);
    setMessages([]);
    setSearch("");
    setAgentFilter("all");
  }, [isOpen]);

  // Build a name lookup for agent labels
  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  // Agents that actually appear in history (so the dropdown only shows real options)
  const agentsInHistory = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) if (c.agentId) set.add(c.agentId);
    return Array.from(set).sort();
  }, [conversations]);

  // Apply filters
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (agentFilter === "general" && c.agentId !== null) return false;
      if (
        agentFilter !== "all" &&
        agentFilter !== "general" &&
        c.agentId !== agentFilter
      ) {
        return false;
      }
      if (q) {
        const hay = [
          c.preview,
          c.tabTitle ?? "",
          c.agentId ?? "general",
          agentNameById.get(c.agentId ?? "") ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [conversations, agentFilter, search, agentNameById]);

  // When a conversation is selected, lazy-load its messages
  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    setMsgsLoading(true);
    aiMessagesByTabAgent(selected.tabId, selected.agentId)
      .then((rows) => setMessages(rows))
      .catch(() => setMessages([]))
      .finally(() => setMsgsLoading(false));
  }, [selected]);

  if (!isOpen) return null;

  const formatTime = (ts: number) => {
    try {
      const d = new Date(ts);
      return d.toLocaleString();
    } catch {
      return String(ts);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-window history-window"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h1>Chat History</h1>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="history-toolbar">
          <input
            type="text"
            placeholder="Search previews, tab titles, agent names…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="history-search"
          />
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="history-agent-filter"
          >
            <option value="all">All agents</option>
            <option value="general">General (no persona)</option>
            {agentsInHistory.map((id) => (
              <option key={id} value={id}>
                {agentNameById.get(id) ?? id}
              </option>
            ))}
          </select>
        </div>

        <div className="history-body">
          <div className="history-list">
            {loading && <p className="muted">Loading…</p>}
            {error && <p className="error-message">{error}</p>}
            {!loading && !error && filtered.length === 0 && (
              <p className="muted">
                {conversations.length === 0
                  ? "No conversations yet. Start chatting and they'll appear here."
                  : "No conversations match your filters."}
              </p>
            )}
            {filtered.map((c) => {
              const isSelected =
                selected &&
                selected.tabId === c.tabId &&
                selected.agentId === c.agentId;
              const agentLabel =
                c.agentId === null
                  ? "General"
                  : agentNameById.get(c.agentId) ?? c.agentId;
              return (
                <button
                  key={`${c.tabId}::${c.agentId ?? "general"}`}
                  className={`history-item${isSelected ? " selected" : ""}`}
                  onClick={() => setSelected(c)}
                >
                  <div className="history-item-row1">
                    <span className="history-item-agent">{agentLabel}</span>
                    <span className="history-item-time">
                      {formatTime(c.lastTimestamp)}
                    </span>
                  </div>
                  <div className="history-item-row2">
                    <span className="history-item-tab">
                      {c.tabExists
                        ? c.tabTitle ?? `tab ${c.tabId.slice(0, 6)}`
                        : `⚠ deleted tab (${c.tabId.slice(0, 6)})`}
                    </span>
                    <span className="history-item-count">
                      {c.messageCount} msg
                    </span>
                  </div>
                  <div className="history-item-preview">
                    {c.preview || <span className="muted">(no user message)</span>}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="history-detail">
            {!selected && (
              <div className="history-detail-empty">
                <p className="muted">Select a conversation to view it.</p>
              </div>
            )}
            {selected && (
              <>
                <div className="history-detail-header">
                  <div>
                    <strong>
                      {selected.agentId === null
                        ? "General"
                        : agentNameById.get(selected.agentId) ?? selected.agentId}
                    </strong>
                    <span className="muted" style={{ marginLeft: 8 }}>
                      in {selected.tabTitle ?? selected.tabId.slice(0, 8)}
                    </span>
                  </div>
                  <span className="muted" style={{ fontSize: 11 }}>
                    read-only
                  </span>
                </div>
                <div className="history-detail-body">
                  {msgsLoading && <p className="muted">Loading messages…</p>}
                  {!msgsLoading && messages.length === 0 && (
                    <p className="muted">No messages.</p>
                  )}
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`agent-message ${m.role}`}
                      style={{ maxWidth: "100%" }}
                    >
                      <div className="agent-message-content">
                        {m.role === "user" ? (
                          <p>{m.content}</p>
                        ) : (
                          <ReactMarkdown>{m.content}</ReactMarkdown>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

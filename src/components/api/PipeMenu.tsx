import { useEffect, useState } from "react";
import {
  agentsList,
  agentSessionSet,
  apiPipeToTerminal,
  listPipeTargets,
  type Agent,
} from "../../lib/tauri";
import type { Tab } from "../../lib/types";
import { useAgentsStore } from "../../state/agentsStore";

/**
 * Human-friendly label for a terminal tab in the PipeMenu. Most terminal
 * tabs have titles like `/bin/zsh` which all look the same — use the
 * shell basename + a per-session index so the user can tell them apart.
 */
function labelForTerminal(t: Tab, idx: number): string {
  const base = (t.shell_cmd || t.title || "shell").split("/").pop() || "shell";
  return `${base} #${idx + 1}`;
}

export type PipeTarget = {
  /** Tab id that initiated the pipe (its own id — the AI chat for THIS tab). */
  sourceTabId: string;
  /** The raw picked value (string / number / object / null). */
  value: unknown;
  /** Optional column name / jsonpath for display. */
  label?: string;
  /** Screen coords where the menu should open. */
  x: number;
  y: number;
};

type Props = {
  target: PipeTarget | null;
  onClose: () => void;
};

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Compact stringify used inside CSV cells (no newlines / indentation). */
function stringifyCompact(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Convert an array of row objects (or a single object) to CSV. Columns are
 * the union of keys in the order they first appear. Strings with commas or
 * quotes are RFC4180-escaped; complex nested values are re-JSONed.
 */
export function rowsToCsv(value: unknown): string {
  const rows = Array.isArray(value) ? value : [value];
  const objectRows = rows.filter(
    (r): r is Record<string, unknown> =>
      r !== null && typeof r === "object" && !Array.isArray(r),
  );
  if (objectRows.length === 0) {
    // Scalar / array-of-scalars fallback: one column "value".
    const lines = ["value"];
    for (const v of rows) {
      lines.push(csvEscape(stringifyCompact(v)));
    }
    return lines.join("\n");
  }
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of objectRows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  const header = cols.map(csvEscape).join(",");
  const lines = [header];
  for (const r of objectRows) {
    lines.push(cols.map((c) => csvEscape(stringifyCompact(r[c]))).join(","));
  }
  return lines.join("\n");
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function PipeMenu({ target, onClose }: Props) {
  const [terminalTabs, setTerminalTabs] = useState<Tab[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const setActiveAgent = useAgentsStore((s) => s.setActiveAgent);
  // Whichever agent the user had active for THIS tab's AgentPanel. Piping
  // into the current tab routes to this agent's bucket so the panel the
  // user is looking at shows the message immediately.
  const currentTabActiveAgent = useAgentsStore((s) =>
    target ? s.activeAgentByTab[target.sourceTabId] ?? "general" : "general",
  );

  useEffect(() => {
    if (!target) return;
    setStatus(null);
    setCopied(false);
    // Only show tabs with a LIVE PTY — listPipeTargets filters out stale
    // DB rows from prior app runs whose PTY died without a clean close.
    listPipeTargets()
      .then(setTerminalTabs)
      .catch(() => setTerminalTabs([]));
    // Load the user-authored Agents list so we can offer them as targets.
    // Failure is non-fatal — we fall back to the "general chat" option.
    agentsList()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [target?.sourceTabId, target?.x, target?.y]);

  useEffect(() => {
    if (!target) return;
    const onClick = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay binding so the event that opened this menu doesn't close it.
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onClick);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [target, onClose]);

  if (!target) return null;

  const valueString = stringify(target.value);

  const sendToTerminal = async (tabId: string) => {
    try {
      await apiPipeToTerminal({ tabId, text: valueString });
      setStatus("sent");
      setTimeout(onClose, 400);
    } catch (err) {
      setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const copyCsv = async () => {
    const csv = rowsToCsv(target.value);
    try {
      await navigator.clipboard.writeText(csv);
      setCopied(true);
      setTimeout(onClose, 400);
    } catch (err) {
      setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * Route the picked value into the AgentPanel's input field.
   * Instead of adding the message directly to the chat history, we dispatch
   * a custom event that the AgentPanel listens for. This allows the user to
   * review and edit the prompt before sending it.
   */
  const sendToAi = async (tabId: string, agentId: string | null) => {
    const prompt = target.label
      ? `Analyze ${target.label} from the response.`
      : "Analyze this response.";
    const snippet = valueString.slice(0, 8192);
    // Build the full prompt with context
    const content = snippet.trim()
      ? `${prompt}\n\nContext from API response:\n\`\`\`json\n${snippet}\n\`\`\``
      : prompt;

    try {
      // Dispatch a custom event to prefill the AgentPanel input
      const event = new CustomEvent("ccie:prefill-agent-input", {
        detail: {
          tabId,
          agentId: agentId ?? "general",
          message: content,
        },
      });
      window.dispatchEvent(event);

      // Point the destination tab's AgentPanel at the agent we're targeting
      setActiveAgent(tabId, agentId ?? "general");
      // Also persist the (tab, agent) binding on the backend
      if (agentId) {
        agentSessionSet(tabId, agentId).catch(() => {});
      }
      setStatus("added to input — open the AgentPanel to send");
      setTimeout(onClose, 600);
    } catch (err) {
      setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div
      data-testid="api-pipe-menu"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: target.y,
        left: target.x,
        zIndex: 30,
        background: "var(--surface-2)",
        border: "1px solid var(--border-default)",
        borderRadius: 4,
        padding: 4,
        minWidth: 220,
        // Cap the menu's height to 70% of the viewport and let overflow
        // scroll. With many terminal tabs × agents the list can get long;
        // overflowing off-screen leaves "Send to AI" unreachable.
        maxHeight: "min(70vh, 520px)",
        overflowY: "auto",
        boxShadow: "0 4px 14px rgb(var(--backdrop-rgb) / 0.5)",
        fontSize: 12,
        fontFamily: "Menlo, monospace",
        color: "var(--text-primary)",
      }}
    >
      <MenuHeader label={target.label} />
      <MenuDivider />
      <SubHeader>Send to terminal…</SubHeader>
      {terminalTabs.length === 0 && (
        <MenuRow disabled data-testid="api-pipe-no-terminals">
          (no open terminal tabs)
        </MenuRow>
      )}
      {terminalTabs.map((t, i) => (
        <MenuRow
          key={t.id}
          data-testid={`api-pipe-to-terminal-${t.id}`}
          onClick={() => sendToTerminal(t.id)}
          title={`${t.shell_cmd} (${t.id.slice(0, 8)}…)`}
        >
          → {labelForTerminal(t, i)}
        </MenuRow>
      ))}
      <MenuDivider />
      <MenuRow
        data-testid="api-pipe-copy-csv"
        onClick={copyCsv}
        title="Arrays-of-objects get one row per item"
      >
        Copy as CSV{copied ? " ✓" : ""}
      </MenuRow>
      <MenuDivider />
      <SubHeader>Send to AI panel (this tab)</SubHeader>
      {/*
        DEFAULT block: pipe into the AgentPanel the user is actually
        looking at — this tab's bucket — and let them pick WHICH agent
        receives it. Every action here also switches the active agent
        for this tab so the panel reloads the chosen bucket instantly.
      */}
      <MenuRow
        data-testid="api-pipe-to-ai"
        onClick={() => sendToAi(target.sourceTabId, null)}
        title="Routes to this tab's general chat"
      >
        ✦ General chat{currentTabActiveAgent === "general" ? "  (active)" : ""}
      </MenuRow>
      {agents.map((a) => (
        <MenuRow
          key={`self:${a.id}`}
          data-testid={`api-pipe-to-ai-self-${a.id}`}
          onClick={() => sendToAi(target.sourceTabId, a.id)}
          title={a.description || a.name}
        >
          ✦ {a.name}
          {currentTabActiveAgent === a.id ? "  (active)" : ""}
        </MenuRow>
      ))}
      {status && (
        <div
          data-testid="api-pipe-status"
          style={{
            padding: "4px 8px",
            color: status.startsWith("error") ? "var(--status-danger)" : "var(--status-success)",
            fontSize: 11,
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}

function MenuHeader({ label }: { label?: string }) {
  return (
    <div
      style={{ padding: "4px 8px", color: "var(--text-secondary)", fontSize: 11 }}
      data-testid="api-pipe-label"
    >
      {label ? `Field: ${label}` : "Picked value"}
    </div>
  );
}

function MenuDivider() {
  return <div style={{ height: 1, background: "var(--surface-3)", margin: "2px 0" }} />;
}

function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "2px 8px",
        color: "var(--text-muted)",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </div>
  );
}

function MenuRow({
  children,
  onClick,
  disabled,
  title,
  ...rest
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
} & Record<string, unknown>) {
  return (
    <button
      {...(rest as Record<string, unknown>)}
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      style={{
        width: "100%",
        textAlign: "left",
        background: "transparent",
        color: disabled ? "var(--text-muted)" : "var(--text-primary)",
        border: "none",
        padding: "4px 8px",
        cursor: disabled ? "default" : "pointer",
        fontSize: 12,
        fontFamily: "Menlo, monospace",
      }}
      onMouseEnter={(e) => {
        if (!disabled)
          (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-2)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

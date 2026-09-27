import { create } from "zustand";
import { saveAiMessage } from "../lib/tauri";
import type { RetrievedChunk } from "../lib/rag";

/**
 * Compose the per-(tab, agent) key used to bucket chat state.
 * agentId defaults to "general" (the no-persona chat).
 *
 * Using `tabId::agentId` means switching agents inside a tab shows a separate
 * conversation history without requiring any store refactor — the existing
 * `Record<string, Message[]>` shape still works.
 */
export function chatKey(tabId: string, agentId?: string | null): string {
  return `${tabId}::${agentId && agentId.length > 0 ? agentId : "general"}`;
}

export type ChatRole = "user" | "assistant" | "tool_proposed" | "tool_result";

export type Message = {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  /** Only set for role === "tool_proposed" or "tool_result" */
  toolCallId?: string;
  /** Only set for role === "tool_proposed" */
  toolKind?: "shell" | "mcp" | string;
  /** Only set for role === "tool_proposed" */
  toolPayload?: Record<string, unknown>;
  /** Only set for role === "tool_proposed" — whether the shell cmd matched the allowlist */
  toolAllowed?: boolean;
  /** "pending" | "run" | "rejected" | "done" — lifecycle for a proposed tool */
  toolStatus?: "pending" | "run" | "rejected" | "done";
  /** For role === "tool_result" */
  exitCode?: number | null;
  /**
   * Plan 12 Phase 5 — RAG-retrieved chunks the assistant cited for
   * this turn. Set via `attachSourcesToInProgress` once the backend
   * emits the `sources` event. Only meaningful for `role === "assistant"`.
   */
  sources?: RetrievedChunk[];
};

type ChatState = {
  messages: Record<string, Message[]>;
  streaming: Record<string, boolean>;
  error: Record<string, string | null>;
  /**
   * Plan 12 Phase 5 — sources received by the channel BEFORE the
   * empty assistant bubble has had a chance to mount, keyed by chat
   * bucket. Drained on first `appendToken` call and attached to the
   * latest assistant message. Survives the corner case where the
   * sidecar emits the Sources event in the same tick the assistant
   * shell is being created.
   */
  pendingSources: Record<string, RetrievedChunk[]>;
};

type ChatActions = {
  /**
   * Add a message. `key` is the `chatKey(tabId, agentId)` bucket; the message's
   * owning tab_id/agent_id for persistence is passed separately so the DB row
   * is tagged correctly (keeps persistence independent from the in-memory bucket).
   */
  addMessage: (
    key: string,
    message: Message,
    persist?: { tabId: string; agentId: string | null }
  ) => void;
  appendToken: (key: string, token: string) => void;
  setStreaming: (key: string, streaming: boolean) => void;
  setError: (key: string, error: string | null) => void;
  clearError: (key: string) => void;
  loadMessages: (key: string, messages: Message[]) => void;
  /** Remove all in-memory messages for a key (does NOT touch the DB). */
  clearMessages: (key: string) => void;
  /** Drop all state for every bucket matching a prefix — useful when a tab closes. */
  dropByTabPrefix: (tabId: string) => void;
  /** Mutate an existing proposed-tool message (e.g., to set status after user acts). */
  updateToolMessage: (
    key: string,
    toolCallId: string,
    patch: Partial<Message>
  ) => void;
  /**
   * Plan 12 Phase 5 — attach RAG-retrieved chunks to the most recent
   * assistant message in `key`. If no assistant message exists yet
   * (the Sources event raced ahead of the empty bubble), the chunks
   * are stashed in `pendingSources[key]` and applied on the first
   * subsequent `appendToken` call.
   */
  attachSourcesToInProgress: (key: string, sources: RetrievedChunk[]) => void;
};

type ChatStore = ChatState & ChatActions;

export const useChatStore = create<ChatStore>((set) => ({
  messages: {},
  streaming: {},
  error: {},
  pendingSources: {},

  addMessage: (key, message, persist) => {
    // Only persist user/assistant text roles to DB — tool proposals/results are
    // ephemeral UI state (the tool_result content is already stored server-side
    // via command block output, and tool_proposed is a render hint).
    if (
      persist &&
      (message.role === "user" || message.role === "assistant")
    ) {
      saveAiMessage({
        tabId: persist.tabId,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        agentId: persist.agentId,
      }).catch(console.error);
    }

    set((state) => {
      // Plan 12 Phase 5 — when a NEW user turn starts, invalidate any
      // sources that were stashed for a prior turn that never
      // materialized an assistant bubble (e.g., the sidecar errored
      // before any token, or the user re-sent before the assistant
      // appeared). Otherwise those stale chunks would incorrectly
      // attach to the next assistant message via appendToken's drain.
      let nextPendingSources = state.pendingSources;
      if (message.role === "user" && key in state.pendingSources) {
        nextPendingSources = { ...state.pendingSources };
        delete nextPendingSources[key];
      }
      return {
        messages: {
          ...state.messages,
          [key]: [...(state.messages[key] || []), message],
        },
        pendingSources: nextPendingSources,
      };
    });
  },

  appendToken: (key, token) =>
    set((state) => {
      const msgs = state.messages[key] || [];
      if (msgs.length === 0) return state;

      // Find the LAST assistant message (not necessarily the last message overall,
      // since tool_proposed / tool_result messages may have been inserted).
      let lastAssistantIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }
      if (lastAssistantIdx < 0) return state;

      const updated = [...msgs];
      const target = updated[lastAssistantIdx];
      // Plan 12 Phase 5 — drain any pending sources that arrived
      // before the assistant bubble was appended. We only attach if
      // the target doesn't already carry sources (a later
      // attachSourcesToInProgress call shouldn't get clobbered by
      // a token arriving in the same tick).
      const pending = state.pendingSources[key];
      const sourcesPatch =
        pending && pending.length > 0 && !target.sources
          ? { sources: pending }
          : {};
      updated[lastAssistantIdx] = {
        ...target,
        content: target.content + token,
        ...sourcesPatch,
      };

      const nextPendingSources = { ...state.pendingSources };
      if (pending && pending.length > 0) {
        delete nextPendingSources[key];
      }

      return {
        messages: {
          ...state.messages,
          [key]: updated,
        },
        pendingSources: nextPendingSources,
      };
    }),

  setStreaming: (key, streaming) =>
    set((state) => ({
      streaming: {
        ...state.streaming,
        [key]: streaming,
      },
    })),

  setError: (key, error) =>
    set((state) => {
      // Plan 12 Phase 5 — the assistant turn failed; any chunks the
      // sidecar already retrieved are no longer relevant and must not
      // bleed into the NEXT assistant message via the pendingSources
      // drain in appendToken.
      let nextPendingSources = state.pendingSources;
      if (error !== null && key in state.pendingSources) {
        nextPendingSources = { ...state.pendingSources };
        delete nextPendingSources[key];
      }
      return {
        error: {
          ...state.error,
          [key]: error,
        },
        pendingSources: nextPendingSources,
      };
    }),

  clearError: (key) =>
    set((state) => ({
      error: {
        ...state.error,
        [key]: null,
      },
    })),

  loadMessages: (key, messages) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: messages,
      },
    })),

  clearMessages: (key) =>
    set((state) => {
      if (!(key in state.messages)) return state;
      const next = { ...state.messages };
      delete next[key];
      return { messages: next };
    }),

  dropByTabPrefix: (tabId) =>
    set((state) => {
      const prefix = `${tabId}::`;
      const filter = <V>(map: Record<string, V>): Record<string, V> => {
        const out: Record<string, V> = {};
        for (const k in map) {
          if (!k.startsWith(prefix)) out[k] = map[k];
        }
        return out;
      };
      return {
        messages: filter(state.messages),
        streaming: filter(state.streaming),
        error: filter(state.error),
        pendingSources: filter(state.pendingSources),
      };
    }),

  updateToolMessage: (key, toolCallId, patch) =>
    set((state) => {
      const msgs = state.messages[key] || [];
      const updated = msgs.map((m) =>
        m.toolCallId === toolCallId ? { ...m, ...patch } : m
      );
      return {
        messages: {
          ...state.messages,
          [key]: updated,
        },
      };
    }),

  attachSourcesToInProgress: (key, sources) =>
    set((state) => {
      const msgs = state.messages[key] || [];
      // Look for the most recent assistant message and attach if it
      // doesn't already carry sources (idempotent against duplicate
      // events).
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant" && !msgs[i].sources) {
          const updated = [...msgs];
          updated[i] = { ...updated[i], sources };
          return {
            messages: {
              ...state.messages,
              [key]: updated,
            },
          };
        }
      }
      // No assistant message yet — stash for the next appendToken to
      // pick up.
      return {
        pendingSources: {
          ...state.pendingSources,
          [key]: sources,
        },
      };
    }),
}));

import { create } from "zustand";
import type { Agent } from "../lib/tauri";

type AgentsState = {
  agents: Agent[];
  /** Per-tab active agent id (empty/unset = "general"/no persona) */
  activeAgentByTab: Record<string, string>;
  /** Per-tab pending @mention override for next message */
  pendingMentionByTab: Record<string, string | null>;
};

type AgentsActions = {
  setAgents: (agents: Agent[]) => void;
  setActiveAgent: (tabId: string, agentId: string) => void;
  getActiveAgent: (tabId: string) => string;
  setPendingMention: (tabId: string, agentId: string | null) => void;
  consumePendingMention: (tabId: string) => string | null;
};

type AgentsStore = AgentsState & AgentsActions;

export const useAgentsStore = create<AgentsStore>((set, get) => ({
  agents: [],
  activeAgentByTab: {},
  pendingMentionByTab: {},

  setAgents: (agents) => set({ agents }),

  setActiveAgent: (tabId, agentId) =>
    set((s) => ({
      activeAgentByTab: { ...s.activeAgentByTab, [tabId]: agentId },
    })),

  getActiveAgent: (tabId) => get().activeAgentByTab[tabId] ?? "general",

  setPendingMention: (tabId, agentId) =>
    set((s) => ({
      pendingMentionByTab: { ...s.pendingMentionByTab, [tabId]: agentId },
    })),

  consumePendingMention: (tabId) => {
    const current = get().pendingMentionByTab[tabId] ?? null;
    if (current) {
      set((s) => ({
        pendingMentionByTab: { ...s.pendingMentionByTab, [tabId]: null },
      }));
    }
    return current;
  },
}));

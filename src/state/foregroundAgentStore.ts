import { create } from 'zustand';
import { listenForegroundAgent } from '../lib/foregroundAgent';

interface ForegroundAgentState {
  byPane: Map<string, string>; // paneId (PTY id) -> agent id
  set: (paneId: string, agent: string | null) => void;
  get: (paneId: string) => string | undefined;
  subscribeToEvents: () => Promise<() => void>;
}

export const useForegroundAgentStore = create<ForegroundAgentState>((set, get) => ({
  byPane: new Map(),
  set: (paneId, agent) => {
    set((state) => {
      const next = new Map(state.byPane);
      if (agent) next.set(paneId, agent);
      else next.delete(paneId);
      return { byPane: next };
    });
  },
  get: (paneId) => get().byPane.get(paneId),
  subscribeToEvents: async () => {
    return listenForegroundAgent((e) => get().set(e.paneId, e.agent));
  },
}));

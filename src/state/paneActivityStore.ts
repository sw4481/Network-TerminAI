import { create } from 'zustand';
import type { PaneActivity, AgentSession } from '../lib/paneActivity';
import { listenPaneActivityUpdated, listenAgentSessionUpdated, getActiveAgentSessions } from '../lib/paneActivity';

interface PaneActivityState {
  activities: Map<string, PaneActivity>;
  agentSessions: Map<string, AgentSession>;

  updateActivity: (activity: PaneActivity) => void;
  getActivity: (paneId: string) => PaneActivity | undefined;
  getAllForTab: (tabId: string) => PaneActivity[];
  removeActivity: (paneId: string) => void;

  updateAgentSession: (session: AgentSession) => void;
  removeAgentSession: (paneId: string) => void;
  getAgentSession: (paneId: string) => AgentSession | undefined;

  // Lifecycle
  subscribeToEvents: () => Promise<() => void>;
}

export const usePaneActivityStore = create<PaneActivityState>((set, get) => ({
  activities: new Map(),
  agentSessions: new Map(),

  updateActivity: (activity) => {
    set((state) => {
      const newActivities = new Map(state.activities);
      newActivities.set(activity.paneId, activity);
      return { activities: newActivities };
    });
  },

  getActivity: (paneId) => {
    return get().activities.get(paneId);
  },

  getAllForTab: (tabId) => {
    return Array.from(get().activities.values()).filter(
      (a) => a.tabId === tabId
    );
  },

  removeActivity: (paneId) => {
    set((state) => {
      const newActivities = new Map(state.activities);
      newActivities.delete(paneId);
      return { activities: newActivities };
    });
  },

  updateAgentSession: (session) => {
    set((state) => {
      const newSessions = new Map(state.agentSessions);
      newSessions.set(session.paneId, session);
      return { agentSessions: newSessions };
    });
  },

  removeAgentSession: (paneId) => {
    set((state) => {
      const newSessions = new Map(state.agentSessions);
      newSessions.delete(paneId);
      return { agentSessions: newSessions };
    });
  },

  getAgentSession: (paneId) => {
    return get().agentSessions.get(paneId);
  },

  subscribeToEvents: async () => {
    const unlistenActivity = await listenPaneActivityUpdated((activity) => {
      get().updateActivity(activity);
    });

    const unlistenAgentSession = await listenAgentSessionUpdated(async () => {
      const sessions = await getActiveAgentSessions();
      set({ agentSessions: new Map(sessions.map(s => [s.paneId, s])) });
    });

    return () => {
      unlistenActivity();
      unlistenAgentSession();
    };
  },
}));

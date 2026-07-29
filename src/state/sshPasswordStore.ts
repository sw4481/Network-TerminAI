import { create } from 'zustand';

interface SshPasswordContext {
  tabId: string;
  host: string;
  user: string | null;
  password: string;
  timestamp: number;
}

interface SshPasswordStore {
  contexts: Map<string, SshPasswordContext>;
  setPasswordContext: (tabId: string, host: string, user: string | null, password: string) => void;
  getPasswordContext: (tabId: string) => SshPasswordContext | null;
  clearPasswordContext: (tabId: string) => void;
  cleanupOldContexts: () => void;
}

export const useSshPasswordStore = create<SshPasswordStore>((set, get) => ({
  contexts: new Map(),

  setPasswordContext: (tabId, host, user, password) => {
    set((state) => {
      const newContexts = new Map(state.contexts);
      newContexts.set(tabId, {
        tabId,
        host,
        user,
        password,
        timestamp: Date.now(),
      });
      return { contexts: newContexts };
    });

    // Auto-cleanup after 5 minutes
    setTimeout(() => {
      get().clearPasswordContext(tabId);
    }, 5 * 60 * 1000);
  },

  getPasswordContext: (tabId) => {
    return get().contexts.get(tabId) || null;
  },

  clearPasswordContext: (tabId) => {
    set((state) => {
      const newContexts = new Map(state.contexts);
      newContexts.delete(tabId);
      return { contexts: newContexts };
    });
  },

  cleanupOldContexts: () => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    set((state) => {
      const newContexts = new Map(state.contexts);
      for (const [tabId, context] of newContexts.entries()) {
        if (now - context.timestamp > maxAge) {
          newContexts.delete(tabId);
        }
      }
      return { contexts: newContexts };
    });
  },
}));

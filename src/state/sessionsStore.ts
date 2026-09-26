import { create } from "zustand";
import type { SavedSession } from "../lib/tauri";

type SessionsStore = {
  sessions: SavedSession[];
  loading: boolean;
  error: string | null;
  setSessions: (sessions: SavedSession[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  addSession: (session: SavedSession) => void;
  removeSession: (id: string) => void;
};

export const useSessionsStore = create<SessionsStore>((set) => ({
  sessions: [],
  loading: false,
  error: null,
  setSessions: (sessions) => set({ sessions, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  addSession: (session) =>
    set((s) => ({ sessions: [session, ...s.sessions] })),
  removeSession: (id) =>
    set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) })),
}));

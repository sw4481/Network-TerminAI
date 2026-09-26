import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { recording, type RecordingDto } from "../lib/recording";

type Store = {
  /** Active recordings keyed by UI tab id (drives the tab's red indicator). */
  active: Record<string, RecordingDto>;
  /** Map backend PTY id → UI key, so we can stop by the id the backend uses. */
  ptyToUiKey: Record<string, string>;
  /** Past recordings list (loaded on demand). */
  list: RecordingDto[];
  // `uiKey` keys the active map + the tab's red indicator (the frontend tab
  // id). `ptyId` is the backend PTY/terminal id the tap attaches to — they
  // differ for split/layout tabs, so both are threaded explicitly.
  start: (uiKey: string, ptyId: string, sessionKind?: string) => Promise<RecordingDto>;
  stop: (uiKey: string) => Promise<RecordingDto>;
  toggle: (uiKey: string, ptyId: string, sessionKind?: string) => Promise<RecordingDto>;
  refreshList: () => Promise<void>;
  remove: (recordingId: string) => Promise<void>;
  initListeners: () => Promise<UnlistenFn[]>;
};

export const useRecordings = create<Store>((set, get) => ({
  active: {},
  ptyToUiKey: {},
  list: [],
  start: async (uiKey, ptyId, sessionKind = "local") => {
    // Backend taps the PTY by ptyId; we key our UI state by uiKey (tab id).
    const dto = await recording.start(ptyId, sessionKind);
    set((s) => ({
      active: { ...s.active, [uiKey]: dto },
      ptyToUiKey: { ...s.ptyToUiKey, [ptyId]: uiKey },
    }));
    return dto;
  },
  stop: async (uiKey) => {
    // Recover the backend PTY id this UI key was started with.
    const dto0 = get().active[uiKey];
    const ptyId = dto0?.tabId ?? uiKey;
    const dto = await recording.stop(ptyId);
    set((s) => {
      const next = { ...s.active };
      delete next[uiKey];
      const nextPty = { ...s.ptyToUiKey };
      delete nextPty[ptyId];
      return { active: next, ptyToUiKey: nextPty };
    });
    await get().refreshList();
    return dto;
  },
  toggle: async (uiKey, ptyId, sessionKind = "local") => {
    const isActive = !!get().active[uiKey];
    return isActive ? get().stop(uiKey) : get().start(uiKey, ptyId, sessionKind);
  },
  refreshList: async () => {
    const list = await recording.list(200);
    set({ list });
  },
  remove: async (recordingId) => {
    await recording.delete(recordingId);
    await get().refreshList();
  },
  initListeners: async () => {
    // Events carry dto.tabId = the backend PTY id. Map it back to the UI key
    // (falling back to the PTY id itself for recordings started elsewhere).
    const u1 = await listen<RecordingDto>("recording://started", (e) => {
      const dto = e.payload;
      set((s) => {
        const uiKey = s.ptyToUiKey[dto.tabId] ?? dto.tabId;
        return { active: { ...s.active, [uiKey]: dto } };
      });
    });
    const u2 = await listen<RecordingDto>("recording://stopped", (e) => {
      const dto = e.payload;
      set((s) => {
        const uiKey = s.ptyToUiKey[dto.tabId] ?? dto.tabId;
        const next = { ...s.active };
        delete next[uiKey];
        const nextPty = { ...s.ptyToUiKey };
        delete nextPty[dto.tabId];
        return { active: next, ptyToUiKey: nextPty };
      });
    });
    return [u1, u2];
  },
}));

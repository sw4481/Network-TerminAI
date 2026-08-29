import { create } from "zustand";
import type { Tab, CommandBlockState } from "../lib/types";
import { useClosedTabs } from "./closedTabsStore";

type Store = {
  tabs: Tab[];
  activeTabId: string | null;
  blocks: Record<string, CommandBlockState[]>;
  setTabs: (t: Tab[]) => void;
  addTab: (t: Tab) => void;
  /**
   * Ensure a permanent Heartbeat tab exists as the SECOND tab (index 1, right
   * after the first terminal tab). Idempotent: does nothing if a heartbeat tab
   * already exists or if there are no tabs yet. Does NOT change the active tab.
   */
  ensureHeartbeatTab: () => void;
  removeTab: (id: string, recordClosed?: boolean) => void;
  setActive: (id: string | null) => void;
  startBlock: (tabId: string, b: CommandBlockState) => void;
  endBlock: (tabId: string, exit: number | null) => void;
  setAiSuggestion: (
    tabId: string,
    blockId: string,
    suggestion: {
      explanation: string;
      suggested_command: string;
      loading?: boolean;
      error?: string;
    }
  ) => void;
  /** Set vendor/platform for a tab (drives workflow picker scoping). */
  setTabVendor: (
    tabId: string,
    vendor: NonNullable<Tab["vendor"]>,
    platform: string,
  ) => void;
  /** Update a tab's live working directory (driven by the shell's OSC 7). */
  setCwd: (tabId: string, cwd: string) => void;
};

export const useTabs = create<Store>((set) => ({
  tabs: [],
  activeTabId: null,
  blocks: {},
  setTabs: (tabs) => set({ tabs, activeTabId: tabs[0]?.id ?? null }),
  addTab: (t) =>
    set((s) => {
      // Idempotent on id: a double-mount (React strict mode) or a restore that
      // races the default slot must not spawn/register the same tab twice.
      if (s.tabs.some((x) => x.id === t.id)) return { activeTabId: t.id };
      return { tabs: [...s.tabs, t], activeTabId: t.id };
    }),
  ensureHeartbeatTab: () =>
    set((s) => {
      // No tabs yet (first terminal not spawned) or already present → no-op.
      if (s.tabs.length === 0) return {};
      if (s.tabs.some((t) => t.tab_type === "heartbeat")) return {};
      const heartbeat: Tab = {
        id: crypto.randomUUID(),
        title: "Heartbeat",
        shell_cmd: "",
        cwd: "/",
        created_at: Math.floor(Date.now() / 1000),
        tab_type: "heartbeat",
      };
      // Insert as the SECOND tab, after the first tab. Keep active tab unchanged.
      const tabs = [s.tabs[0], heartbeat, ...s.tabs.slice(1)];
      return { tabs };
    }),
  removeTab: (id, recordClosed = true) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);

      const closed = s.tabs.find((t) => t.id === id);
      if (recordClosed && closed && (closed.tab_type === undefined || closed.tab_type === "terminal")) {
        useClosedTabs.getState().push({
          id: closed.id,
          title: closed.title,
          cwd: closed.cwd,
          closedAt: Math.floor(Date.now() / 1000),
        });
      }

      // Only recompute the active tab if we closed the one that was active.
      let activeTabId = s.activeTabId;
      if (s.activeTabId === id) {
        if (tabs.length === 0) {
          activeTabId = null;
        } else if (idx > 0) {
          // Prefer the tab to the LEFT of the one just closed.
          activeTabId = tabs[idx - 1].id;
        } else {
          // Closed the first tab — fall through to the new first.
          activeTabId = tabs[0].id;
        }
      }

      return { tabs, activeTabId };
    }),
  setActive: (id) => set({ activeTabId: id }),
  startBlock: (tabId, b) =>
    set((s) => ({
      blocks: { ...s.blocks, [tabId]: [...(s.blocks[tabId] ?? []), b] },
    })),
  endBlock: (tabId, exit) =>
    set((s) => {
      const arr = [...(s.blocks[tabId] ?? [])];
      const last = arr[arr.length - 1];
      if (last && last.ended_at === undefined) {
        arr[arr.length - 1] = {
          ...last,
          ended_at: Math.floor(Date.now() / 1000),
          exit_code: exit,
        };
      }
      return { blocks: { ...s.blocks, [tabId]: arr } };
    }),
  setAiSuggestion: (tabId, blockId, suggestion) =>
    set((s) => {
      const arr = [...(s.blocks[tabId] ?? [])];
      const idx = arr.findIndex((b) => b.id === blockId);
      if (idx !== -1) {
        arr[idx] = { ...arr[idx], aiSuggestion: suggestion };
      }
      return { blocks: { ...s.blocks, [tabId]: arr } };
    }),
  setTabVendor: (tabId, vendor, platform) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, vendor, platform } : t,
      ),
    })),
  setCwd: (tabId, cwd) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, cwd } : t)),
    })),
}));

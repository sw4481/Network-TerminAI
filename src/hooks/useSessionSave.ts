import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabs } from "../state/tabsStore";
import { saveCurrentSession } from "../lib/tauri";

type Saver = ((activeTabId: string | null, tabIds: string[]) => void) & {
  flush: () => void;
};

/** Debounce saves; `flush()` fires the pending save now (used on window close). */
export function makeDebouncedSaver(
  save: (activeTabId: string | null, tabIds: string[]) => void,
  delayMs: number,
): Saver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingActive: string | null = null;
  let pendingTabIds: string[] = [];
  let hasPending = false;
  const run = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (hasPending) { hasPending = false; save(pendingActive, pendingTabIds); }
  };
  const saver = ((activeTabId: string | null, tabIds: string[]) => {
    pendingActive = activeTabId;
    pendingTabIds = tabIds;
    hasPending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  }) as Saver;
  saver.flush = run;
  return saver;
}

/**
 * Persist the session snapshot continuously: debounced on tab-store changes
 * and synchronously on window close, so restore survives crashes/force-quit.
 */
export function useSessionSave(): void {
  useEffect(() => {
    const saver = makeDebouncedSaver(
      (activeTabId, tabIds) => {
        saveCurrentSession(activeTabId, tabIds).catch(() => {});
      },
      1000,
    );
    // Save whenever the tab list or active tab changes. Pass the LIVE tab-bar
    // ids explicitly: the backend must not infer "open tabs" from closed_at,
    // which leaks (tabs alive at quit/crash are never closed).
    const unsub = useTabs.subscribe((s) =>
      saver(s.activeTabId, s.tabs.map((t) => t.id)),
    );

    // Synchronous save on close so a clean quit captures the exact state.
    let unlistenClose: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async () => {
        const { activeTabId, tabs } = useTabs.getState();
        try {
          await saveCurrentSession(activeTabId, tabs.map((t) => t.id));
        } catch { /* best effort */ }
      })
      .then((fn) => { unlistenClose = fn; })
      .catch(() => {});

    return () => {
      unsub();
      saver.flush();
      unlistenClose?.();
    };
  }, []);
}

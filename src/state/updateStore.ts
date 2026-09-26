import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Shared auto-update state. The floating toast (UpdateNotification), the
 * status-bar pill (UpdateStatusPill) and Settings → Updates all read from and
 * drive this single store so the "update available" state stays consistent
 * across every surface.
 *
 * The heavy lifting (network check, download, install) runs in Rust via the
 * tauri-plugin-updater; this store just wraps it with UI-friendly state.
 */

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

interface UpdateState {
  /** Populated when a newer version is available, else null. */
  available: AvailableUpdate | null;
  /** In-flight network check. */
  checking: boolean;
  /** Download + install in progress. */
  downloading: boolean;
  /** Set true once the user dismisses the toast this session. */
  dismissed: boolean;
  /** Last error message from a check/install, if any. */
  error: string | null;
  /** Timestamp (ms) of the last completed check, for the Settings tab. */
  lastCheckedAt: number | null;

  /** Held between check() and downloadAndInstall() so we reuse the handle. */
  _handle: Update | null;

  /**
   * Check for an update. `manual` surfaces "you're up to date" state and
   * errors in the UI; automatic (mount) checks stay quiet on failure.
   */
  checkForUpdate: (manual?: boolean) => Promise<void>;
  /** Download, install, and relaunch. No-op if nothing is available. */
  downloadAndInstall: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  available: null,
  checking: false,
  downloading: false,
  dismissed: false,
  error: null,
  lastCheckedAt: null,
  _handle: null,

  checkForUpdate: async (manual = false) => {
    if (get().checking || get().downloading) return;
    set({ checking: true, error: null });
    try {
      const update = await check();
      if (update) {
        set({
          available: {
            version: update.version,
            currentVersion: update.currentVersion,
            date: update.date,
            body: update.body,
          },
          _handle: update,
          dismissed: false,
        });
      } else {
        set({ available: null, _handle: null });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only surface check failures for a user-initiated "Check now".
      set({ error: manual ? message : null });
      if (!manual) console.error("Update check failed:", message);
    } finally {
      set({ checking: false, lastCheckedAt: Date.now() });
    }
  },

  downloadAndInstall: async () => {
    const { downloading } = get();
    if (downloading) return;
    set({ downloading: true, error: null });
    try {
      // Re-fetch the handle if we don't have one (e.g. store was reset).
      let handle = get()._handle;
      if (!handle) {
        handle = await check();
        if (!handle) {
          set({ error: "Update no longer available", available: null });
          return;
        }
      }
      await handle.downloadAndInstall();
      await relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      console.error("Update install failed:", message);
    } finally {
      set({ downloading: false });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));

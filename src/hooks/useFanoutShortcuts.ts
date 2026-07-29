import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFanoutRunsStore } from "../state/fanoutRunsStore";

interface Options {
  onOpenFanout?: () => void;
  onExport?: () => void;
}

/**
 * Global hotkeys for the fan-out feature:
 * - ⌘⇧F: open fan-out panel (delegated to caller)
 * - ⌘.:  cancel all remaining devices in the active run
 * - ⌘R:  retry every failed/timed-out device in the active run
 * - ⌘E:  export active run as zip (delegated to caller)
 */
export function useFanoutShortcuts(opts: Options) {
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      // ⌘⇧F — open
      if (e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        opts.onOpenFanout?.();
        return;
      }

      const state = useFanoutRunsStore.getState();
      const runId = state.selectedRunId;
      if (!runId) return;
      const run = state.activeRunsById[runId];
      if (!run) return;

      if (e.key === ".") {
        e.preventDefault();
        if (run.status === "running") {
          await invoke("fanout_run_cancel", { runId }).catch(() => {});
        }
        return;
      }
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        for (const d of Object.values(run.devices)) {
          if (d.status === "failed" || d.status === "timeout") {
            await invoke("fanout_device_retry", {
              runId,
              deviceId: d.deviceId,
              deviceKind: d.deviceKind,
            }).catch(() => {});
          }
        }
        return;
      }
      if (e.key === "e" || e.key === "E") {
        if (e.shiftKey) return; // ⌘⇧E reserved
        e.preventDefault();
        opts.onExport?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [opts]);
}

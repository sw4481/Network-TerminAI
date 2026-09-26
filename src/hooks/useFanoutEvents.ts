import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useFanoutRunsStore } from "../state/fanoutRunsStore";

const CHANNEL = "fanout://event";

/** Subscribe to fan-out events and pump them into the runs store. */
export function useFanoutEvents() {
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        const u = await listen<any>(CHANNEL, (msg) => {
          useFanoutRunsStore.getState().applyEvent(msg.payload);
        });
        if (cancelled) {
          u();
        } else {
          unsub = u;
        }
      } catch (e) {
        // Tauri not available (e.g. test) — that's fine.
        // eslint-disable-next-line no-console
        console.warn("useFanoutEvents: listen failed", e);
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, []);
}

import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { Terminal } from "./Terminal";
import { listTabs, ptyKill, tabScrollback, terminalDetachedWindowClose } from "../lib/tauri";
import type { Tab } from "../lib/types";

export function DetachedTerminalWindow() {
  const tabId = new URLSearchParams(window.location.search).get("tab_id");
  const [tab, setTab] = useState<Tab | null>(null);
  const [replayBytes, setReplayBytes] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const closingRef = useRef(false);
  const returningRef = useRef(false);

  useEffect(() => {
    if (!tabId) {
      setError("Detached terminal id is missing.");
      return;
    }
    void Promise.all([listTabs(), tabScrollback(tabId)])
      .then(([tabs, bytes]) => {
        const current = tabs.find((candidate) => candidate.id === tabId);
        if (!current) throw new Error("Detached terminal no longer exists.");
        setTab(current);
        setReplayBytes(bytes);
      })
      .catch((loadError) => setError(String(loadError)));
  }, [tabId]);

  const close = useCallback(async () => {
    if (closingRef.current || returningRef.current || !tabId) return;
    closingRef.current = true;
    try {
      await ptyKill(tabId);
      await terminalDetachedWindowClose(getCurrentWindow().label);
    } catch (closeError) {
      closingRef.current = false;
      setError(String(closeError));
    }
  }, [tabId]);

  const popIn = useCallback(async () => {
    if (closingRef.current || returningRef.current || !tabId) return;
    returningRef.current = true;
    try {
      await emit("terminal-pop-in", { tabId });
      await terminalDetachedWindowClose(getCurrentWindow().label);
    } catch (popInError) {
      returningRef.current = false;
      setError(String(popInError));
    }
  }, [tabId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (disposed || closingRef.current || returningRef.current) return;
        event.preventDefault();
        void close();
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((closeError) => setError(String(closeError)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [close]);

  if (error || !tab) {
    return (
      <main style={{ padding: 20, color: "var(--text-primary)" }}>
        {error ?? "Loading terminal…"}
      </main>
    );
  }

  return (
    <main style={{ width: "100vw", height: "100vh", display: "flex" }}>
      <Terminal
        terminalId={tab.id}
        shell={tab.shell_cmd}
        cwd={tab.cwd}
        attach
        replayBytes={replayBytes}
        skipTabRegistration
      />
      <button
        type="button"
        onClick={() => void popIn()}
        title="Pop terminal back into the main window"
        style={{ position: "fixed", top: 8, right: 36, zIndex: 2 }}
      >
        ↙
      </button>
      <button
        type="button"
        onClick={() => void close()}
        title="Close terminal"
        style={{ position: "fixed", top: 8, right: 8, zIndex: 2 }}
      >
        ×
      </button>
    </main>
  );
}

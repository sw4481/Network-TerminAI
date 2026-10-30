import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { message, save } from "@tauri-apps/plugin-dialog";
import { editorFileExists } from "../lib/tauri";
import { resolveWorkflowTerminalTarget } from "../lib/workflowDispatcher";
import { useTerminalLoggingStore } from "../state/terminalLoggingStore";

export function TerminalLoggingControls({ tabId, terminalId }: { tabId: string; terminalId: string }) {
  const logs = useTerminalLoggingStore((state) => state.logs);
  const pending = useTerminalLoggingStore((state) => state.pending);
  const listenerError = useTerminalLoggingStore((state) => state.listenerError);
  const [error, setError] = useState<string | null>(null);
  const paneLogs = Object.values(logs).filter((log) => log.uiTabId === tabId);
  const focusedLogging = paneLogs.some((log) => log.terminalId === terminalId && log.active);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void useTerminalLoggingStore.getState().refresh(tabId, resolveWorkflowTerminalTarget(tabId))
      .catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [tabId, terminalId]);

  const start = async () => {
    if (useTerminalLoggingStore.getState().pending) return;
    // Keep the original pane, including while the native dialog is open.
    const target = resolveWorkflowTerminalTarget(tabId);
    useTerminalLoggingStore.setState({ pending: true });
    setError(null);
    try {
      const path = await save({
        title: "Log terminal output",
        defaultPath: "terminal-session.txt",
        filters: [{ name: "Text log", extensions: ["txt", "log"] }],
      });
      if (!path) return;
      let mode: "create" | "append" | "overwrite" = "create";
      if (await editorFileExists(path)) {
        const choice = await message(`The file already exists:\n${path}\n\nAppend to it or overwrite its contents?`, {
          title: "Terminal logfile exists",
          kind: "warning",
          buttons: { yes: "Append", no: "Overwrite", cancel: "Cancel" },
        });
        if (choice !== "Append" && choice !== "Overwrite") return;
        mode = choice === "Append" ? "append" : "overwrite";
      }
      await useTerminalLoggingStore.getState().start(tabId, target, path, mode);
    } catch (cause) {
      setError(`Unable to start terminal logging: ${String(cause)}`);
    } finally {
      useTerminalLoggingStore.setState({ pending: false });
    }
  };

  const stop = async (ptyId: string) => {
    if (useTerminalLoggingStore.getState().pending) return;
    useTerminalLoggingStore.setState({ pending: true });
    setError(null);
    try {
      await useTerminalLoggingStore.getState().stop(ptyId);
    } catch (cause) {
      setError(`Unable to finish terminal logging: ${String(cause)}`);
    } finally {
      useTerminalLoggingStore.setState({ pending: false });
    }
  };

  const failure = error ?? listenerError ?? paneLogs.find((log) => log.error)?.error;
  return (
    <div className="terminal-logging-controls">
      <button
        type="button"
        className="global-command-bar__add"
        aria-label="Log terminal"
        disabled={pending || focusedLogging || !!listenerError}
        title={focusedLogging ? "This pane is being logged" : "Log new output from the focused pane. Displayed output may contain sensitive information."}
        onClick={() => void start()}
      >
        Log terminal
      </button>
      {paneLogs.filter((log) => log.active).map((log) => {
        const filename = log.path.split(/[\\/]/).pop() || log.path;
        return (
          <button
            key={log.id}
            type="button"
            className="global-command-bar__add"
            aria-label={`Stop logging ${filename}`}
            title={`Logging the original pane to ${log.path}. Click to stop and flush.`}
            disabled={pending}
            onClick={() => void stop(log.tabId)}
          >
            ■ Stop log: {filename}
          </button>
        );
      })}
      {failure && <span className="global-command-bar__error" role="alert">{failure}</span>}
    </div>
  );
}

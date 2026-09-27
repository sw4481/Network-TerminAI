import { useState, useEffect, useCallback } from "react";
import { runAndParseOverSsh } from "../lib/structured";
import {
  listSshConnections,
  matchConnectionForTab,
  resolveSshPassword,
  type SshConnection,
} from "../lib/resolveTabConnection";
import { useSshPasswordStore } from "../state/sshPasswordStore";
import { useTabs } from "../state/tabsStore";
import { PARSER_DEVICE_PROFILES } from "../lib/deviceProfiles";
import { PasswordPromptModal } from "./PasswordPromptModal";
import { StructuredTab } from "./StructuredTab";
import { StructuredDiff } from "./StructuredDiff";
import { SnapshotPinDialog } from "./SnapshotPinDialog";
import { toCsv, toJson, toMarkdownTable, downloadFile, copyToClipboard } from "../lib/export";
import "./RunStructuredModal.css";

const DEVICE_TYPES = PARSER_DEVICE_PROFILES;

type Stage = "input" | "running" | "result" | "error";

interface RunStructuredModalProps {
  tabId: string;
  initialCommand: string;
  onClose: () => void;
}

export function RunStructuredModal({ tabId, initialCommand, onClose }: RunStructuredModalProps) {
  const [command, setCommand] = useState(initialCommand);
  const [stage, setStage] = useState<Stage>("input");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [blockId, setBlockId] = useState<string | null>(null);

  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [resultView, setResultView] = useState<"table" | "diff">("table");
  const [pinDialogOpen, setPinDialogOpen] = useState(false);

  const getPasswordContext = useSshPasswordStore((s) => s.getPasswordContext);
  const tabs = useTabs((s) => s.tabs);
  const setTabVendor = useTabs((s) => s.setTabVendor);

  const tab = tabs.find((t) => t.id === tabId);
  const resolvedDeviceIdx = DEVICE_TYPES.findIndex(
    (d) => d.vendor === tab?.vendor && d.platform === tab?.platform,
  );
  const [deviceIdx, setDeviceIdx] = useState(resolvedDeviceIdx >= 0 ? resolvedDeviceIdx : 0);
  const device = DEVICE_TYPES[deviceIdx] ?? DEVICE_TYPES[0];

  // Load saved connections and try to auto-resolve one from the tab's live
  // SSH session, same pattern as ChangeWindowPanel.
  useEffect(() => {
    (async () => {
      try {
        const conns = await listSshConnections();
        setConnections(conns);
        const ctx = getPasswordContext(tabId);
        const match = matchConnectionForTab(conns, ctx ? { host: ctx.host, user: ctx.user } : null);
        if (match) setConnectionId(match.id);
      } catch (e) {
        console.error("Failed to load SSH connections:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const runWithPassword = useCallback(
    async (password: string | undefined) => {
      if (!connectionId) return;
      setStage("running");
      setErrorMsg(null);
      try {
        const newBlockId = await runAndParseOverSsh(
          tabId,
          connectionId,
          command,
          device.vendor,
          device.platform,
          password,
        );
        setBlockId(newBlockId);
        setStage("result");
      } catch (e) {
        setErrorMsg(String(e));
        setStage("error");
      }
    },
    [tabId, connectionId, command, device],
  );

  const handleRun = useCallback(async () => {
    if (!connectionId || !command.trim()) return;
    if (resolvedDeviceIdx < 0) {
      setTabVendor(tabId, device.vendor, device.platform);
    }
    const pwd = await resolveSshPassword(tabId, connectionId, connections, getPasswordContext);
    if (pwd === undefined) {
      setPasswordPromptOpen(true);
      return;
    }
    await runWithPassword(pwd);
  }, [connectionId, command, resolvedDeviceIdx, device, tabId, setTabVendor, connections, getPasswordContext, runWithPassword]);

  const handlePasswordSubmit = useCallback(
    (password: string) => {
      setPasswordPromptOpen(false);
      void runWithPassword(password);
    },
    [runWithPassword],
  );

  // Export/copy/pin handlers, mirroring CommandBlock's StructuredTab wiring so
  // the in-modal toolbar buttons behave identically. Filenames derive from the
  // command (the block has no persisted title here).
  const safeName = command.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
  const handleExportCsv = useCallback(
    async (rows: Record<string, unknown>[], columns: string[]) => {
      try {
        await downloadFile(`${safeName || "structured"}.csv`, toCsv(rows, columns), "text/csv;charset=utf-8");
      } catch (err) {
        console.error("CSV export failed:", err);
      }
    },
    [safeName],
  );
  const handleExportJson = useCallback(
    async (rows: Record<string, unknown>[]) => {
      try {
        await downloadFile(`${safeName || "structured"}.json`, toJson(rows), "application/json");
      } catch (err) {
        console.error("JSON export failed:", err);
      }
    },
    [safeName],
  );
  const handleCopyMarkdown = useCallback(
    async (rows: Record<string, unknown>[], columns: string[]) => {
      try {
        await copyToClipboard(toMarkdownTable(rows, columns));
      } catch (err) {
        console.error("clipboard write failed:", err);
      }
    },
    [],
  );

  return (
    <div className="run-structured-overlay" onClick={onClose}>
      <div className="run-structured-modal" onClick={(e) => e.stopPropagation()}>
        <div className="run-structured-header">
          <h3>Run as Structured...</h3>
          <button className="run-structured-close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {(stage === "input" || stage === "error") && (
          <>
            {errorMsg && (
              <div className="run-structured-error" role="alert">
                {errorMsg}
              </div>
            )}
            <div className="run-structured-field">
              <label htmlFor="rsm-command">Command</label>
              <input
                id="rsm-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="show ip interface brief"
                autoFocus
              />
            </div>
            <div className="run-structured-field">
              <label htmlFor="rsm-connection">SSH connection</label>
              <select
                id="rsm-connection"
                value={connectionId ?? ""}
                onChange={(e) => setConnectionId(e.target.value || null)}
              >
                <option value="" disabled>
                  Select a saved connection…
                </option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.user ? `${c.user}@` : ""}{c.host})
                  </option>
                ))}
              </select>
            </div>
            <div className="run-structured-field">
              <label htmlFor="rsm-device">Device type</label>
              <select
                id="rsm-device"
                value={deviceIdx}
                onChange={(e) => setDeviceIdx(Number(e.target.value))}
              >
                {DEVICE_TYPES.map((d, i) => (
                  <option key={`${d.vendor}-${d.platform}`} value={i}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="run-structured-actions">
              <button onClick={onClose}>Cancel</button>
              <button onClick={handleRun} disabled={!connectionId || !command.trim()}>
                {stage === "error" ? "Retry" : "Run"}
              </button>
            </div>
          </>
        )}

        {stage === "running" && <p>Running &ldquo;{command}&rdquo;…</p>}

        {stage === "result" && blockId && (
          <>
            <div className="run-structured-actions" style={{ marginTop: 0, marginBottom: 12, justifyContent: "flex-start" }}>
              <button
                onClick={() => setResultView("table")}
                disabled={resultView === "table"}
              >
                Table
              </button>
              <button
                onClick={() => setResultView("diff")}
                disabled={resultView === "diff"}
              >
                Diff
              </button>
            </div>
            {resultView === "table" ? (
              <StructuredTab
                blockId={blockId}
                onExportCsv={handleExportCsv}
                onExportJson={handleExportJson}
                onCopyMarkdown={handleCopyMarkdown}
                onPinSnapshot={() => setPinDialogOpen(true)}
              />
            ) : (
              <StructuredDiff blockId={blockId} tabId={tabId} command={command} />
            )}
            {pinDialogOpen && (
              <SnapshotPinDialog
                blockId={blockId}
                defaultName={command.trim()}
                onClose={() => setPinDialogOpen(false)}
              />
            )}
          </>
        )}

        <PasswordPromptModal
          isOpen={passwordPromptOpen}
          connectionName={connections.find((c) => c.id === connectionId)?.name ?? "SSH connection"}
          onSubmit={handlePasswordSubmit}
          onCancel={() => setPasswordPromptOpen(false)}
        />
      </div>
    </div>
  );
}

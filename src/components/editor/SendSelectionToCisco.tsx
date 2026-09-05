import { useMemo, useState } from "react";
import type * as Monaco from "monaco-editor";
import { classifyCommand, recordDecision } from "../../lib/guardrails";
import { ptyWrite } from "../../lib/tauri";
import { useGuardrailsStore } from "../../state/guardrailsStore";
import { useTerminalConnectionStore } from "../../state/terminalConnectionStore";
import {
  listConnectedCiscoTargets,
  sendSelectionToCisco,
} from "./ciscoSelectionBridge";
import "./SendSelectionToCisco.css";

type SendSelectionToCiscoProps = {
  editor: Monaco.editor.IStandaloneCodeEditor | null;
  sessionId: string;
  onClose: () => void;
};

export function SendSelectionToCisco({
  editor,
  sessionId,
  onClose,
}: SendSelectionToCiscoProps) {
  const byTerminalId = useTerminalConnectionStore((state) => state.byTerminalId);
  const targets = useMemo(
    () => listConnectedCiscoTargets({ byTerminalId }),
    [byTerminalId],
  );
  const [selectedTerminalId, setSelectedTerminalId] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const target =
    targets.find((entry) => entry.terminalId === selectedTerminalId) ??
    targets[0] ??
    null;

  const selection = editor?.getSelection();
  const model = editor?.getModel();
  const text = selection && model ? model.getValueInRange(selection) : "";

  const send = async () => {
    const currentSelection = editor?.getSelection();
    const currentModel = editor?.getModel();
    const currentText =
      currentSelection && currentModel
        ? currentModel.getValueInRange(currentSelection)
        : "";
    if (!target || !currentText) return;

    setSending(true);
    setStatus(null);
    try {
      const result = await sendSelectionToCisco({
        selection: currentText,
        target,
        sessionId,
        classify: classifyCommand,
        record: recordDecision,
        write: ptyWrite,
        approve: useGuardrailsStore.getState().enqueueAndAwait,
        getCurrentTarget: (terminalId) =>
          useTerminalConnectionStore.getState().get(terminalId),
      });
      setStatus(
        result === "sent"
          ? { kind: "success", message: `Sent selection to ${target.displayName}.` }
          : {
              kind: "error",
              message:
                "Send canceled. Verify the Cisco target is still connected and try again.",
            },
      );
    } catch (error) {
      setStatus({ kind: "error", message: `Send failed: ${String(error)}` });
    } finally {
      setSending(false);
      onClose();
    }
  };

  return (
    <section
      className="send-selection-to-cisco"
      role="dialog"
      aria-label="Send selection to Cisco"
    >
      <div className="send-selection-to-cisco-header">
        <span>Send Selection to Cisco</span>
        <button type="button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <label>
        Cisco target
        <select
          aria-label="Cisco target"
          value={target?.terminalId ?? ""}
          disabled={targets.length === 0 || sending}
          onChange={(event) => setSelectedTerminalId(event.target.value)}
        >
          {targets.map((entry) => (
            <option key={entry.terminalId} value={entry.terminalId}>
              {entry.displayName} · {entry.platform}
            </option>
          ))}
        </select>
      </label>

      <p className="send-selection-to-cisco-note">
        Selection is sent verbatim. Include a trailing newline in the selection
        to execute the final command.
      </p>
      {targets.length === 0 && (
        <p className="send-selection-to-cisco-status">
          Connect a Cisco terminal before sending.
        </p>
      )}
      {!text && targets.length > 0 && (
        <p className="send-selection-to-cisco-status">
          Select editor text before sending.
        </p>
      )}
      {status && (
        <p
          className={`send-selection-to-cisco-${status.kind}`}
          role={status.kind === "success" ? "status" : "alert"}
        >
          {status.message}
        </p>
      )}

      <div className="send-selection-to-cisco-actions">
        <button type="button" onClick={onClose} disabled={sending}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!editor || !text || !target || sending}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </section>
  );
}

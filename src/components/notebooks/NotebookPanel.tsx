import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sshDecryptPassword, sshListConnections, type SshConnection } from "../../lib/sshConnections";
import {
  type CellStatus,
  type NotebookCell,
  type RunnableNotebookDto,
} from "../../lib/runnableNotebook";
import { useNotebookRuns, type NotebookRunState } from "../../state/notebookRunsStore";
import { NotebookToolbar } from "./NotebookToolbar";
import { MarkdownCell } from "./cells/MarkdownCell";
import { CommandCell } from "./cells/CommandCell";
import { ApprovalCell } from "./cells/ApprovalCell";
import { AssertionCell } from "./cells/AssertionCell";
import { ParameterCell } from "./cells/ParameterCell";
import { PasswordPromptModal } from "../PasswordPromptModal";
import "./NotebookPanel.css";

interface Props {
  notebook: RunnableNotebookDto;
  tabId: string;
}

interface NetconfDevice {
  id: number;
  name: string;
  host: string;
}

type TargetDevice = {
  type: "current-tab";
} | {
  type: "ssh";
  connectionId: string;
  name: string;
  password?: string;
} | {
  type: "netconf";
  deviceId: number;
  name: string;
};

export function NotebookPanel({ notebook, tabId }: Props) {
  const { runs, start, approve, cancel, resume } = useNotebookRuns();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of notebook.frontmatter.parameters ?? []) {
      if (p.default) init[p.name] = p.default;
    }
    return init;
  });
  const [targetDevice, setTargetDevice] = useState<TargetDevice>({ type: "current-tab" });
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [netconfDevices, setNetconfDevices] = useState<NetconfDevice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);

  // Password prompt state
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);

  const run = activeRunId ? runs[activeRunId] : null;
  const cells = notebook.cells;

  useEffect(() => {
    (async () => {
      try {
        const [ssh, nc] = await Promise.all([
          sshListConnections(),
          invoke<NetconfDevice[]>("netconf_device_list"),
        ]);
        setSshConnections(ssh);
        setNetconfDevices(nc);
      } catch (e) {
        console.error("Failed to load devices:", e);
      } finally {
        setLoadingDevices(false);
      }
    })();
  }, []);

  const summary = useMemo(() => {
    if (!run) return { passed: 0, failed: 0, total: cells.length };
    let passed = 0;
    let failed = 0;
    for (const status of Object.values(run.cellStatuses)) {
      if (status === "passed") passed++;
      else if (status === "failed") failed++;
    }
    return { passed, failed, total: cells.length };
  }, [run, cells.length]);

  const canResumeFromFailure = run?.status === "failed" || run?.status === "paused";

  const onRun = async () => {
    // Current-tab (or any non-SSH) runs need no password handling.
    if (targetDevice.type !== "ssh") {
      await executeRun(undefined);
      return;
    }

    // SSH: try the saved+encrypted password first.
    const conn = sshConnections.find((c) => c.id === targetDevice.connectionId);
    if (conn?.password_encrypted) {
      let password: string | undefined;
      try {
        const pwd = await sshDecryptPassword(conn.password_encrypted);
        if (pwd) password = pwd;
      } catch (e) {
        console.warn("Could not decrypt saved password:", e);
      }
      if (password) {
        await executeRun(password);
        return;
      }
    }

    // No usable saved password → prompt. The modal's submit handler
    // calls executeRun directly with the entered password, so we do
    // NOT round-trip through state here (that caused a double prompt).
    setPasswordPromptOpen(true);
  };

  const executeRun = async (password?: string) => {
    try {
      const connectionId =
        targetDevice.type === "ssh" ? targetDevice.connectionId : undefined;
      const id = await start(notebook.id, tabId, paramValues as Record<string, unknown>, connectionId, password);
      setActiveRunId(id);
    } catch (e) {
      console.error("Failed to start notebook run:", e);
    }
  };

  const handlePasswordSubmit = (password: string) => {
    setPasswordPromptOpen(false);
    void executeRun(password);
  };

  const handlePasswordCancel = () => {
    setPasswordPromptOpen(false);
  };
  const onStop = async () => {
    if (activeRunId) await cancel(activeRunId);
  };
  const onResume = async () => {
    let connectionId: string | undefined;
    let password: string | undefined;

    if (targetDevice.type === "ssh") {
      connectionId = targetDevice.connectionId;
      const conn = sshConnections.find((c) => c.id === connectionId);
      if (conn?.password_encrypted) {
        try {
          const pwd = await sshDecryptPassword(conn.password_encrypted);
          if (pwd) password = pwd;
        } catch (e) {
          console.warn("Could not decrypt password:", e);
        }
      }
    }

    if (activeRunId) await resume(activeRunId, tabId, connectionId, password);
  };

  return (
    <div className="notebook-panel" data-testid="notebook-panel">
      <header className="notebook-panel-header">
        <div>
          <h2 className="notebook-title">{notebook.frontmatter.title}</h2>
          {notebook.frontmatter.description && (
            <p className="notebook-description">{notebook.frontmatter.description}</p>
          )}
        </div>
        <NotebookToolbar
          status={run?.status ?? "idle"}
          canResumeFromFailure={!!canResumeFromFailure}
          onRun={onRun}
          onStop={onStop}
          onResume={onResume}
        />
      </header>

      {!run && (
        <>
          <section className="notebook-device-selector">
            <h3>Target Device</h3>
            <div className="device-selector-options">
              <label className="device-selector-option">
                <input
                  type="radio"
                  name="target-device"
                  value="current-tab"
                  checked={targetDevice.type === "current-tab"}
                  onChange={() => setTargetDevice({ type: "current-tab" })}
                  data-testid="target-current-tab"
                />
                <span>Current tab</span>
              </label>

              {!loadingDevices && sshConnections.length > 0 && (
                <label className="device-selector-option">
                  <input
                    type="radio"
                    name="target-device"
                    value="ssh"
                    checked={targetDevice.type === "ssh"}
                    onChange={() => {
                      if (sshConnections.length > 0) {
                        setTargetDevice({
                          type: "ssh",
                          connectionId: sshConnections[0].id,
                          name: sshConnections[0].name,
                        });
                      }
                    }}
                    data-testid="target-ssh"
                  />
                  <span>SSH Connection:</span>
                  {targetDevice.type === "ssh" && (
                    <select
                      value={targetDevice.connectionId}
                      onChange={(e) => {
                        const conn = sshConnections.find((c) => c.id === e.target.value);
                        if (conn) {
                          setTargetDevice({
                            type: "ssh",
                            connectionId: conn.id,
                            name: conn.name,
                          });
                        }
                      }}
                      className="device-selector-dropdown"
                      data-testid="ssh-connection-select"
                    >
                      {sshConnections.map((conn) => (
                        <option key={conn.id} value={conn.id}>
                          {conn.name} ({conn.user ? `${conn.user}@` : ""}{conn.host})
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              )}

              {!loadingDevices && sshConnections.length === 0 && netconfDevices.length === 0 && (
                <p className="device-selector-empty">
                  No saved devices. Save SSH/NETCONF connections to target them directly.
                </p>
              )}
            </div>
          </section>

          {(notebook.frontmatter.parameters ?? []).length > 0 && (
            <section className="notebook-params-form">
              <h3>Parameters</h3>
              {(notebook.frontmatter.parameters ?? []).map((p) => (
                <label key={p.name} className="param-input">
                  <span>{p.prompt || p.name}</span>
                  <input
                    type="text"
                    value={paramValues[p.name] ?? ""}
                    onChange={(e) =>
                      setParamValues((v) => ({ ...v, [p.name]: e.target.value }))
                    }
                    placeholder={p.default ?? ""}
                    data-testid={`param-input-${p.name}`}
                  />
                </label>
              ))}
            </section>
          )}
        </>
      )}

      <ol className="notebook-cell-list">
        {cells.map((cell, idx) => {
          const status: CellStatus | "idle" = run?.cellStatuses[idx] ?? "idle";
          const error = run?.cellErrors[idx];
          return (
            <li key={idx} className="notebook-cell-item" data-cell-idx={idx}>
              {renderCell(cell, status, error, idx, run, approve, cancel, paramValues)}
            </li>
          );
        })}
      </ol>

      <footer className="notebook-footer">
        <span data-testid="run-summary">
          {summary.passed}/{summary.total} passed
          {summary.failed > 0 && ` · ${summary.failed} failed`}
          {run?.status && ` · ${run.status}`}
          {run?.awaitingApprovalIdx != null && ` · paused at step ${run.awaitingApprovalIdx + 1}`}
        </span>
      </footer>

      <PasswordPromptModal
        isOpen={passwordPromptOpen}
        connectionName={
          targetDevice.type === "ssh"
            ? sshConnections.find((c) => c.id === targetDevice.connectionId)?.name || "Unknown"
            : ""
        }
        onSubmit={handlePasswordSubmit}
        onCancel={handlePasswordCancel}
      />
    </div>
  );
}

function renderCell(
  cell: NotebookCell,
  status: CellStatus | "idle",
  error: string | undefined,
  idx: number,
  run: NotebookRunState | null,
  approve: (id: string) => Promise<void>,
  cancel: (id: string) => Promise<void>,
  paramValues: Record<string, string>,
) {
  switch (cell.type) {
    case "markdown":
      return <MarkdownCell content={cell.content} />;
    case "command":
      return <CommandCell content={cell.content} status={status} error={error} />;
    case "approval":
      return (
        <ApprovalCell
          content={cell.content}
          status={status}
          isAwaiting={run?.awaitingApprovalIdx === idx}
          onApprove={() => run && approve(run.runId)}
          onCancel={() => run && cancel(run.runId)}
        />
      );
    case "assertion":
      return <AssertionCell spec={cell.spec} status={status} error={error} />;
    case "parameter":
      return <ParameterCell params={cell.params} values={paramValues} />;
  }
}

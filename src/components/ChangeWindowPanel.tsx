import { useState, useCallback, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useChangeVerifyStore } from "../state/changeVerifyStore";
import { useTabs } from "../state/tabsStore";
import { useSshPasswordStore } from "../state/sshPasswordStore";
import { PARSER_DEVICE_PROFILES } from "../lib/deviceProfiles";
import { BundlePicker } from "./BundlePicker";
import { BundleEditor } from "./BundleEditor";
import { ChangeTimeline } from "./ChangeTimeline";
import { PreCheckRunner } from "./PreCheckRunner";
import { PostCheckRunner } from "./PostCheckRunner";
import { ChangeReportView } from "./ChangeReportView";
import { PasswordPromptModal } from "./PasswordPromptModal";
import { renderReportMarkdown } from "../lib/changeReportMarkdown";
import { bundleGet } from "../lib/changeVerify";
import type { CheckBundle } from "../lib/changeVerify";
import {
  listSshConnections,
  matchConnectionForTab,
  resolveSshPassword as resolveSshPasswordHelper,
  type SshConnection,
} from "../lib/resolveTabConnection";
import "./ChangeWindowPanel.css";

/** Where pre/post commands execute: the tab's local PTY, or SSH-direct. */
type Target =
  | { type: "current-tab" }
  | { type: "ssh"; connectionId: string };

type PanelStage = "select" | "pre-running" | "pre-done" | "change-open" | "post-running" | "report";

/**
 * Device types the sidecar parser supports (mirrors the sidecar's
 * `textfsm_adapter.VENDOR_MAP`). The pre/post-check parser fails with
 * "no template mapping" for any pair not in this list, so the picker only
 * offers supported combinations. `generic` is intentionally excluded.
 */
const DEVICE_TYPES = PARSER_DEVICE_PROFILES;

const DEFAULT_DEVICE = DEVICE_TYPES[0];

interface ChangeWindowPanelProps {
  tabId: string;
  vendor: string;
  platform: string;
  onClose: () => void;
}

export function ChangeWindowPanel({
  tabId,
  vendor: vendorProp,
  platform: platformProp,
  onClose,
}: ChangeWindowPanelProps) {
  const [stage, setStage] = useState<PanelStage>("select");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingBundle, setEditingBundle] = useState<CheckBundle | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Execution target: local PTY (current tab) vs SSH-direct to a saved conn.
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [target, setTarget] = useState<Target>({ type: "current-tab" });
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  // Which check the password modal is gating ("pre" | notes-string for post).
  const [pendingPost, setPendingPost] = useState<string | null>(null);

  const setTabVendor = useTabs((s) => s.setTabVendor);
  const getPasswordContext = useSshPasswordStore((s) => s.getPasswordContext);

  // Resolve the effective device type. The tab's vendor/platform is unset for
  // plain shell tabs (defaults to "generic", which the parser can't handle),
  // so fall back to the first supported device type. The user can override via
  // the header dropdown, and the choice is persisted back onto the tab.
  const resolvedIndex = DEVICE_TYPES.findIndex(
    (d) => d.vendor === vendorProp && d.platform === platformProp,
  );
  const [deviceIdx, setDeviceIdx] = useState(
    resolvedIndex >= 0 ? resolvedIndex : 0,
  );
  const device = DEVICE_TYPES[deviceIdx] ?? DEFAULT_DEVICE;
  const vendor = device.vendor;
  const platform = device.platform;

  const handleDeviceChange = useCallback(
    (idx: number) => {
      setDeviceIdx(idx);
      const d = DEVICE_TYPES[idx] ?? DEFAULT_DEVICE;
      // Persist so bundle filtering + future runs use the same device type.
      setTabVendor(tabId, d.vendor, d.platform);
    },
    [tabId, setTabVendor],
  );

  // On first mount, if the tab had no valid device type, persist the default
  // so the rest of the app (workflow picker, etc.) agrees with this panel.
  useEffect(() => {
    if (resolvedIndex < 0) {
      setTabVendor(tabId, DEFAULT_DEVICE.vendor, DEFAULT_DEVICE.platform);
    }
    // Only run on mount for this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Load saved SSH connections and try to prepopulate the target from the
  // active tab's SSH session. When you connect via a saved connection, the
  // app records {host, user} for the tab in sshPasswordStore (best-effort:
  // it auto-clears after 5 min and is empty for key-only auth), so we match
  // that against the saved-connection list to auto-select the right one.
  useEffect(() => {
    (async () => {
      try {
        const conns = await listSshConnections();
        setSshConnections(conns);

        const ctx = getPasswordContext(tabId);
        const match = matchConnectionForTab(conns, ctx ? { host: ctx.host, user: ctx.user } : null);
        if (match) {
          setTarget({ type: "ssh", connectionId: match.id });
        }
      } catch (e) {
        console.error("Failed to load SSH connections:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const {
    selectedBundleId,
    selectBundle,
    createBundle,
    updateBundleCommands,
    renameBundle,
    deleteBundle,
    runPreCheck,
    runPostCheck,
    runPreCheckSsh,
    runPostCheckSsh,
    preSnapshot,
    currentReport,
    clearSnapshots,
  } = useChangeVerifyStore();

  // Initialize stage based on store state
  useEffect(() => {
    if (currentReport) {
      setStage("report");
    } else if (preSnapshot) {
      setStage("pre-done");
    } else {
      setStage("select");
    }
  }, [currentReport, preSnapshot]);

  const handleSelectBundle = useCallback(
    (bundleId: string) => {
      selectBundle(bundleId);
    },
    [selectBundle],
  );

  const handleCreateNew = useCallback(() => {
    setEditingBundle(undefined);
    setEditorOpen(true);
  }, []);

  const handleEdit = useCallback((bundleId: string) => {
    const store = useChangeVerifyStore.getState();
    const bundle = store.bundles.find((b) => b.id === bundleId);
    if (bundle) {
      setEditingBundle(bundle);
      setEditorOpen(true);
    }
  }, []);

  const handleDelete = useCallback(
    async (bundleId: string) => {
      await deleteBundle(bundleId);
      if (selectedBundleId === bundleId) {
        selectBundle(null);
      }
    },
    [deleteBundle, selectedBundleId, selectBundle],
  );

  const handleSaveBundle = useCallback(
    async (name: string, description: string | null, commands: string[]) => {
      if (editingBundle) {
        await renameBundle(editingBundle.id, name, description);
        await updateBundleCommands(editingBundle.id, commands);
      } else {
        const bundle = await createBundle({
          name,
          description,
          vendor,
          platform,
          commands,
        });
        selectBundle(bundle.id);
      }
      setEditorOpen(false);
      setEditingBundle(undefined);
    },
    [
      editingBundle,
      vendor,
      platform,
      createBundle,
      updateBundleCommands,
      renameBundle,
      selectBundle,
    ],
  );

  // Resolve a password for an SSH target without prompting: prefer the tab's
  // live session password, then a saved+encrypted one. Returns undefined when
  // neither is available (caller must prompt).
  const resolveSshPassword = useCallback(
    (connectionId: string): Promise<string | undefined> =>
      resolveSshPasswordHelper(tabId, connectionId, sshConnections, getPasswordContext),
    [tabId, sshConnections, getPasswordContext],
  );

  const execPreCheck = useCallback(
    async (password?: string) => {
      if (!selectedBundleId) return;
      setErrorMsg(null);
      setStage("pre-running");
      try {
        if (target.type === "ssh") {
          await runPreCheckSsh(
            tabId, target.connectionId, selectedBundleId, vendor, platform, password,
          );
        } else {
          await runPreCheck(tabId, selectedBundleId, vendor, platform);
        }
        setStage("pre-done");
      } catch (error) {
        console.error("Pre-check failed:", error);
        setErrorMsg(`Pre-check failed: ${String(error)}`);
        setStage("select");
      }
    },
    [selectedBundleId, tabId, vendor, platform, target, runPreCheck, runPreCheckSsh],
  );

  const handleRunPreCheck = useCallback(async () => {
    if (!selectedBundleId) return;
    if (target.type === "ssh") {
      const pwd = await resolveSshPassword(target.connectionId);
      if (pwd === undefined) {
        setPendingPost(null);
        setPasswordPromptOpen(true);
        return;
      }
      await execPreCheck(pwd);
      return;
    }
    await execPreCheck();
  }, [selectedBundleId, target, resolveSshPassword, execPreCheck]);

  const handleStartChange = useCallback(() => {
    setStage("change-open");
  }, []);

  const execPostCheck = useCallback(
    async (notes: string, password?: string) => {
      if (!selectedBundleId || !preSnapshot) return;
      setErrorMsg(null);
      setStage("post-running");
      try {
        if (target.type === "ssh") {
          await runPostCheckSsh(
            tabId, target.connectionId, selectedBundleId, vendor, platform,
            preSnapshot.id, [], notes || null, password,
          );
        } else {
          await runPostCheck(
            tabId, selectedBundleId, vendor, platform, preSnapshot.id, [], notes || null,
          );
        }
        setStage("report");
      } catch (error) {
        console.error("Post-check failed:", error);
        setErrorMsg(`Post-check failed: ${String(error)}`);
        setStage("change-open");
      }
    },
    [selectedBundleId, preSnapshot, tabId, vendor, platform, target, runPostCheck, runPostCheckSsh],
  );

  const handleRunPostCheck = useCallback(
    async (notes: string) => {
      if (!selectedBundleId || !preSnapshot) return;
      if (target.type === "ssh") {
        const pwd = await resolveSshPassword(target.connectionId);
        if (pwd === undefined) {
          setPendingPost(notes || "");
          setPasswordPromptOpen(true);
          return;
        }
        await execPostCheck(notes, pwd);
        return;
      }
      await execPostCheck(notes);
    },
    [selectedBundleId, preSnapshot, target, resolveSshPassword, execPostCheck],
  );

  // Password modal submit: routes to pre- or post-check based on pendingPost.
  const handlePasswordSubmit = useCallback(
    (password: string) => {
      setPasswordPromptOpen(false);
      if (pendingPost !== null) {
        void execPostCheck(pendingPost, password);
        setPendingPost(null);
      } else {
        void execPreCheck(password);
      }
    },
    [pendingPost, execPreCheck, execPostCheck],
  );

  const handleExportMarkdown = useCallback(async () => {
    if (!currentReport) return;
    let bundleName = currentReport.summary.bundle_id;
    try {
      const bundle = await bundleGet(currentReport.summary.bundle_id);
      bundleName = bundle.name;
    } catch {
      // Bundle deleted post-report — fall back to id.
    }
    const path = await save({
      defaultPath: `change-report-${bundleName.replace(/[^\w-]/g, "_")}-${currentReport.createdAt ?? Math.floor(Date.now() / 1000)}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    const md = renderReportMarkdown(currentReport.summary, {
      bundleName,
      capturedAt: currentReport.createdAt ?? Math.floor(Date.now() / 1000),
    });
    await writeTextFile(path as string, md);
  }, [currentReport]);

  const handleDone = useCallback(() => {
    clearSnapshots();
    selectBundle(null);
    setStage("select");
  }, [clearSnapshots, selectBundle]);

  const renderContent = () => {
    switch (stage) {
      case "select":
        return (
          <>
            <BundlePicker
              vendor={vendor}
              platform={platform}
              onSelect={handleSelectBundle}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onCreateNew={handleCreateNew}
            />
            {selectedBundleId && (
              <div className="panel-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={handleRunPreCheck}
                >
                  Run Pre-Check
                </button>
              </div>
            )}
          </>
        );

      case "pre-running":
      case "pre-done":
        return (
          <PreCheckRunner
            running={stage === "pre-running"}
            snapshot={preSnapshot}
            onRun={handleRunPreCheck}
            onStartChange={handleStartChange}
          />
        );

      case "change-open":
      case "post-running":
        return (
          <PostCheckRunner
            running={stage === "post-running"}
            onRun={handleRunPostCheck}
          />
        );

      case "report":
        return (
          <>
            {currentReport && (
              <ChangeReportView report={currentReport.summary} reportId={currentReport.id} />
            )}
            <div className="panel-actions">
              <button type="button" onClick={handleExportMarkdown}>
                Export Markdown
              </button>
              <button type="button" className="primary" onClick={handleDone}>
                Done
              </button>
            </div>
          </>
        );
    }
  };

  return (
    <div className="change-window-panel">
      <div className="change-window-header">
        <h2>Change Verification</h2>
        <button
          type="button"
          className="close-btn"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="change-window-device">
        <label htmlFor="change-device-type">Device type</label>
        <select
          id="change-device-type"
          value={deviceIdx}
          onChange={(e) => handleDeviceChange(Number(e.target.value))}
          disabled={stage !== "select"}
          title={
            stage !== "select"
              ? "Finish or reset this change to switch device type"
              : "Selects the parser used for pre/post output"
          }
        >
          {DEVICE_TYPES.map((d, i) => (
            <option key={`${d.vendor}-${d.platform}`} value={i}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div className="change-window-device">
        <label htmlFor="change-target">Run against</label>
        <select
          id="change-target"
          value={target.type === "ssh" ? target.connectionId : "current-tab"}
          onChange={(e) => {
            const v = e.target.value;
            setTarget(
              v === "current-tab"
                ? { type: "current-tab" }
                : { type: "ssh", connectionId: v },
            );
          }}
          disabled={stage !== "select" && stage !== "change-open"}
          title="Where pre/post commands run. Use an SSH connection to query a network device; 'Current tab' runs in the local shell."
        >
          <option value="current-tab">Current tab (local shell)</option>
          {sshConnections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.user ? `${c.user}@` : ""}{c.host})
            </option>
          ))}
        </select>
      </div>

      {target.type === "current-tab" && (
        <div className="change-window-hint">
          Runs commands in this tab's local shell. To query a switch, pick a
          saved SSH connection above.
        </div>
      )}

      <ChangeTimeline currentStage={stage} />

      {errorMsg && (
        <div className="change-window-error" role="alert">
          <span>{errorMsg}</span>
          <button
            type="button"
            className="close-btn"
            onClick={() => setErrorMsg(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <div className="change-window-content">{renderContent()}</div>

      {editorOpen && (
        <BundleEditor
          vendor={vendor}
          platform={platform}
          existing={editingBundle}
          onSave={handleSaveBundle}
          onCancel={() => {
            setEditorOpen(false);
            setEditingBundle(undefined);
          }}
        />
      )}

      <PasswordPromptModal
        isOpen={passwordPromptOpen}
        connectionName={
          target.type === "ssh"
            ? sshConnections.find((c) => c.id === target.connectionId)?.name ??
              "SSH connection"
            : "SSH connection"
        }
        onSubmit={handlePasswordSubmit}
        onCancel={() => {
          setPasswordPromptOpen(false);
          setPendingPost(null);
        }}
      />
    </div>
  );
}

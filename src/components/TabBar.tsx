import { useEffect, useRef, useState } from "react";
import type { Tab } from "../lib/types";
import { useTabs } from "../state/tabsStore";
import { usePanesStore, getAllLeafPanes } from "../state/panesStore";
import { useRecordings } from "../state/recordingStore";
import { usePaneActivityStore } from "../state/paneActivityStore";
import { useEditorStore } from "../state/editorStore";
import { tabActivityState } from "../lib/tabActivity";
import {
  ptyKill,
  tabCloseApi,
  tabCloseNetconf,
  tabCloseEditor,
} from "../lib/tauri";
import { ENABLE_TERMINAL_REGISTRY } from "../hooks/usePty";
import * as terminalRegistry from "../lib/terminalRegistry";
import NotificationCenter from "./NotificationCenter";

export function TabBar({
  onNew,
  onNewApi,
  onNewNetconf,
  onNewEditor,
  onNewTopology,
  onNewVault,
  onNewRecordings,
  onNewTroubleshoot,
  onSettings,
  onSaveSession,
  onDetach,
}: {
  onNew: () => void;
  onNewApi?: () => void;
  onNewNetconf?: () => void;
  onNewEditor?: () => void;
  onNewTopology?: () => void;
  onNewVault?: () => void;
  onNewRecordings?: () => void;
  onNewTroubleshoot?: () => void;
  onSettings?: () => void;
  onSaveSession?: () => void;
  onDetach?: (tab: Tab) => void | Promise<void>;
}) {
  const { tabs, activeTabId, setActive, removeTab } = useTabs();
  const activeRecordings = useRecordings((s) => s.active);
  const { focusedPaneId, splitPane } = usePanesStore();
  const activities = usePaneActivityStore((s) => s.activities);
  // Subscribe to layouts so the tab dot re-derives when a tab's panes change.
  const layoutsByTab = usePanesStore((s) => s.layoutsByTab);

  const [chooserOpen, setChooserOpen] = useState(false);
  const chooserRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!chooserOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (!chooserRef.current?.contains(e.target as Node))
        setChooserOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChooserOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [chooserOpen]);

  const pickAndClose = (fn?: () => void) => {
    if (!fn) return;
    fn();
    setChooserOpen(false);
  };

  const hasSecondaryChooser =
    !!onNewApi ||
    !!onNewNetconf ||
    !!onNewEditor ||
    !!onNewTopology ||
    !!onNewVault ||
    !!onNewRecordings ||
    !!onNewTroubleshoot;

  const handleSplitVertical = () => {
    if (focusedPaneId) {
      const placeholderId = `pending-${crypto.randomUUID()}`;
      splitPane(focusedPaneId, "vertical", placeholderId);
    }
  };

  const handleSplitHorizontal = () => {
    if (focusedPaneId) {
      const placeholderId = `pending-${crypto.randomUUID()}`;
      splitPane(focusedPaneId, "horizontal", placeholderId);
    }
  };

  return (
    <div className="tabbar">
      {tabs.map((t) => {
        const isApi = t.tab_type === "api";
        const isNetconf = t.tab_type === "netconf";
        const isEditor = t.tab_type === "editor";
        const isTopology = t.tab_type === "topology";
        const isVault = t.tab_type === "vault";
        const isRecordings = t.tab_type === "recordings";
        const isRecordingPlayer = t.tab_type === "recording-player";
        const isTroubleshoot = t.tab_type === "troubleshoot";
        const isTroubleshootEditor = t.tab_type === "troubleshoot-editor";
        // Heartbeat is a permanent tab — no close button.
        const isHeartbeat = t.tab_type === "heartbeat";
        const isRecording = !!activeRecordings[t.id];
        const isTerminalTab =
          !isApi &&
          !isNetconf &&
          !isEditor &&
          !isTopology &&
          !isVault &&
          !isRecordings &&
          !isRecordingPlayer &&
          !isTroubleshoot &&
          !isTroubleshootEditor &&
          !isHeartbeat;
        const layout = layoutsByTab.get(t.id);
        const canDetach =
          isTerminalTab && (!layout || getAllLeafPanes(layout).length === 1);
        // Backend pane-activity is keyed by each pane's spawned PTY id, not the
        // frontend tab/terminal id. Resolve this tab's pane terminalIds → their
        // PTY ids (registry), then match activities by those. Fall back to the
        // tab id itself for the single-pane/legacy case where they're equal.
        let tabActivity = null;
        if (isTerminalTab && t.id !== activeTabId) {
          const layout = layoutsByTab.get(t.id);
          const leafTerminalIds = layout
            ? getAllLeafPanes(layout).map((leaf) => leaf.terminalId)
            : [t.id];
          const ptyIds = new Set(
            leafTerminalIds.map(
              (tid) => terminalRegistry.ptyTabIdFor(tid) ?? tid,
            ),
          );
          tabActivity = tabActivityState(
            Array.from(activities.values()).filter(
              (a) => ptyIds.has(a.tabId) || ptyIds.has(a.paneId),
            ),
          );
        }
        return (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? "tab-active" : ""} ${
              isApi
                ? "tab-api"
                : isNetconf
                  ? "tab-netconf"
                  : isEditor
                    ? "tab-editor"
                    : isTopology
                      ? "tab-topology"
                      : "tab-terminal"
            }`}
            onClick={() => setActive(t.id)}
            draggable={canDetach && !!onDetach}
            onDragStart={(event) => {
              if (!canDetach || !onDetach) return;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", t.id);
            }}
            onDragEnd={(event) => {
              if (!canDetach || !onDetach) return;
              const outside =
                event.clientX <= 0 ||
                event.clientY <= 0 ||
                event.clientX >= window.innerWidth ||
                event.clientY >= window.innerHeight;
              if (outside) void onDetach(t);
            }}
            data-testid={`tab-${t.id}`}
            data-tab-type={t.tab_type ?? "terminal"}
          >
            {isApi && (
              <span className="tab-type-badge" title="API Runner tab">
                API
              </span>
            )}
            {isNetconf && (
              <span className="tab-type-badge" title="NETCONF tab">
                NC
              </span>
            )}
            {isEditor && (
              <span className="tab-type-badge" title="Code Editor tab">
                ED
              </span>
            )}
            {isTopology && (
              <span className="tab-type-badge" title="Topology tab">
                TOP
              </span>
            )}
            {isVault && (
              <span className="tab-type-badge" title="Vault tab">
                VAULT
              </span>
            )}
            {isRecordings && (
              <span className="tab-type-badge" title="Recordings tab">
                REC
              </span>
            )}
            {isTroubleshoot && (
              <span className="tab-type-badge" title="Troubleshoot tab">
                TS
              </span>
            )}
            {isTroubleshootEditor && (
              <span className="tab-type-badge" title="Playbook editor tab">
                PB
              </span>
            )}
            {isRecordingPlayer && (
              <span className="tab-type-badge" title="Recording player">
                ▶
              </span>
            )}
            {isRecording && (
              <span
                className="tab-recording-dot"
                title="Recording active"
                aria-label="Recording"
                data-testid={`tab-recording-dot-${t.id}`}
              />
            )}
            {tabActivity && (
              <span
                className={`tab-activity-dot tab-activity-dot--${tabActivity === "needs_attention" ? "needs-attention" : "running"}`}
                title={
                  tabActivity === "needs_attention"
                    ? "Needs attention"
                    : "Running"
                }
                aria-label={
                  tabActivity === "needs_attention"
                    ? "Needs attention"
                    : "Running"
                }
                data-testid={`tab-activity-dot-${t.id}`}
              />
            )}
            <span>{t.title}</span>
            {canDetach && onDetach && (
              <button
                className="tab-detach"
                onClick={(event) => {
                  event.stopPropagation();
                  void onDetach(t);
                }}
                title="Detach terminal window"
                aria-label={`Detach ${t.title}`}
              >
                ↗
              </button>
            )}
            {!isHeartbeat && (
              <button
                className="tab-close"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (isApi) {
                    await tabCloseApi(t.id).catch(() => {});
                  } else if (isNetconf) {
                    await tabCloseNetconf(t.id).catch(() => {});
                  } else if (isEditor) {
                    try {
                      await tabCloseEditor(t.id);
                    } catch (error) {
                      useEditorStore
                        .getState()
                        .patchWorkspace(t.id, { error: String(error) });
                      return;
                    }
                    useEditorStore.getState().resetWorkspace(t.id);
                  } else if (
                    isTopology ||
                    isVault ||
                    isRecordings ||
                    isRecordingPlayer ||
                    isTroubleshoot ||
                    isTroubleshootEditor
                  ) {
                    // Pure-frontend tabs; no Rust-side close.
                  } else {
                    if (ENABLE_TERMINAL_REGISTRY) {
                      terminalRegistry.dispose(t.id);
                    } else {
                      await ptyKill(t.id).catch(() => {});
                    }
                  }
                  removeTab(t.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <div
        className={`tab-new-group ${chooserOpen ? "tab-new-group-open" : ""}`}
        ref={chooserRef}
      >
        <button className="tab-new" onClick={onNew} title="New terminal tab">
          +
        </button>
        {hasSecondaryChooser && (
          <button
            className="tab-new-chooser"
            onClick={() => setChooserOpen((v) => !v)}
            title="More tab types…"
            aria-expanded={chooserOpen}
            aria-haspopup="menu"
            data-testid="tab-new-chooser"
          >
            ▾
          </button>
        )}
        {hasSecondaryChooser && (
          <div
            className="tab-chooser-popover"
            role="menu"
            hidden={!chooserOpen}
          >
            <div className="tab-chooser-section">
              <div className="tab-chooser-label">Run</div>
              {onNewApi && (
                <button
                  className="tab-chooser-item"
                  onClick={() => pickAndClose(onNewApi)}
                  data-testid="tab-new-api"
                  role="menuitem"
                >
                  <span className="tab-chooser-badge tab-chooser-badge-api">
                    API
                  </span>
                  API Runner
                </button>
              )}
              {onNewNetconf && (
                <button
                  className="tab-chooser-item"
                  onClick={() => pickAndClose(onNewNetconf)}
                  data-testid="tab-new-netconf"
                  role="menuitem"
                >
                  <span className="tab-chooser-badge tab-chooser-badge-nc">
                    NC
                  </span>
                  NETCONF
                </button>
              )}
              {onNewEditor && (
                <button
                  className="tab-chooser-item"
                  onClick={() => pickAndClose(onNewEditor)}
                  data-testid="tab-new-editor"
                  role="menuitem"
                >
                  <span className="tab-chooser-badge tab-chooser-badge-ed">
                    ED
                  </span>
                  Editor
                </button>
              )}
            </div>
            {(onNewTopology || onNewRecordings) && (
              <div className="tab-chooser-section">
                <div className="tab-chooser-label">View</div>
                {onNewTopology && (
                  <button
                    className="tab-chooser-item"
                    onClick={() => pickAndClose(onNewTopology)}
                    data-testid="tab-new-topology"
                    role="menuitem"
                  >
                    <span className="tab-chooser-badge tab-chooser-badge-top">
                      TOP
                    </span>
                    Topology
                  </button>
                )}
                {onNewRecordings && (
                  <button
                    className="tab-chooser-item"
                    onClick={() => pickAndClose(onNewRecordings)}
                    data-testid="tab-new-recordings"
                    role="menuitem"
                  >
                    <span className="tab-chooser-badge tab-chooser-badge-rec">
                      REC
                    </span>
                    Recordings
                  </button>
                )}
              </div>
            )}
            {onNewTroubleshoot && (
              <div className="tab-chooser-section">
                <div className="tab-chooser-label">Diagnose</div>
                <button
                  className="tab-chooser-item"
                  onClick={() => pickAndClose(onNewTroubleshoot)}
                  data-testid="tab-new-troubleshoot"
                  role="menuitem"
                >
                  <span className="tab-chooser-badge tab-chooser-badge-ts">
                    TS
                  </span>
                  Troubleshoot
                </button>
              </div>
            )}
            {onNewVault && (
              <div className="tab-chooser-section">
                <div className="tab-chooser-label">Secure</div>
                <button
                  className="tab-chooser-item"
                  onClick={() => pickAndClose(onNewVault)}
                  data-testid="tab-new-vault"
                  role="menuitem"
                >
                  <span className="tab-chooser-badge tab-chooser-badge-vault">
                    VAULT
                  </span>
                  Vault
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="tab-actions">
        <button
          className="tab-action-btn"
          onClick={handleSplitVertical}
          disabled={!focusedPaneId}
          title="Split Vertically (Cmd+D)"
        >
          ⬌
        </button>
        <button
          className="tab-action-btn"
          onClick={handleSplitHorizontal}
          disabled={!focusedPaneId}
          title="Split Horizontally (Cmd+Shift+D)"
        >
          ⬍
        </button>
        <NotificationCenter />
      </div>
      {onSaveSession && (
        <button
          className="tab-save-session"
          onClick={onSaveSession}
          title="Save Session"
        >
          Save
        </button>
      )}
      {onSettings && (
        <button className="tab-settings" onClick={onSettings} title="Settings">
          ⚙
        </button>
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { listen } from '@tauri-apps/api/event';
import { TabBar } from "./components/TabBar";
import { CommandBlock } from "./components/CommandBlock";
import { AgentPanel } from "./components/AgentPanel";
import { SearchBar } from "./components/SearchBar";
import { Settings } from "./windows/Settings";
import { CommandPalette } from "./components/CommandPalette";
import { WorkflowRunner } from "./components/WorkflowRunner";
import { GlobalCommandBar } from "./components/GlobalCommandBar";
import { NotebookLibrary } from "./components/notebooks/NotebookLibrary";
import { NotebookPanel } from "./components/notebooks/NotebookPanel";
import { getRunnableNotebook } from "./lib/runnableNotebook";
import type { RunnableNotebookDto } from "./lib/runnableNotebook";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { StatusFooter } from "./components/StatusFooter";
import { UpdateNotification } from "./components/UpdateNotification";
import { ApiTab } from "./components/api/ApiTab";
import { NetconfTab } from "./components/netconf/NetconfTab";
const EditorTab = lazy(() => import("./components/editor/EditorTab").then(m => ({ default: m.EditorTab })));
const IacStudioTab = lazy(() => import("./components/iac/IacStudioTab").then(m => ({ default: m.IacStudioTab })));
const TopologyTab = lazy(() => import("./components/topology/TopologyTab").then(m => ({ default: m.TopologyTab })));
const VaultTab = lazy(() => import("./components/vault/VaultTab").then(m => ({ default: m.VaultTab })));
const RecordingsTab = lazy(() => import("./components/recording/RecordingsTab").then(m => ({ default: m.RecordingsTab })));
const CastPlayer = lazy(() => import("./components/recording/CastPlayer").then(m => ({ default: m.CastPlayer })));
const TroubleshootTab = lazy(() => import("./components/troubleshoot/TroubleshootTab").then(m => ({ default: m.TroubleshootTab })));
const TroubleshootEditorTab = lazy(() => import("./components/troubleshoot/TroubleshootEditorTab").then(m => ({ default: m.TroubleshootEditorTab })));
const SubnetTab = lazy(() => import("./components/subnet/SubnetTab").then(m => ({ default: m.SubnetTab })));
const HeartbeatTab = lazy(() => import("./components/HeartbeatTab").then(m => ({ default: m.HeartbeatTab })));
const ExecutionDetailDrawer = lazy(() => import("./components/ExecutionDetailDrawer").then(m => ({ default: m.ExecutionDetailDrawer })));
import { PaneContainer } from "./components/PaneContainer";
import { SavedSSHConnectionsModal } from "./components/SavedSSHConnectionsModal";
import { SerialConsolePanel } from "./components/SerialConsolePanel";
import { SftpPanel } from "./components/SftpPanel";
import { RecentlyClosedModal } from "./components/RecentlyClosedModal";
import { ChangeWindowPanel } from "./components/ChangeWindowPanel";
import { FanoutPanel } from "./components/FanoutPanel";
import { FanoutGroupsPanel } from "./components/FanoutGroupsPanel";
import BrowserUrlModal from "./components/BrowserUrlModal";
import { DriftSidebar } from "./components/DriftSidebar";
import { BlastRadiusHost } from "./components/BlastRadius/BlastRadiusHost";
import { RuleEditor } from "./components/BlastRadius/RuleEditor";
import { DecisionLogView } from "./components/BlastRadius/DecisionLogView";
import { IntentEditor } from "./components/IntentEditor";
import { PcapPanel } from "./components/PcapPanel";
import { DiagramPanel } from "./components/DiagramPanel";
import { HelpModal, type HelpSection } from "./components/help/HelpModal";
import { StateDrawer } from "./components/StateDrawer";
import MetadataCard from "./components/MetadataCard";
import RichInputModal from "./components/RichInputModal";
import { useMetadataStore } from "./state/metadataStore";
import { useForegroundAgentStore } from "./state/foregroundAgentStore";
import { useTabs } from "./state/tabsStore";
import type { Tab } from "./lib/types";
import { useClosedTabs } from "./state/closedTabsStore";
import { useIacStateStore } from "./state/iacStateStore";
import { useIacStudioStore } from "./state/iacStudioStore";
import { useBlocksStore } from "./state/blocksStore";
import { useStructuredView } from "./state/structuredViewStore";
import { usePanesStore } from "./state/panesStore";
import { usePaneActivityStore } from "./state/paneActivityStore";
import { useHeartbeatStore } from "./state/heartbeatStore";
import { useNetconfRunner } from "./state/netconfRunnerStore";
import { useChangeVerifyStore } from "./state/changeVerifyStore";
import { useSessionSave } from "./hooks/useSessionSave";
import { useKeyboardShortcut } from "./hooks/useKeyboardShortcut";
import { usePaneSplit } from "./hooks/usePaneSplit";
import { useFanoutShortcuts } from "./hooks/useFanoutShortcuts";
import { listTabs, tabNewApi, tabNewNetconf, tabNewEditor, tabNewSubnet, terminalDetach } from "./lib/tauri";
import { buildSshCommand } from "./lib/sshConnections";
import { AgentNotifier } from "./lib/agentNotifications";
import "./App.css";

const AGENT_MIN = 220;
const AGENT_MAX = 900;

function loadWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    if (Number.isFinite(v) && v >= min && v <= max) return v;
  } catch {
    /* ignore */
  }
  return fallback;
}

// Lazy load Terminal
const Terminal = lazy(() => import("./components/Terminal").then(module => ({ default: module.Terminal })));

function defaultShell() {
  if (navigator.platform.toLowerCase().includes("win")) return "powershell.exe";
  return "/bin/zsh";
}

type TermSlot = {
  /** Stable React key — never reused. */
  spawnKey: string;
  /** The PTY / tab id this slot owns once spawn resolves. null = still spawning. */
  tabId: string | null;
  /** Directory to spawn the PTY in (for run-in-terminal). Defaults to "/". */
  cwd?: string;
  /** A command piped into the PTY once it's live (run-in-terminal). Consumed once. */
  pendingCommand?: string;
};

export default function App() {
  // One slot per Terminal component. Slots are added on new-tab, removed when
  // their paired tab disappears from the tabs store (tab closed).
  const [termSlots, setTermSlots] = useState<TermSlot[]>([]); // seeded by boot-restore effect
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [notebookLibraryOpen, setNotebookLibraryOpen] = useState(false);
  const [openNotebook, setOpenNotebook] = useState<RunnableNotebookDto | null>(null);
  const [sshModalOpen, setSshModalOpen] = useState(false);
  const [serialConsoleOpen, setSerialConsoleOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [changeWindowOpen, setChangeWindowOpen] = useState(false);
  const [fanoutOpen, setFanoutOpen] = useState(false);
  const [fanoutGroupsOpen, setFanoutGroupsOpen] = useState(false);
  const [browserUrlModalOpen, setBrowserUrlModalOpen] = useState(false);
  const [driftOpen, setDriftOpen] = useState(false);
  const [intentEditorOpen, setIntentEditorOpen] = useState(false);
  const [guardrailsRulesOpen, setGuardrailsRulesOpen] = useState(false);
  const [guardrailsLogOpen, setGuardrailsLogOpen] = useState(false);
  const [capturesOpen, setCapturesOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  // Help modal — opened via the Tauri Help menu (`menu:help_open`) or by F1
  // / Cmd+/. The section is bound to the menu payload so individual menu
  // items deep-link straight to User Guide / Quick Start / Shortcuts / About.
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [helpSection, setHelpSection] = useState<HelpSection>("user-guide");
  // Inline banner shown after a deep-link share import. Auto-dismissed
  // after a short delay; deliberately not a generic toast framework.
  const [sharedImportNotice, setSharedImportNotice] = useState<string | null>(null);
  // Recently-closed tab picker (View ▸ Recently Closed / menu:reopen_closed_pick).
  const [recentlyClosedOpen, setRecentlyClosedOpen] = useState(false);
  const { tabs, activeTabId, addTab } = useTabs();

  // Persist the live session (tabs + scrollback) on a debounce.
  useSessionSave();
  const ensureHeartbeatTab = useTabs((s) => s.ensureHeartbeatTab);
  const { layoutsByTab, loadLayoutForTab, initializeLayout } = usePanesStore();
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);

  // Derive the active NETCONF device id from the active tab's netconf state.
  // Falls back to null when the active tab is not a netconf tab or no device
  // is selected. This is what the palette's "Device" scope binds against.
  const activeDeviceId = useNetconfRunner((s) => {
    if (!activeTabId) return null;
    const tabState = s.tabs[activeTabId];
    return tabState?.selected_device_id != null
      ? String(tabState.selected_device_id)
      : null;
  });

  useKeyboardShortcut('k', () => setPaletteOpen(true), { cmd: true });
  useFanoutShortcuts({
    onOpenFanout: () => setFanoutOpen(true),
    onExport: () => {
      // Defer to the panel; simply ensure it's open so the export button is reachable.
      setFanoutOpen(true);
    },
  });
  useKeyboardShortcut('w', () => setWorkflowOpen(true), { cmd: true, shift: true });
  useKeyboardShortcut('m', () => setNotebookLibraryOpen(true), { cmd: true, shift: true }); // Changed from 'n' to 'm' (MOPs)
  useKeyboardShortcut('i', () => setDiagramOpen(true), { cmd: true, shift: true });
  const toggleMetadata = useMetadataStore((s) => s.toggle);
  useKeyboardShortcut('l', () => toggleMetadata(), { cmd: true, shift: true });

  // Phase 3: New browser window. Triggered by the native menu item
  // "Operate → Browser → New Browser Window…" (⌘⇧B). We use the native menu
  // accelerator rather than a JS keydown handler because the focused xterm
  // terminal swallows keystrokes before they reach window-level listeners.
  // The URL is collected via an inline modal — window.prompt() is blocked in
  // the Tauri webview (returns null), same constraint as FanoutGroupsPanel.
  const handleBrowserUrlSubmit = async (url: string) => {
    const { createBrowserWindow } = await import('./lib/browser');
    try {
      await createBrowserWindow(url);
    } catch (e) {
      console.error('Failed to open browser window:', e);
      window.alert(`Failed to open browser window: ${e}`);
    }
  };

  // Phase 2 Task 10: Cycle through notifications with ⌘⇧M.
  // ⌘⇧N is reserved for Notebooks by the native Tools menu.
  useKeyboardShortcut('m', async () => {
    const activities = usePaneActivityStore.getState().activities;
    const needsAttention = Array.from(activities.values())
      .filter(a => a.notificationState === 'needs_attention')
      .sort((a, b) => a.updatedAt - b.updatedAt);

    if (needsAttention.length > 0) {
      const { setPaneFocus } = await import('./lib/paneActivity');
      const { setFocusedPane } = usePanesStore.getState();
      const nextPane = needsAttention[0];

      // Focus in both frontend and backend
      setFocusedPane(nextPane.paneId);
      await setPaneFocus(nextPane.paneId);
    }
  }, { cmd: true, shift: true });

  usePaneSplit();

  // Agents auto-open the diagram viewer when they produce a diagram.
  useEffect(() => {
    const open = () => setDiagramOpen(true);
    window.addEventListener("ccie:open-diagram-panel", open);
    return () => window.removeEventListener("ccie:open-diagram-panel", open);
  }, []);

  // Plan 14 — vault/recordings tab openers (declared early so menu listeners can use them).
  const handleOpenVault = useCallback(() => {
    const existing = useTabs.getState().tabs.find((t) => t.tab_type === "vault");
    if (existing) {
      useTabs.getState().setActive(existing.id);
      return;
    }
    addTab({
      id: crypto.randomUUID(),
      title: "Vault",
      shell_cmd: "",
      cwd: "/",
      created_at: Math.floor(Date.now() / 1000),
      tab_type: "vault" as const,
    });
  }, [addTab]);

  // Plan 15 Phase 4 — troubleshoot tab opener.
  const handleOpenTroubleshoot = useCallback(() => {
    const existing = useTabs.getState().tabs.find(
      (t) => t.tab_type === "troubleshoot",
    );
    if (existing) {
      useTabs.getState().setActive(existing.id);
      return;
    }
    addTab({
      id: crypto.randomUUID(),
      title: "Troubleshoot",
      shell_cmd: "",
      cwd: "/",
      created_at: Math.floor(Date.now() / 1000),
      tab_type: "troubleshoot" as const,
    });
  }, [addTab]);

  // Plan 15 Phase 6 — playbook editor tab opener.
  const handleOpenTroubleshootEditor = useCallback(() => {
    const existing = useTabs.getState().tabs.find(
      (t) => t.tab_type === "troubleshoot-editor",
    );
    if (existing) {
      useTabs.getState().setActive(existing.id);
      return;
    }
    addTab({
      id: crypto.randomUUID(),
      title: "Playbooks",
      shell_cmd: "",
      cwd: "/",
      created_at: Math.floor(Date.now() / 1000),
      tab_type: "troubleshoot-editor" as const,
    });
  }, [addTab]);

  // Task 12 — heartbeat tab opener.
  const handleOpenHeartbeat = useCallback(() => {
    const existing = useTabs.getState().tabs.find(
      (t) => t.tab_type === "heartbeat",
    );
    if (existing) {
      useTabs.getState().setActive(existing.id);
      return;
    }
    addTab({
      id: crypto.randomUUID(),
      title: "Heartbeat",
      shell_cmd: "",
      cwd: "/",
      created_at: Math.floor(Date.now() / 1000),
      tab_type: "heartbeat" as const,
    });
  }, [addTab]);

  // Heartbeat is a PERMANENT tab: once the first (terminal) tab exists, ensure a
  // Heartbeat tab sits second (index 1). Idempotent — re-runs are no-ops once
  // present. The first tab is spawned async by the initial PTY, so this fires
  // when `tabs` first becomes non-empty.
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.tab_type === "heartbeat")) {
      ensureHeartbeatTab();
    }
  }, [tabs, ensureHeartbeatTab]);

  const handleOpenRecordings = useCallback(() => {
    const existing = useTabs.getState().tabs.find(
      (t) => t.tab_type === "recordings",
    );
    if (existing) {
      useTabs.getState().setActive(existing.id);
      return;
    }
    addTab({
      id: crypto.randomUUID(),
      title: "Recordings",
      shell_cmd: "",
      cwd: "/",
      created_at: Math.floor(Date.now() / 1000),
      tab_type: "recordings" as const,
    });
  }, [addTab]);

  // Create a fresh terminal tab the SAME way restore/reopen do: mint the id
  // client-side, pre-create the registry entry with preferredTabId so the
  // backend reuses that id, register the tab, then seed a default pane layout
  // so the render routes straight through the registry (TerminalSlot), NOT
  // LegacyTerminal.
  //
  // Why this matters (root cause of "restore replays prompts, not output"):
  // going through LegacyTerminal first spawns a throwaway PTY under a random
  // id X and puts X in the tab store (so X is what gets snapshotted). The
  // active-tab layout effect then seeds a layout for X, the render flips to
  // PaneContainer → TerminalSlot → the registry spawns a SECOND PTY Y that the
  // user actually types into. Backend scrollback is keyed by the PTY id Y, but
  // the snapshot only knows X — so on restore we replay X (prompt redraws
  // only) and the real command output under Y is lost. Seeding the registry
  // up front collapses this to ONE PTY where tab id == PTY id == snapshot id.
  //
  // Falls back to a bare LegacyTerminal slot only if the xterm CDN isn't ready
  // yet (getOrCreate throws) — never leave the terminal column blank.
  const seedTerminalTab = useCallback(
    async (opts: { cwd?: string; pendingCommand?: string } = {}): Promise<void> => {
      const id = crypto.randomUUID();
      const shell = defaultShell();
      const cwd = opts.cwd || "/";
      try {
        const terminalRegistry = await import("./lib/terminalRegistry");
        // skipTabRegistration: we addTab ourselves below with the right values;
        // the registry's own spawn-resolve addTab would race with default ones.
        terminalRegistry.getOrCreate(id, {
          shell,
          cwd,
          preferredTabId: id,
          skipTabRegistration: true,
        });
        addTab({
          id,
          title: shell.split("/").pop() ?? shell,
          shell_cmd: shell,
          cwd,
          created_at: Math.floor(Date.now() / 1000),
          tab_type: "terminal",
        });
        await usePanesStore.getState().loadLayoutForTab(id);
        setTermSlots((prev) => [...prev, { spawnKey: "spawn-" + id, tabId: id }]);
        if (opts.pendingCommand) {
          terminalRegistry.runWhenReady(id, opts.pendingCommand);
        }
      } catch (e) {
        // xterm CDN not loaded yet — fall back to the legacy slot so boot is
        // never blank. This slot mis-keys scrollback (the bug above) but only
        // triggers in the rare pre-CDN window.
        console.warn("[seedTerminalTab] registry unavailable, legacy fallback:", e);
        setTermSlots((prev) => [
          ...prev,
          {
            spawnKey: "spawn-" + id,
            tabId: null,
            cwd: opts.cwd,
            pendingCommand: opts.pendingCommand,
          },
        ]);
      }
    },
    [addTab],
  );

  // One-time session restore. Recreate terminal tabs (fresh shell + replayed
  // scrollback, reusing saved ids so scrollback/pane_layouts line up). Falls
  // back to a single fresh slot when there is nothing to restore.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let plan: import("./lib/sessionRestore").RestorePlan = { tabs: [], activeTabId: null };
      try {
        const { restoreLastSession } = await import("./lib/tauri");
        const { planRestore } = await import("./lib/sessionRestore");
        plan = planRestore(await restoreLastSession());
      } catch (e) {
        console.warn("[restore] failed; starting fresh:", e);
      }
      if (cancelled) return;

      if (plan.tabs.length === 0) {
        void seedTerminalTab();
        return;
      }

      let seeded = 0;
      const terminalRegistry = await import("./lib/terminalRegistry");
      for (const t of plan.tabs) {
        try {
          // Reuse the saved id as the registry terminalId AND the backend tab id.
          terminalRegistry.getOrCreate(t.id, {
            shell: t.shell_cmd,
            cwd: t.cwd,
            preferredTabId: t.id,
            replayBytes: t.replayBytes,
            skipTabRegistration: true,
          });
          addTab({
            id: t.id,
            title: t.title,
            shell_cmd: t.shell_cmd,
            cwd: t.cwd,
            created_at: t.created_at,
            tab_type: "terminal",
          });
          // Route this tab through the registry (not LegacyTerminal): ensure a
          // pane layout exists keyed by the saved id so <PaneContainer> renders
          // <Terminal terminalId={t.id}> → the registry entry we just created
          // (id reuse → scrollback/pane_layouts line up → replay attaches).
          // loadLayoutForTab loads saved splits, or inits a default root pane
          // whose terminalId === t.id.
          await usePanesStore.getState().loadLayoutForTab(t.id);
          setTermSlots((prev) => [...prev, { spawnKey: "restore-" + t.id, tabId: t.id }]);
          seeded++;
        } catch (e) {
          console.warn("[restore] tab failed, skipping:", t.id, e);
        }
      }
      // Restore must never block boot: if every tab failed to seed, fall back
      // to a single fresh slot so the terminal column is never left blank.
      if (seeded === 0) {
        void seedTerminalTab();
      } else if (
        plan.activeTabId &&
        useTabs.getState().tabs.some((t) => t.id === plan.activeTabId)
      ) {
        // Only activate the saved tab if it actually seeded — if it was the one
        // that failed mid-loop, setting a dangling id would leave no tab active.
        useTabs.getState().setActive(plan.activeTabId);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reopen a closed terminal tab (⌘⇧O most-recent, or picked from the modal).
  // Mirrors the boot-restore path: pre-create the registry entry with the saved
  // id + replayed scrollback, register the tab, then seed the pane layout so the
  // render routes through the registry entry (id reuse → replay attaches).
  const reopenClosedTab = useCallback(async (tabId: string, title: string, cwd: string) => {
    if (useTabs.getState().tabs.some((t) => t.id === tabId)) {
      useTabs.getState().setActive(tabId);
      return;
    }
    const terminalRegistry = await import("./lib/terminalRegistry");
    const { tabScrollback } = await import("./lib/tauri");
    let replayBytes: number[] = [];
    try { replayBytes = await tabScrollback(tabId); } catch { /* no history */ }
    terminalRegistry.getOrCreate(tabId, {
      shell: defaultShell(), cwd, preferredTabId: tabId, replayBytes,
    });
    addTab({ id: tabId, title, shell_cmd: defaultShell(), cwd, created_at: Math.floor(Date.now() / 1000), tab_type: "terminal" });
    await usePanesStore.getState().loadLayoutForTab(tabId);
    setTermSlots((prev) => [...prev, { spawnKey: "reopen-" + tabId, tabId }]);
    useClosedTabs.getState().removeById(tabId);
  }, [addTab]);

  // Listen for menu events
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(listen('menu:ssh_saved_connections', () => {
      setSshModalOpen(true);
    }));
    unlistens.push(listen('menu:ssh_serial_console', () => {
      setSerialConsoleOpen(true);
    }));
    unlistens.push(listen('menu:ssh_sftp', () => {
      setSftpOpen(true);
    }));

    // View menu — drives the focused block's view mode. Restored 2026-07-02
    // (see docs/superpowers/specs/2026-07-02-restore-blocks-mode-and-view-menu-design.md).
    unlistens.push(
      listen<string>('menu:view_mode', (e) => {
        const mode = e.payload as 'raw' | 'structured' | 'diff';
        const { focusedBlockId, setViewMode } = useStructuredView.getState();
        if (focusedBlockId) setViewMode(focusedBlockId, mode);
      }),
    );

    // Plan 06 — Change menu events
    unlistens.push(listen('menu:change_open', () => {
      setChangeWindowOpen(true);
    }));

    unlistens.push(listen('menu:change_run_pre', () => {
      // If panel not open, open it; otherwise this is handled by panel state
      if (!changeWindowOpen) {
        setChangeWindowOpen(true);
      }
      // TODO: dispatch pre-check if panel is already open with bundle selected
    }));

    unlistens.push(listen('menu:change_run_post', () => {
      // If panel not open, open it; otherwise this is handled by panel state
      if (!changeWindowOpen) {
        setChangeWindowOpen(true);
      }
      // TODO: dispatch post-check if panel is in change-open stage
    }));

    unlistens.push(listen('menu:change_new_bundle', () => {
      if (!changeWindowOpen) {
        setChangeWindowOpen(true);
      }
      // TODO: dispatch new-bundle event to panel
    }));

    unlistens.push(listen('menu:change_manage_bundles', () => {
      setChangeWindowOpen(true);
    }));

    // Plan 07 — Fan-out menu events
    // Phase 3 — Browser menu event (Operate → Browser → New Browser Window…)
    unlistens.push(listen('menu:browser_new', () => {
      setBrowserUrlModalOpen(true);
    }));

    unlistens.push(listen('menu:fanout_open', () => {
      setFanoutOpen(true);
    }));
    unlistens.push(listen('menu:fanout_groups', () => {
      setFanoutGroupsOpen(true);
    }));

    // Plan 08 — Drift menu events
    unlistens.push(listen('menu:drift_open', () => {
      setDriftOpen(true);
    }));
    unlistens.push(listen('menu:drift_intents', () => {
      setIntentEditorOpen(true);
    }));
    unlistens.push(listen('menu:pane_metadata_toggle', () => {
      useMetadataStore.getState().toggle();
    }));
    unlistens.push(listen('menu:rich_input', () => {
      window.dispatchEvent(
        new CustomEvent('ccie:open-rich-input', { detail: { paneId: null } }),
      );
    }));

    // IaC menu event — open the state drawer at the focused terminal's LIVE
    // cwd. The shell's OSC 7 cwd is keyed by the backend PTY id (panes spawn
    // PTYs under their own id, not the tab id), so resolve that id via the
    // panes store and look it up; fall back to the tab's recorded cwd.
    unlistens.push(listen('menu:iac_state_open', () => {
      const st = useTabs.getState();
      const activeTabId = st.activeTabId;
      const activeTab = st.tabs.find((t) => t.id === activeTabId);
      let liveCwd: string | undefined;
      if (activeTabId) {
        const ptyId = usePanesStore.getState().resolveRecordingTerminalId(activeTabId);
        liveCwd = useIacStateStore.getState().cwdByTerminal[ptyId];
      }
      useIacStateStore.getState().openDrawer(liveCwd ?? activeTab?.cwd ?? ".");
    }));

    // IaC Studio menu event — open a full-screen editor workspace rooted at the
    // focused terminal's LIVE cwd (same OSC 7 / PTY-id resolution as the state
    // drawer above), falling back to the tab's recorded cwd.
    unlistens.push(listen('menu:iac_studio_open', () => {
      const st = useTabs.getState();
      const activeTabId = st.activeTabId;
      const activeTab = st.tabs.find((t) => t.id === activeTabId);
      let liveCwd: string | undefined;
      if (activeTabId) {
        const ptyId = usePanesStore.getState().resolveRecordingTerminalId(activeTabId);
        liveCwd = useIacStateStore.getState().cwdByTerminal[ptyId];
      }
      st.addTab({
        id: crypto.randomUUID(),
        title: "IaC Studio",
        shell_cmd: "",
        cwd: liveCwd ?? activeTab?.cwd ?? ".",
        created_at: Math.floor(Date.now() / 1000),
        tab_type: "iac-studio" as const,
      });
    }));

    // IaC Studio wizard launchers — reuse or create IaC Studio tab, set pending_wizard flag.
    const launchWizard = (wizard: "resource" | "pipeline" | "onboarding") => {
      const st = useTabs.getState();
      const activeTabId = st.activeTabId;
      const activeTab = st.tabs.find((t) => t.id === activeTabId);
      // Reuse an existing IaC Studio tab if one is open; else create one.
      let studioTab = st.tabs.find((t) => t.tab_type === "iac-studio");
      let liveCwd: string | undefined;
      if (activeTabId) {
        const ptyId = usePanesStore.getState().resolveRecordingTerminalId(activeTabId);
        liveCwd = useIacStateStore.getState().cwdByTerminal[ptyId];
      }
      if (!studioTab) {
        const id = crypto.randomUUID();
        st.addTab({
          id,
          title: "IaC Studio",
          shell_cmd: "",
          cwd: liveCwd ?? activeTab?.cwd ?? ".",
          created_at: Math.floor(Date.now() / 1000),
          tab_type: "iac-studio" as const,
        });
        studioTab = useTabs.getState().tabs.find((t) => t.id === id);
      } else {
        st.setActive(studioTab.id);
      }
      if (studioTab) {
        useIacStudioStore.getState().ensure(studioTab.id, studioTab.cwd ?? ".");
        useIacStudioStore.getState().setPendingWizard(studioTab.id, wizard);
      }
    };

    unlistens.push(listen('menu:iac_new_resource', () => launchWizard("resource")));
    unlistens.push(listen('menu:iac_new_pipeline', () => launchWizard("pipeline")));
    unlistens.push(listen('menu:iac_get_started_pipelines', () => launchWizard("onboarding")));

    // Command-palette entry point for the pipeline onboarding wizard. The
    // palette dispatches this custom event; production `ccie:execute-command`
    // routing is unfinished, so onboarding gets its own dedicated event.
    const onStartOnboarding = () => launchWizard("onboarding");
    window.addEventListener("ccie:start-pipeline-onboarding", onStartOnboarding);
    unlistens.push(Promise.resolve(() =>
      window.removeEventListener("ccie:start-pipeline-onboarding", onStartOnboarding),
    ));

    // Plan 09 — Guardrails menu events
    unlistens.push(listen('menu:guardrails_rules', () => {
      setGuardrailsRulesOpen(true);
    }));
    unlistens.push(listen('menu:guardrails_log', () => {
      setGuardrailsLogOpen(true);
    }));

    // Plan 11 — Captures menu
    unlistens.push(listen('menu:captures_open', () => {
      setCapturesOpen(true);
    }));

    // Diagrams menu — draw.io diagram viewer
    unlistens.push(listen('menu:diagram_open', () => {
      setDiagramOpen(true);
    }));

    // Plan 14 — Vault menu
    unlistens.push(listen('menu:vault_open', () => {
      handleOpenVault();
    }));
    unlistens.push(listen('menu:vault_lock_active', async () => {
      const tabId = useTabs.getState().activeTabId;
      const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
      if (tab?.tab_type !== 'vault') {
        // No active envelope context; lock all unlocked.
        const { useVault } = await import('./state/vaultStore');
        const ids = Array.from(useVault.getState().unlockedIds);
        for (const id of ids) await useVault.getState().lock(id);
      }
    }));
    unlistens.push(listen('menu:vault_lock_all', async () => {
      const { useVault } = await import('./state/vaultStore');
      const ids = Array.from(useVault.getState().unlockedIds);
      for (const id of ids) await useVault.getState().lock(id);
    }));
    unlistens.push(listen('menu:vault_new_envelope', () => {
      handleOpenVault();
      // The VaultTab listens for this and opens the modal.
      window.dispatchEvent(new CustomEvent('vault:new-envelope'));
    }));
    unlistens.push(listen('menu:vault_audit', () => {
      handleOpenVault();
      window.dispatchEvent(new CustomEvent('vault:open-audit'));
    }));
    unlistens.push(listen('menu:vault_import_csv', () => {
      handleOpenVault();
      window.dispatchEvent(new CustomEvent('vault:open-import'));
    }));

    // Plan 15 Phase 4 — Troubleshoot menu (wired via menu:troubleshoot_*
    // events; the actual macOS menu items land alongside Phase 6 docs).
    unlistens.push(listen('menu:troubleshoot_open', () => {
      handleOpenTroubleshoot();
    }));
    unlistens.push(listen('menu:troubleshoot_editor', () => {
      // Plan 15 Phase 6 — dedicated playbook editor surface.
      handleOpenTroubleshootEditor();
    }));
    unlistens.push(listen('menu:troubleshoot_templates', () => {
      handleOpenTroubleshoot();
    }));

    // Task 12 — Heartbeat menu
    unlistens.push(listen('menu:heartbeat_open', () => {
      handleOpenHeartbeat();
    }));

    // Help menu — payload is the section name. Falls back to user-guide if
    // an unexpected payload arrives so the modal still surfaces something.
    unlistens.push(
      listen<string>('menu:help_open', (e) => {
        const valid: HelpSection[] = [
          'user-guide',
          'quick-start',
          'shortcuts',
          'about',
        ];
        const next = (valid.includes(e.payload as HelpSection)
          ? (e.payload as HelpSection)
          : 'user-guide');
        setHelpSection(next);
        setHelpModalOpen(true);
      }),
    );

    // Plan 14 — Recording menu
    unlistens.push(listen('menu:recording_open_list', () => {
      handleOpenRecordings();
    }));
    unlistens.push(listen('menu:recording_toggle', async () => {
      const tabId = useTabs.getState().activeTabId;
      if (!tabId) return;
      const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.tab_type !== undefined && tab.tab_type !== 'terminal') {
        return; // only terminal tabs can be recorded
      }
      // PTYs are keyed by their per-pane spawn id, not the frontend tab id.
      // Record the focused pane's terminal so the cast actually captures
      // output (otherwise the tap attaches to a missing PTY → empty cast).
      const { usePanesStore } = await import('./state/panesStore');
      const terminalId = usePanesStore.getState().resolveRecordingTerminalId(tabId);
      console.log('[recording] toggle: activeTabId=', tabId, 'resolved terminalId=', terminalId);
      const { useRecordings } = await import('./state/recordingStore');
      try {
        // uiKey = tabId (drives the red indicator); ptyId = resolved terminal.
        await useRecordings.getState().toggle(tabId, terminalId, 'local');
      } catch (e) {
        console.error('recording toggle failed', e);
        const note = document.createElement('div');
        note.style.cssText = 'position:fixed;top:20px;right:20px;background:var(--status-recording-failure-surface);border:1px solid var(--status-recording-failure-border);border-radius:8px;padding:12px 16px;color:var(--status-recording-failure-text);font-size:13px;z-index:10001;max-width:480px;box-shadow:0 4px 12px rgb(var(--backdrop-rgb) / 0.5)';
        note.textContent = `Recording failed: ${String(e)}`;
        document.body.appendChild(note);
        setTimeout(() => note.remove(), 8000);
      }
    }));

    // Tools menu — palette, workflows, notebooks
    unlistens.push(listen('menu:open_palette', () => {
      setPaletteOpen(true);
    }));
    unlistens.push(listen('menu:open_workflows', () => {
      setWorkflowOpen(true);
    }));
    unlistens.push(listen('menu:open_notebooks', () => {
      setNotebookLibraryOpen(true);
    }));

    // Subnet Calculator menu
    unlistens.push(listen('menu:subnet_new', async () => {
      const tab = await tabNewSubnet({ title: "Subnet Calculator" });
      addTab(tab);
    }));

    unlistens.push(listen('menu:change_export_md', async () => {
      const report = useChangeVerifyStore.getState().currentReport;
      if (!report) {
        console.warn("Export Markdown: no current report");
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const { renderReportMarkdown } = await import("./lib/changeReportMarkdown");
      const { bundleGet } = await import("./lib/changeVerify");
      let bundleName = report.summary.bundle_id;
      try {
        const bundle = await bundleGet(report.summary.bundle_id);
        bundleName = bundle.name;
      } catch {}
      const path = await save({
        defaultPath: `change-report-${bundleName.replace(/[^\w-]/g, "_")}-${report.createdAt ?? Math.floor(Date.now() / 1000)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      const md = renderReportMarkdown(report.summary, {
        bundleName,
        capturedAt: report.createdAt ?? Math.floor(Date.now() / 1000),
      });
      await writeTextFile(path as string, md);
    }));

    // Recently-closed tab reopen (native accelerator ⌘⇧O + View menu).
    unlistens.push(listen('menu:reopen_closed_tab', () => {
      const t = useClosedTabs.getState().popMostRecent();
      if (t) reopenClosedTab(t.id, t.title, t.cwd);
    }));
    unlistens.push(listen('menu:reopen_closed_pick', () => setRecentlyClosedOpen(true)));

    return () => {
      unlistens.forEach((p) => p.then((fn) => fn()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeWindowOpen]);

  // Deep-link handler: ccie-terminal://block/<share_id>
  // Local-first: if the share already exists in the store, scroll to it.
  // Otherwise import via block_share_fetch and surface a small banner.
  useEffect(() => {
    let dismissTimer: ReturnType<typeof setTimeout> | null = null;

    const unlisten = listen<{ shareId: string }>('deep-link:block-share', async (evt) => {
      const shareId = evt.payload?.shareId;
      if (!shareId) return;

      const store = useBlocksStore.getState();

      // 1. Local-first: scan all tabs for a block with this shareId.
      let foundBlockId: string | null = null;
      for (const blocks of store.blocksByTab.values()) {
        const hit = blocks.find((b) => b.shareId === shareId);
        if (hit) {
          foundBlockId = hit.id;
          break;
        }
      }

      if (foundBlockId) {
        // Wait one frame so a freshly-mounted row has a DOM node.
        requestAnimationFrame(() => {
          const el = document.getElementById(`block-row-${foundBlockId}`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        return;
      }

      // 2. Otherwise import the shared payload and append to the active tab.
      try {
        const block = await store.importShare(shareId);
        const targetTabId = useTabs.getState().activeTabId ?? block.tabId;
        store.loadBlocks(targetTabId, [{ ...block, tabId: targetTabId }]);

        const short = shareId.length > 8 ? `${shareId.slice(0, 8)}…` : shareId;
        setSharedImportNotice(`Imported shared block ${short}`);
        if (dismissTimer) clearTimeout(dismissTimer);
        dismissTimer = setTimeout(() => setSharedImportNotice(null), 4000);
      } catch (err) {
        console.error('[deep-link] failed to import shared block:', err);
      }
    });

    return () => {
      if (dismissTimer) clearTimeout(dismissTimer);
      unlisten.then((fn) => fn());
    };
  }, []);

  // Plan 14 — wire `recording://started/stopped` listeners once.
  useEffect(() => {
    let unlistens: Array<() => void> = [];
    void (async () => {
      const { useRecordings } = await import('./state/recordingStore');
      const fns = await useRecordings.getState().initListeners();
      unlistens = fns;
    })();
    return () => {
      unlistens.forEach((u) => u());
    };
  }, []);

  // Phase 1: AI Assistant Integration — subscribe to pane activity events
  useEffect(() => {
    const subscribeToActivity = async () => {
      const unlisten = await usePaneActivityStore.getState().subscribeToEvents();
      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    subscribeToActivity().then((fn) => {
      cleanup = fn;
    });

    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // Warp-style: fire an OS notification when an in-pane agent (claude/codex)
  // transitions into needs_attention. Reuses the Web Notification API exactly
  // like heartbeatStore. Permission is requested by the heartbeat effect below.
  useEffect(() => {
    const notifier = new AgentNotifier({
      notify: (paneId, title, body) => {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const n = new Notification(title, { body, tag: `pane-${paneId}` });
        n.onclick = () => {
          const activity = usePaneActivityStore.getState().getActivity(paneId);
          if (activity) useTabs.getState().setActive(activity.tabId);
          window.focus();
        };
      },
      resolveTabTitle: (tabId) =>
        useTabs.getState().tabs.find((t) => t.id === tabId)?.title ?? 'a terminal',
      agentLabel: (paneId) => {
        const session = usePaneActivityStore.getState().getAgentSession(paneId);
        return session?.agentType?.startsWith('claude') ? 'Claude' : 'Codex';
      },
    });

    let cleanup: (() => void) | undefined;
    notifier.start().then((fn) => {
      cleanup = fn;
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // Warp-style: track which panes are running an agent CLI for the toolbelt.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    useForegroundAgentStore
      .getState()
      .subscribeToEvents()
      .then((fn) => {
        cleanup = fn;
      });
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // Subscribe to heartbeat events and request notification permission
  useEffect(() => {
    const subscribeToHeartbeat = async () => {
      // Request notification permission if not already granted
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      const unlisten = await useHeartbeatStore.getState().subscribeToEvents();
      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    subscribeToHeartbeat().then((fn) => {
      cleanup = fn;
    });

    // Listen for show-heartbeat-tab event
    const handleShowHeartbeatTab = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { executionId, heartbeatId } = customEvent.detail;
      // Switch to heartbeat tab
      const tabs = useTabs.getState();
      const heartbeatTab = tabs.tabs.find(t => t.tab_type === 'heartbeat');
      if (heartbeatTab) {
        tabs.setActive(heartbeatTab.id);
      }
    };

    window.addEventListener('show-heartbeat-tab', handleShowHeartbeatTab);

    return () => {
      if (cleanup) cleanup();
      window.removeEventListener('show-heartbeat-tab', handleShowHeartbeatTab);
    };
  }, []);

  // Report the focused pane to the backend so its notification heuristic knows
  // which pane the user is looking at (it never notifies the focused pane, and
  // clears needs_attention on focus). Backend activity is keyed by the spawned
  // PTY id, so resolve focusedPane → its leaf terminalId → ptyTabId. Without
  // this, focus is stale and completed bg commands never flip to needs_attention.
  useEffect(() => {
    if (!activeTabId) return;
    void (async () => {
      const { setPaneFocus } = await import('./lib/paneActivity');
      const { ptyTabIdFor } = await import('./lib/terminalRegistry');
      const terminalId = usePanesStore.getState().resolveRecordingTerminalId(activeTabId);
      const ptyId = ptyTabIdFor(terminalId) ?? terminalId;
      await setPaneFocus(ptyId).catch(() => {});
    })();
  }, [focusedPaneId, activeTabId]);

  // Load pane layout when active tab changes
  useEffect(() => {
    console.log('[App useEffect] activeTabId:', activeTabId, 'tabs.length:', tabs.length);
    if (!activeTabId) return;
    const activeTab = tabs.find(t => t.id === activeTabId);
    console.log('[App useEffect] activeTab:', activeTab, 'tab_type:', activeTab?.tab_type);
    if (!activeTab) return;

    // Initialize pane layout for all terminal tabs
    console.log('[App useEffect] Checking if terminal tab:', activeTab.tab_type, '===', 'terminal', '?', activeTab.tab_type === 'terminal');
    if (activeTab.tab_type === 'terminal') {
      const existingLayout = layoutsByTab.get(activeTabId);
      console.log('[App useEffect] Terminal tab, existingLayout:', existingLayout);
      if (!existingLayout) {
        console.log('[App useEffect] Calling loadLayoutForTab for:', activeTabId);
        // Try loading from DB, or initialize default if none exists
        loadLayoutForTab(activeTabId);
      }
    }
  }, [activeTabId, tabs, layoutsByTab, loadLayoutForTab]);

  // When a tab disappears from the store (closed via TabBar), drop its slot so
  // the Terminal unmounts and the xterm is disposed.
  const tabIdSet = new Set(tabs.map((t) => t.id));
  useEffect(() => {
    setTermSlots((prev) => {
      // Keep slots that either haven't registered yet (tabId=null) or whose
      // tab is still in the store.
      const next = prev.filter((s) => s.tabId === null || tabIdSet.has(s.tabId));
      return next.length === prev.length ? prev : next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  // Panel widths — resizable via drag handles, persisted in localStorage
  const [agentWidth, setAgentWidth] = useState<number>(() =>
    loadWidth("ccie.agentWidth", 300, AGENT_MIN, AGENT_MAX)
  );

  useEffect(() => {
    try {
      localStorage.setItem("ccie.agentWidth", String(agentWidth));
    } catch {}
  }, [agentWidth]);

  // Drag state for the resize handle
  const dragRef = useRef<{
    startX: number;
    startAgent: number;
  } | null>(null);

  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    // Handle is between terminal and agent — dragging right shrinks agent.
    const next = Math.min(
      AGENT_MAX,
      Math.max(AGENT_MIN, d.startAgent - dx)
    );
    setAgentWidth(next);
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
  }, [onDragMove]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startAgent: agentWidth,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
  };

  // Debug: log API tabs
  const apiTabs = tabs.filter((t) => t.tab_type === "api");
  useEffect(() => {
    console.log('[App] Tabs:', tabs.length, 'API tabs:', apiTabs.length, 'Active:', activeTabId);
    if (apiTabs.length > 0) {
      console.log('[App] API tabs:', apiTabs.map(t => ({ id: t.id, title: t.title, type: t.tab_type })));
    }
  }, [tabs, apiTabs.length, activeTabId]);

  // Pair each Terminal slot with the tab it owns (by id, not index).
  // A slot is visible iff its owning tab is the active tab, OR it's an
  // unregistered slot that hasn't registered yet (actively spawning).
  const terminals = termSlots.map((slot, index) => {
    const tab = slot.tabId ? tabs.find((t) => t.id === slot.tabId) : null;
    const shell = tab?.shell_cmd || defaultShell();
    // Prefer the slot's spawn cwd (set by run-in-terminal) until the tab exists.
    const cwd = tab?.cwd || slot.cwd || "/";
    const visible = tab
      ? tab.id === activeTabId
      : // Unregistered slot: show if it's the most recent one (last in array) that's still spawning
        slot.tabId === null && index === termSlots.length - 1;
    return { slot, tab, shell, cwd, visible };
  });

  const handleNewTab = () => {
    void seedTerminalTab();
  };

  const handleDetachTab = useCallback(async (tab: Tab) => {
    if (tab.tab_type && tab.tab_type !== "terminal") return;
    try {
      const { ptyTabIdFor } = await import("./lib/terminalRegistry");
      const ptyId = ptyTabIdFor(tab.id) ?? tab.id;
      await terminalDetach(ptyId, tab.title);
      useTabs.getState().removeTab(tab.id, false);
    } catch (error) {
      console.error("Failed to detach terminal tab:", error);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisten = listen<{ tabId: string }>("terminal-pop-in", async (event) => {
      const tabId = event.payload?.tabId;
      if (!tabId || disposed) return;
      if (useTabs.getState().tabs.some((tab) => tab.id === tabId)) {
        useTabs.getState().setActive(tabId);
        return;
      }
      try {
        const tab = (await listTabs()).find((candidate) => candidate.id === tabId);
        if (!tab || disposed) return;
        addTab(tab);
        await usePanesStore.getState().loadLayoutForTab(tab.id);
        setTermSlots((prev) =>
          prev.some((slot) => slot.tabId === tab.id)
            ? prev
            : [...prev, { spawnKey: "pop-in-" + tab.id, tabId: tab.id }],
        );
        useTabs.getState().setActive(tab.id);
      } catch (error) {
        console.error("Failed to pop terminal back in:", error);
      }
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, [addTab]);

  const handleNewApiTab = async () => {
    console.log('[App] Creating new API tab...');
    try {
      const tab = await tabNewApi({
        title: "New API Request",
        targetId: null,
        environment: null,
      });
      console.log('[App] API tab created:', tab);
      // Add tab to the frontend store and activate it
      addTab(tab);
      console.log('[App] API tab added to store and activated:', tab.id);
    } catch (err) {
      console.error("Failed to create API tab:", err);
    }
  };

  const handleNewNetconfTab = async () => {
    try {
      const tab = await tabNewNetconf({ title: "New NETCONF Session" });
      addTab(tab);
    } catch (err) {
      console.error("Failed to create NETCONF tab:", err);
    }
  };

  const handleNewEditor = useCallback(async () => {
    try {
      const tab = await tabNewEditor({
        title: "Editor",
        filePath: null,
      });
      addTab(tab);
    } catch (err) {
      console.error("Failed to create editor tab:", err);
    }
  }, [addTab]);

  const handleNewTopology = useCallback(() => {
    // Topology tabs are pure frontend (no Rust-side spawn) — generate
    // a uuid client-side and append to the tabs store directly.
    const tab = {
      id: crypto.randomUUID(),
      title: "Topology",
      shell_cmd: "",
      cwd: "/",
      created_at: Math.floor(Date.now() / 1000),
      tab_type: "topology" as const,
    };
    addTab(tab);
  }, [addTab]);

  // Pair a freshly-spawned Terminal's tab_id back into its slot. If the slot
  // carried a run-in-terminal command, hand it to the terminal registry keyed
  // by the tab id. We do NOT pipe to the PTY directly here: the slot that first
  // mounts (LegacyTerminal) is torn down and replaced by the registry-backed
  // PaneContainer once the new tab gets a default layout — piping to the
  // original PTY would land on an orphaned session the user never sees. The
  // registry delivers the command to whichever PTY it ends up owning for this
  // id, whether it's already live or still spawning.
  const registerSlotTab = useCallback((spawnKey: string, tabId: string) => {
    setTermSlots((prev) =>
      prev.map((s) => {
        if (s.spawnKey !== spawnKey) return s;
        if (s.pendingCommand) {
          // Focus the new terminal so the user sees it run.
          useTabs.getState().setActive(tabId);
          void import("./lib/terminalRegistry").then((reg) =>
            reg.runWhenReady(tabId, s.pendingCommand!),
          );
        }
        return { ...s, tabId, pendingCommand: undefined };
      })
    );
  }, []);

  // "Run in terminal" — spawn a fresh terminal in `cwd` and pipe `command` into
  // it once its PTY is live. Used by the IaC Studio Run-playbook button and the
  // pipeline onboarding wizard's direct-SSH "run now" action.
  useEffect(() => {
    const onRunInTerminal = (e: Event) => {
      const detail = (e as CustomEvent<{ command?: string; cwd?: string }>).detail;
      const command = detail?.command?.trim();
      if (!command) return;
      void seedTerminalTab({ cwd: detail?.cwd || undefined, pendingCommand: command });
    };
    window.addEventListener("ccie:run-in-terminal", onRunInTerminal);
    return () => window.removeEventListener("ccie:run-in-terminal", onRunInTerminal);
  }, [seedTerminalTab]);

  // If panel is collapsed we override its effective width to a thin strip.
  const effectiveAgentWidth = agentPanelOpen ? agentWidth : 40;

  const workspaceStyle: React.CSSProperties = {
    gridTemplateColumns: `1fr 6px ${effectiveAgentWidth}px`,
  };
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  return (
    <div className="shell">
      <ErrorBoundary componentName="TabBar">
        <TabBar
          onNew={handleNewTab}
          onNewApi={handleNewApiTab}
          onNewNetconf={handleNewNetconfTab}
          onNewEditor={handleNewEditor}
          onNewTopology={handleNewTopology}
          onNewVault={handleOpenVault}
          onNewRecordings={handleOpenRecordings}
          onNewTroubleshoot={handleOpenTroubleshoot}
          onDetach={handleDetachTab}
          onSettings={() => setSettingsOpen(true)}
        />
      </ErrorBoundary>
      <div className="workspace" style={workspaceStyle}>
        <ErrorBoundary componentName="Terminal">
          <Suspense fallback={<div style={{ padding: "20px", color: "var(--text-muted)" }}>Loading terminal...</div>}>
            <div className="term-col">
              {activeTab?.tab_type === "terminal" && activeTabId && (
                <GlobalCommandBar
                  tabId={activeTabId}
                  vendor={activeTab.vendor ?? "generic"}
                  platform={activeTab.platform ?? "generic"}
                />
              )}
              <div className="term-col__content">
              {/* Render active terminal tab */}
              {terminals.map(({ slot, tab, shell, cwd, visible }) => {
                // Check if this tab should use PaneContainer
                const layout = tab?.id ? layoutsByTab.get(tab.id) : null;

                if (layout) {
                  // Render with PaneContainer for split panes
                  return (
                    <div
                      key={`pane-${slot.spawnKey}`}
                      style={{ height: "100%", display: visible ? "block" : "none" }}
                    >
                      <PaneContainer node={layout} shell={shell} cwd={cwd} />
                    </div>
                  );
                } else {
                  // Render traditional single Terminal
                  return (
                    <div
                      key={`term-${slot.spawnKey}`}
                      style={{ height: "100%", display: visible ? "block" : "none" }}
                    >
                      <Terminal
                        key={slot.spawnKey}
                        shell={shell}
                        cwd={cwd}
                        onRegistered={(tabId) => registerSlotTab(slot.spawnKey, tabId)}
                      />
                    </div>
                  );
                }
              })}
              {tabs
                .filter((t) => t.tab_type === "api")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <ApiTab tab={tab} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "netconf")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <NetconfTab tab={tab} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "editor")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <EditorTab tab={tab} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "iac-studio")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <IacStudioTab tab={tab} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "topology")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <TopologyTab tabId={tab.id} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "vault")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <VaultTab />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "recordings")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <RecordingsTab />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "troubleshoot")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <TroubleshootTab tabId={tab.id} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "troubleshoot-editor")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <TroubleshootEditorTab tabId={tab.id} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "subnet")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <SubnetTab tab={tab} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "recording-player" && !!t.recordingId)
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <CastPlayer recordingId={tab.recordingId!} />
                  </div>
                ))}
              {tabs
                .filter((t) => t.tab_type === "heartbeat")
                .map((tab) => (
                  <div
                    key={tab.id}
                    style={{
                      height: "100%",
                      display: tab.id === activeTabId ? "block" : "none",
                    }}
                  >
                    <HeartbeatTab />
                  </div>
                ))}
              </div>
            </div>
          </Suspense>
        </ErrorBoundary>
        <div
          className={`resize-handle${agentPanelOpen ? "" : " disabled"}`}
          onMouseDown={agentPanelOpen ? startDrag : undefined}
          title={agentPanelOpen ? "Drag to resize" : "Expand agent panel to resize"}
        />
        <ErrorBoundary componentName="AgentPanel">
          <AgentPanel
            tabId={activeTabId}
            isOpen={agentPanelOpen}
            onToggle={() => setAgentPanelOpen(!agentPanelOpen)}
          />
        </ErrorBoundary>
      </div>
      {sharedImportNotice && (
        <div
          className="shared-import-banner"
          role="status"
          aria-live="polite"
        >
          <span>{sharedImportNotice}</span>
          <button
            type="button"
            className="shared-import-banner-close"
            aria-label="Dismiss"
            onClick={() => setSharedImportNotice(null)}
          >
            ×
          </button>
        </div>
      )}
      <ErrorBoundary componentName="SearchBar">
        <SearchBar />
      </ErrorBoundary>
      <ErrorBoundary componentName="StatusFooter">
        <StatusFooter />
      </ErrorBoundary>
      <ErrorBoundary componentName="UpdateNotification">
        <UpdateNotification />
      </ErrorBoundary>
      <ErrorBoundary componentName="Settings">
        <Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </ErrorBoundary>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        activeTabId={activeTabId ?? null}
        activeDeviceId={activeDeviceId}
      />
      {workflowOpen && activeTabId && (
        <WorkflowRunner
          open={workflowOpen}
          tabId={activeTabId}
          vendor={tabs.find((t) => t.id === activeTabId)?.vendor ?? "generic"}
          platform={tabs.find((t) => t.id === activeTabId)?.platform ?? "generic"}
          onClose={() => setWorkflowOpen(false)}
        />
      )}
      <NotebookLibrary
        open={notebookLibraryOpen}
        onClose={() => setNotebookLibraryOpen(false)}
        onOpen={async (id) => {
          try {
            const nb = await getRunnableNotebook(id);
            setOpenNotebook(nb);
            setNotebookLibraryOpen(false);
          } catch (e) {
            console.error("failed to open notebook", e);
          }
        }}
      />
      {openNotebook && activeTabId && (
        <div className="notebook-panel-overlay" data-testid="notebook-panel-overlay">
          <div className="notebook-panel-overlay-close-bar">
            <span className="notebook-panel-overlay-title">{openNotebook.frontmatter.title}</span>
            <button
              type="button"
              onClick={() => setOpenNotebook(null)}
              data-testid="notebook-panel-close"
              aria-label="Close notebook panel"
            >
              ×
            </button>
          </div>
          <NotebookPanel notebook={openNotebook} tabId={activeTabId} />
        </div>
      )}
      {sshModalOpen && (
        <SavedSSHConnectionsModal
          onConnect={(connection, password) => {
            const cmd = buildSshCommand(connection);

            // Close modal first
            setSshModalOpen(false);

            // Resolve the target PTY: the focused pane's terminalId for the
            // active tab (falls back to the tab id for single-pane tabs). The
            // terminal registry matches this against both its ptyTabId and
            // terminalId. Without ENABLE_TERMINAL_REGISTRY, LegacyTerminal
            // ignores targetTabId and handles the event globally.
            const targetTabId = activeTabId
              ? usePanesStore.getState().resolveRecordingTerminalId(activeTabId)
              : null;

            // Execute via custom event that the terminal listens for
            window.dispatchEvent(new CustomEvent('ssh-connect', {
              detail: {
                command: cmd,
                targetTabId,
                connection: {
                  id: connection.id,
                  display_name: connection.name,
                  vendor: connection.vendor,
                  platform: connection.platform,
                  accent_color: connection.accent_color,
                  syntax_highlighting_enabled: connection.syntax_highlighting_enabled,
                  syntax_profile: connection.syntax_profile,
                },
                credentials: {
                  host: connection.host,
                  user: connection.user,
                  password: password,
                }
              }
            }));
          }}
          onClose={() => setSshModalOpen(false)}
        />
      )}
      {serialConsoleOpen && (
        <SerialConsolePanel onClose={() => setSerialConsoleOpen(false)} />
      )}
      {sftpOpen && (
        <SftpPanel onClose={() => setSftpOpen(false)} />
      )}
      {changeWindowOpen && activeTabId && (
        <ChangeWindowPanel
          tabId={activeTabId}
          vendor={tabs.find((t) => t.id === activeTabId)?.vendor ?? "generic"}
          platform={tabs.find((t) => t.id === activeTabId)?.platform ?? "generic"}
          onClose={() => setChangeWindowOpen(false)}
        />
      )}
      {fanoutOpen && (
        <FanoutOverlay onClose={() => setFanoutOpen(false)} />
      )}
      {fanoutGroupsOpen && (
        <FanoutGroupsOverlay onClose={() => setFanoutGroupsOpen(false)} />
      )}
      <BrowserUrlModal
        isOpen={browserUrlModalOpen}
        onClose={() => setBrowserUrlModalOpen(false)}
        onSubmit={handleBrowserUrlSubmit}
      />
      {driftOpen && (
        <DriftOverlay onClose={() => setDriftOpen(false)} />
      )}
      {intentEditorOpen && (
        <IntentEditorOverlay onClose={() => setIntentEditorOpen(false)} />
      )}
      {guardrailsRulesOpen && (
        <GuardrailsRulesOverlay onClose={() => setGuardrailsRulesOpen(false)} />
      )}
      {guardrailsLogOpen && (
        <GuardrailsLogOverlay onClose={() => setGuardrailsLogOpen(false)} />
      )}
      {capturesOpen && (
        <CapturesOverlay onClose={() => setCapturesOpen(false)} />
      )}
      {diagramOpen && (
        <ModalShell title="Diagrams" onClose={() => setDiagramOpen(false)}>
          <DiagramPanel />
        </ModalShell>
      )}
      {helpModalOpen && (
        <HelpModal
          section={helpSection}
          onClose={() => setHelpModalOpen(false)}
        />
      )}
      <RecentlyClosedModal
        open={recentlyClosedOpen}
        onClose={() => setRecentlyClosedOpen(false)}
        onPick={(t) => reopenClosedTab(t.id, t.title, t.cwd)}
      />
      <BlastRadiusHost />
      <StateDrawer />
      <MetadataCard />
      <RichInputModal />
      <ExecutionDetailDrawer />
    </div>
  );
}

function DriftOverlay({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="Drift" onClose={onClose}>
      <DriftSidebar />
    </ModalShell>
  );
}

function IntentEditorOverlay({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="Intent Templates" onClose={onClose}>
      <IntentEditor />
    </ModalShell>
  );
}

function GuardrailsRulesOverlay({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="Guardrail Rules" onClose={onClose}>
      <RuleEditor />
    </ModalShell>
  );
}

function GuardrailsLogOverlay({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="Guardrail Decision Log" onClose={onClose}>
      <DecisionLogView />
    </ModalShell>
  );
}

function CapturesOverlay({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="Packet Captures" onClose={onClose} workspaceSize>
      <PcapPanel />
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
  workspaceSize = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  workspaceSize?: boolean;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--surface-modal-backdrop-60)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 90,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: workspaceSize ? "calc(100vw - 24px)" : "min(1200px, 92vw)",
          height: workspaceSize ? "calc(100vh - 24px)" : "min(800px, 86vh)",
          background: "var(--app-canvas)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 14px",
            borderBottom: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            fontFamily: "Menlo, monospace",
            fontSize: 12,
          }}
        >
          <span>{title}</span>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "none",
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function FanoutOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--surface-modal-backdrop-60)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 90,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(1200px, 92vw)",
          height: "min(800px, 86vh)",
          background: "var(--app-canvas)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 14px",
            borderBottom: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            fontFamily: "Menlo, monospace",
            fontSize: 12,
          }}
        >
          <span>Multi-Device Fan-Out</span>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "none",
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>
        <FanoutPanel />
      </div>
    </div>
  );
}

function FanoutGroupsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--surface-modal-backdrop-60)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 90,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(1100px, 90vw)",
          height: "min(720px, 80vh)",
          background: "var(--app-canvas)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 14px",
            borderBottom: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            fontFamily: "Menlo, monospace",
            fontSize: 12,
          }}
        >
          <span>Fan-Out Device Groups</span>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "none",
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>
        <FanoutGroupsPanel />
      </div>
    </div>
  );
}

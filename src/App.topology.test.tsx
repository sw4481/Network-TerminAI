import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshConnection, SshConnectEventDetail } from "./lib/sshConnections";
import type { CreateOpts, TerminalEntry } from "./lib/terminalRegistry";
import { useTabs } from "./state/tabsStore";
import { usePanesStore } from "./state/panesStore";
import { useNetconfRunner } from "./state/netconfRunnerStore";
import { useTerminalConnectionStore } from "./state/terminalConnectionStore";
import { MANAGED_SSH_SHELL_MARKER } from "./lib/sessionRestore";
import App from "./App";

type Callbacks = { onOpenSshTab?: (ref: string) => Promise<void> | void; onOpenNetconfTab?: (ref: string) => Promise<void> | void };
const h = vi.hoisted(() => ({
  callbacks: {} as Callbacks,
  invoke: vi.fn(), getOrCreate: vi.fn(), runWhenReady: vi.fn(), dispose: vi.fn(),
  platform: "macos",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("./lib/terminalRegistry", () => ({ getOrCreate: h.getOrCreate, runWhenReady: h.runWhenReady, dispose: h.dispose, ptyTabIdFor: () => null }));
vi.mock("./lib/terminalClipboard", () => ({ normalizeTerminalPlatform: () => h.platform }));
vi.mock("./hooks/useSessionSave", () => ({ useSessionSave: () => {} }));
vi.mock("./hooks/usePaneSplit", () => ({ usePaneSplit: () => ({}) }));
vi.mock("./components/topology/TopologyTab", () => ({ TopologyTab: (props: Callbacks) => { h.callbacks = props; return null; } }));
vi.mock("./components/TabBar", () => ({ TabBar: () => null }));
vi.mock("./components/CommandBlock", () => ({ CommandBlock: () => null }));
vi.mock("./components/AgentPanel", () => ({ AgentPanel: () => null }));
vi.mock("./components/canvas/CanvasWorkspace", () => ({ CanvasWorkspace: () => null }));
vi.mock("./components/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("./windows/Settings", () => ({ Settings: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/WorkflowRunner", () => ({ WorkflowRunner: () => null }));
vi.mock("./components/GlobalCommandBar", () => ({ GlobalCommandBar: () => null }));
vi.mock("./components/notebooks/NotebookLibrary", () => ({ NotebookLibrary: () => null }));
vi.mock("./components/notebooks/NotebookPanel", () => ({ NotebookPanel: () => null }));
vi.mock("./components/StatusFooter", () => ({ StatusFooter: () => null }));
vi.mock("./components/UpdateNotification", () => ({ UpdateNotification: () => null }));
vi.mock("./components/api/ApiTab", () => ({ ApiTab: () => null }));
vi.mock("./components/netconf/NetconfTab", () => ({ NetconfTab: () => null }));
vi.mock("./components/PaneContainer", () => ({ PaneContainer: () => <div data-testid="registry-pane" /> }));
vi.mock("./components/Terminal", () => ({ Terminal: () => <div data-testid="legacy-terminal" /> }));
vi.mock("./components/SavedSSHConnectionsModal", () => ({ SavedSSHConnectionsModal: () => null }));
vi.mock("./components/SerialConsolePanel", () => ({ SerialConsolePanel: () => null }));
vi.mock("./components/SftpPanel", () => ({ SftpPanel: () => null }));
vi.mock("./components/RecentlyClosedModal", () => ({ RecentlyClosedModal: () => null }));
vi.mock("./components/ChangeWindowPanel", () => ({ ChangeWindowPanel: () => null }));
vi.mock("./components/FanoutPanel", () => ({ FanoutPanel: () => null }));
vi.mock("./components/FanoutGroupsPanel", () => ({ FanoutGroupsPanel: () => null }));
vi.mock("./components/BrowserUrlModal", () => ({ default: () => null }));
vi.mock("./components/DriftSidebar", () => ({ DriftSidebar: () => null }));
vi.mock("./components/BlastRadius/BlastRadiusHost", () => ({ BlastRadiusHost: () => null }));
vi.mock("./components/BlastRadius/RuleEditor", () => ({ RuleEditor: () => null }));
vi.mock("./components/BlastRadius/DecisionLogView", () => ({ DecisionLogView: () => null }));
vi.mock("./components/IntentEditor", () => ({ IntentEditor: () => null }));
vi.mock("./components/PcapPanel", () => ({ PcapPanel: () => null }));
vi.mock("./components/DiagramPanel", () => ({ DiagramPanel: () => null }));
vi.mock("./components/help/HelpModal", () => ({ HelpModal: () => null }));
vi.mock("./components/StateDrawer", () => ({ StateDrawer: () => null }));
vi.mock("./components/MetadataCard", () => ({ default: () => null }));
vi.mock("./components/RichInputModal", () => ({ default: () => null }));
vi.mock("./components/HeartbeatTab", () => ({ HeartbeatTab: () => null }));
vi.mock("./components/KanbanTab", () => ({ KanbanTab: () => null }));

const connection: SshConnection = {
  id: "synthetic-saved-ssh", name: "Synthetic saved switch", host: "switch.example.test", user: "operator", port: 2222,
  identity_file: null, password_encrypted: "fake-encrypted", folder_id: "root", tags: [],
  accent_color: null, vendor: "generic", platform: "generic", syntax_highlighting_enabled: false,
  syntax_profile: "auto", created_at: 0, last_used_at: null,
};
let ready: (id: string) => void;
let fail: (error: Error) => void;
let entry: Pick<TerminalEntry, "ptyTabId" | "disposed" | "_ptySpawnPromise">;
let opts: CreateOpts;
const sshEvents: SshConnectEventDetail[] = [];
const onSsh = (event: Event) => sshEvents.push((event as CustomEvent<SshConnectEventDetail>).detail);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "alert").mockImplementation(() => {});
  h.callbacks = {};
  h.platform = "macos";
  useTabs.setState({ tabs: [{ id: "topology", title: "Topology", tab_type: "topology", shell_cmd: "", cwd: "/", created_at: 0 }], activeTabId: "topology" });
  usePanesStore.setState({ layoutsByTab: new Map(), focusedPaneId: null });
  useNetconfRunner.setState({ tabs: {}, savedDevices: [] });
  useTerminalConnectionStore.setState({ byTerminalId: {}, terminalIdByBackendPtyId: {} });
  h.invoke.mockImplementation(async (command: string) => {
    if (command === "restore_last_session") return new Promise(() => {}); // Boot restore must not create unrelated PTYs.
    if (command === "ssh_list_connections") return [connection];
    if (command === "ssh_decrypt_password") return "fake-password";
    if (command === "netconf_device_list") return [{ id: 42, name: "Saved NETCONF", host: connection.host, port: 1830, username: "operator" }];
    if (command === "netconf_device_get_password") return "fake-password";
    if (command === "tab_new_netconf") return { id: "netconf", title: "Saved NETCONF", tab_type: "netconf", shell_cmd: "", cwd: "/", created_at: 0 };
    return null;
  });
  h.getOrCreate.mockImplementation((_id: string, options: CreateOpts) => {
    opts = options;
    entry = { ptyTabId: null, disposed: false };
    entry._ptySpawnPromise = new Promise<string>((resolve, reject) => {
      ready = (id) => {
        if (!entry.disposed) { entry.ptyTabId = id; options.onPtyReady?.(id); }
        resolve(id);
      };
      fail = reject;
    });
    return entry;
  });
  sshEvents.length = 0;
  window.addEventListener("ssh-connect", onSsh);
});
afterEach(() => {
  cleanup();
  window.removeEventListener("ssh-connect", onSsh);
  vi.restoreAllMocks();
});

async function mount() {
  const view = render(<App />);
  await waitFor(() => expect(h.callbacks.onOpenSshTab).toBeTypeOf("function"));
  expect(h.callbacks.onOpenNetconfTab).toBeTypeOf("function");
  return view;
}

describe("App topology opener integration", () => {
  it("dispatches only to the new ready PTY, creates one terminal, and never broadcasts to the existing terminal", async () => {
    await mount();
    let opening: Promise<void> | void;
    let completed = false;
    act(() => { opening = h.callbacks.onOpenSshTab!(connection.host); Promise.resolve(opening).then(() => { completed = true; }); });
    await waitFor(() => expect(h.getOrCreate).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    expect(sshEvents).toEqual([]);
    const id = h.getOrCreate.mock.calls[0][0] as string;
    expect(opts).toMatchObject({ preferredTabId: id, skipTabRegistration: true });
    await act(async () => { ready(id); await opening; });
    expect(sshEvents).toHaveLength(1);
    expect(sshEvents[0]).toMatchObject({ targetTabId: id, credentials: { host: connection.host, password: "fake-password" } });
    expect(sshEvents[0].command).not.toContain("fake-password");
    expect(useTabs.getState().tabs.filter(tab => tab.tab_type === "terminal")).toHaveLength(1);
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.runWhenReady).not.toHaveBeenCalled();
    expect(h.dispose).not.toHaveBeenCalled();
  });

  it("uses Windows managedConnectionId with no shell SSH event", async () => {
    h.platform = "windows";
    await mount();
    let opening: Promise<void> | void;
    act(() => { opening = h.callbacks.onOpenSshTab!(connection.host); });
    await waitFor(() => expect(h.getOrCreate).toHaveBeenCalledTimes(1));
    const id = h.getOrCreate.mock.calls[0][0] as string;
    expect(opts.managedConnectionId).toBe(connection.id);
    expect(useTerminalConnectionStore.getState().get(id)).toMatchObject({ managed: true, connection_id: connection.id });
    await act(async () => { ready(id); await opening; });
    expect(sshEvents).toEqual([]);
    expect(useTabs.getState().tabs.find(tab => tab.id === id)?.shell_cmd).toBe(MANAGED_SSH_SHELL_MARKER);
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it.each(["macos", "windows"])("rejects failed %s spawns without registering a tab/slot, legacy fallback or duplicate PTY", async (platform) => {
    h.platform = platform;
    const addTab = vi.spyOn(useTabs.getState(), "addTab");
    const loadLayout = vi.spyOn(usePanesStore.getState(), "loadLayoutForTab");
    const view = await mount();
    let opening: Promise<void>;
    act(() => { opening = Promise.resolve(h.callbacks.onOpenSshTab!(connection.host)); });
    await waitFor(() => expect(h.getOrCreate).toHaveBeenCalledTimes(1));
    await act(async () => {
      const rejected = expect(opening!).rejects.toThrow("SSH terminal could not be opened.");
      fail(new Error("fake-secret-error"));
      await rejected;
    });
    expect(sshEvents).toEqual([]);
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledExactlyOnceWith(h.getOrCreate.mock.calls[0][0]);
    expect(addTab).not.toHaveBeenCalled();
    expect(loadLayout).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs.filter(tab => tab.tab_type === "terminal")).toHaveLength(0);
    expect(useTabs.getState().activeTabId).toBe("topology");
    expect(view.queryByTestId("registry-pane")).not.toBeInTheDocument();
    expect(view.queryByTestId("legacy-terminal")).not.toBeInTheDocument();
    expect(h.invoke.mock.calls.some(([command]) => command === "ssh_mark_used")).toBe(false);
    expect(window.alert).toHaveBeenCalledExactlyOnceWith("SSH terminal could not be opened.");
  });

  it.each(["macos", "windows"])("rejects synchronous %s construction failure without a second create path", async (platform) => {
    h.platform = platform;
    h.getOrCreate.mockImplementationOnce(() => { throw new Error("fake-secret-error"); });
    const view = await mount();
    await act(async () => {
      await expect(h.callbacks.onOpenSshTab!(connection.host)).rejects.toThrow("SSH terminal could not be opened.");
    });
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs.filter(tab => tab.tab_type === "terminal")).toHaveLength(0);
    expect(window.alert).toHaveBeenCalledExactlyOnceWith("SSH terminal could not be opened.");
    expect(view.queryByTestId("legacy-terminal")).not.toBeInTheDocument();
    expect(sshEvents).toEqual([]);
  });

  it.each(["macos", "windows"])("cleans up a disposed pending %s launch instead of claiming it opened or emitting an SSH event", async (platform) => {
    h.platform = platform;
    await mount();
    let opening: Promise<void>;
    act(() => { opening = Promise.resolve(h.callbacks.onOpenSshTab!(connection.host)); });
    await waitFor(() => expect(h.getOrCreate).toHaveBeenCalledTimes(1));
    await act(async () => {
      entry.disposed = true;
      const rejected = expect(opening!).rejects.toThrow("SSH terminal could not be opened.");
      ready(h.getOrCreate.mock.calls[0][0] as string);
      await rejected;
    });
    expect(sshEvents).toEqual([]);
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledExactlyOnceWith(h.getOrCreate.mock.calls[0][0]);
    expect(useTabs.getState().tabs.filter(tab => tab.tab_type === "terminal")).toHaveLength(0);
    expect(useTabs.getState().activeTabId).toBe("topology");
  });

  it("wires explicit NETCONF to a populated disconnected tab without creating a terminal or connecting", async () => {
    await mount();
    await act(async () => { await h.callbacks.onOpenNetconfTab!(connection.host); });
    expect(useTabs.getState().activeTabId).toBe("netconf");
    expect(useNetconfRunner.getState().tabs.netconf).toMatchObject({ host: connection.host, port: 1830, selected_device_id: 42, status: "disconnected" });
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.invoke.mock.calls.some(([command]) => command === "netconf_connect")).toBe(false);
  });
});

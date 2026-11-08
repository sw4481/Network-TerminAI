import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopologyOpeners } from "./topologyOpeners";
import { sshDecryptPassword, sshListConnections, sshMarkUsed, type SshConnection } from "./sshConnections";
import { netconfConnect, netconfDeviceGetPassword, netconfDeviceList, tabNewNetconf, type SavedNetconfDevice } from "./tauri";
import { useNetconfRunner } from "../state/netconfRunnerStore";

vi.mock("./sshConnections", async (original) => ({
  ...await original<typeof import("./sshConnections")>(),
  sshListConnections: vi.fn(), sshDecryptPassword: vi.fn(), sshMarkUsed: vi.fn(),
}));
vi.mock("./tauri", () => ({
  netconfDeviceList: vi.fn(), netconfDeviceGetPassword: vi.fn(),
  tabNewNetconf: vi.fn(), netconfConnect: vi.fn(),
}));

const ssh: SshConnection = {
  id: "saved-ssh", name: "Synthetic switch", host: "switch.example.test", user: "operator", port: 2222,
  identity_file: null, password_encrypted: "fake-encrypted", folder_id: "root", tags: [],
  accent_color: null, vendor: "generic", platform: "generic", syntax_highlighting_enabled: false,
  syntax_profile: "auto", created_at: 0, last_used_at: null,
};
const netconf: SavedNetconfDevice = {
  id: 42, name: "Synthetic NETCONF", host: ssh.host, port: 1830, username: "operator",
  verify_host_key: true, created_at: "",
};
const tab = { id: "new-netconf-tab", title: netconf.name, tab_type: "netconf" as const, shell_cmd: "", cwd: "/", created_at: 0 };
const seed = vi.fn<ConstructorParameters<typeof TopologyOpeners>[0]>();
const addTab = vi.fn<ConstructorParameters<typeof TopologyOpeners>[1]>();
let openers: TopologyOpeners;

beforeEach(() => {
  vi.resetAllMocks();
  useNetconfRunner.setState({ tabs: {}, savedDevices: [] });
  vi.mocked(sshListConnections).mockResolvedValue([ssh]);
  vi.mocked(sshDecryptPassword).mockResolvedValue("fake-password");
  vi.mocked(sshMarkUsed).mockResolvedValue();
  vi.mocked(netconfDeviceList).mockResolvedValue([netconf]);
  vi.mocked(netconfDeviceGetPassword).mockResolvedValue("fake-password");
  vi.mocked(tabNewNetconf).mockResolvedValue(tab);
  seed.mockResolvedValue();
  openers = new TopologyOpeners(seed, addTab);
});

describe("topology SSH opener", () => {
  it("opens exactly one saved profile and marks it used without putting a password in the command", async () => {
    await openers.openSsh(ssh.host);
    expect(seed).toHaveBeenCalledExactlyOnceWith({ savedSsh: { connection: ssh, password: "fake-password" } });
    expect(sshDecryptPassword).toHaveBeenCalledExactlyOnceWith("fake-encrypted");
    expect(sshMarkUsed).toHaveBeenCalledExactlyOnceWith(ssh.id);
    const detail = TopologyOpeners.sshConnectDetail(ssh, "fake-password", "ready-pty");
    expect(detail.targetTabId).toBe("ready-pty");
    expect(detail.command).toContain("-p 2222");
    expect(detail.command).not.toContain("fake-password");
    expect(detail.connection).not.toHaveProperty("password_encrypted");
    expect(detail.credentials).toEqual({ host: ssh.host, user: ssh.user, password: "fake-password" });
  });

  it.each([[], [{ ...ssh, host: "switch" }], [{ ...ssh, host: "SWITCH.EXAMPLE.TEST" }]].map(profiles => ({ profiles })))("rejects absent/non-exact profiles before opening: $profiles", async ({ profiles }) => {
    vi.mocked(sshListConnections).mockResolvedValue(profiles);
    await expect(openers.openSsh(ssh.host)).rejects.toThrow("No saved SSH profile matches this host.");
    expect(seed).not.toHaveBeenCalled();
    expect(sshDecryptPassword).not.toHaveBeenCalled();
  });

  it.each([{ ...ssh, id: "other", user: "other-user" }, { ...ssh, id: "other", port: 22 }])("rejects ambiguous exact hosts without choosing a user/port", async (other) => {
    vi.mocked(sshListConnections).mockResolvedValue([ssh, other]);
    await expect(openers.openSsh(ssh.host)).rejects.toThrow("Multiple saved SSH profiles match this host.");
    expect(seed).not.toHaveBeenCalled();
    expect(sshDecryptPassword).not.toHaveBeenCalled();
  });

  it.each(["absent", "decrypt-failure", "null"])("allows interactive password entry when saved password is %s", async (kind) => {
    if (kind === "absent") vi.mocked(sshListConnections).mockResolvedValue([{ ...ssh, password_encrypted: null }]);
    if (kind === "decrypt-failure") vi.mocked(sshDecryptPassword).mockRejectedValue(new Error("fake-secret-error"));
    if (kind === "null") vi.mocked(sshDecryptPassword).mockResolvedValue(null);
    await openers.openSsh(ssh.host);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed.mock.calls[0][0].savedSsh.password).toBeNull();
  });

  it("propagates sanitized spawn failure without a second seed or a successful usage mark", async () => {
    seed.mockRejectedValue(new Error("fake-secret-error"));
    await expect(openers.openSsh(ssh.host)).rejects.toThrow("SSH terminal could not be opened.");
    expect(seed).toHaveBeenCalledTimes(1);
    expect(sshMarkUsed).not.toHaveBeenCalled();
  });

  it("sanitizes listing errors and treats usage bookkeeping as best effort", async () => {
    vi.mocked(sshListConnections).mockRejectedValueOnce(new Error("fake-secret-error"));
    await expect(openers.openSsh(ssh.host)).rejects.toThrow("Saved SSH profiles could not be loaded.");
    expect(seed).not.toHaveBeenCalled();
    vi.mocked(sshMarkUsed).mockRejectedValueOnce(new Error("fake-secret-error"));
    await expect(openers.openSsh(ssh.host)).resolves.toBeUndefined();
    expect(seed).toHaveBeenCalledTimes(1);
  });
});

describe("topology NETCONF opener", () => {
  it("creates one prefilled disconnected tab with the saved ID, leaving Connect operator-driven", async () => {
    addTab.mockImplementation((created) => {
      expect(useNetconfRunner.getState().tabs[created.id]).toMatchObject({ host: netconf.host, selected_device_id: 42 });
    });
    await openers.openNetconf(netconf.host);
    expect(netconfDeviceGetPassword).toHaveBeenCalledExactlyOnceWith(42);
    expect(tabNewNetconf).toHaveBeenCalledExactlyOnceWith({ title: netconf.name });
    expect(addTab).toHaveBeenCalledExactlyOnceWith(tab);
    expect(useNetconfRunner.getState().tabs[tab.id]).toMatchObject({
      host: netconf.host, port: 1830, username: "operator", password: "fake-password",
      device_name: netconf.name, selected_device_id: 42, status: "disconnected", connection_error: null,
    });
    expect(netconfConnect).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it.each(["failure", "empty"])("prefills fields with a visible missing-password message on %s", async (kind) => {
    if (kind === "failure") vi.mocked(netconfDeviceGetPassword).mockRejectedValue(new Error("fake-secret-error"));
    else vi.mocked(netconfDeviceGetPassword).mockResolvedValue("");
    await openers.openNetconf(netconf.host);
    expect(useNetconfRunner.getState().tabs[tab.id]).toMatchObject({
      host: netconf.host, password: "", selected_device_id: 42, status: "disconnected",
      connection_error: "Password not found - please enter it below",
    });
    expect(netconfConnect).not.toHaveBeenCalled();
  });

  it.each([[], [{ ...netconf, host: "switch" }], [netconf, { ...netconf, id: 43, username: "other-user" }]].map(profiles => ({ profiles })))("rejects absent or ambiguous exact hosts before password/tab creation", async ({ profiles }) => {
    vi.mocked(netconfDeviceList).mockResolvedValue(profiles);
    await expect(openers.openNetconf(netconf.host)).rejects.toThrow(profiles.length > 1
      ? "Multiple saved NETCONF profiles match this host." : "No saved NETCONF profile matches this host.");
    expect(netconfDeviceGetPassword).not.toHaveBeenCalled();
    expect(tabNewNetconf).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it("does not fall back to SSH for an explicit NETCONF request", async () => {
    vi.mocked(netconfDeviceList).mockResolvedValue([]);
    await expect(openers.openNetconf(ssh.host)).rejects.toThrow("No saved NETCONF profile matches this host.");
    expect(sshListConnections).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it("sanitizes listing and tab creation failures without creating a blank/second tab", async () => {
    vi.mocked(netconfDeviceList).mockRejectedValueOnce(new Error("fake-secret-error"));
    await expect(openers.openNetconf(netconf.host)).rejects.toThrow("Saved NETCONF profiles could not be loaded.");
    expect(tabNewNetconf).not.toHaveBeenCalled();
    vi.mocked(tabNewNetconf).mockRejectedValueOnce(new Error("fake-secret-error"));
    await expect(openers.openNetconf(netconf.host)).rejects.toThrow("NETCONF tab could not be opened.");
    expect(tabNewNetconf).toHaveBeenCalledTimes(1);
    expect(addTab).not.toHaveBeenCalled();
  });
});

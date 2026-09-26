import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const terminalLaunchSavedSshMock = vi.hoisted(() => vi.fn(async () => undefined));
const ptyTabIdForMock = vi.hoisted(() => vi.fn(() => "pty-live"));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./tauri", () => ({ terminalLaunchSavedSsh: terminalLaunchSavedSshMock }));
vi.mock("./terminalRegistry", () => ({ ptyTabIdFor: ptyTabIdForMock }));

import { reconnectSavedSsh, useLocalShell } from "./sshReconnect";
import { useSshPasswordStore } from "../state/sshPasswordStore";
import { useTerminalConnectionStore } from "../state/terminalConnectionStore";

const LATEST_CONNECTION = {
  id: "connection-1",
  name: "Core Renamed",
  host: "core-new.example",
  user: "netops",
  port: 2222,
  identity_file: "/keys/new",
  password_encrypted: "encrypted",
  folder_id: "root",
  tags: ["core"],
  accent_color: "purple",
  vendor: "cisco",
  platform: "iosxe",
  syntax_highlighting_enabled: true,
  syntax_profile: "auto",
  created_at: 1,
  last_used_at: null,
};

function bindDisconnected() {
  useTerminalConnectionStore.getState().bind({
    terminalId: "stable-terminal",
    backendPtyId: "pty-live",
    connectionId: "connection-1",
    displayName: "Old Name",
    vendor: "generic",
    platform: "generic",
    accentColor: null,
    syntaxHighlightingEnabled: false,
    syntaxProfile: "auto",
    sshCommand: "ssh old.example",
    lifecycle: "connecting",
  });
  useTerminalConnectionStore.getState().setLifecycle("stable-terminal", "disconnected", {
    exitStatus: 255,
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  terminalLaunchSavedSshMock.mockReset().mockResolvedValue(undefined);
  ptyTabIdForMock.mockClear().mockReturnValue("pty-live");
  useTerminalConnectionStore.setState({ byTerminalId: {}, terminalIdByBackendPtyId: {} });
  useSshPasswordStore.setState({ contexts: new Map() });
  bindDisconnected();
});

describe("in-place saved SSH reconnect", () => {
  it("reloads the latest saved connection and asks Rust to launch it in the same backend PTY", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ssh_get_connection") return Promise.resolve(LATEST_CONNECTION);
      if (command === "ssh_decrypt_password") return Promise.resolve("new-password");
      if (command === "ssh_mark_used") return Promise.resolve(undefined);
      throw new Error(`unexpected command ${command}`);
    });

    expect(await reconnectSavedSsh("stable-terminal")).toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("ssh_get_connection", { id: "connection-1" });
    expect(terminalLaunchSavedSshMock).toHaveBeenCalledWith("pty-live", "connection-1");
    expect(useTerminalConnectionStore.getState().get("stable-terminal")).toMatchObject({
      terminal_id: "stable-terminal",
      backend_pty_id: "pty-live",
      display_name: "Core Renamed",
      lifecycle: "reconnecting",
    });
    expect(useSshPasswordStore.getState().getPasswordContext("pty-live")?.password)
      .toBe("new-password");
  });

  it("permits only one attempt while a reload is in progress", async () => {
    let resolveConnection!: (value: typeof LATEST_CONNECTION) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "ssh_get_connection") {
        return new Promise((resolve) => { resolveConnection = resolve; });
      }
      if (command === "ssh_decrypt_password") return Promise.resolve(null);
      if (command === "ssh_mark_used") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const first = reconnectSavedSsh("stable-terminal");
    expect(await reconnectSavedSsh("stable-terminal")).toBe(false);
    expect(invokeMock.mock.calls.filter(([command]) => command === "ssh_get_connection"))
      .toHaveLength(1);
    resolveConnection({ ...LATEST_CONNECTION, password_encrypted: null });
    expect(await first).toBe(true);
  });

  it("keeps a recoverable error when the saved connection was deleted", async () => {
    invokeMock.mockRejectedValue(new Error("SSH connection not found"));
    expect(await reconnectSavedSsh("stable-terminal")).toBe(false);
    expect(useTerminalConnectionStore.getState().get("stable-terminal")).toMatchObject({
      lifecycle: "error",
      error: expect.stringContaining("no longer exists"),
    });
    useLocalShell("stable-terminal");
    expect(useTerminalConnectionStore.getState().get("stable-terminal")).toBeNull();
  });

  it("clears the transient password context when the reconnect write fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ssh_get_connection") return Promise.resolve(LATEST_CONNECTION);
      if (command === "ssh_decrypt_password") return Promise.resolve("new-password");
      if (command === "ssh_mark_used") return Promise.resolve(undefined);
      throw new Error(`unexpected command ${command}`);
    });
    terminalLaunchSavedSshMock.mockRejectedValueOnce(new Error("launch failed"));

    expect(await reconnectSavedSsh("stable-terminal")).toBe(false);
    expect(useSshPasswordStore.getState().getPasswordContext("pty-live")).toBeNull();
    expect(useTerminalConnectionStore.getState().get("stable-terminal")).toMatchObject({
      lifecycle: "error",
    });
  });
});

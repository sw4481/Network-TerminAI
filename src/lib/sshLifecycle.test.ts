import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalConnectionStore } from "../state/terminalConnectionStore";
import { handleSavedSshCommandEnd, handleSavedSshCommandStart } from "./sshLifecycle";

beforeEach(() => {
  useTerminalConnectionStore.setState({ byTerminalId: {}, terminalIdByBackendPtyId: {} });
  useTerminalConnectionStore.getState().bind({
    terminalId: "stable",
    backendPtyId: "pty",
    connectionId: "connection",
    displayName: "Core",
    vendor: "cisco",
    platform: "iosxe",
    accentColor: null,
    syntaxHighlightingEnabled: true,
    syntaxProfile: "auto",
    sshCommand: "ssh admin@core",
  });
});

describe("saved SSH command lifecycle", () => {
  it("uses matching shell command events as lifecycle authority", () => {
    expect(handleSavedSshCommandStart("pty", " ssh admin@core \r")).toBe(true);
    expect(useTerminalConnectionStore.getState().get("stable")?.lifecycle).toBe("connected");
    expect(handleSavedSshCommandEnd("stable", "ssh admin@core", 255)).toBe(true);
    expect(useTerminalConnectionStore.getState().get("stable")).toMatchObject({
      lifecycle: "disconnected",
      exit_status: 255,
    });
  });

  it("ignores unrelated local commands", () => {
    expect(handleSavedSshCommandStart("stable", "show version")).toBe(false);
    expect(handleSavedSshCommandEnd("stable", "show version", 0)).toBe(false);
    expect(useTerminalConnectionStore.getState().get("stable")?.lifecycle).toBe("connecting");
  });
});

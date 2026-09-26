import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalConnectionStore } from "./terminalConnectionStore";

beforeEach(() => {
  useTerminalConnectionStore.setState({ byTerminalId: {}, terminalIdByBackendPtyId: {} });
});

describe("terminalConnectionStore", () => {
  it("indexes safe connection metadata by stable terminal and backend PTY IDs", () => {
    useTerminalConnectionStore.getState().bind({
      terminalId: "stable-1",
      backendPtyId: "pty-1",
      connectionId: "connection-1",
      displayName: "Core",
      vendor: "cisco",
      platform: "iosxe",
      accentColor: "cyan",
      syntaxHighlightingEnabled: true,
      syntaxProfile: "auto",
      sshCommand: "ssh admin@core",
    });
    expect(useTerminalConnectionStore.getState().get("stable-1")).toEqual(
      useTerminalConnectionStore.getState().get("pty-1"),
    );
    expect(JSON.stringify(useTerminalConnectionStore.getState().get("pty-1"))).not.toContain("password");
  });

  it("keeps split-pane metadata isolated and updates live sessions by connection ID", () => {
    const bind = useTerminalConnectionStore.getState().bind;
    bind({
      terminalId: "left", backendPtyId: "pty-left", connectionId: "a", displayName: "Left",
      vendor: "cisco", platform: "iosxe", accentColor: "blue",
      syntaxHighlightingEnabled: true, syntaxProfile: "cisco", sshCommand: "ssh left",
    });
    bind({
      terminalId: "right", backendPtyId: "pty-right", connectionId: "b", displayName: "Right",
      vendor: "juniper", platform: "junos", accentColor: "pink",
      syntaxHighlightingEnabled: true, syntaxProfile: "auto", sshCommand: "ssh right",
    });
    useTerminalConnectionStore.getState().updateConnectionMetadata("b", {
      display_name: "Right Updated", vendor: "arista", platform: "eos", accent_color: "green",
      syntax_highlighting_enabled: false, syntax_profile: "generic",
    });
    expect(useTerminalConnectionStore.getState().get("left")?.display_name).toBe("Left");
    expect(useTerminalConnectionStore.getState().get("right")).toMatchObject({
      display_name: "Right Updated", vendor: "arista", accent_color: "green",
      syntax_highlighting_enabled: false, syntax_profile: "generic",
    });
  });
});

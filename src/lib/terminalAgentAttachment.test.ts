import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaneNode } from "../state/panesStore";
import type { TerminalConnectionState } from "../state/terminalConnectionStore";
import {
  parseTerminalAttachmentRequest,
  resolveTerminalAttachment,
} from "./terminalAgentAttachment";

const splitLayout: PaneNode = {
  type: "split",
  id: "split-1",
  direction: "horizontal",
  size: 100,
  children: [
    { type: "leaf", id: "pane-left", terminalId: "pty-left", size: 50 },
    { type: "leaf", id: "pane-right", terminalId: "pty-right", size: 50 },
  ],
};

const connectedSsh: TerminalConnectionState = {
  terminal_id: "pty-right",
  backend_pty_id: "backend-right",
  connection_id: "ssh-connection-7",
  display_name: "Access switch 7",
  vendor: "cisco",
  platform: "iosxe",
  accent_color: null,
  syntax_highlighting_enabled: true,
  syntax_profile: "cisco",
  lifecycle: "connected",
  ssh_command: "ssh operator@switch.example",
  exit_status: null,
  error: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseTerminalAttachmentRequest", () => {
  it("keeps ordinary questions detached by default", () => {
    expect(parseTerminalAttachmentRequest("Why is RADIUS down?", false)).toEqual({
      message: "Why is RADIUS down?",
      requested: false,
    });
  });

  it("strips a terminal prefix and opts in for that turn", () => {
    expect(parseTerminalAttachmentRequest("/terminal   Why is RADIUS down?", false)).toEqual({
      message: "Why is RADIUS down?",
      requested: true,
    });
  });

  it("honors the attachment chip without changing the message", () => {
    expect(parseTerminalAttachmentRequest("Check this switch", true)).toEqual({
      message: "Check this switch",
      requested: true,
    });
  });
});

describe("resolveTerminalAttachment", () => {
  it("locks the focused split pane backend PTY and non-secret saved identity on macOS", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    const attachment = resolveTerminalAttachment({
      agentId: "network-architect",
      requested: true,
      focusedPaneId: "pane-right",
      layout: splitLayout,
      connectionsByTerminalId: { "pty-right": connectedSsh },
      backendPtyIdFor: () => "backend-right",
    });

    expect(attachment).toEqual({
      backendPtyId: "backend-right",
      terminalId: "pty-right",
      source: "saved_ssh",
      connectionId: "ssh-connection-7",
      displayName: "Access switch 7",
      vendor: "cisco",
      platform: "iosxe",
    });
  });

  it("keeps the focused managed Windows SSH binding and backend PTY identity", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32" });
    const backendPtyIdFor = vi.fn((id: string) => id === "pty-right" ? "backend-right" : "backend-left");

    expect(resolveTerminalAttachment({
      agentId: "network-architect",
      requested: true,
      focusedPaneId: "pane-right",
      layout: splitLayout,
      connectionsByTerminalId: { "pty-right": { ...connectedSsh, managed: true } },
      backendPtyIdFor,
    })).toEqual({
      backendPtyId: "backend-right",
      terminalId: "pty-right",
      source: "saved_ssh",
      connectionId: "ssh-connection-7",
      displayName: "Access switch 7",
      vendor: "cisco",
      platform: "iosxe",
    });
    expect(backendPtyIdFor).toHaveBeenCalledExactlyOnceWith("pty-right");
  });

  it("retains manual attachment for unmanaged Windows SSH", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32" });

    const attachment = resolveTerminalAttachment({
      agentId: "network-architect",
      requested: true,
      focusedPaneId: "pane-right",
      layout: splitLayout,
      connectionsByTerminalId: { "pty-right": { ...connectedSsh, managed: false } },
      backendPtyIdFor: () => "backend-right",
    });

    expect(attachment).toEqual({
      backendPtyId: "backend-right",
      terminalId: "pty-right",
      source: "manual_ssh",
    });
  });

  it("retains manual attachment for managed SSH on Linux", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Linux x86_64" });
    expect(resolveTerminalAttachment({
      agentId: "network-architect",
      requested: true,
      focusedPaneId: "pane-right",
      layout: splitLayout,
      connectionsByTerminalId: { "pty-right": { ...connectedSsh, managed: true } },
      backendPtyIdFor: () => "backend-right",
    })).toEqual({ backendPtyId: "backend-right", terminalId: "pty-right", source: "manual_ssh" });
  });

  it("never grants terminal authority to another agent", () => {
    expect(resolveTerminalAttachment({
      agentId: "ise",
      requested: true,
      focusedPaneId: "pane-right",
      layout: splitLayout,
      connectionsByTerminalId: { "pty-right": connectedSsh },
      backendPtyIdFor: () => "backend-right",
    })).toBeNull();
  });

  it("rejects pending or disconnected managed Windows SSH before send", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32" });
    for (const lifecycle of ["connecting", "disconnected"] as const) {
      expect(() => resolveTerminalAttachment({
        agentId: "network-architect",
        requested: true,
        focusedPaneId: "pane-right",
        layout: splitLayout,
        connectionsByTerminalId: {
          "pty-right": { ...connectedSsh, managed: true, lifecycle },
        },
        backendPtyIdFor: () => "backend-right",
      })).toThrow("connected SSH terminal");
    }
  });

  it("does not borrow a managed Windows binding from the other split pane", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32" });
    expect(resolveTerminalAttachment({
      agentId: "network-architect",
      requested: true,
      focusedPaneId: "pane-left",
      layout: splitLayout,
      connectionsByTerminalId: { "pty-right": { ...connectedSsh, managed: true } },
      backendPtyIdFor: (id) => id,
    })).toEqual({
      backendPtyId: "pty-left",
      terminalId: "pty-left",
      source: "manual_ssh",
    });
  });
});

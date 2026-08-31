import { describe, expect, it } from "vitest";
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
  it("locks the focused split pane backend PTY and non-secret saved identity", () => {
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

  it("rejects a disconnected saved SSH session before send", () => {
    expect(() => resolveTerminalAttachment({
      agentId: "network-architect",
      requested: true,
      focusedPaneId: "pane-right",
      layout: splitLayout,
      connectionsByTerminalId: {
        "pty-right": { ...connectedSsh, lifecycle: "disconnected" },
      },
      backendPtyIdFor: () => "backend-right",
    })).toThrow("connected SSH terminal");
  });

  it("permits a manual terminal candidate for host-side SSH verification", () => {
    expect(resolveTerminalAttachment({
      agentId: "network-architect",
      requested: true,
      focusedPaneId: "pane-left",
      layout: splitLayout,
      connectionsByTerminalId: {},
      backendPtyIdFor: (id) => id,
    })).toEqual({
      backendPtyId: "pty-left",
      terminalId: "pty-left",
      source: "manual_ssh",
    });
  });
});

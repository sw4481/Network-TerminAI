import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class<T> {
    onmessage?: (event: T) => void;
  },
}));

import {
  agentReactCodeRun,
  agentReactResume,
  agentTerminalApproveFix,
  agentTerminalCancel,
  agentTerminalPreviewFixEdit,
  terminalLaunchSavedSsh,
} from "./tauri";

describe("agentReactCodeRun terminal attachment", () => {
  beforeEach(() => invokeMock.mockClear());

  it("passes the one-turn locked PTY attachment to Rust", async () => {
    await agentReactCodeRun({
      agentId: "network-architect",
      message: "Why is RADIUS down?",
      history: [],
      terminalAttachment: {
        backendPtyId: "pty-7",
        terminalId: "pane-terminal-7",
        source: "saved_ssh",
        connectionId: "connection-7",
        displayName: "Access 7",
        vendor: "cisco",
        platform: "iosxe",
      },
      onEvent: () => undefined,
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "agent_react_code_run",
      expect.objectContaining({
        terminalAttachment: expect.objectContaining({
          backendPtyId: "pty-7",
          connectionId: "connection-7",
        }),
      }),
    );
  });

  it("registers a saved SSH launch with the backend PTY authority", async () => {
    await terminalLaunchSavedSsh("pty-7", "connection-7");

    expect(invokeMock).toHaveBeenCalledWith("terminal_launch_saved_ssh", {
      tabId: "pty-7",
      connectionId: "connection-7",
    });
  });

  it("re-reviews and approves an exact edited batch without exposing a capability", async () => {
    const batch = {
      summary: "Fix source interface",
      commands: ["ip radius source-interface Vlan20"],
      verification_commands: ["show aaa servers"],
      rollback_commands: ["no ip radius source-interface Vlan20"],
    };
    await agentTerminalPreviewFixEdit({ leaseId: "lease-7", batch });
    await agentTerminalApproveFix({ leaseId: "lease-7", digest: "digest-7", batch });
    await agentReactResume({
      threadId: "turn-7",
      decision: "edit",
      editedAction: { name: "terminal_apply_fix", args: batch },
      onEvent: () => undefined,
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "agent_terminal_preview_fix_edit",
      { leaseId: "lease-7", batch },
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "agent_terminal_approve_fix",
      { leaseId: "lease-7", digest: "digest-7", batch },
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "agent_react_resume",
      expect.objectContaining({
        threadId: "turn-7",
        decision: "edit",
        editedAction: { name: "terminal_apply_fix", args: batch },
      }),
    );
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain("capability");
  });

  it("cancels terminal control using only the public lease id", async () => {
    await agentTerminalCancel("lease-7");
    expect(invokeMock).toHaveBeenCalledWith("agent_terminal_cancel", {
      leaseId: "lease-7",
    });
  });
});

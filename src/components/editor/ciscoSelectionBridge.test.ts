import { describe, expect, it, vi } from "vitest";
import type { ClassifyResponse } from "../../lib/guardrails";
import type { TerminalConnectionState } from "../../state/terminalConnectionStore";
import {
  listConnectedCiscoTargets,
  sendSelectionToCisco,
  type CiscoSelectionTarget,
} from "./ciscoSelectionBridge";

function connection(
  overrides: Partial<TerminalConnectionState> = {},
): TerminalConnectionState {
  return {
    terminal_id: "terminal-1",
    backend_pty_id: "pty-1",
    connection_id: "connection-1",
    display_name: "Core",
    vendor: "cisco",
    platform: "iosxe",
    accent_color: "cyan",
    syntax_highlighting_enabled: true,
    syntax_profile: "cisco",
    lifecycle: "connected",
    ssh_command: "ssh core",
    exit_status: null,
    error: null,
    ...overrides,
  };
}

const target: CiscoSelectionTarget = {
  terminalId: "terminal-1",
  backendPtyId: "pty-1",
  displayName: "Core",
  vendor: "cisco",
  platform: "iosxe",
};

const t0 = (reasoning = "Read-only"): ClassifyResponse => ({
  tier: "T0",
  rule_id: "show-rule",
  reasoning,
});

describe("ciscoSelectionBridge", () => {
  it("keeps only connected Cisco targets with real PTY ids", () => {
    const state = {
      byTerminalId: {
        allowed: connection({
          terminal_id: "allowed",
          backend_pty_id: "pty-allowed",
          display_name: "Access",
        }),
        second: connection({
          terminal_id: "second",
          backend_pty_id: "pty-second",
          display_name: "Core",
        }),
        disconnected: connection({
          terminal_id: "disconnected",
          backend_pty_id: "pty-disconnected",
          lifecycle: "disconnected",
        }),
        juniper: connection({
          terminal_id: "juniper",
          backend_pty_id: "pty-juniper",
          vendor: "juniper",
          platform: "junos",
        }),
        missingPty: connection({
          terminal_id: "missing-pty",
          backend_pty_id: "   ",
        }),
      },
    };

    expect(listConnectedCiscoTargets(state)).toEqual([
      {
        terminalId: "allowed",
        backendPtyId: "pty-allowed",
        displayName: "Access",
        vendor: "cisco",
        platform: "iosxe",
      },
      {
        terminalId: "second",
        backendPtyId: "pty-second",
        displayName: "Core",
        vendor: "cisco",
        platform: "iosxe",
      },
    ]);
  });

  it("classifies every non-empty line before the first write", async () => {
    const selection = "show clock\r\n\r\nshow version";
    const events: string[] = [];
    const classify = vi.fn(async (_vendor: string, _platform: string, command: string) => {
      events.push(`classified:${command}`);
      return command === "show clock"
        ? t0("Clock is read-only")
        : { tier: "T1" as const, rule_id: "version-rule", reasoning: "Confirm" };
    });
    const approve = vi.fn(async () => {
      events.push("approved");
      return "proceed" as const;
    });
    const record = vi.fn(async () => {
      events.push("recorded");
      return "decision-1";
    });
    const write = vi.fn(async (_ptyId: string, _bytes: Uint8Array) => {
      events.push("wrote");
    });

    const result = await sendSelectionToCisco({
      selection,
      target,
      sessionId: "session-1",
      classify,
      approve,
      record,
      write,
      getCurrentTarget: () => connection(),
    });

    expect(result).toBe("sent");
    expect(classify.mock.calls).toEqual([
      ["cisco", "iosxe", "show clock"],
      ["cisco", "iosxe", "show version"],
    ]);
    expect(events).toEqual([
      "classified:show clock",
      "classified:show version",
      "approved",
      "recorded",
      "wrote",
    ]);
    expect(approve).toHaveBeenCalledWith({
      pendingId: expect.any(String),
      tier: "T1",
      command: "show version",
      reasoning: "Confirm",
      vendor: "cisco",
      platform: "iosxe",
      sessionId: "session-1",
      ruleId: "version-rule",
    });
    expect(record).toHaveBeenCalledWith({
      sessionId: "session-1",
      command: "show clock",
      tier: 0,
      ruleId: "show-rule",
      decision: "auto_approved",
      userAction: "proceed",
      reasoning: "Clock is read-only",
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("pty-1");
    expect(new TextDecoder().decode(write.mock.calls[0][1])).toBe(selection);
  });

  it("cancels with zero writes when approval is denied", async () => {
    const write = vi.fn();
    const record = vi.fn();
    const result = await sendSelectionToCisco({
      selection: "show clock\nconfigure terminal",
      target,
      sessionId: "session-1",
      classify: vi.fn(async (_vendor, _platform, command): Promise<ClassifyResponse> =>
        command === "show clock"
          ? t0()
          : { tier: "T1", rule_id: "config-rule", reasoning: "Configuration" },
      ),
      approve: vi.fn(async (): Promise<"cancel" | "proceed"> => "cancel"),
      record,
      write,
      getCurrentTarget: () => connection(),
    });

    expect(result).toBe("cancelled");
    expect(record).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects a target that becomes disconnected before writing", async () => {
    let current = connection();
    const write = vi.fn();
    const result = await sendSelectionToCisco({
      selection: "configure terminal",
      target,
      sessionId: "session-1",
      classify: vi.fn(async (): Promise<ClassifyResponse> => ({
        tier: "T1",
        rule_id: "config-rule",
        reasoning: "Configuration",
      })),
      approve: vi.fn(async (): Promise<"cancel" | "proceed"> => {
        current = connection({ lifecycle: "disconnected" });
        return "proceed";
      }),
      record: vi.fn(),
      write,
      getCurrentTarget: () => current,
    });

    expect(result).toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
  });

  it("cancels an all-empty selection without classifying or writing", async () => {
    const classify = vi.fn();
    const write = vi.fn();

    const result = await sendSelectionToCisco({
      selection: "\r\n\n\r\n",
      target,
      sessionId: "session-1",
      classify,
      approve: vi.fn(),
      record: vi.fn(),
      write,
      getCurrentTarget: () => connection(),
    });

    expect(result).toBe("cancelled");
    expect(classify).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("cancels with zero writes when classification fails", async () => {
    const write = vi.fn();
    const result = await sendSelectionToCisco({
      selection: "show clock",
      target,
      sessionId: "session-1",
      classify: vi.fn(async () => {
        throw new Error("classifier unavailable");
      }),
      approve: vi.fn(),
      record: vi.fn(),
      write,
      getCurrentTarget: () => connection(),
    });

    expect(result).toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
  });

  it("cancels with zero writes when approval fails", async () => {
    const write = vi.fn();
    const result = await sendSelectionToCisco({
      selection: "configure terminal",
      target,
      sessionId: "session-1",
      classify: vi.fn(async (): Promise<ClassifyResponse> => ({
        tier: "T1",
        rule_id: "config-rule",
        reasoning: "Configuration",
      })),
      approve: vi.fn(async (): Promise<"cancel" | "proceed"> => {
        throw new Error("approval unavailable");
      }),
      record: vi.fn(),
      write,
      getCurrentTarget: () => connection(),
    });

    expect(result).toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
  });

  it("cancels with zero writes when T0 audit recording fails", async () => {
    const write = vi.fn();
    const result = await sendSelectionToCisco({
      selection: "show clock",
      target,
      sessionId: "session-1",
      classify: vi.fn(async () => t0()),
      approve: vi.fn(),
      record: vi.fn(async () => {
        throw new Error("audit unavailable");
      }),
      write,
      getCurrentTarget: () => connection(),
    });

    expect(result).toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
  });

  it("rechecks the target after a pending T0 audit before writing", async () => {
    let current = connection();
    let markAuditStarted!: () => void;
    let finishAudit!: (decisionId: string) => void;
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve;
    });
    const auditPending = new Promise<string>((resolve) => {
      finishAudit = resolve;
    });
    const write = vi.fn();
    const sendPromise = sendSelectionToCisco({
      selection: "show clock",
      target,
      sessionId: "session-1",
      classify: vi.fn(async () => t0()),
      approve: vi.fn(),
      record: vi.fn(async () => {
        markAuditStarted();
        return auditPending;
      }),
      write,
      getCurrentTarget: () => current,
    });

    await auditStarted;
    current = connection({ lifecycle: "disconnected" });
    finishAudit("decision-1");

    expect(await sendPromise).toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyCommand,
  recordDecision,
  classifyAndAutoApprove,
  isPureNetconfRead,
} from "./guardrails";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("classifyCommand", () => {
  it("forwards args under the `args` wrapper", async () => {
    mockedInvoke.mockResolvedValueOnce({
      tier: "T0",
      rule_id: "builtin-iosxe-show-version",
      reasoning: "Read-only",
    });
    const r = await classifyCommand("cisco", "iosxe", "show version");
    expect(mockedInvoke).toHaveBeenCalledWith("guardrail_classify", {
      args: { vendor: "cisco", platform: "iosxe", command: "show version" },
    });
    expect(r.tier).toBe("T0");
  });
});

describe("recordDecision", () => {
  it("snake-cases keys for the Tauri command", async () => {
    mockedInvoke.mockResolvedValueOnce("decision-id-1");
    const id = await recordDecision({
      sessionId: "s1",
      command: "reload",
      tier: 3,
      ruleId: "builtin-iosxe-reload",
      decision: "admin_override",
      userAction: "proceed",
      reasoning: "Full device reload",
    });
    expect(id).toBe("decision-id-1");
    expect(mockedInvoke).toHaveBeenCalledWith("guardrail_record_decision", {
      args: {
        session_id: "s1",
        command: "reload",
        tier: 3,
        rule_id: "builtin-iosxe-reload",
        decision: "admin_override",
        user_action: "proceed",
        reasoning: "Full device reload",
      },
    });
  });
});

describe("classifyAndAutoApprove", () => {
  it("auto-records T0 decisions in one round-trip", async () => {
    mockedInvoke
      .mockResolvedValueOnce({
        tier: "T0",
        rule_id: "builtin-iosxe-show-version",
        reasoning: "Read-only",
      })
      .mockResolvedValueOnce("decision-id-2");
    const r = await classifyAndAutoApprove({
      vendor: "cisco",
      platform: "iosxe",
      command: "show version",
      sessionId: "s1",
    });
    expect(r.tier).toBe("T0");
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    const lastCall = mockedInvoke.mock.calls[1];
    expect(lastCall[0]).toBe("guardrail_record_decision");
  });

  it("does NOT auto-record T1+ decisions", async () => {
    mockedInvoke.mockResolvedValueOnce({
      tier: "T2",
      rule_id: "builtin-iosxe-shutdown",
      reasoning: "Iface shutdown",
    });
    const r = await classifyAndAutoApprove({
      vendor: "cisco",
      platform: "iosxe",
      command: "shutdown",
      sessionId: "s1",
    });
    expect(r.tier).toBe("T2");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });
});

describe("isPureNetconfRead", () => {
  it("returns true for <get>/<get-config>", () => {
    expect(isPureNetconfRead("<rpc><get/></rpc>")).toBe(true);
    expect(isPureNetconfRead("<rpc><get-config><source><running/></source></get-config></rpc>")).toBe(true);
  });

  it("returns false for edit-config / commit / exec-command", () => {
    expect(isPureNetconfRead("<rpc><edit-config>…</edit-config></rpc>")).toBe(false);
    expect(isPureNetconfRead("<rpc><commit/></rpc>")).toBe(false);
    expect(
      isPureNetconfRead(
        "<rpc><exec-command><exec>show ip route</exec></exec-command></rpc>",
      ),
    ).toBe(false);
  });
});

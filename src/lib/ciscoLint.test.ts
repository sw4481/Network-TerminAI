import { describe, expect, it } from "vitest";
import { guardrailDiagnostic, lintCiscoConfig } from "./ciscoLint";

describe("guardrailDiagnostic", () => {
  it("maps non-T0 findings without changing the source command", () => {
    const command = " no ip route 0.0.0.0 0.0.0.0";

    expect(
      guardrailDiagnostic(3, 2, "iosxe", command, {
        tier: "T3",
        rule_id: "remove-default-route",
        reasoning: "High impact route removal",
      }),
    ).toMatchObject({
      line: 3,
      column: 2,
      severity: "error",
      source: "guardrails",
      code: "guardrail-remove-default-route",
      message: expect.stringContaining(command),
    });
  });

  it("does not produce a finding for T0", () => {
    expect(
      guardrailDiagnostic(1, 1, "nxos", "show version", {
        tier: "T0",
        rule_id: null,
        reasoning: "Read-only",
      }),
    ).toBeNull();
  });

  it.each([
    ["T1", "warning", "guardrail-t1"],
    ["T2", "warning", "guardrail-t2"],
    ["Ambiguous", "warning", "guardrail-ambiguous"],
  ] as const)("maps %s to a stable %s diagnostic", (tier, severity, code) => {
    const diagnostic = guardrailDiagnostic(1, 1, "iosxe", "reload", {
      tier,
      rule_id: null,
      reasoning: "Needs review",
    });

    expect(diagnostic).toMatchObject({ severity, code });
    if (tier === "Ambiguous") {
      expect(diagnostic?.message).toContain("Ambiguous");
    }
  });
});

describe("lintCiscoConfig", () => {
  it("accepts comments, known contexts, exits, and unknown release commands", () => {
    const result = lintCiscoConfig(
      [
        "!",
        "interface GigabitEthernet1/0/1",
        " description uplink",
        " mystery-release-command",
        " exit",
      ].join("\n"),
      "iosxe",
    );

    expect(result.diagnostics).toEqual([]);
  });

  it("flags a captured CLI prompt and control character", () => {
    const result = lintCiscoConfig("Router#show version\ninterface \u0000 Gi1", "iosxe");

    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "cli-prompt",
      "control-character",
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      line: 1,
      column: 1,
      severity: "warning",
    });
  });

  it("warns when a recognized child command is outside its context", () => {
    const result = lintCiscoConfig(" ip address 192.0.2.1 255.255.255.0", "iosxe");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "orphan-child-command",
        line: 1,
        severity: "warning",
      }),
    ]);
  });

  it("uses the innermost context for nested child-command compatibility", () => {
    const result = lintCiscoConfig(
      [
        "interface Gi1/0/1",
        " router ospf 1",
        " ip address 192.0.2.1 255.255.255.0",
      ].join("\n"),
      "iosxe",
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "orphan-child-command",
        line: 3,
        severity: "warning",
      }),
    ]);
  });

  it("ignores control characters on separator and comment lines", () => {
    const result = lintCiscoConfig("  !\u0000 captured separator", "iosxe");

    expect(result.diagnostics).toEqual([]);
  });

  it("flags unmatched exit without requiring a final end", () => {
    const result = lintCiscoConfig("exit\ninterface Gi1/0/1\n description test", "nxos");

    expect(result.diagnostics.map((d) => d.code)).toContain("unmatched-exit");
    expect(result.diagnostics.map((d) => d.code)).not.toContain("missing-end");
  });

  it("matches uppercase exits with trailing whitespace and preserves columns", () => {
    const matched = lintCiscoConfig(
      "router bgp 65000\n address-family ipv4\n EXIT-ADDRESS-FAMILY   \n EXIT\t",
      "iosxe",
    );
    const unmatched = lintCiscoConfig("  EXIT   ", "nxos");

    expect(matched.diagnostics).toEqual([]);
    expect(unmatched.diagnostics).toEqual([
      expect.objectContaining({ code: "unmatched-exit", column: 3 }),
    ]);
  });

  it("reports only high-confidence platform mismatches", () => {
    const ios = lintCiscoConfig("feature ospf\n", "iosxe");
    const nxos = lintCiscoConfig("router ospf 1\n", "nxos");

    expect(ios.diagnostics.some((d) => d.code === "platform-mismatch")).toBe(true);
    expect(nxos.diagnostics.some((d) => d.code === "platform-mismatch")).toBe(false);
  });

  it("returns stable path-independent output", () => {
    const text = "!\ninterface Gi1/0/1\n ip address 192.0.2.1 255.255.255.0";
    expect(lintCiscoConfig(text, "iosxe")).toEqual(lintCiscoConfig(text, "iosxe"));
  });
});

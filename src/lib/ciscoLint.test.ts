import { describe, expect, it } from "vitest";
import { lintCiscoConfig } from "./ciscoLint";

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

import { describe, it, expect } from "vitest";
import { prettyFormat } from "./prettyFormat";

describe("prettyFormat", () => {
  it("renders a scalar on one line", () => {
    expect(prettyFormat("hello")).toBe("hello");
    expect(prettyFormat(42)).toBe("42");
    expect(prettyFormat(true)).toBe("true");
    expect(prettyFormat(false)).toBe("false");
    expect(prettyFormat(null)).toBe("(none)");
  });

  it("renders an object as key: value lines, alphabetically sorted", () => {
    const out = prettyFormat({ name: "HQ", count: 12, online: true });
    expect(out).toBe("count: 12\nname: HQ\nonline: true");
  });

  it("nests objects by indentation", () => {
    const out = prettyFormat({
      org: "Acme",
      location: { city: "Boston", state: "MA" },
    });
    expect(out).toContain("location: ");
    // location's children indented two spaces beneath it
    expect(out).toMatch(/location: \n {2}city: Boston\n {2}state: MA/);
  });

  it("renders an array of primitives as bullets", () => {
    expect(prettyFormat([1, 2, 3])).toBe("- 1\n- 2\n- 3");
  });

  it("renders array of objects with first key on the dash line", () => {
    const out = prettyFormat([
      { id: "L_1", name: "HQ" },
      { id: "L_2", name: "Lab" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("- id: L_1");
    expect(lines[1]).toBe("  name: HQ");
    expect(lines[2]).toBe("- id: L_2");
    expect(lines[3]).toBe("  name: Lab");
  });

  it("empty array and empty object render as (empty)", () => {
    expect(prettyFormat([])).toBe("(empty)");
    expect(prettyFormat({})).toBe("(empty)");
  });

  it("empty values inside an object render as (empty)", () => {
    const out = prettyFormat({ devices: [], tags: {} });
    expect(out).toBe("devices: (empty)\ntags: (empty)");
  });

  it("null values inside an object render as (none)", () => {
    const out = prettyFormat({ serial: "AB-CD", tag: null });
    expect(out).toBe("serial: AB-CD\ntag: (none)");
  });

  it("empty-string values render as (empty), not a blank value", () => {
    // Without this, `name: ` leaves an ambiguous trailing space that
    // looks like a rendering bug.
    expect(prettyFormat({ name: "" })).toBe("name: (empty)");
  });

  it("ISO-8601 timestamps are converted to a local-friendly form", () => {
    const out = prettyFormat({ lastSeen: "2026-04-30T12:34:56Z" });
    // The exact format depends on the runner's locale, but it MUST NOT
    // be the raw ISO string anymore.
    expect(out).not.toContain("2026-04-30T12:34:56Z");
    // Sanity: year and minute should still be present in some form.
    expect(out).toMatch(/2026/);
  });

  it("multi-line string values use a pipe marker with indented body", () => {
    const out = prettyFormat({ log: "line1\nline2\nline3" });
    expect(out).toBe("log: |\n  line1\n  line2\n  line3");
  });

  it("deeply nested structure preserves relative indentation", () => {
    const out = prettyFormat({
      network: {
        devices: [
          { serial: "Q2XX-1", model: "MS120" },
          { serial: "Q2XX-2", model: "MS125" },
        ],
      },
    });
    const lines = out.split("\n");
    // Top-level "network:" with zero indent.
    expect(lines[0]).toBe("network: ");
    // "devices:" sits under it with 2-space indent.
    expect(lines[1]).toBe("  devices: ");
    // Array dashes sit under devices with 4-space indent.
    expect(lines[2]).toBe("    - model: MS120");
    expect(lines[3]).toBe("      serial: Q2XX-1");
  });

  it("preserves the Meraki org-list shape: array of {id,name}", () => {
    // Real-world smoke test for the most common response we'll format.
    const merakiOrgs = [
      { id: "L_111", name: "Acme HQ" },
      { id: "L_222", name: "Acme Lab" },
    ];
    const out = prettyFormat(merakiOrgs);
    // None of the JSON syntax survives.
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
    expect(out).not.toContain('"');
    // Content IS there.
    expect(out).toContain("L_111");
    expect(out).toContain("Acme HQ");
    expect(out).toContain("L_222");
    expect(out).toContain("Acme Lab");
  });

  it("arrays of arrays render all values (exact formatting flexible)", () => {
    const out = prettyFormat([[1, 2], [3, 4]]);
    // Cisco APIs rarely return nested arrays, so we don't hand-craft a
    // specific shape — just assert every value survives.
    for (const n of ["1", "2", "3", "4"]) {
      expect(out).toContain(n);
    }
  });

  it("numbers like 0 and false-y primitives render correctly (not as 'none')", () => {
    expect(prettyFormat({ count: 0, enabled: false })).toBe(
      "count: 0\nenabled: false",
    );
  });
});

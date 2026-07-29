import { describe, it, expect } from "vitest";
import {
  blankDraft,
  emitMarkdown,
  emitBody,
  emitFrontmatter,
  newCell,
  validateDraft,
  yamlScalar,
} from "./notebookAuthoring";

describe("yamlScalar", () => {
  it("leaves bare identifiers unquoted", () => {
    expect(yamlScalar("cisco")).toBe("cisco");
  });
  it("quotes empty strings", () => {
    expect(yamlScalar("")).toBe('""');
  });
  it("quotes values with colons", () => {
    expect(yamlScalar("a: b")).toBe('"a: b"');
  });
  it("quotes leading whitespace", () => {
    expect(yamlScalar(" foo")).toBe('" foo"');
  });
  it("quotes ambiguous booleans", () => {
    expect(yamlScalar("yes")).toBe('"yes"');
    expect(yamlScalar("true")).toBe('"true"');
    expect(yamlScalar("null")).toBe('"null"');
  });
  it("quotes numbers", () => {
    expect(yamlScalar("65001")).toBe('"65001"');
    expect(yamlScalar("-1")).toBe('"-1"');
  });
  it("escapes embedded double quotes", () => {
    expect(yamlScalar('he said "hi"')).toBe('"he said \\"hi\\""');
  });
});

describe("emitFrontmatter", () => {
  it("emits required title and skips empty optional fields", () => {
    const d = { ...blankDraft(), title: "T", description: "", vendor: "cisco", platform: "iosxe", parameters: [] };
    const fm = emitFrontmatter(d);
    expect(fm).toContain("title: T");
    expect(fm).toContain("vendor: cisco");
    expect(fm).toContain("platform: iosxe");
    expect(fm).not.toContain("description:");
    expect(fm.startsWith("---")).toBe(true);
    expect(fm.endsWith("---")).toBe(true);
  });

  it("emits parameter list when present", () => {
    const d = {
      ...blankDraft(),
      title: "T",
      parameters: [
        { name: "peer_ip", prompt: "Peer IP", default: "10.0.0.1" },
        { name: "peer_asn", prompt: "ASN" },
      ],
    };
    const fm = emitFrontmatter(d);
    expect(fm).toContain("parameters:");
    expect(fm).toContain("- name: peer_ip");
    expect(fm).toContain("prompt: Peer IP");
    expect(fm).toContain('default: "10.0.0.1"');
    expect(fm).toContain("- name: peer_asn");
  });
});

describe("emitBody", () => {
  it("renders fenced blocks per cell type", () => {
    const d = {
      ...blankDraft(),
      title: "T",
      cells: [
        { kind: "markdown" as const, body: "# Hi" },
        { kind: "command" as const, body: "show version" },
        { kind: "approval" as const, body: "Continue?" },
        {
          kind: "assertion" as const,
          spec: {
            command: "show version",
            jsonpath: "$.version",
            op: "equals" as const,
            expected: "17.09",
          },
        },
      ],
    };
    const body = emitBody(d);
    expect(body).toContain("# Hi");
    expect(body).toContain("```command\nshow version\n```");
    expect(body).toContain("```approval\nContinue?\n```");
    expect(body).toContain("```assertion");
    expect(body).toContain('"jsonpath":"$.version"');
  });
});

describe("emitMarkdown round-trip-friendly", () => {
  it("produces markdown that starts with frontmatter and contains a fenced block", () => {
    const d = blankDraft();
    d.title = "BGP Test";
    d.cells = [{ kind: "command", body: "show ip bgp summary" }];
    const md = emitMarkdown(d);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("title: BGP Test");
    expect(md).toContain("```command");
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("validateDraft", () => {
  it("flags empty title", () => {
    const d = blankDraft();
    d.cells = [];
    const errs = validateDraft(d);
    expect(errs.some((e) => e.toLowerCase().includes("title"))).toBe(true);
  });

  it("flags invalid parameter identifiers", () => {
    const d = blankDraft();
    d.title = "T";
    d.parameters = [{ name: "1bad", prompt: "x" }];
    const errs = validateDraft(d);
    expect(errs.some((e) => e.includes("1bad"))).toBe(true);
  });

  it("flags duplicate parameter names", () => {
    const d = blankDraft();
    d.title = "T";
    d.parameters = [
      { name: "a", prompt: "" },
      { name: "a", prompt: "" },
    ];
    const errs = validateDraft(d);
    expect(errs.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });

  it("flags empty command cell", () => {
    const d = blankDraft();
    d.title = "T";
    d.cells = [{ kind: "command", body: "" }];
    const errs = validateDraft(d);
    expect(errs.some((e) => e.includes("command"))).toBe(true);
  });

  it("flags assertion missing required fields", () => {
    const d = blankDraft();
    d.title = "T";
    d.cells = [
      {
        kind: "assertion",
        spec: { command: "", jsonpath: "", op: "equals", expected: "" },
      },
    ];
    const errs = validateDraft(d);
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it("returns no errors for a well-formed draft", () => {
    const d = blankDraft();
    d.title = "T";
    d.cells = [
      { kind: "markdown", body: "intro" },
      { kind: "command", body: "show version" },
    ];
    expect(validateDraft(d)).toEqual([]);
  });
});

describe("newCell", () => {
  it("produces sensible defaults per kind", () => {
    expect(newCell("markdown")).toMatchObject({ kind: "markdown", body: "" });
    expect(newCell("command")).toMatchObject({ kind: "command", body: "" });
    const approval = newCell("approval");
    expect(approval.kind).toBe("approval");
    if (approval.kind === "approval") expect(approval.body.length).toBeGreaterThan(0);
    const a = newCell("assertion");
    expect(a.kind).toBe("assertion");
    if (a.kind === "assertion") expect(a.spec.op).toBe("equals");
  });
});

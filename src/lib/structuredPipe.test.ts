import { describe, it, expect } from "vitest";
import {
  splitStructuredPipe,
  parseFilter,
  applyFilter,
  StructuredPipeError,
} from "./structuredPipe";

describe("splitStructuredPipe", () => {
  it("returns command + filter for a pipe-filter command", () => {
    const r = splitStructuredPipe(
      "show ip route | ↗structured.nexthop=10.0.0.1",
    );
    expect(r.command).toBe("show ip route");
    expect(r.filter).toEqual({
      kind: "eq",
      path: "nexthop",
      value: "10.0.0.1",
    });
  });

  it("returns null filter when no pipe is present", () => {
    const r = splitStructuredPipe("show run");
    expect(r).toEqual({ command: "show run", filter: null });
  });

  it("throws on empty filter", () => {
    expect(() =>
      splitStructuredPipe("show ip route | ↗structured."),
    ).toThrow(StructuredPipeError);
  });
});

describe("parseFilter", () => {
  it("parses eq with quoted value", () => {
    expect(parseFilter('intf="Gi 1"')).toEqual({
      kind: "eq",
      path: "intf",
      value: "Gi 1",
    });
  });
  it("parses regex with /pat/flags", () => {
    expect(parseFilter("intf ~ /^Gi[0-9]+$/i")).toEqual({
      kind: "regex",
      path: "intf",
      pattern: "^Gi[0-9]+$",
      flags: "i",
    });
  });
  it("parses bare regex without slashes", () => {
    expect(parseFilter("intf ~ ^Gi")).toEqual({
      kind: "regex",
      path: "intf",
      pattern: "^Gi",
      flags: "",
    });
  });
  it("throws on invalid regex", () => {
    expect(() => parseFilter("intf ~ /(")).toThrow(StructuredPipeError);
  });
  it("parses in (...)", () => {
    expect(parseFilter("status in (up, down)")).toEqual({
      kind: "in",
      path: "status",
      values: ["up", "down"],
      negated: false,
    });
  });
  it("parses not in (...)", () => {
    expect(parseFilter("status not in (up)")).toEqual({
      kind: "in",
      path: "status",
      values: ["up"],
      negated: true,
    });
  });
  it("parses jsonpath:", () => {
    expect(parseFilter("jsonpath:$.foo[*]")).toEqual({
      kind: "jsonpath",
      expr: "$.foo[*]",
    });
  });
  it("throws on unrecognized syntax", () => {
    expect(() => parseFilter("???")).toThrow(StructuredPipeError);
  });
});

describe("applyFilter", () => {
  const rows = [
    { intf: "Gi1", status: "up" },
    { intf: "Gi2", status: "down" },
    { intf: "Te0/1", status: "up" },
  ];
  it("eq is case-insensitive", () => {
    expect(applyFilter(rows, { kind: "eq", path: "status", value: "UP" }))
      .toHaveLength(2);
  });
  it("regex matches per-row", () => {
    expect(
      applyFilter(rows, {
        kind: "regex",
        path: "intf",
        pattern: "^Gi",
        flags: "",
      }),
    ).toHaveLength(2);
  });
  it("in matches any-of", () => {
    expect(
      applyFilter(rows, {
        kind: "in",
        path: "status",
        values: ["up"],
        negated: false,
      }),
    ).toHaveLength(2);
  });
  it("not in negates", () => {
    expect(
      applyFilter(rows, {
        kind: "in",
        path: "status",
        values: ["up"],
        negated: true,
      }),
    ).toHaveLength(1);
  });
  it("jsonpath returns rows unmodified", () => {
    const r = applyFilter(rows, { kind: "jsonpath", expr: "$" });
    expect(r).toEqual(rows);
  });
});

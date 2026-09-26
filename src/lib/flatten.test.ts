import { describe, it, expect } from "vitest";
import { flattenToRows, isListOfDicts, inferColumns } from "./flatten";

describe("isListOfDicts", () => {
  it("returns true for TextFSM-style arrays", () => {
    expect(isListOfDicts([{ a: 1 }, { a: 2 }])).toBe(true);
  });
  it("returns false for nested dicts", () => {
    expect(
      isListOfDicts({ interfaces: { Gi1: { ip: "10.0.0.1" } } }),
    ).toBe(false);
  });
  it("returns false for empty arrays", () => {
    expect(isListOfDicts([])).toBe(false);
  });
  it("returns false for arrays with primitives", () => {
    expect(isListOfDicts([1, 2, 3])).toBe(false);
  });
});

describe("flattenToRows", () => {
  it("flattens a Genie-style nested dict to dotted-path rows", () => {
    const data = {
      interfaces: {
        Gi1: { ip: "10.0.0.1", up: true },
        Gi2: { ip: "10.0.0.2", up: false },
      },
    };
    const rows = flattenToRows(data);
    expect(rows).toEqual([
      { key: "interfaces.Gi1.ip", value: "10.0.0.1" },
      { key: "interfaces.Gi1.up", value: true },
      { key: "interfaces.Gi2.ip", value: "10.0.0.2" },
      { key: "interfaces.Gi2.up", value: false },
    ]);
  });
  it("preserves arrays as values without descending into them", () => {
    const data = { hostname: "R1", uptime_days: 42, neighbors: ["R2", "R3"] };
    const rows = flattenToRows(data);
    expect(rows).toContainEqual({ key: "neighbors", value: ["R2", "R3"] });
  });
});

describe("inferColumns", () => {
  it("returns the union of keys across all rows in insertion order", () => {
    const rows = [
      { intf: "Gi1", status: "up" },
      { intf: "Gi2", status: "down", description: "uplink" },
    ];
    expect(inferColumns(rows)).toEqual(["intf", "status", "description"]);
  });
});

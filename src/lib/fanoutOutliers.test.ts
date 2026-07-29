import { describe, it, expect } from "vitest";
import { detectOutliers } from "./fanoutOutliers";

describe("detectOutliers", () => {
  it("detects single outlier in 50-device BGP parsed output", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      deviceKey: `ssh:r${i}`,
      columns: {
        neighbor: "10.0.0.1",
        state: i === 37 ? "Idle" : "Established",
      },
    }));
    const outliers = detectOutliers(rows, { keyColumn: "neighbor" });
    expect(outliers).toEqual([
      {
        deviceKey: "ssh:r37",
        column: "state",
        value: "Idle",
        majorityValue: "Established",
        minoritySize: 1,
        majoritySize: 49,
      },
    ]);
  });

  it("does not flag columns with a 50/50 split", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      deviceKey: `r${i}`,
      columns: { neighbor: "10.0.0.1", state: i % 2 ? "A" : "B" },
    }));
    expect(
      detectOutliers(rows, { keyColumn: "neighbor", majorityThreshold: 0.75 }),
    ).toEqual([]);
  });

  it("handles multiple key groups independently", () => {
    // Two BGP neighbors. For 10.0.0.1: 19 of 20 are Up, 1 is Down (5% minority).
    // For 10.0.0.2: 10 of 10 are Up — no outlier.
    const rows = [
      ...Array.from({ length: 19 }, (_, i) => ({
        deviceKey: `a${i}`,
        columns: { neighbor: "10.0.0.1", state: "Up" },
      })),
      { deviceKey: "aBad", columns: { neighbor: "10.0.0.1", state: "Down" } },
      ...Array.from({ length: 10 }, (_, i) => ({
        deviceKey: `b${i}`,
        columns: { neighbor: "10.0.0.2", state: "Up" },
      })),
    ];
    const outliers = detectOutliers(rows, { keyColumn: "neighbor" });
    expect(outliers.length).toBe(1);
    expect(outliers[0].deviceKey).toBe("aBad");
  });

  it("ignores rows missing the key column", () => {
    const rows: { deviceKey: string; columns: Record<string, string> }[] = [
      { deviceKey: "r1", columns: { state: "Up" } }, // no neighbor
      { deviceKey: "r2", columns: { neighbor: "10.0.0.1", state: "Up" } },
    ];
    expect(detectOutliers(rows, { keyColumn: "neighbor" })).toEqual([]);
  });

  it("returns sorted by (column, minoritySize, deviceKey)", () => {
    // 30 devices, 2 outliers — 28/30 = 93% majority, 7% minority — clearly flaggable.
    const rows = [
      ...Array.from({ length: 28 }, (_, i) => ({
        deviceKey: `r${i.toString().padStart(2, "0")}`,
        columns: { neighbor: "10.0.0.1", state: "Up" },
      })),
      { deviceKey: "rZ", columns: { neighbor: "10.0.0.1", state: "X" } },
      { deviceKey: "rA", columns: { neighbor: "10.0.0.1", state: "X" } },
    ];
    const outliers = detectOutliers(rows, { keyColumn: "neighbor" });
    expect(outliers.map((o) => o.deviceKey)).toEqual(["rA", "rZ"]);
  });
});

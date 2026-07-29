import { describe, expect, it } from "vitest";
import {
  compareZedSnapshotRevision,
  isNewerZedSnapshotRevision,
  nextZedSnapshotRevision,
  type ZedSnapshotRevision,
} from "./zedSnapshotRevision";

const revision = (
  counter: number,
  sourceId: string,
): ZedSnapshotRevision => ({ counter, sourceId });

describe("Zed snapshot revisions", () => {
  it("orders larger counters after smaller counters", () => {
    expect(compareZedSnapshotRevision(revision(2, "a"), revision(1, "z")))
      .toBeGreaterThan(0);
    expect(isNewerZedSnapshotRevision(revision(2, "a"), revision(1, "z")))
      .toBe(true);
  });

  it("uses sourceId as a deterministic tie-break for equal counters", () => {
    expect(compareZedSnapshotRevision(revision(4, "window-b"), revision(4, "window-a")))
      .toBeGreaterThan(0);
    expect(compareZedSnapshotRevision(revision(4, "window-a"), revision(4, "window-b")))
      .toBeLessThan(0);
  });

  it("treats the same revision as a duplicate", () => {
    const value = revision(7, "window-a");
    expect(compareZedSnapshotRevision(value, value)).toBe(0);
    expect(isNewerZedSnapshotRevision(value, value)).toBe(false);
  });

  it("increments from the latest counter for the local source", () => {
    expect(nextZedSnapshotRevision(revision(9, "remote"), "local"))
      .toEqual(revision(10, "local"));
  });
});

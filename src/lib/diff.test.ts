import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { diffSnapshots, type CellDiff } from "./diff";

describe("diffSnapshots", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes structured_snapshot_diff with the correct args and returns CellDiff[]", async () => {
    const expected: CellDiff[] = [
      {
        row_key: "Gi1",
        column: "status",
        status: "changed",
        a: "up",
        b: "down",
      },
    ];
    invokeMock.mockResolvedValue(expected);
    const result = await diffSnapshots(1, 2);
    expect(invokeMock).toHaveBeenCalledWith("structured_snapshot_diff", {
      a: 1,
      b: 2,
    });
    expect(result).toEqual(expected);
  });
});

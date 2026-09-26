import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const listSnapshotsMock = vi.fn();
vi.mock("../lib/structured", () => ({
  listSnapshots: (...args: unknown[]) => listSnapshotsMock(...args),
}));

const diffSnapshotsMock = vi.fn();
vi.mock("../lib/diff", () => ({
  diffSnapshots: (...args: unknown[]) => diffSnapshotsMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { StructuredDiff } from "./StructuredDiff";

const sampleSnapshots = [
  {
    id: 2,
    tabId: "t1",
    name: "after",
    parsedOutputId: 11,
    capturedAt: 2000,
    command: "show ip int br",
    parser: "textfsm" as const,
    vendor: "cisco",
    platform: "iosxe",
  },
  {
    id: 1,
    tabId: "t1",
    name: "before",
    parsedOutputId: 10,
    capturedAt: 1000,
    command: "show ip int br",
    parser: "textfsm" as const,
    vendor: "cisco",
    platform: "iosxe",
  },
];

describe("StructuredDiff", () => {
  beforeEach(() => {
    listSnapshotsMock.mockReset();
    diffSnapshotsMock.mockReset();
  });

  it("shows 'Need two snapshots' when fewer than 2 exist", async () => {
    listSnapshotsMock.mockResolvedValue([sampleSnapshots[0]]);
    render(<StructuredDiff blockId="b1" tabId="t1" command="show ip int br" />);
    await waitFor(() => screen.getByText("Need two snapshots"));
  });

  it("auto-selects newest+older and renders a color-coded diff table", async () => {
    listSnapshotsMock.mockResolvedValue(sampleSnapshots);
    diffSnapshotsMock.mockResolvedValue([
      {
        row_key: "Gi1",
        column: "status",
        status: "changed",
        a: "up",
        b: "down",
      },
      {
        row_key: "Gi2",
        column: "status",
        status: "added",
        a: null,
        b: "up",
      },
    ]);
    render(<StructuredDiff blockId="b1" tabId="t1" command="show ip int br" />);
    await waitFor(() => screen.getByTestId("structured-diff-table"));
    expect(diffSnapshotsMock).toHaveBeenCalledWith(1, 2);
    expect(screen.getByText("Gi1")).toBeInTheDocument();
    expect(screen.getByText("Gi2")).toBeInTheDocument();
    expect(screen.getByText("down")).toBeInTheDocument();
    // color-coded by status — verify a `diff-changed` cell exists.
    const cell = document.querySelector(".diff-changed");
    expect(cell).not.toBeNull();
  });

  it("shows 'No changes' when every cell is unchanged", async () => {
    listSnapshotsMock.mockResolvedValue(sampleSnapshots);
    diffSnapshotsMock.mockResolvedValue([
      {
        row_key: "Gi1",
        column: "status",
        status: "unchanged",
        a: "up",
        b: "up",
      },
    ]);
    render(<StructuredDiff blockId="b1" tabId="t1" command="show ip int br" />);
    await waitFor(() => screen.getByText(/No changes/));
  });

  it("changing the A or B selector triggers a new diff fetch", async () => {
    listSnapshotsMock.mockResolvedValue(sampleSnapshots);
    diffSnapshotsMock.mockResolvedValue([]);
    render(<StructuredDiff blockId="b1" tabId="t1" command="show ip int br" />);
    await waitFor(() => screen.getByTestId("structured-diff-a"));
    diffSnapshotsMock.mockClear();
    fireEvent.change(screen.getByTestId("structured-diff-a"), {
      target: { value: "2" },
    });
    await waitFor(() => expect(diffSnapshotsMock).toHaveBeenCalled());
  });
});

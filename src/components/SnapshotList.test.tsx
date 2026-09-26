import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const listSnapshotsMock = vi.fn();
const deleteSnapshotMock = vi.fn();
const renameSnapshotMock = vi.fn();
vi.mock("../lib/structured", () => ({
  listSnapshots: (...args: unknown[]) => listSnapshotsMock(...args),
  deleteSnapshot: (...args: unknown[]) => deleteSnapshotMock(...args),
  renameSnapshot: (...args: unknown[]) => renameSnapshotMock(...args),
}));

import { SnapshotList } from "./SnapshotList";

const sampleSnapshots = [
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
];

describe("SnapshotList", () => {
  beforeEach(() => {
    listSnapshotsMock.mockReset();
    deleteSnapshotMock.mockReset();
    renameSnapshotMock.mockReset();
  });

  it("renders the snapshots", async () => {
    listSnapshotsMock.mockResolvedValue(sampleSnapshots);
    render(<SnapshotList tabId="t1" />);
    await waitFor(() => screen.getByText("before"));
    expect(screen.getByText("after")).toBeInTheDocument();
  });

  it("filters by command when provided", async () => {
    listSnapshotsMock.mockResolvedValue([
      ...sampleSnapshots,
      {
        ...sampleSnapshots[0],
        id: 3,
        command: "show version",
        name: "v-snap",
      },
    ]);
    render(<SnapshotList tabId="t1" command="show version" />);
    await waitFor(() => screen.getByText("v-snap"));
    expect(screen.queryByText("before")).not.toBeInTheDocument();
  });

  it("calls onSelect when a snapshot is clicked", async () => {
    listSnapshotsMock.mockResolvedValue(sampleSnapshots);
    const onSelect = vi.fn();
    render(<SnapshotList tabId="t1" onSelect={onSelect} />);
    await waitFor(() => screen.getByTestId("snapshot-1"));
    fireEvent.click(screen.getByTestId("snapshot-1"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, name: "before" }),
    );
  });

  it("delete button calls deleteSnapshot and refreshes", async () => {
    listSnapshotsMock.mockResolvedValueOnce(sampleSnapshots);
    listSnapshotsMock.mockResolvedValueOnce([sampleSnapshots[1]]);
    deleteSnapshotMock.mockResolvedValue(undefined);
    render(<SnapshotList tabId="t1" />);
    await waitFor(() => screen.getByTestId("snapshot-delete-1"));
    fireEvent.click(screen.getByTestId("snapshot-delete-1"));
    await waitFor(() =>
      expect(deleteSnapshotMock).toHaveBeenCalledWith(1),
    );
  });

  it("shows empty state when no snapshots", async () => {
    listSnapshotsMock.mockResolvedValue([]);
    render(<SnapshotList tabId="t1" />);
    await waitFor(() => screen.getByText(/No snapshots/));
  });
});

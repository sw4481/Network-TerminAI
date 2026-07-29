import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const createSnapshotMock = vi.fn();
vi.mock("../lib/structured", () => ({
  createSnapshot: (...args: unknown[]) => createSnapshotMock(...args),
}));

import { SnapshotPinDialog } from "./SnapshotPinDialog";

describe("SnapshotPinDialog", () => {
  beforeEach(() => {
    createSnapshotMock.mockReset();
  });

  it("focuses the input on mount and pre-fills defaultName", () => {
    render(
      <SnapshotPinDialog
        blockId="b1"
        defaultName="show version"
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByTestId("snapshot-pin-name") as HTMLInputElement;
    expect(input.value).toBe("show version");
    expect(document.activeElement).toBe(input);
  });

  it("disables Pin button when name is empty", () => {
    render(<SnapshotPinDialog blockId="b1" defaultName="" onClose={vi.fn()} />);
    expect(screen.getByTestId("snapshot-pin-save")).toBeDisabled();
  });

  it("invokes createSnapshot on submit and calls onPinned + onClose", async () => {
    createSnapshotMock.mockResolvedValue(42);
    const onClose = vi.fn();
    const onPinned = vi.fn();
    render(
      <SnapshotPinDialog
        blockId="b1"
        defaultName="snap-1"
        onClose={onClose}
        onPinned={onPinned}
      />,
    );
    fireEvent.click(screen.getByTestId("snapshot-pin-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createSnapshotMock).toHaveBeenCalledWith("b1", "snap-1");
    expect(onPinned).toHaveBeenCalledWith(42, "snap-1");
  });

  it("displays error and stays open on failure", async () => {
    createSnapshotMock.mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    render(
      <SnapshotPinDialog
        blockId="b1"
        defaultName="snap-1"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("snapshot-pin-save"));
    await waitFor(() => screen.getByText(/boom/));
    expect(onClose).not.toHaveBeenCalled();
  });
});

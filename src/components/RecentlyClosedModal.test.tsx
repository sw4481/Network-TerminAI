import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecentlyClosedModal } from "./RecentlyClosedModal";
import { useClosedTabs } from "../state/closedTabsStore";

beforeEach(() => useClosedTabs.setState({ items: [] }));

describe("RecentlyClosedModal", () => {
  it("lists closed tabs and fires onPick", () => {
    useClosedTabs.setState({ items: [{ id: "a", title: "SSH r1", cwd: "/cfg", closedAt: 1 }] });
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<RecentlyClosedModal open onClose={onClose} onPick={onPick} />);
    fireEvent.click(screen.getByText("SSH r1"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<RecentlyClosedModal open={false} onClose={() => {}} onPick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});

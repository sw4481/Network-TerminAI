/**
 * Plan 12 Phase 5 Task 5.4 — AgentSourcesDrawer tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AgentSourcesDrawer } from "./AgentSourcesDrawer";
import type { RetrievedChunk } from "../lib/rag";
import { useRagStore } from "../state/ragStore";

function makeChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 1,
    document_id: 10,
    document_title: "IOS-XE BGP Reference",
    chunk_idx: 7,
    text: "show ip bgp summary\nNeighbor 10.0.0.1 Established",
    distance: 0.14,
    tags: ["cisco-iosxe-router", "generic"],
    ...overrides,
  };
}

describe("AgentSourcesDrawer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when not open", () => {
    const { container } = render(
      <AgentSourcesDrawer
        open={false}
        sources={[]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the chunk title, tags, and text when open", () => {
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk()]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    expect(screen.getByText("IOS-XE BGP Reference")).toBeInTheDocument();
    expect(screen.getByText("cisco-iosxe-router")).toBeInTheDocument();
    expect(screen.getByText("generic")).toBeInTheDocument();
    expect(
      screen.getByText(/show ip bgp summary/),
    ).toBeInTheDocument();
  });

  it("formats similarity as `1 - distance` to 2 decimals", () => {
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk({ distance: 0.14 })]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    // sim = 1 - 0.14 = 0.86
    expect(screen.getByText(/sim 0\.86/)).toBeInTheDocument();
  });

  it("clamps similarity to [0, 1] for negative distances", () => {
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk({ distance: -0.05 })]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    // 1 - (-0.05) = 1.05 → clamp to 1.00
    expect(screen.getByText(/sim 1\.00/)).toBeInTheDocument();
  });

  it("clamps similarity to [0, 1] for distances > 1", () => {
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk({ distance: 1.5 })]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    // 1 - 1.5 = -0.5 → clamp to 0.00
    expect(screen.getByText(/sim 0\.00/)).toBeInTheDocument();
  });

  it("renders the empty state when sources is empty", () => {
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    expect(
      screen.getByText(/No sources for this turn/),
    ).toBeInTheDocument();
  });

  it("calls onClose on Esc keydown", () => {
    const onClose = vi.fn();
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk()]}
        onClose={onClose}
        tabId="tab-x"
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when overlay is clicked", () => {
    const onClose = vi.fn();
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk()]}
        onClose={onClose}
        tabId="tab-x"
      />,
    );
    const overlay = document.querySelector(".agent-sources-overlay");
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClose when drawer panel is clicked", () => {
    const onClose = vi.fn();
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk()]}
        onClose={onClose}
        tabId="tab-x"
      />,
    );
    fireEvent.click(screen.getByTestId("agent-sources-drawer"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("places initial focus on the close button", () => {
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk()]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    const close = screen.getByLabelText("Close sources drawer");
    expect(document.activeElement).toBe(close);
  });

  it("traps Tab to wrap from last focusable to first", () => {
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk(), makeChunk({ chunk_id: 2 })]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    // Drawer has: close button + 2 copy buttons = 3 focusables.
    // After Tab from the LAST focusable (the second copy button), we
    // should wrap back to the first (close).
    const close = screen.getByLabelText("Close sources drawer");
    const copyButtons = screen.getAllByTestId("agent-source-copy");
    const lastCopy = copyButtons[copyButtons.length - 1];
    lastCopy.focus();
    expect(document.activeElement).toBe(lastCopy);
    const drawer = screen.getByTestId("agent-sources-drawer");
    fireEvent.keyDown(drawer, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("Shift+Tab from the first focusable wraps to the last", () => {
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk(), makeChunk({ chunk_id: 2 })]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    const close = screen.getByLabelText("Close sources drawer");
    const copyButtons = screen.getAllByTestId("agent-source-copy");
    const lastCopy = copyButtons[copyButtons.length - 1];
    close.focus();
    const drawer = screen.getByTestId("agent-sources-drawer");
    fireEvent.keyDown(drawer, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastCopy);
  });

  it("flashes [ Copied ] in amber after a successful copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk()]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    const copyBtn = screen.getByTestId("agent-source-copy");
    expect(copyBtn).toHaveTextContent("[ Copy ]");
    await act(async () => {
      fireEvent.click(copyBtn);
      // Allow the awaited writeText promise to resolve so the state
      // transition lands before we assert.
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      "show ip bgp summary\nNeighbor 10.0.0.1 Established",
    );
    expect(copyBtn).toHaveTextContent("[ Copied ]");
    expect(copyBtn).toHaveClass("agent-source-copy--copied");

    // Reverts after 1.2s.
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(copyBtn).toHaveTextContent("[ Copy ]");
  });

  it("clears the copy-flash timer on unmount (no setState warning)", async () => {
    // The ChunkCard schedules a 1.2s timer to revert the Copy label.
    // If the drawer is closed (Esc / overlay click) before that timer
    // fires, setState would land on an unmounted component and React
    // would print a console.error. Assert that no such warning fires.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { unmount } = render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk()]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    const copyBtn = screen.getByTestId("agent-source-copy");
    await act(async () => {
      fireEvent.click(copyBtn);
      await Promise.resolve();
    });
    // Unmount BEFORE the 1.2s timer fires.
    unmount();
    // Now advance past the original timer interval to ensure no
    // pending callback runs against the unmounted component.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const offending = (calls: unknown[][]) =>
      calls.filter((args) =>
        args.some(
          (a) =>
            typeof a === "string" &&
            (a.includes("unmounted") ||
              a.includes("Can't perform a React state update")),
        ),
      );
    expect(offending(errorSpy.mock.calls)).toHaveLength(0);
    expect(offending(warnSpy.mock.calls)).toHaveLength(0);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("flashes [ Copy failed ] when clipboard rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[makeChunk()]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    const copyBtn = screen.getByTestId("agent-source-copy");
    await act(async () => {
      fireEvent.click(copyBtn);
      // Two ticks: one for the rejected promise, one for setState.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(copyBtn).toHaveTextContent("[ Copy failed ]");
    expect(copyBtn).toHaveClass("agent-source-copy--failed");
  });
});

describe("AgentSourcesDrawer active tags", () => {
  beforeEach(() => {
    // The other suite uses fake timers; this one doesn't need them
    // but we reset the store between cases so taxonomy seeding is
    // hermetic.
    useRagStore.getState().reset();
  });

  it("renders the empty-state copy when taxonomy.user is empty", () => {
    useRagStore.setState({
      taxonomy: { builtin: ["generic"], user: [] },
    });
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    expect(screen.getByText(/Tag uploads in/)).toBeInTheDocument();
  });

  it("toggles a user tag into activeUserTagsByTab on click", () => {
    useRagStore.setState({
      taxonomy: {
        builtin: ["generic"],
        user: [{ tag: "customer-acme", usage_count: 3 }],
      },
    });
    render(
      <AgentSourcesDrawer
        open={true}
        sources={[]}
        onClose={() => {}}
        tabId="tab-x"
      />,
    );
    const chip = screen.getByTestId("agent-sources-user-tag-customer-acme");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "customer-acme",
    ]);
  });
});

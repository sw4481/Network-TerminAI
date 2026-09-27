import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import type { PaletteHit } from "../lib/palette";

// Each test seeds its own behavior via mockImplementation.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function defaultInvoke(cmd: string): Promise<unknown> {
  if (cmd === "palette_search") {
    return Promise.resolve([
      {
        kind: "command",
        target_id: "show ip route",
        title: "show ip route",
        subtitle: "5× • last used 0",
        score: 1,
        recency_boost: 0,
        frequency_boost: 0,
        meta: {},
      },
      {
        kind: "workflow",
        target_id: "wf1",
        title: "show-tech-light",
        subtitle: "cisco/iosxe",
        score: 1,
        recency_boost: 0,
        frequency_boost: 0,
        meta: {},
      },
      {
        kind: "block",
        target_id: "b1",
        title: "show interfaces",
        subtitle: "tab t1",
        score: 0.9,
        recency_boost: 0,
        frequency_boost: 0,
        meta: { tab_id: "t1" },
      },
      {
        kind: "ssh",
        target_id: "c1",
        title: "core-sw1",
        subtitle: "admin@10.0.0.1:22",
        score: 1,
        recency_boost: 0,
        frequency_boost: 0,
        meta: {},
      },
    ] satisfies PaletteHit[]);
  }
  if (cmd === "palette_record_use") return Promise.resolve(null);
  return Promise.resolve(null);
}

describe("CommandPalette", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(defaultInvoke);
  });

  it("does not render when closed", () => {
    render(<CommandPalette open={false} onClose={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });

  it("renders when open", () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it("calls onClose when pressing Escape", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the scope segmented control with three tabs", () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /tab/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /device/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /global/i })).toBeInTheDocument();
  });

  it("starts with Global selected and switches scope via Cmd+2", async () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /global/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), {
      key: "2",
      metaKey: true,
    });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /device/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("switches scope by clicking a tab", async () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /tab/i }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /tab/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("renders hits returned from palette_search", async () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "show" },
    });
    await waitFor(() => {
      expect(screen.getByText("show ip route")).toBeInTheDocument();
      expect(screen.getByText("show-tech-light")).toBeInTheDocument();
      expect(screen.getByText("show interfaces")).toBeInTheDocument();
    });
  });

  it("transforms `>w` into a workflow chip and filters hits to workflows", async () => {
    invokeMock.mockImplementation((cmd: string, args: { payload: { args: { kind_filter: string | null } } }) => {
      if (cmd === "palette_search") {
        const kf = args.payload.args.kind_filter;
        const all: PaletteHit[] = [
          {
            kind: "workflow",
            target_id: "wf1",
            title: "show-tech-light",
            subtitle: "cisco/iosxe",
            score: 1,
            recency_boost: 0,
            frequency_boost: 0,
            meta: {},
          },
          {
            kind: "command",
            target_id: "show ip route",
            title: "show ip route",
            subtitle: "",
            score: 1,
            recency_boost: 0,
            frequency_boost: 0,
            meta: {},
          },
        ];
        return Promise.resolve(kf ? all.filter((h) => h.kind === kf) : all);
      }
      return Promise.resolve(null);
    });
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: ">w" } });

    await waitFor(() => {
      expect(screen.getByTestId("palette-kind-chip")).toBeInTheDocument();
      expect(screen.queryByText("show ip route")).not.toBeInTheDocument();
      expect(screen.getByText("show-tech-light")).toBeInTheDocument();
    });
  });

  it("calls palette_record_use on Enter pick", async () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: "show" } });
    await waitFor(() => screen.getByText("show ip route"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "palette_record_use",
        expect.objectContaining({
          targetType: expect.any(String),
          targetId: expect.any(String),
        }),
      );
    });
  });

  it("dispatches the per-kind custom event on pick", async () => {
    const cmdListener = vi.fn();
    const wfListener = vi.fn();
    const blockListener = vi.fn();
    window.addEventListener("ccie:execute-command", cmdListener);
    window.addEventListener("ccie:run-workflow", wfListener);
    window.addEventListener("ccie:scroll-to-block", blockListener);
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "show" },
    });
    // Click the command row directly so the test does not depend on Fuse
    // re-rank ordering.
    await waitFor(() => screen.getByText("show ip route"));
    fireEvent.click(screen.getByText("show ip route"));
    await waitFor(() => {
      expect(cmdListener).toHaveBeenCalled();
    });
    expect(cmdListener.mock.calls[0][0].detail.command).toBe("show ip route");
    window.removeEventListener("ccie:execute-command", cmdListener);
    window.removeEventListener("ccie:run-workflow", wfListener);
    window.removeEventListener("ccie:scroll-to-block", blockListener);
  });

  it("backspace at position 0 clears an active kind chip", async () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: ">w" } });
    await waitFor(() => screen.getByTestId("palette-kind-chip"));
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "Backspace" });
    await waitFor(() => {
      expect(screen.queryByTestId("palette-kind-chip")).not.toBeInTheDocument();
    });
  });
});

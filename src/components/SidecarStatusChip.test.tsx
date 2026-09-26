import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { SidecarStatusChip } from "./SidecarStatusChip";

describe("SidecarStatusChip", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("shows starting and recovers quickly while the first heartbeat is pending", async () => {
    vi.useFakeTimers();
    (invoke as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        running: false,
        last_seen: null,
        version: null,
        pid: null,
        now: 1_700_000_000,
      })
      .mockResolvedValueOnce({
        running: true,
        last_seen: 1_700_000_001,
        version: "0.0.1",
        pid: 12345,
        now: 1_700_000_001,
      });

    render(<SidecarStatusChip />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Sidecar:/)).toHaveTextContent(/starting/i);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText(/Sidecar:/)).toHaveTextContent(/v0\.0\.1/i);
  });

  it("renders 'down' after the startup grace period expires", async () => {
    vi.useFakeTimers();
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: false,
      last_seen: null,
      version: null,
      pid: null,
      now: 1_700_000_000,
    });

    render(<SidecarStatusChip />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Sidecar:/)).toHaveTextContent(/starting/i);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText(/Sidecar:/)).toHaveTextContent(/down/i);
  });

  it("renders version when running", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: true,
      last_seen: 1_700_000_000,
      version: "0.0.1",
      pid: 12345,
      now: 1_700_000_005,
    });
    render(<SidecarStatusChip />);
    await waitFor(() => {
      expect(screen.getByText(/Sidecar:/)).toHaveTextContent(/v0\.0\.1/);
    });
  });

  it("announces textual sidecar state changes without relying on the status dot", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: true,
      last_seen: 1_700_000_000,
      version: "0.0.1",
      pid: 12345,
      now: 1_700_000_005,
    });

    render(<SidecarStatusChip />);

    const status = await screen.findByRole("status", { name: "Sidecar status" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Sidecar: v0.0.1");
    expect(status.querySelector(".status-dot")).toHaveAttribute("aria-hidden", "true");
  });
});

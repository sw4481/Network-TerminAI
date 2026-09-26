import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TftpSettingsTab } from "./TftpSettingsTab";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../lib/tauri", () => ({
  tftpConfigGet: vi.fn(),
  tftpConfigSet: vi.fn(),
  tftpStatus: vi.fn(),
  tftpStart: vi.fn(),
  tftpStop: vi.fn(),
  tftpEventsTail: vi.fn(),
}));

import * as tauri from "../lib/tauri";

const cfg = {
  bindHost: "0.0.0.0",
  bindPort: 69,
  rootDir: "",
  readOnly: false,
  autoStart: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  (tauri.tftpConfigGet as any).mockResolvedValue(cfg);
  (tauri.tftpStatus as any).mockResolvedValue({
    running: false,
    bindAddress: null,
    startedAt: null,
    lastError: null,
    elevated: false,
  });
  (tauri.tftpEventsTail as any).mockResolvedValue([]);
});

describe("TftpSettingsTab", () => {
  it("shows the empty-activity state when there are no events", async () => {
    render(<TftpSettingsTab visible={true} />);
    await waitFor(() => expect(screen.getByText(/no transfers yet/i)).toBeInTheDocument());
  });

  it("renders a feed row per event", async () => {
    (tauri.tftpEventsTail as any).mockResolvedValue([
      { id: 1, ts: 1, kind: "write", clientIp: "10.0.0.1", path: "r.cfg", detail: null },
      { id: 2, ts: 2, kind: "read", clientIp: "10.0.0.2", path: "img.bin", detail: "100 bytes" },
    ]);
    render(<TftpSettingsTab visible={true} />);
    await waitFor(() => expect(screen.getByTestId("tftp-feed")).toBeInTheDocument());
    expect(screen.getByText("r.cfg")).toBeInTheDocument();
    expect(screen.getByText("img.bin")).toBeInTheDocument();
    expect(screen.getByText("write")).toBeInTheDocument();
    expect(screen.getByText("read")).toBeInTheDocument();
  });

  it("shows a Start button when stopped", async () => {
    render(<TftpSettingsTab visible={true} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument());
  });

  it("surfaces status.lastError when stopped after a failed bind", async () => {
    (tauri.tftpStatus as any).mockResolvedValue({
      running: false,
      bindAddress: null,
      startedAt: null,
      lastError: "bind: address in use",
      elevated: false,
    });
    render(<TftpSettingsTab visible={true} />);
    await waitFor(() =>
      expect(screen.getByTestId("tftp-last-error")).toBeInTheDocument(),
    );
    expect(screen.getByText(/bind: address in use/i)).toBeInTheDocument();
    // Pill reflects an error state rather than a plain "Stopped".
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("stops polling when hidden and resumes when shown", async () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(<TftpSettingsTab visible={true} />);

    // Flush initial load (calls tftpStatus once via load())
    await vi.runOnlyPendingTimersAsync();
    expect(tauri.tftpConfigGet).toHaveBeenCalled();
    vi.clearAllMocks();

    // Advance through one poll cycle (interval fires)
    vi.advanceTimersByTime(1500);
    await vi.runOnlyPendingTimersAsync();
    expect(tauri.tftpStatus).toHaveBeenCalled();
    vi.clearAllMocks();

    // Hide → no more polls
    rerender(<TftpSettingsTab visible={false} />);
    vi.advanceTimersByTime(3000);
    await vi.runOnlyPendingTimersAsync();
    expect(tauri.tftpStatus).not.toHaveBeenCalled();

    // Show → resume polling (load() fires again)
    rerender(<TftpSettingsTab visible={true} />);
    await vi.runOnlyPendingTimersAsync();
    expect(tauri.tftpStatus).toHaveBeenCalled(); // from load()
    vi.clearAllMocks();
    vi.advanceTimersByTime(1500);
    await vi.runOnlyPendingTimersAsync();
    expect(tauri.tftpStatus).toHaveBeenCalled(); // from interval
    vi.clearAllMocks();

    // Unmount → no more polls
    unmount();
    vi.advanceTimersByTime(3000);
    await vi.runOnlyPendingTimersAsync();
    expect(tauri.tftpStatus).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

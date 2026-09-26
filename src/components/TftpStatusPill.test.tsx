import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TftpStatusPill } from "./TftpStatusPill";

vi.mock("../lib/tauri", () => ({
  tftpStatus: vi.fn(),
  tftpStart: vi.fn(),
  tftpStop: vi.fn(),
  tftpEventsTail: vi.fn(),
}));

import * as tauri from "../lib/tauri";

const stopped = {
  running: false,
  bindAddress: null,
  startedAt: null,
  lastError: null,
  elevated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  (tauri.tftpEventsTail as any).mockResolvedValue([]);
});

describe("TftpStatusPill", () => {
  it("shows 'TFTP: stopped' with the stopped class when not running", async () => {
    (tauri.tftpStatus as any).mockResolvedValue(stopped);
    render(<TftpStatusPill />);
    await waitFor(() =>
      expect(screen.getByText(/TFTP:/).textContent).toMatch(/stopped/i),
    );
    const pill = screen.getByRole("button");
    expect(pill.className).toContain("stopped");
  });

  it("shows the bind address and 'elevated' with the running class", async () => {
    (tauri.tftpStatus as any).mockResolvedValue({
      ...stopped,
      running: true,
      bindAddress: "0.0.0.0:69",
      elevated: true,
    });
    render(<TftpStatusPill />);
    await waitFor(() =>
      expect(screen.getByText(/TFTP:/).textContent).toMatch(/0\.0\.0\.0:69/),
    );
    const label = screen.getByText(/TFTP:/).textContent ?? "";
    expect(label).toMatch(/elevated/);
    expect(screen.getByRole("button").className).toContain("running");
  });

  it("shows the error state when stopped with a lastError", async () => {
    (tauri.tftpStatus as any).mockResolvedValue({
      ...stopped,
      lastError: "bind: address already in use",
    });
    render(<TftpStatusPill />);
    await waitFor(() =>
      expect(screen.getByText(/TFTP:/).textContent).toMatch(/error/i),
    );
    expect(screen.getByRole("button").className).toContain("error");
  });
});

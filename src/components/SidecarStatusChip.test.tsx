import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { SidecarStatusChip } from "./SidecarStatusChip";

describe("SidecarStatusChip", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("renders 'down' when the first status reports not-running", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: false,
      last_seen: null,
      version: null,
      pid: null,
      now: 1_700_000_000,
    });
    render(<SidecarStatusChip />);
    await waitFor(() => {
      expect(screen.getByText(/Sidecar:/)).toHaveTextContent(/down/i);
    });
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
});

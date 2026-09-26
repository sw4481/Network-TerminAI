import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock the tauri bindings so the component runs without a backend.
const proxmoxGetConfig = vi.fn();
const proxmoxSaveConfig = vi.fn();
const proxmoxTestConnection = vi.fn();
vi.mock("../../lib/tauri", () => ({
  proxmoxGetConfig: () => proxmoxGetConfig(),
  proxmoxSaveConfig: (c: unknown) => proxmoxSaveConfig(c),
  proxmoxTestConnection: (c: unknown) => proxmoxTestConnection(c),
}));

import { ProxmoxSettingsTab } from "./ProxmoxSettingsTab";

beforeEach(() => {
  proxmoxGetConfig.mockReset().mockResolvedValue(null);
  proxmoxSaveConfig.mockReset().mockResolvedValue(undefined);
  proxmoxTestConnection.mockReset();
});

describe("ProxmoxSettingsTab — Test connection button", () => {
  it("fires proxmoxTestConnection and renders a success message", async () => {
    proxmoxTestConnection.mockResolvedValue({ ok: true, message: "Connected. 3 node(s)." });
    render(<ProxmoxSettingsTab />);

    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "proxmox.example.test" } });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => expect(proxmoxTestConnection).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Connected\. 3 node\(s\)\./)).toBeInTheDocument();
  });

  it("renders an error message when the test fails", async () => {
    proxmoxTestConnection.mockResolvedValue({ ok: false, message: "Connection failed: 401 auth" });
    render(<ProxmoxSettingsTab />);

    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "proxmox.example.test" } });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    expect(await screen.findByText(/Connection failed: 401 auth/)).toBeInTheDocument();
  });

  it("guards against testing with an empty host (no backend call)", async () => {
    render(<ProxmoxSettingsTab />);
    // Host starts empty.
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/Enter a host before testing\./)).toBeInTheDocument();
    expect(proxmoxTestConnection).not.toHaveBeenCalled();
  });
});

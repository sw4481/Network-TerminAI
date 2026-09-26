/**
 * Plan 13 Phase 3 Task 3.3 — SaveNeighborModal tests.
 *
 * The modal is a self-contained, parent-controlled component that lets
 * the user save an unknown neighbor (clicked in InlineTopologyPanel) as
 * either an SSH connection or a NETCONF device. We mock both call paths:
 *   - `invoke("ssh_save_connection", ...)` for the SSH branch
 *   - `netconfDeviceCreate(...)` (TS wrapper in `src/lib/tauri.ts`) for
 *     the NETCONF branch
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const netconfDeviceCreateMock = vi.fn();
const netconfDeviceListMock = vi.fn();
vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    netconfDeviceCreate: (...args: unknown[]) =>
      netconfDeviceCreateMock(...args),
    netconfDeviceList: (...args: unknown[]) => netconfDeviceListMock(...args),
  };
});

import { SaveNeighborModal } from "./SaveNeighborModal";
import type { TopologyNode } from "../../lib/topology";

function makeNeighbor(overrides: Partial<TopologyNode> = {}): TopologyNode {
  return {
    graph_id: "g1",
    device_ref: "device:r5",
    device_kind: "discovered",
    label: "R5",
    vendor: "cisco",
    mgmt_ip: "10.0.0.5",
    ...overrides,
  };
}

describe("SaveNeighborModal", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    netconfDeviceCreateMock.mockReset();
    netconfDeviceListMock.mockReset();
    // Default: no existing rows for either lookup. Individual tests can
    // override via mockImplementation.
    netconfDeviceListMock.mockResolvedValue([]);
  });

  it("renders pre-filled form when open with a neighbor", () => {
    render(
      <SaveNeighborModal
        isOpen={true}
        neighbor={makeNeighbor()}
        onClose={() => {}}
      />,
    );

    const nameInput = screen.getByLabelText(/^name/i) as HTMLInputElement;
    const hostInput = screen.getByLabelText(/^host/i) as HTMLInputElement;

    expect(nameInput.value).toBe("R5");
    expect(hostInput.value).toBe("10.0.0.5");
    // Host is read-only — it represents the resolved neighbor address.
    expect(hostInput.readOnly).toBe(true);
  });

  it("returns null when isOpen=false", () => {
    const { container } = render(
      <SaveNeighborModal
        isOpen={false}
        neighbor={makeNeighbor()}
        onClose={() => {}}
      />,
    );
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("returns null when neighbor=null", () => {
    const { container } = render(
      <SaveNeighborModal isOpen={true} neighbor={null} onClose={() => {}} />,
    );
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("saves SSH on submit (kind=ssh)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ssh_list_connections") return Promise.resolve([]);
      if (cmd === "ssh_save_connection") {
        return Promise.resolve({
          id: "conn-1",
          name: "R5",
          host: "10.0.0.5",
          user: "admin",
          port: 22,
          identity_file: null,
          password_encrypted: null,
          created_at: 0,
          last_used_at: null,
        });
      }
      return Promise.resolve(undefined);
    });

    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <SaveNeighborModal
        isOpen={true}
        neighbor={makeNeighbor()}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    // SSH is the default kind. Fill in optional username.
    const usernameInput = screen.getByLabelText(/username/i) as HTMLInputElement;
    fireEvent.change(usernameInput, { target: { value: "admin" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("ssh_save_connection", {
        request: {
          name: "R5",
          host: "10.0.0.5",
          user: "admin",
          port: 22,
          identity_file: null,
          password: null,
        },
      }),
    );

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("ssh", "10.0.0.5"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(netconfDeviceCreateMock).not.toHaveBeenCalled();
  });

  it("saves NETCONF on submit (kind=netconf)", async () => {
    netconfDeviceCreateMock.mockResolvedValue({
      id: 7,
      name: "R5",
      host: "10.0.0.5",
      port: 830,
      username: "admin",
      verify_host_key: true,
      created_at: "2026-05-19T00:00:00Z",
    });

    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <SaveNeighborModal
        isOpen={true}
        neighbor={makeNeighbor()}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    // Switch radio to NETCONF
    fireEvent.click(screen.getByLabelText(/save as netconf/i));

    // Fill username + password
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "secret" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(netconfDeviceCreateMock).toHaveBeenCalledWith(
        "R5",
        "10.0.0.5",
        830,
        "admin",
        "secret",
        true,
      ),
    );

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("netconf", "10.0.0.5"),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows validation error for empty name", async () => {
    render(
      <SaveNeighborModal
        isOpen={true}
        neighbor={makeNeighbor()}
        onClose={() => {}}
      />,
    );

    const nameInput = screen.getByLabelText(/^name/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(screen.getByText(/name is required/i)).toBeInTheDocument(),
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(netconfDeviceCreateMock).not.toHaveBeenCalled();
  });

  it("warns and aborts when SSH connection name already exists with a different host", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ssh_list_connections") {
        return Promise.resolve([
          { name: "R5", host: "10.99.99.99", user: null, port: 22 },
        ]);
      }
      return Promise.resolve(undefined);
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <SaveNeighborModal
        isOpen={true}
        neighbor={makeNeighbor()}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(invokeMock).not.toHaveBeenCalledWith(
      "ssh_save_connection",
      expect.anything(),
    );
    expect(onSaved).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("proceeds with save when user accepts the overwrite confirm", async () => {
    invokeMock.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "ssh_list_connections") {
        return Promise.resolve([
          { name: "R5", host: "10.99.99.99", user: null, port: 22 },
        ]);
      }
      if (cmd === "ssh_save_connection") {
        return Promise.resolve({ id: "abc", ...(args?.request ?? {}) });
      }
      return Promise.resolve(undefined);
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <SaveNeighborModal
        isOpen={true}
        neighbor={makeNeighbor()}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "ssh_save_connection",
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("ssh", expect.any(String)),
    );
    confirmSpy.mockRestore();
  });

  it("flips port default to 830 when switching to NETCONF", () => {
    render(
      <SaveNeighborModal
        isOpen={true}
        neighbor={makeNeighbor()}
        onClose={() => {}}
      />,
    );

    const portInput = screen.getByLabelText(/port/i) as HTMLInputElement;
    expect(portInput.value).toBe("22");

    fireEvent.click(screen.getByLabelText(/save as netconf/i));
    expect(portInput.value).toBe("830");

    fireEvent.click(screen.getByLabelText(/save as ssh/i));
    expect(portInput.value).toBe("22");
  });
});

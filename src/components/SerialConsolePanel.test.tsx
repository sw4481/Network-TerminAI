import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SerialConsolePanel } from "./SerialConsolePanel";
import type { SerialEvent } from "../lib/serial";

const mocks = vi.hoisted(() => ({
  listPorts: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
  sendBreak: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../lib/serial", () => ({
  serialListPorts: mocks.listPorts,
  serialOpen: mocks.open,
  serialWrite: mocks.write,
  serialSendBreak: mocks.sendBreak,
  serialClose: mocks.close,
}));
vi.mock("../theme/AppearanceProvider", () => ({
  useAppearance: () => ({ settings: {} }),
}));
vi.mock("../lib/terminalAppearance", () => ({
  createTerminalOptions: () => ({}),
  applyTerminalOptions: vi.fn(),
  terminalMetricsChanged: () => false,
}));

class FakeDisposable {
  dispose = vi.fn();
}

class FakeTerminal {
  static latest: FakeTerminal | null = null;
  writes: unknown[] = [];
  dataHandler: ((data: string) => void) | null = null;
  binaryHandler: ((data: string) => void) | null = null;
  loadAddon = vi.fn();
  open = vi.fn();
  focus = vi.fn();
  dispose = vi.fn();
  onData = vi.fn((handler: (data: string) => void) => {
    this.dataHandler = handler;
    return new FakeDisposable();
  });
  onBinary = vi.fn((handler: (data: string) => void) => {
    this.binaryHandler = handler;
    return new FakeDisposable();
  });
  write = vi.fn((value: unknown) => this.writes.push(value));

  constructor() {
    FakeTerminal.latest = this;
  }
}

class FakeFitAddon {
  fit = vi.fn();
}

describe("SerialConsolePanel", () => {
  let eventHandler: ((event: SerialEvent) => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandler = null;
    FakeTerminal.latest = null;
    (window as any).Terminal = FakeTerminal;
    (window as any).FitAddon = FakeFitAddon;
    (window as any).WebLinksAddon = undefined;
    mocks.listPorts.mockResolvedValue([{
      port_name: "/dev/cu.usbserial-A",
      port_type: "usb",
      vid: 1027,
      pid: 24577,
      serial_number: "SERIAL-A",
      manufacturer: "FTDI",
      product: "USB Serial",
    }]);
    mocks.open.mockImplementation(async (_config, onEvent) => {
      eventHandler = onEvent;
      onEvent({ type: "connected", session_id: "serial-1", port_name: "/dev/cu.usbserial-A" });
      return "serial-1";
    });
    mocks.write.mockResolvedValue(undefined);
    mocks.sendBreak.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(true);
  });

  it("opens with 9600 8N1/no-flow defaults and owns a separate xterm", async () => {
    const { unmount } = render(<SerialConsolePanel onClose={() => {}} />);
    expect(await screen.findByRole("option", { name: /USB Serial/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith({
      port_name: "/dev/cu.usbserial-A",
      baud_rate: 9600,
      data_bits: "eight",
      parity: "none",
      stop_bits: "one",
      flow_control: "none",
    }, expect.any(Function)));
    expect(screen.getByText(/connected · \/dev\/cu\.usbserial-A/i)).toBeInTheDocument();
    expect(FakeTerminal.latest).not.toBeNull();

    FakeTerminal.latest?.dataHandler?.("show version\r");
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(
      "serial-1",
      new TextEncoder().encode("show version\r"),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Send Break" }));
    expect(mocks.sendBreak).toHaveBeenCalledWith("serial-1");

    unmount();
    expect(mocks.close).toHaveBeenCalledWith("serial-1");
  });

  it("preserves output and disables input while reconnecting", async () => {
    render(<SerialConsolePanel onClose={() => {}} />);
    await screen.findByRole("option", { name: /USB Serial/ });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(eventHandler).not.toBeNull());

    eventHandler?.({ type: "data", session_id: "serial-1", bytes: [65, 66, 67] });
    const terminal = FakeTerminal.latest;
    const writesBeforeReconnect = terminal?.writes.length ?? 0;
    eventHandler?.({
      type: "reconnecting",
      session_id: "serial-1",
      port_name: "/dev/cu.usbserial-A",
      message: null,
    });

    expect(await screen.findByRole("status")).toHaveTextContent("same device");
    expect(screen.getByLabelText("Serial port")).toBeDisabled();
    terminal?.dataHandler?.("ignored");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(FakeTerminal.latest).toBe(terminal);
    expect(terminal?.writes.length).toBe(writesBeforeReconnect);
  });
});

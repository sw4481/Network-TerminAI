import { Channel, invoke } from "@tauri-apps/api/core";

export interface SerialPortDescriptor {
  port_name: string;
  port_type: "usb" | "bluetooth" | "pci" | "unknown";
  vid: number | null;
  pid: number | null;
  serial_number: string | null;
  manufacturer: string | null;
  product: string | null;
}

export type SerialDataBits = "seven" | "eight";
export type SerialParity = "none" | "even" | "odd";
export type SerialStopBits = "one" | "two";
export type SerialFlowControl = "none" | "software" | "hardware";

export interface SerialOpenConfig {
  port_name: string;
  baud_rate: number;
  data_bits: SerialDataBits;
  parity: SerialParity;
  stop_bits: SerialStopBits;
  flow_control: SerialFlowControl;
}

export type SerialEvent =
  | { type: "data"; session_id: string; bytes: number[] }
  | { type: "connected"; session_id: string; port_name: string }
  | { type: "reconnecting"; session_id: string; port_name: string; message: string | null }
  | { type: "disconnected"; session_id: string; reason: string }
  | { type: "error"; session_id: string; message: string };

export const serialListPorts = (): Promise<SerialPortDescriptor[]> =>
  invoke<SerialPortDescriptor[]>("serial_list_ports");

export async function serialOpen(
  config: SerialOpenConfig,
  onEvent: (event: SerialEvent) => void,
): Promise<string> {
  const channel = new Channel<SerialEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("serial_open", { config, onEvent: channel });
}

export const serialWrite = (sessionId: string, bytes: Uint8Array): Promise<void> =>
  invoke<void>("serial_write", { sessionId, bytes: Array.from(bytes) });

export const serialSendBreak = (sessionId: string): Promise<void> =>
  invoke<void>("serial_send_break", { sessionId });

export const serialClose = (sessionId: string): Promise<boolean> =>
  invoke<boolean>("serial_close", { sessionId });

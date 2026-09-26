import { create } from "zustand";
import type { PyatsDevice } from "../features/pyats/api";

export type TabTransport = "sshpass" | "pyats";

interface PyatsState {
  devices: PyatsDevice[];
  transport: TabTransport;
  setDevices: (d: PyatsDevice[]) => void;
  addDevice: (d: PyatsDevice) => void;
  updateDevice: (index: number, d: PyatsDevice) => void;
  removeDevice: (index: number) => void;
  setTransport: (t: TabTransport) => void;
}

const emptyDevice = (): PyatsDevice => ({
  name: "",
  host: "",
  os: "iosxe",
  port: 22,
  username: "",
  password: "",
  enablePassword: "",
  platform: null,
});

export const usePyatsStore = create<PyatsState>((set) => ({
  devices: [],
  transport: "sshpass",
  setDevices: (devices) => set({ devices }),
  addDevice: (d) => set((s) => ({ devices: [...s.devices, d] })),
  updateDevice: (index, d) =>
    set((s) => ({ devices: s.devices.map((x, i) => (i === index ? d : x)) })),
  removeDevice: (index) =>
    set((s) => ({ devices: s.devices.filter((_, i) => i !== index) })),
  setTransport: (transport) => set({ transport }),
}));

export { emptyDevice };

import { invoke } from "@tauri-apps/api/core";

export interface PyatsDevice {
  name: string;
  host: string;
  os: string;
  port: number;
  username: string;
  password: string;
  enablePassword: string;
  platform: string | null;
}

export interface PyatsConnTest {
  ok: boolean;
  message: string;
}

export async function saveTestbed(devices: PyatsDevice[]): Promise<string> {
  return invoke<string>("pyats_save_testbed", { devices });
}

export async function testConnection(device: PyatsDevice): Promise<PyatsConnTest> {
  return invoke<PyatsConnTest>("pyats_test_connection", { device });
}


export async function importFromTopology(): Promise<PyatsDevice[]> {
  return invoke<PyatsDevice[]>("pyats_import_from_topology");
}

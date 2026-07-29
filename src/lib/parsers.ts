import { invoke } from "@tauri-apps/api/core";

export type ParseArgs = { vendor: string; platform: string; command: string; raw: string };
export type ParseResponse<T = unknown> = { parser: "genie" | "textfsm"; data: T; from_cache: boolean };

export async function parseShow<T = unknown>(args: ParseArgs): Promise<ParseResponse<T>> {
  return invoke<ParseResponse<T>>("parse_show", { args });
}

/**
 * Plan 11 — Tauri invoke wrappers for the packet-capture surface.
 *
 * The orchestrator emits `pcap://progress/<id>` events; subscribe with
 * `subscribePcapProgress(captureId, cb)`.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type DeviceKind = 'iosxe' | 'nxos' | 'junos' | 'eos';

export interface PcapTemplate {
  id: string;
  name: string;
  vendor: string;
  platform: string;
  interface: string | null;
  acl: string | null;
  duration_s: number;
  builtin: boolean;
}

export interface PcapCapture {
  id: string;
  session_id: string | null;
  device_ref: string;
  device_kind: DeviceKind;
  interface: string;
  filter: string | null;
  started_at: number | null;
  ended_at: number | null;
  status: 'setup' | 'capturing' | 'pulling' | 'ready' | 'failed';
  local_path: string | null;
  packet_count: number | null;
  size_bytes: number | null;
  error: string | null;
  created_at: number;
}

export interface PcapPacket {
  no: number;
  time: number;
  src: string | null;
  dst: string | null;
  protocol: string;
  length: number;
}

export interface PcapSummary {
  packet_count: number;
  packets: PcapPacket[];
}

export interface PcapPacketBytes {
  hex: string;
  ascii: string;
  length: number;
}

export interface FollowStreamResult {
  client_ascii: string;
  server_ascii: string;
  client_bytes: number;
  server_bytes: number;
  packets: PcapPacket[];
}

export interface CaptureSpec {
  capture_name: string;
  device_kind: DeviceKind;
  interface: string;
  acl: string | null;
  duration_s: number;
  buffer_mb: number;
  on_device_path: string;
}

export interface DeviceConn {
  host: string;
  port: number;
  username: string;
  password: string;
}

export type CaptureProgress =
  | { phase: 'started' }
  | { phase: 'capturing' }
  | { phase: 'pulling'; bytes: number; total: number | null }
  | {
      phase: 'ready';
      local_path: string;
      size_bytes: number;
      packet_count: number;
    }
  | { phase: 'size-warning'; size_bytes: number }
  | { phase: 'failed'; error: string };

export const listTemplates = () =>
  invoke<PcapTemplate[]>('pcap_list_templates');

export const createTemplate = (template: PcapTemplate) =>
  invoke<string>('pcap_create_template', { template });

export const updateTemplate = (template: PcapTemplate) =>
  invoke<void>('pcap_update_template', { template });

export const deleteTemplate = (id: string) =>
  invoke<void>('pcap_delete_template', { id });

export const captureGet = (id: string) =>
  invoke<PcapCapture | null>('pcap_capture_get', { id });

export const captureList = (sessionId?: string) =>
  invoke<PcapCapture[]>('pcap_capture_list', { sessionId });

export const captureDelete = (id: string) =>
  invoke<void>('pcap_capture_delete', { id });

export const startCapture = (
  spec: CaptureSpec,
  conn: DeviceConn,
  sessionId?: string,
) =>
  invoke<{ capture_id: string }>('pcap_start_capture', {
    args: { spec, conn, session_id: sessionId ?? null },
  });

export const cancelCapture = (id: string) =>
  invoke<boolean>('pcap_cancel', { id });

export const summarize = (
  captureId: string,
  options?: { maxPackets?: number; displayFilter?: string | null },
) =>
  invoke<PcapSummary>('pcap_summarize', {
    captureId,
    maxPackets: options?.maxPackets ?? 200,
    displayFilter: options?.displayFilter ?? null,
  });

export const packetBytes = (captureId: string, index: number) =>
  invoke<PcapPacketBytes>('pcap_packet_bytes', { captureId, index });

export const followStream = (captureId: string, streamIndex: number) =>
  invoke<FollowStreamResult>('pcap_follow_stream', { captureId, streamIndex });

export const exportPcap = (captureId: string, destPath: string) =>
  invoke<number>('pcap_export', { captureId, destPath });

export const subscribePcapProgress = async (
  captureId: string,
  cb: (event: CaptureProgress) => void,
) => {
  const unlisten = await listen<CaptureProgress>(
    `pcap://progress/${captureId}`,
    (e) => cb(e.payload),
  );
  return unlisten;
};

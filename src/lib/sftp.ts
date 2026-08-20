import { Channel, invoke } from '@tauri-apps/api/core';

export type SftpSide = 'local' | 'remote';
export type SftpMutation = 'mkdir' | 'rename' | 'delete';
export type SftpTransferDirection = 'upload' | 'download';

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number | null;
  modified_at: number | null;
}

export interface SftpListing {
  path: string;
  entries: SftpEntry[];
}

export type SftpTransferEvent =
  | { type: 'started'; transfer_id: string; total: number | null }
  | { type: 'progress'; transfer_id: string; bytes: number; total: number | null }
  | { type: 'completed'; transfer_id: string; bytes: number }
  | { type: 'cancelled'; transfer_id: string }
  | { type: 'error'; transfer_id: string; message: string };

export const sftpConnect = (connectionId: string, passwordOverride?: string) =>
  invoke<string>('sftp_connect', {
    connectionId,
    passwordOverride: passwordOverride?.length ? passwordOverride : null,
  });

export const sftpList = (side: SftpSide, path: string, sessionId?: string) =>
  invoke<SftpListing>('sftp_list', {
    side,
    path,
    sessionId: sessionId ?? null,
  });

export const sftpMutate = (
  side: SftpSide,
  operation: SftpMutation,
  path: string,
  destination?: string,
  sessionId?: string,
) =>
  invoke<void>('sftp_mutate', {
    side,
    operation,
    path,
    destination: destination ?? null,
    sessionId: sessionId ?? null,
  });

export const sftpTransfer = (
  sessionId: string,
  direction: SftpTransferDirection,
  localPath: string,
  remotePath: string,
  onEvent: (event: SftpTransferEvent) => void,
) => {
  const channel = new Channel<SftpTransferEvent>();
  channel.onmessage = onEvent;
  return invoke<string>('sftp_transfer', {
    sessionId,
    direction,
    localPath,
    remotePath,
    onEvent: channel,
  });
};

export const sftpCancelTransfer = (transferId: string) =>
  invoke<boolean>('sftp_cancel_transfer', { transferId });

export const sftpDisconnect = (sessionId: string) =>
  invoke<void>('sftp_disconnect', { sessionId });

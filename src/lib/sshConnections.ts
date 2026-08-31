import { invoke } from "@tauri-apps/api/core";
import type { DeviceAccentColor, SyntaxProfile, Vendor } from "./deviceProfiles";

export interface SshConnection {
  id: string;
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  password_encrypted: string | null;
  folder_id: string;
  tags: string[];
  accent_color: DeviceAccentColor | null;
  vendor: Vendor;
  platform: string;
  syntax_highlighting_enabled: boolean;
  syntax_profile: SyntaxProfile;
  created_at: number;
  last_used_at: number | null;
}

export interface SshFolder {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface SaveSshConnectionRequest {
  name: string;
  host: string;
  user?: string | null;
  port?: number | null;
  identity_file?: string | null;
  password?: string | null;
  folder_id?: string;
  tags?: string[];
  /** Empty string explicitly clears an existing accent. */
  accent_color?: DeviceAccentColor | "";
  vendor?: Vendor;
  platform?: string;
  syntax_highlighting_enabled?: boolean;
  syntax_profile?: SyntaxProfile;
}

export type UpdateSshConnectionRequest = SaveSshConnectionRequest;

export interface CreateSshFolderRequest {
  parent_id?: string | null;
  name: string;
  position?: number | null;
}

export interface UpdateSshFolderRequest {
  parent_id: string;
  name: string;
  position: number;
}

export interface SafeSshConnectionMetadata {
  id: string;
  display_name: string;
  vendor: Vendor;
  platform: string;
  accent_color: DeviceAccentColor | null;
  syntax_highlighting_enabled: boolean;
  syntax_profile: SyntaxProfile;
}

export interface SshConnectEventDetail {
  command: string;
  targetTabId: string | null;
  connection: SafeSshConnectionMetadata;
  credentials: {
    host: string;
    user: string | null;
    password: string | null;
  };
}

export type SshImportSourceType = "securecrt" | "mtputty" | "mobaxterm" | "openssh" | "csv";
export type SshImportAction = "create" | "update" | "skip";
export type SshImportCredentialState = "none" | "plaintext" | "unsupported";

export interface SshImportPreviewRow {
  source: string;
  name: string;
  host: string;
  user: string | null;
  port: number;
  identity_file: string | null;
  folder: string | null;
  tags: string[];
  action: SshImportAction;
  credential_state: SshImportCredentialState;
  warnings: string[];
}

export interface SshImportPreview {
  source_type: SshImportSourceType;
  source_path: string;
  fingerprint: string;
  rows: SshImportPreviewRow[];
  warnings: string[];
}

export interface SshImportResult {
  created: number;
  updated: number;
  skipped: number;
  credential_skipped: number;
  warnings: string[];
}

export const sshListConnections = (): Promise<SshConnection[]> =>
  invoke<SshConnection[]>("ssh_list_connections");

export const sshGetConnection = (id: string): Promise<SshConnection> =>
  invoke<SshConnection>("ssh_get_connection", { id });

export const sshSaveConnection = (request: SaveSshConnectionRequest): Promise<SshConnection> =>
  invoke<SshConnection>("ssh_save_connection", { request });

export const sshUpdateConnection = (
  id: string,
  request: UpdateSshConnectionRequest,
): Promise<SshConnection> => invoke<SshConnection>("ssh_update_connection", { id, request });

export const sshDeleteConnection = (id: string): Promise<void> =>
  invoke<void>("ssh_delete_connection", { id });

export const sshMarkUsed = (id: string): Promise<void> =>
  invoke<void>("ssh_mark_used", { id });

export const sshDecryptPassword = (encrypted: string): Promise<string | null> =>
  invoke<string | null>("ssh_decrypt_password", { encrypted });

export const sshListFolders = (): Promise<SshFolder[]> =>
  invoke<SshFolder[]>("ssh_list_folders");

export const sshCreateFolder = (request: CreateSshFolderRequest): Promise<SshFolder> =>
  invoke<SshFolder>("ssh_create_folder", { request });

export const sshUpdateFolder = (
  id: string,
  request: UpdateSshFolderRequest,
): Promise<SshFolder> => invoke<SshFolder>("ssh_update_folder", { id, request });

export const sshDeleteFolder = (id: string): Promise<void> =>
  invoke<void>("ssh_delete_folder", { id });

export const sshImportPreview = (
  sourceType: SshImportSourceType,
  sourcePath: string,
): Promise<SshImportPreview> =>
  invoke<SshImportPreview>("ssh_import_preview", { sourceType, sourcePath });

export const sshImportCommit = (
  sourceType: SshImportSourceType,
  sourcePath: string,
  fingerprint: string,
): Promise<SshImportResult> =>
  invoke<SshImportResult>("ssh_import_commit", { sourceType, sourcePath, fingerprint });

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildSshCommand(connection: Pick<SshConnection, "host" | "user" | "port" | "identity_file">): string {
  // Always pin the effective port. Omitting `-p 22` would let a matching
  // Host stanza in ~/.ssh/config silently redirect a saved device record.
  const parts = [
    "/usr/bin/ssh",
    "-p",
    String(connection.port ?? 22),
    "-o",
    quoteShellArgument(`HostName=${connection.host}`),
  ];
  if (connection.identity_file) parts.push("-i", quoteShellArgument(connection.identity_file));
  parts.push("--");
  parts.push(quoteShellArgument(connection.user ? `${connection.user}@${connection.host}` : connection.host));
  return parts.join(" ");
}

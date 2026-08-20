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

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildSshCommand(connection: Pick<SshConnection, "host" | "user" | "port" | "identity_file">): string {
  const parts = ["ssh"];
  if (connection.port && connection.port !== 22) parts.push("-p", String(connection.port));
  if (connection.identity_file) parts.push("-i", quoteShellArgument(connection.identity_file));
  parts.push(quoteShellArgument(connection.user ? `${connection.user}@${connection.host}` : connection.host));
  return parts.join(" ");
}

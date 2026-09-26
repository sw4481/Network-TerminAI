import { invoke } from "@tauri-apps/api/core";

export type SecretKind =
  | "password"
  | "ssh_key"
  | "api_token"
  | "snmp_community"
  | "netconf";

export interface EnvelopeDto {
  id: string;
  name: string;
  description?: string | null;
  createdAt: number;
  updatedAt: number;
  autoUnlock: boolean;
}

export interface SecretDto {
  id: string;
  envelopeId: string;
  kind: SecretKind;
  label: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  lastUsedAt?: number | null;
  rotatesAt?: number | null;
  expiresAt?: number | null;
}

export interface VaultSessionRow {
  id: string;
  envelope_id: string;
  envelope_name: string;
  unlocked_at: number;
  locked_at: number | null;
  reason: string | null;
}

export const vault = {
  listEnvelopes: () => invoke<EnvelopeDto[]>("vault_list_envelopes"),
  createEnvelope: (
    name: string,
    description: string | null,
    passphrase: string,
  ) =>
    invoke<EnvelopeDto>("vault_create_envelope", {
      name,
      description,
      passphrase,
    }),
  unlock: (name: string, passphrase: string) =>
    invoke<string>("vault_unlock", { name, passphrase }),
  lock: (envelopeId: string) =>
    invoke<void>("vault_lock", { envelopeId }),
  deleteEnvelope: (envelopeId: string) =>
    invoke<void>("vault_delete_envelope", { envelopeId }),
  addSecret: (
    envelopeId: string,
    kind: SecretKind,
    label: string,
    plaintext: string,
    metadata: Record<string, unknown> = {},
  ) =>
    invoke<SecretDto>("vault_add_secret", {
      envelopeId,
      kind,
      label,
      plaintext,
      metadataJson: JSON.stringify(metadata),
    }),
  listSecrets: (envelopeId: string) =>
    invoke<SecretDto[]>("vault_list_secrets", { envelopeId }),
  revealSecret: (secretId: string) =>
    invoke<string>("vault_reveal_secret", { secretId }),
  deleteSecret: (secretId: string) =>
    invoke<void>("vault_delete_secret", { secretId }),
  rotateSecret: (secretId: string, newPlaintext: string) =>
    invoke<void>("vault_rotate_secret", {
      secretId,
      newPlaintext,
    }),
  unlockedIds: () => invoke<string[]>("vault_unlocked_ids"),
  setAutoUnlock: (
    envelopeId: string,
    enabled: boolean,
    passphrase: string | null,
  ) =>
    invoke<void>("vault_set_auto_unlock", {
      envelopeId,
      enabled,
      passphrase,
    }),
  idleSweep: () => invoke<string[]>("vault_idle_sweep"),
  auditList: (
    envelopeId: string | null,
    since: number | null,
    limit: number | null,
  ) =>
    invoke<VaultSessionRow[]>("vault_audit_list", {
      envelopeId,
      since,
      limit,
    }),
  importCsv: (
    envelopeId: string,
    csvPath: string,
    format: "1password" | "bitwarden" | null,
    secureDeleteAfter: boolean,
  ) =>
    invoke<{ imported: number; skipped: number; errors: string[] }>(
      "vault_import_csv",
      { envelopeId, csvPath, format, secureDeleteAfter },
    ),
};

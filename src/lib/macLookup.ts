import { invoke } from '@tauri-apps/api/core';

export interface RegistryInfo {
  snapshot_at: string;
  loaded_from: 'bundled' | 'updated';
  record_count: number;
  sources: { registry: string; url: string }[];
  cache_warning: string | null;
}

export interface MacLookupResult {
  normalized: string;
  formats: { colon: string; hyphen: string; dotted: string; plain: string };
  oui: string;
  binary: string;
  is_multicast: boolean;
  is_locally_administered: boolean;
  is_broadcast: boolean;
  is_zero: boolean;
  warnings: string[];
  assignment: {
    registry: string;
    prefix: string;
    prefix_length: number;
    organization: string;
    organization_address: string;
    block_start: string;
    block_end: string;
    address_count: number;
  } | null;
  registry: RegistryInfo;
}

export const lookupMacAddress = (address: string) =>
  invoke<MacLookupResult>('mac_lookup', { address });

export const getMacRegistryInfo = () =>
  invoke<RegistryInfo>('mac_registry_info');

// Native IPC has no frontend deadline; IEEE downloads are bounded by the backend.
export const updateMacRegistry = () =>
  invoke<RegistryInfo>('mac_registry_update');

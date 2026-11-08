/**
 * Plan 13 Phase 1.4 — Frontend wrapper for the topology Tauri commands.
 *
 * This module is intentionally thin: it owns the TS types for the
 * topology data model (kept in sync with `src-tauri/src/topology/mod.rs`)
 * and exposes a typed `topologyApi` that just forwards to `invoke()`.
 * Business logic (caching, selectors, error handling) lives in
 * `src/state/topologyStore.ts`.
 */
import { invoke } from "@tauri-apps/api/core";

export type Protocol = "cdp" | "lldp" | "bgp" | "ospf" | "isis" | "eigrp" | "unknown";

export interface TopologyNode {
  graph_id: string;
  device_ref: string;
  device_kind: "ssh" | "netconf" | "discovered";
  label: string;
  vendor?: string;
  platform?: string;
  mgmt_ip?: string;
}

export interface TopologyEdge {
  graph_id: string;
  a_device_ref: string;
  a_port: string;
  b_device_ref: string;
  b_port: string;
  protocol: Protocol;
  captured_at: number;
}

export interface TopologyGraph {
  id: string;
  name: string;
  description?: string;
  created_at: number;
  updated_at: number;
}

export interface NodePosition {
  device_ref: string;
  x: number;
  y: number;
}

export interface TopologyImportProvenance {
  format: "sc2" | "native";
  imported_at: number;
  source_graph_id?: string;
  node_metadata: { device_ref: string; placeholder: boolean; model?: string; serial?: string; os_version?: string }[];
  unsupported_protocols: { a_device_ref: string; a_port: string; b_device_ref: string; b_port: string; raw_protocol: string }[];
}

export interface TopologyImportPreview {
  format: "sc2" | "native";
  node_count: number;
  edge_count: number;
  placeholder_count: number;
  warnings: string[];
}

export interface RoutingEvidence {
  state: string;
  established: boolean;
  peer_address: string | null;
  vrf: string | null;
  address_family: string | null;
  instance: string | null;
  level: string | null;
  scope_supported: boolean;
  interface_association?: {
    interface: string;
    local_address: string;
    prefix_length: number;
    source_command: string;
    relationship: "same_subnet_unverified";
  } | null;
}

export interface NeighborRecord {
  protocol: string;
  local_port: string;
  neighbor_name: string;
  neighbor_port: string;
  neighbor_mgmt_ip: string | null;
  neighbor_platform: string | null;
  neighbor_vendor: string | null;
  capabilities: string[];
  routing?: RoutingEvidence | null;
}

export interface NeighborObservation {
  record: NeighborRecord;
  captured_at: number;
  in_latest_capture: boolean;
}

export interface SnmpObservation {
  captured_at?: number;
  in_latest_attempt?: boolean;
  index: number[];
  neighbor_name: string;
  local_port_id: string;
  local_port_description: string;
  remote_port_id: string;
  remote_port_description: string;
  remote_port_subtype: number | null;
  local_ifindex: number | null;
  mapping: string | null;
  reason: string | null;
  management_addresses: string[];
  management_indexes: number[][];
}

export interface CaptureEvidence {
  source_ref: string;
  protocol: string;
  source_command: string;
  attempted_at: number;
  status: "incomplete" | "completed" | "failed" | "unsupported";
  observations: NeighborObservation[];
  snmp_observations?: SnmpObservation[];
}

export interface GraphSnapshot {
  graph: TopologyGraph;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  positions?: NodePosition[];
  /** Import origin only; subsequent native observations may coexist. */
  import_provenance?: TopologyImportProvenance;
  /** Local collection evidence; intentionally excluded from native v1 interchange. */
  capture_evidence?: CaptureEvidence[];
}

export interface DiscoverySummary extends IngestSummary {
  status: "completed" | "partial" | "failed";
  captures: {
    protocol: string;
    status: "completed" | "failed" | "unsupported";
    records: number;
    error?: string;
  }[];
}

export type CollectionMode = "ssh" | "snmp_v3" | "snmp_v2c";

export interface DiscoveryRequest {
  graph_id: string;
  seed_ids: string[];
  eligible_ids: string[];
  passwords: Record<string, string>;
  max_depth: 0 | 1;
  include_routing?: boolean;
  collection_mode?: CollectionMode;
  snmp_secret_id?: string;
}
export interface DiscoveryRun {
  collection_mode?: CollectionMode;
  run_id: string;
  graph_id: string;
  state: "running" | "cancelling" | "completed" | "cancelled" | "timed_out" | "failed";
  max_depth: 0 | 1;
  devices: { connection_id: string; host: string; depth: number; status: string; captures: DiscoverySummary["captures"]; error?: string | null }[];
  not_dialed: { reference: string; reason: string }[];
  additional_not_dialed: number;
  nodes_processed: number;
  edges_processed: number;
  parser_admission_ms: number;
  parser_reply_ms: number;
}

/** A render projection only: legacy rows remain intact in the database. */
export class TopologyProjection {
  static project(rows: TopologyNode[], graphId: string): { nodes: TopologyNode[]; warnings: string[] } {
    const groups = new Map<string, TopologyNode[]>();
    for (const row of rows) {
      if (row.graph_id !== graphId) continue;
      const group = groups.get(row.device_ref) ?? [];
      group.push(row);
      groups.set(row.device_ref, group);
    }
    const nodes: TopologyNode[] = [];
    const warnings: string[] = [];
    const priority = { ssh: 0, netconf: 1, discovered: 2 };
    const fields = ["device_kind", "label", "vendor", "platform", "mgmt_ip"] as const;
    for (const ref of [...groups.keys()].sort()) {
      const group = groups.get(ref)!;
      group.sort((a, b) => priority[a.device_kind] - priority[b.device_kind] ||
        JSON.stringify(fields.map((field) => a[field] ?? null)).localeCompare(JSON.stringify(fields.map((field) => b[field] ?? null))));
      nodes.push(group[0]);
      const conflicts = fields.flatMap((field) => {
        const values = [...new Set(group.map((row) => JSON.stringify(row[field] ?? null)))].sort();
        return values.length > 1 ? [`${field}: ${values.join(" / ")}`] : [];
      });
      if (conflicts.length) warnings.push(`${ref} has conflicting metadata (${conflicts.join("; ")}). Displaying ${group[0].device_kind}; legacy rows retained.`);
    }
    return { nodes, warnings };
  }
}

export interface IngestSummary {
  nodes_added: number;
  edges_added: number;
  cache_updated: boolean;
}

export interface NeighborCacheRow {
  device_ref: string;
  device_kind: string;
  source_cmd: string;
  captured_at: number;
  parsed_json: string;
}

export const topologyApi = {
  startDiscovery: (request: DiscoveryRequest) => invoke<DiscoveryRun>("topology_discovery_start", { request }),
  discoveryStatus: (runId?: string) => invoke<DiscoveryRun | null>("topology_discovery_status", { runId }),
  cancelDiscovery: (runId: string) => invoke<DiscoveryRun>("topology_discovery_cancel", { runId }),
  previewImport: (content: string) => invoke<TopologyImportPreview>("topology_preview_import", { content }),
  importGraph: (content: string, name: string) => invoke<GraphSnapshot>("topology_import_graph", { content, name }),
  ingestFromBlock: (
    blockId: string,
    vendor: string,
    platform: string,
    deviceRef: string,
    deviceKind: string,
  ) =>
    invoke<IngestSummary>("topology_ingest_from_block", {
      blockId,
      vendor,
      platform,
      deviceRef,
      deviceKind,
    }),
  ingestFromText: (
    command: string,
    output: string,
    vendor: string,
    platform: string,
    deviceRef: string,
    deviceKind: string,
  ) =>
    invoke<IngestSummary>("topology_ingest_from_text", {
      command,
      output,
      vendor,
      platform,
      deviceRef,
      deviceKind,
    }),
  discoverDevice: (connectionId: string, vendor: string, platform: string, password?: string, graphId?: string) =>
    invoke<DiscoverySummary>("topology_discover_device", {
      connectionId,
      vendor,
      platform,
      password,
      graphId,
    }),
  saveLayout: (graphId: string, positions: NodePosition[]) =>
    invoke<void>("topology_save_layout", { graphId, positions }),
  resetLayout: (graphId: string) =>
    invoke<void>("topology_reset_layout", { graphId }),
  listGraphs: () => invoke<TopologyGraph[]>("topology_list_graphs"),
  getGraph: (graphId: string) =>
    invoke<GraphSnapshot>("topology_get_graph", { graphId }),
  createGraph: (name: string, description?: string) =>
    invoke<TopologyGraph>("topology_create_graph", { name, description }),
  deleteGraph: (graphId: string) =>
    invoke<void>("topology_delete_graph", { graphId }),
  clearGraph: (graphId: string) =>
    invoke<void>("topology_clear_graph", { graphId }),
  neighborCacheList: () =>
    invoke<NeighborCacheRow[]>("topology_neighbor_cache_list"),
};

/**
 * Stable id of the seeded "Global" topology graph, mirrored from the
 * Rust constant in `src-tauri/src/topology/mod.rs`. Migration `V0040`
 * inserts the row, so the frontend always has at least one graph.
 */
export const GLOBAL_GRAPH_ID = "00000000-0000-0000-0000-0000000000g1";

/**
 * Regex for the show commands that trigger topology ingest. Phase 1
 * shipped CDP and LLDP; Phase 5 Task 5.2 extended coverage to routing
 * adjacencies (BGP / OSPF / IS-IS).
 */
export const TOPOLOGY_TRIGGER_CMD_RE =
  /^\s*show\s+(?:(?:cdp|lldp)\s+neigh(?:bor)?|ip\s+bgp\s+summ(?:ary)?|ip\s+ospf\s+neigh(?:bor)?|isis\s+neigh(?:bors)?)/i;

/**
 * Map a topology-trigger command to the protocol the sidecar should
 * normalize against. Returns `null` for non-matching commands so the
 * block-completion hook can short-circuit.
 */
export function detectTopologyProtocol(command: string): Protocol | null {
  const cmd = command.trim().toLowerCase();
  if (/^show\s+cdp\s+neigh/.test(cmd)) return "cdp";
  if (/^show\s+lldp\s+neigh/.test(cmd)) return "lldp";
  if (/^show\s+ip\s+bgp\s+summ/.test(cmd)) return "bgp";
  if (/^show\s+ip\s+ospf\s+neigh/.test(cmd)) return "ospf";
  if (/^show\s+isis\s+neigh/.test(cmd)) return "isis";
  return null;
}

/** localStorage key for the user-facing toggle to disable topology auto-ingest. */
export const ENABLE_TOPOLOGY_INGEST_KEY = "ccie:enableTopologyIngest";

/**
 * Default ON; flip to "false" in localStorage to disable. We deliberately
 * use localStorage (not a settingsStore) because there is no shared
 * settings store in this codebase yet and a single flag does not warrant
 * creating one. Any value that is not the literal string "false" leaves
 * ingest enabled.
 */
export function isTopologyIngestEnabled(): boolean {
  try {
    return window.localStorage.getItem(ENABLE_TOPOLOGY_INGEST_KEY) !== "false";
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Phase 3.1 — openNeighbor resolver
// ---------------------------------------------------------------------------

/**
 * Result of `device_lookup_by_ref` (Tauri command landing in Phase 3.2).
 * Mirrors the Rust enum that distinguishes saved SSH connections from
 * saved NETCONF devices.
 */
export interface SavedDeviceLookup {
  kind: "ssh" | "netconf";
  device_ref: string;
}

/**
 * Callback bundle for `openNeighbor`. The resolver is intentionally
 * decoupled from the UI layer — there is no shared `uiStore` in this
 * codebase, so the caller (e.g., InlineTopologyPanel) wires modal
 * visibility and tab spawning via these handlers.
 */
export interface OpenNeighborHandlers {
  /** Called when neighbor resolves to a saved SSH connection. */
  onOpenSshTab: (ref: string) => Promise<void> | void;
  /** Called when neighbor resolves to a saved NETCONF device. */
  onOpenNetconfTab: (ref: string) => Promise<void> | void;
  /** Called when neighbor is unknown — caller surfaces SaveNeighborModal. */
  onUnknownNeighbor: (node: TopologyNode) => void;
}

/**
 * Resolve a clicked topology neighbor node to a saved device and open
 * the appropriate tab. Falls back to `onUnknownNeighbor` (which the
 * caller wires to a SaveNeighborModal) when no match is found or when
 * the lookup command is unavailable.
 *
 * Lookup precedence: `node.mgmt_ip` if present, else `node.device_ref`.
 *
 * Connects directly to the resolved host. (Session chaining / jump-host
 * routing was removed in favor of Fan-Out; there is no chain resolve step.)
 *
 * Plan 13 spec (lines 549–582) explicitly allows this direct-connect path.
 */
export async function openNeighbor(
  node: TopologyNode,
  handlers: OpenNeighborHandlers,
): Promise<void> {
  // Scoped routing identifiers are observations, never management or save-profile targets.
  if (node.device_ref.startsWith("routing:")) return;
  const ref = node.mgmt_ip ?? node.device_ref;
  let saved: SavedDeviceLookup | null = null;
  try {
    saved = await invoke<SavedDeviceLookup | null>("device_lookup_by_ref", {
      ref,
    });
  } catch (err) {
    // device_lookup_by_ref may not be wired yet (Task 3.2 lands in
    // parallel). Treat any failure as "unknown neighbor" so the caller
    // can offer the SaveNeighborModal flow.
    console.warn("[topology] device_lookup_by_ref unavailable:", err);
  }

  if (!saved) {
    handlers.onUnknownNeighbor(node);
    return;
  }

  if (saved.kind === "ssh") {
    await handlers.onOpenSshTab(saved.device_ref);
    return;
  }

  if (saved.kind === "netconf") {
    await handlers.onOpenNetconfTab(saved.device_ref);
    return;
  }
}

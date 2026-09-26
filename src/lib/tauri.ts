/**
 * Tauri command wrappers for CCIE Terminal backend API.
 *
 * This module provides type-safe wrappers around Tauri IPC commands
 * for terminal management, AI features, MCP servers, and more.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { PtyEvent, Tab } from "./types";
import type { AppearanceSettingsV1 } from "../theme/types";
import type { CiscoPlatform } from "./ciscoLint";

export type TopolographConfig = { singletonId: string; enabled: boolean; baseUrl: string; apiKey: string; verifyTls: boolean; updatedAt: number };
export type TopolographConnectionStage = { name: string; status: "passed" | "failed" | "skipped" };
export type TopolographConnectionReport = { ok: boolean; message: string; warnings: string[]; serverName: string; serverVersion: string; latencyMs: number | null; tools: string[]; missingTools: string[]; unexpectedTools: string[]; stages: TopolographConnectionStage[] };
export type TopolographUploadResult = { ok: boolean; message: string; bytes: number; warnings: string[] };
export type PyatsDeviceSummary = { name: string; os: "iosxe" | "nxos" };
export type TopolographPyatsLsdbImportRequest = { device: string; protocol: "ospf" | "ospfv3" | "isis"; description?: string | null };
export type TopolographAuditEvent = { id: number; action: string; outcome: string; occurredAt: number; targetLabel?: string; durationMs?: number };
export type StpPort = { deviceId: string; interface: string; role: string | null; state: string | null; cost?: number | null; bundleId?: string | null; explicitEvidence?: string | null };
export type StpInstance = { id: string; label: string | null; vlan: string | null; mode: string | null; bridgeId: string | null; rootId: string | null; topologyChangeCount?: number | null; mstRegion?: string | null; bridgePriority?: number | null; rootPriority?: number | null; rootCost?: number | null; rootPort?: string | null; ports: StpPort[] };
export type StpLink = { id?: string; localDeviceId: string; localInterface: string; remoteDeviceId: string | null; instanceId: string | null; bidirectional: boolean };
export type StpFinding = { kind: string; severity: string; deviceId: string | null; interface: string | null; detail: string };
export type StpDevice = { deviceId: string; platform: string };
export type StpGap = { source: string; code: string };
export type StpPayload = { devices: StpDevice[]; instances: StpInstance[]; links: StpLink[]; findings: StpFinding[]; gaps: StpGap[] };
export type StpSnapshot = { id: string; startedAt: number; finishedAt: number | null; trigger: "manual" | "scheduled"; status: "complete" | "partial" | "failed"; baselineEligible: boolean; schemaVersion: number; payload: StpPayload; errorSummary: string | null };
export type StpSettings = { singletonId: string; scheduleEnabled: boolean; intervalMinutes: number; updatedAt: number };
export const topolographConfigGet = () => invoke<TopolographConfig | null>("topolograph_config_get");
export const topolographConfigSave = (config: TopolographConfig) => invoke<void>("topolograph_config_save", { config });
export const topolographTestConnection = (config: TopolographConfig) => invoke<TopolographConnectionReport>("topolograph_test_connection", { config });
export const topolographUploadLsdbFile = (request: { path: string; protocol: string }) => invoke<TopolographUploadResult>("topolograph_upload_lsdb_file", { request });
export const pyatsListSupportedDevices = () => invoke<PyatsDeviceSummary[]>("pyats_list_supported_devices");
export const topolographImportLsdbFromPyats = (request: TopolographPyatsLsdbImportRequest) => invoke<TopolographUploadResult>("topolograph_import_lsdb_from_pyats", { request });
export const topolographUploadYamlFile = (path: string) => invoke<TopolographUploadResult>("topolograph_upload_yaml_file", { path });
export const topolographAuditList = () => invoke<TopolographAuditEvent[]>("topolograph_audit_list", { limit: 50 });
export const stpSnapshotList = () => invoke<StpSnapshot[]>("stp_snapshot_list", { limit: 100 });
export const stpSettingsGet = () => invoke<StpSettings>("stp_settings_get");
export const stpSettingsSave = (settings: StpSettings) => invoke<StpSettings>("stp_settings_save", { settings });
export const stpCollectNow = () => invoke<StpSnapshot>("stp_collect_now");

/**
 * Ping the Rust core to verify it's responsive.
 * Used for health checks and testing.
 *
 * @returns Promise resolving to "pong @ <timestamp>"
 */
export async function pingCore(): Promise<string> {
  return invoke<string>("ping_cmd");
}

/**
 * Ping the Python sidecar to verify it's responsive.
 * Used for health checks and testing.
 *
 * @returns Promise resolving to "pong"
 */
export async function pingSidecar(): Promise<string> {
  return invoke<string>("ping_sidecar");
}

export const dictationStart = () => invoke<void>("dictation_start");
export const dictationStop = () => invoke<string>("dictation_stop");
export const dictationCancel = () => invoke<void>("dictation_cancel");

/**
 * Snapshot of the sidecar heartbeat row (Plan 00 / Task 3.3). Polled by the
 * status-footer chip so the user can see whether the AI backend is alive.
 */
export type SidecarStatus = {
  running: boolean;
  last_seen: number | null;
  version: string | null;
  pid: number | null;
  now: number;
};

export async function getSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("get_sidecar_status");
}

export type LogFileLocation = {
  id: string;
  label: string;
  description: string;
  path: string;
  exists: boolean;
};

export type LogLocations = {
  directory: string;
  files: LogFileLocation[];
};

/** Return the backend-authoritative TerminAI diagnostic log locations. */
export async function getLogLocations(): Promise<LogLocations> {
  return invoke<LogLocations>("get_log_locations");
}

/** Open a known log (or the log directory) with the operating system viewer. */
export async function openLogLocation(id: string): Promise<void> {
  return invoke<void>("open_log_location", { id });
}

/** Reveal a known log in Finder/Explorer without accepting an arbitrary path. */
export async function revealLogLocation(id: string): Promise<void> {
  return invoke<void>("reveal_log_location", { id });
}

/**
 * Spawn a new PTY (pseudo-terminal) session.
 *
 * Creates a new shell process with the specified configuration
 * and returns a tab ID for managing it.
 *
 * @param opts - PTY configuration options
 * @param opts.shell - Shell executable path (e.g., "/bin/zsh")
 * @param opts.args - Shell arguments (e.g., ["-l"] for login shell)
 * @param opts.cwd - Initial working directory
 * @param opts.cols - Terminal width in columns
 * @param opts.rows - Terminal height in rows
 * @param opts.onEvent - Callback for PTY events (output, command start/end, exit)
 * @returns Promise resolving to a unique tab ID
 *
 * @example
 * ```typescript
 * const tabId = await ptySpawn({
 *   shell: "/bin/bash",
 *   args: [],
 *   cwd: "/home/user",
 *   cols: 80,
 *   rows: 24,
 *   onEvent: (event) => {
 *     if (event.type === 'output') {
 *       console.log(new TextDecoder().decode(new Uint8Array(event.bytes)));
 *     }
 *   }
 * });
 * ```
 */
export async function ptySpawn(opts: {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  onEvent: (e: PtyEvent) => void;
  preferredTabId?: string;
}): Promise<string> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = opts.onEvent;
  return invoke<string>("pty_spawn", {
    shell: opts.shell,
    args: opts.args,
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    onEvent: channel,
    preferredTabId: opts.preferredTabId ?? null,
  });
}

/**
 * Write data to a PTY session (send user input to shell).
 *
 * @param tabId - Tab ID from ptySpawn
 * @param data - Bytes to write (typically UTF-8 encoded text)
 * @returns Promise resolving when write completes
 */
export const ptyWrite = (tabId: string, data: Uint8Array) =>
  invoke<void>("pty_write", { tabId, data: Array.from(data) });

/** Register the kernel-observed SSH process launched from a saved connection. */
export const terminalLaunchSavedSsh = (tabId: string, connectionId: string) =>
  invoke<void>("terminal_launch_saved_ssh", { tabId, connectionId });

/**
 * Resize a PTY session (update terminal dimensions).
 *
 * @param tabId - Tab ID
 * @param cols - New width in columns
 * @param rows - New height in rows
 * @returns Promise resolving when resize completes
 */
export const ptyResize = (tabId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { tabId, cols, rows });

/**
 * Kill a PTY session (terminate shell process and close tab).
 *
 * @param tabId - Tab ID to kill
 * @returns Promise resolving when kill completes
 */
export const ptyKill = (tabId: string) => invoke<void>("pty_kill", { tabId });

/** Open a terminal tab in a native window without replacing its PTY. */
export const terminalDetach = (tabId: string, title: string) =>
  invoke<string>("terminal_detach", { tabId, title });

export const terminalDetachedWindowClose = (windowId: string) =>
  invoke<void>("terminal_detached_window_close", { windowId });

/**
 * List all open terminal tabs.
 *
 * @returns Promise resolving to array of tab metadata
 */
export const listTabs = () => invoke<Tab[]>("list_tabs");

/**
 * List open terminal tabs that have a **live PTY** (i.e. currently usable
 * as `api_pipe_to_terminal` targets). Filters out stale DB rows left
 * behind by app restarts where the PTY died without a clean close.
 */
export const listPipeTargets = () => invoke<Tab[]>("list_pipe_targets");

/**
 * Create a new API Runner tab. Does NOT spawn a PTY.
 */
export const tabNewApi = (opts: {
  title: string;
  targetId?: string | null;
  environment?: string | null;
}) =>
  invoke<Tab>("tab_new_api", {
    title: opts.title,
    targetId: opts.targetId ?? null,
    environment: opts.environment ?? null,
  });

/** Close an API tab (no PTY to kill, just a DB close). */
export const tabCloseApi = (tabId: string) =>
  invoke<void>("tab_close_api", { tabId });

/**
 * Create a new NETCONF tab. Does NOT open a session or spawn a PTY.
 */
export const tabNewNetconf = (opts: { title: string }) =>
  invoke<Tab>("tab_new_netconf", { title: opts.title });

/** Close a NETCONF tab (no PTY, no active session). */
export const tabCloseNetconf = (tabId: string) =>
  invoke<void>("tab_close_netconf", { tabId });

/**
 * Create a new Subnet Calculator tab. Does NOT spawn a PTY.
 */
export const tabNewSubnet = (opts: { title: string }) =>
  invoke<Tab>("tab_new_subnet", { title: opts.title });

/** Close a Subnet Calculator tab (no PTY, just a DB close). */
export const tabCloseSubnet = (tabId: string) =>
  invoke<void>("tab_close_subnet", { tabId });

export type NetconfConnectArgs = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type NetconfConnectResult = {
  session_id: string;
  server_session_id: number;
  capabilities: string[];
  /** "1.0" for end-of-message framing, "1.1" for chunked. */
  framing: "1.0" | "1.1";
};

/** Open a NETCONF session (SSH + hello exchange). Returns an opaque session_id. */
export const netconfConnect = (args: NetconfConnectArgs) =>
  invoke<NetconfConnectResult>("netconf_connect", args);

/** Send a single <rpc> over an existing session. Returns raw <rpc-reply> XML. */
export const netconfSendRpc = (
  tabId: string,
  sessionId: string,
  host: string,
  rpcXml: string,
) => invoke<string>("netconf_send_rpc", { tabId, sessionId, host, rpcXml });

export type SavedNetconfDevice = {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  verify_host_key: boolean;
  created_at: string;
};

/** List all saved NETCONF devices (passwords excluded). */
export const netconfDeviceList = () =>
  invoke<SavedNetconfDevice[]>("netconf_device_list");

/** Create a new saved NETCONF device. Password stored in OS keychain. */
export const netconfDeviceCreate = (
  name: string,
  host: string,
  port: number,
  username: string,
  password: string,
  verifyHostKey: boolean,
) =>
  invoke<SavedNetconfDevice>("netconf_device_create", {
    name,
    host,
    port,
    username,
    password,
    verifyHostKey,
  });

/** Delete a saved NETCONF device (also removes password from keychain). */
export const netconfDeviceDelete = (id: number) =>
  invoke<void>("netconf_device_delete", { id });

/** Retrieve a device's password from the OS keychain. */
export const netconfDeviceGetPassword = (id: number) =>
  invoke<string>("netconf_device_get_password", { id });

/** Wrap CLI text into a NETCONF <rpc> for the given platform. Returns XML ready to send. */
export const netconfWrapCli = (platform: string, cliText: string) =>
  invoke<string>("netconf_wrap_cli", { platform, cliText });

export type NetconfHistoryItem = {
  id: string;
  tab_id: string | null;
  device_id: number | null;
  host: string | null;
  operation: string;
  status: string;
  duration_ms: number | null;
  sent_at: string;
};

export type NetconfHistoryDetail = {
  id: string;
  tab_id: string | null;
  saved_rpc_id: string | null;
  device_id: number | null;
  host: string | null;
  operation: string;
  target_datastore: string | null;
  request_xml: string;
  response_xml: string | null;
  response_truncated: boolean;
  status: string;
  error_message: string | null;
  duration_ms: number | null;
  sent_at: string;
};

/** List NETCONF history for a tab. */
export const netconfHistoryList = (
  tabId: string,
  limit: number,
  offset: number,
) =>
  invoke<NetconfHistoryItem[]>("netconf_history_list", {
    tabId,
    limit,
    offset,
  });

/** Get full NETCONF history detail by ID. */
export const netconfHistoryDetail = (id: string) =>
  invoke<NetconfHistoryDetail>("netconf_history_detail", { id });

export type SavedNetconfRpc = {
  id: number;
  name: string;
  rpc_xml: string;
  created_at: string;
  updated_at: string;
};

/** List all saved NETCONF RPCs. */
export const netconfSavedRpcList = () =>
  invoke<SavedNetconfRpc[]>("netconf_saved_rpc_list");

/** Create or update a saved NETCONF RPC. */
export const netconfSavedRpcUpsert = (
  id: number | null,
  name: string,
  rpcXml: string,
) => invoke<SavedNetconfRpc>("netconf_saved_rpc_upsert", { id, name, rpcXml });

/** Delete a saved NETCONF RPC. */
export const netconfSavedRpcDelete = (id: number) =>
  invoke<void>("netconf_saved_rpc_delete", { id });

/** Get AI explanation of a NETCONF response. */
export const netconfExplainResponse = (
  operation: string,
  responseXml: string,
) => invoke<string>("netconf_explain_response", { operation, responseXml });

export type YangRelease = {
  id: number;
  vendor: string;
  os: string;
  release: string;
  source_path: string;
  cache_dir: string;
  module_count: number;
  downloaded_at: string;
};

export type YangModule = {
  id: number;
  release_id: number;
  name: string;
  namespace: string | null;
  revision: string | null;
  file_path: string;
};

/** List all downloaded YANG releases. */
export const yangReleaseList = () => invoke<YangRelease[]>("yang_release_list");

/** Download a YANG release from YangModels/yang. Returns the release ID. */
export const yangReleaseDownload = (
  vendor: string,
  os: string,
  release: string,
) => invoke<number>("yang_release_download", { vendor, os, release });

/** Delete a YANG release and its cache directory. */
export const yangReleaseDelete = (releaseId: number) =>
  invoke<void>("yang_release_delete", { releaseId });

/** List modules in a YANG release, optionally filtered by name. */
export const yangModuleList = (releaseId: number, query?: string) =>
  invoke<YangModule[]>("yang_module_list", { releaseId, query });

export const yangModuleContent = (filePath: string) =>
  invoke<string>("yang_module_content", { filePath });

export const yangExplainModule = (moduleName: string, yangContent: string) =>
  invoke<string>("yang_explain_module", { moduleName, yangContent });

// ---- API Runner -----------------------------------------------------------

export type TokenLoginCredentials =
  | { type: "basic"; username: string; password: string }
  | { type: "json_body"; body: string }
  | { type: "form_body"; body: string };

export type TokenApply = { mode: "header"; name: string } | { mode: "bearer" };

export type TokenLoginEndpoint = {
  method: HttpMethod;
  url: string;
  credentials: TokenLoginCredentials;
  token_jsonpath: string;
};

export type SessionCookieLogin = {
  method: HttpMethod;
  url: string;
  credentials: TokenLoginCredentials;
};

/** Auth strategies exposed to the UI. Shape matches the Rust `ApiAuth` enum. */
export type ApiAuth =
  | { type: "none" }
  | { type: "header"; name: string; value: string }
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string }
  | {
      type: "token_login";
      login: TokenLoginEndpoint;
      apply: TokenApply;
      refresh_on_status: number[];
    }
  | { type: "session_cookie"; login: SessionCookieLogin }
  | { type: "hook"; module: string; function: string };

export type BodyKind = "none" | "json" | "form" | "text" | "binary";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type ApiRequest = {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body_kind: BodyKind;
  body_text?: string | null;
  /** Base64-encoded bytes. Only used when body_kind === "binary". */
  body_bytes?: string | null;
  auth: ApiAuth;
  timeout_secs?: number | null;
  insecure_skip_verify?: boolean;
  /** Path to a PEM CA bundle to trust in addition to system roots. */
  tls_ca_bundle?: string | null;
  /** Path to a PEM file containing client cert + key for mTLS. */
  tls_client_cert?: string | null;
};

export type ApiResponse = {
  status_code: number;
  status_text: string;
  headers: Record<string, string>;
  /** Base64-encoded body bytes. */
  body: string;
  body_truncated: boolean;
  duration_ms: number;
  final_url: string;
  /** Present only for transport/network failures. HTTP 4xx/5xx → null. */
  error: string | null;
};

export const apiSendRequest = (opts: {
  tabId?: string | null;
  /** Target id for the stateful auth cache key. "" or null = "custom" scope. */
  targetId?: string | null;
  environment?: string | null;
  request: ApiRequest;
}) =>
  invoke<ApiResponse>("api_send_request", {
    tabId: opts.tabId ?? null,
    targetId: opts.targetId ?? null,
    environment: opts.environment ?? null,
    request: opts.request,
  });

// ---- Targets + OpenAPI ----------------------------------------------------

export type ApiTargetSummary = {
  id: string;
  display_name: string;
  base_url: string;
  builtin: boolean;
  has_openapi: boolean;
  endpoint_count: number;
};

export type ApiEndpoint = {
  id: string;
  name: string;
  description: string | null;
  method: HttpMethod;
  path: string;
  path_params: string[];
  query_params: Record<string, string>;
};

/**
 * Manifest-level auth shape. Mirrors the Rust `ManifestAuth` enum, which
 * uses different field names than the wire-level `ApiAuth` (e.g. manifest
 * uses `header_name`, wire uses `name`). Converted via
 * `manifestAuthToApiAuth` before being put on a request.
 */
export type ApiManifestAuth =
  | { type: "none" }
  | { type: "header"; header_name: string; value: string }
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string }
  | {
      type: "token_login";
      login: {
        method: HttpMethod;
        url: string;
        credentials: TokenLoginCredentials;
        token_jsonpath: string;
      };
      apply: TokenApply;
      refresh_on_status: number[];
    }
  | {
      type: "session_cookie";
      login: {
        method: HttpMethod;
        url: string;
        credentials: TokenLoginCredentials;
      };
    }
  | { type: "hook"; module: string; function: string };

/**
 * Scan a string for `${env:NAME}` placeholders and return the set of NAMEs.
 * Case-sensitive — matches the Rust resolver.
 */
export function extractEnvPlaceholders(s: string | null | undefined): string[] {
  if (!s) return [];
  const re = /\$\{env:([^}]+)\}/g;
  const out: string[] = [];
  for (const m of s.matchAll(re)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Scan a string for `${var:NAME}` placeholders and return the set of NAMEs.
 * Path params get rewritten to this shape — see `rewritePathParams`.
 */
export function extractVarPlaceholders(s: string | null | undefined): string[] {
  if (!s) return [];
  const re = /\$\{var:([^}]+)\}/g;
  const out: string[] = [];
  for (const m of s.matchAll(re)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Collect every `${env:X}` reference inside a target manifest — spans
 * base_url, default headers, and every branch of the auth declaration.
 * Used to tell the user which env vars a target expects to have set.
 */
export function manifestRequiredEnvKeys(m: ApiTargetManifest): string[] {
  const out = new Set<string>();
  for (const s of extractEnvPlaceholders(m.base_url)) out.add(s);
  for (const [k, v] of Object.entries(m.defaults?.headers ?? {})) {
    for (const s of extractEnvPlaceholders(k)) out.add(s);
    for (const s of extractEnvPlaceholders(v)) out.add(s);
  }
  const a = m.auth;
  const push = (s: string | undefined | null) => {
    for (const n of extractEnvPlaceholders(s ?? "")) out.add(n);
  };
  switch (a.type) {
    case "header":
      push(a.header_name);
      push(a.value);
      break;
    case "basic":
      push(a.username);
      push(a.password);
      break;
    case "bearer":
      push(a.token);
      break;
    case "token_login":
      push(a.login.url);
      push(a.login.token_jsonpath);
      if (a.login.credentials.type === "basic") {
        push(a.login.credentials.username);
        push(a.login.credentials.password);
      } else {
        push(a.login.credentials.body);
      }
      if (a.apply.mode === "header") push(a.apply.name);
      break;
    case "session_cookie":
      push(a.login.url);
      if (a.login.credentials.type === "basic") {
        push(a.login.credentials.username);
        push(a.login.credentials.password);
      } else {
        push(a.login.credentials.body);
      }
      break;
    case "hook":
      push(a.module);
      push(a.function);
      break;
    case "none":
      break;
  }
  return Array.from(out);
}

/**
 * Convert a manifest-level auth declaration into the executor's wire format.
 * Placeholders like `${env:MERAKI_API_KEY}` survive this pass — they're
 * resolved on the Rust side using the currently-active environment.
 */
export function manifestAuthToApiAuth(a: ApiManifestAuth): ApiAuth {
  switch (a.type) {
    case "none":
      return { type: "none" };
    case "header":
      return { type: "header", name: a.header_name, value: a.value };
    case "basic":
      return { type: "basic", username: a.username, password: a.password };
    case "bearer":
      return { type: "bearer", token: a.token };
    case "token_login":
      return {
        type: "token_login",
        login: a.login,
        apply: a.apply,
        refresh_on_status: a.refresh_on_status,
      };
    case "session_cookie":
      return { type: "session_cookie", login: a.login };
    case "hook":
      return { type: "hook", module: a.module, function: a.function };
  }
}

export type ApiTargetManifest = {
  id: string;
  display_name: string;
  schema_version: number;
  base_url: string;
  auth: ApiManifestAuth;
  tls: {
    verify: boolean;
    ca_bundle: string | null;
    client_cert: string | null;
  };
  defaults: { headers: Record<string, string> };
  openapi_url: string | null;
  endpoints: Array<{
    id: string | null;
    name: string;
    description: string | null;
    method: string;
    path: string;
    query: Record<string, string>;
  }>;
};

export type ApiTargetDetail = {
  manifest: ApiTargetManifest;
  endpoints: ApiEndpoint[];
  builtin: boolean;
};

export const apiListTargets = () =>
  invoke<{ targets: ApiTargetSummary[] }>("api_list_targets").then(
    (r) => r.targets,
  );

export const apiGetTarget = (id: string) =>
  invoke<ApiTargetDetail>("api_get_target", { id });

export const apiImportOpenApi = (source: string) =>
  invoke<ApiEndpoint[]>("api_import_openapi", { source });

/** Send a text line into a terminal tab's PTY stdin (auto-appends newline). */
export const apiPipeToTerminal = (opts: { tabId: string; text: string }) =>
  invoke<void>("api_pipe_to_terminal", {
    tabId: opts.tabId,
    text: opts.text,
  });

/**
 * Queue a user message in the AI chat for a tab, pre-populated with a JSON
 * snippet from the API response. Returns the stored message id.
 */
export const apiPipeToAi = (opts: {
  tabId: string;
  prompt: string;
  contextSnippet: string;
  /**
   * Optional agent id — matches one from `agentsList()`. `null` / omitted =
   * general chat (no persona). Routes the message into the same per-tab,
   * per-agent conversation bucket the AgentPanel reads from.
   */
  agentId?: string | null;
}) =>
  invoke<string>("api_pipe_to_ai", {
    tabId: opts.tabId,
    prompt: opts.prompt,
    contextSnippet: opts.contextSnippet,
    agentId: opts.agentId ?? null,
  });

/**
 * Ask the LLM to summarize an API response in plain English for someone
 * who's not used to reading raw JSON. Returns the summary as a string.
 */
export const apiExplainResponse = (opts: {
  method: HttpMethod;
  url: string;
  statusCode: number;
  body: string;
}) =>
  invoke<string>("api_explain_response", {
    method: opts.method,
    url: opts.url,
    statusCode: opts.statusCode,
    body: opts.body,
  });

// ---- History + saved requests (Step 7) ----------------------------------

export type ApiHistoryRow = {
  id: string;
  tab_id: string | null;
  saved_request_id: string | null;
  target_id: string | null;
  environment: string | null;
  method: string;
  url: string;
  status_code: number | null;
  duration_ms: number | null;
  error: string | null;
  sent_at: number;
};

export type ApiHistoryDetail = ApiHistoryRow & {
  request_headers_json: string;
  request_body: string | null;
  response_headers_json: string | null;
  response_body: string | null;
  response_body_truncated: boolean;
};

export type ApiSavedRequest = {
  id: string;
  name: string;
  target_id: string | null;
  environment: string | null;
  method: string;
  url: string;
  headers_json: string;
  query_json: string;
  body_kind: string;
  body_text: string | null;
  collection_id: string | null;
  folder_path: string;
  display_name: string;
  auth_json: string;
  collection_name: string | null;
  created_at: number;
  updated_at: number;
};

export const apiListHistory = (opts?: {
  tabId?: string | null;
  savedRequestId?: string | null;
  limit?: number;
  offset?: number;
}) =>
  invoke<ApiHistoryRow[]>("api_list_history", {
    tabId: opts?.tabId ?? null,
    savedRequestId: opts?.savedRequestId ?? null,
    limit: opts?.limit ?? 100,
    offset: opts?.offset ?? 0,
  });

export const apiGetHistoryDetail = (id: string) =>
  invoke<ApiHistoryDetail>("api_get_history_detail", { id });

export type SaveRequestInput = {
  name: string;
  targetId?: string | null;
  environment?: string | null;
  method: string;
  url: string;
  headersJson: string;
  queryJson: string;
  bodyKind: string;
  bodyText?: string | null;
};

export const apiSaveRequest = (input: SaveRequestInput) =>
  invoke<ApiSavedRequest>("api_save_request", {
    input: {
      name: input.name,
      target_id: input.targetId ?? null,
      environment: input.environment ?? null,
      method: input.method,
      url: input.url,
      headers_json: input.headersJson,
      query_json: input.queryJson,
      body_kind: input.bodyKind,
      body_text: input.bodyText ?? null,
    },
  });

export const apiListSavedRequests = () =>
  invoke<ApiSavedRequest[]>("api_list_saved_requests");

export const apiDeleteSavedRequest = (id: string) =>
  invoke<void>("api_delete_saved_request", { id });

export type PostmanVariableSummary = {
  key: string;
  is_secret: boolean;
};

export type PostmanSkippedItem = {
  path: string;
  reason: string;
};

export type PostmanImportPreview = {
  fingerprint: string;
  collection_name: string;
  request_count: number;
  folder_count: number;
  variable_keys: PostmanVariableSummary[];
  skipped_items: PostmanSkippedItem[];
  warnings: string[];
};

export type PostmanImportResult = {
  collection_id: string;
  collection_name: string;
  environment: string;
  imported_count: number;
  skipped_count: number;
  warnings: string[];
};

export type PostmanCollectionSummary = {
  id: string;
  name: string;
  environment: string;
  request_count: number;
};

export type PostmanCollectionDetail = {
  collection: PostmanCollectionSummary;
  requests: ApiSavedRequest[];
};

export const apiPreviewPostmanImport = (sourcePath: string) =>
  invoke<PostmanImportPreview>("api_preview_postman_import", { sourcePath });

export const apiCommitPostmanImport = (sourcePath: string, fingerprint: string) =>
  invoke<PostmanImportResult>("api_commit_postman_import", { sourcePath, fingerprint });

export const apiListPostmanCollections = () =>
  invoke<PostmanCollectionSummary[]>("api_list_postman_collections");

export const apiGetPostmanCollection = (id: string) =>
  invoke<PostmanCollectionDetail>("api_get_postman_collection", { id });

export const apiDeletePostmanCollection = (id: string) =>
  invoke<PostmanCollectionSummary>("api_delete_postman_collection", { id });

// ---- Environments + credentials ------------------------------------------

export type ApiEnvVar = {
  key: string;
  value: string;
  is_secret: boolean;
};

export const apiListEnvironments = () =>
  invoke<string[]>("api_list_environments");

export const apiCreateEnvironment = (name: string) =>
  invoke<boolean>("api_create_environment", { name });

export const apiDeleteEnvironment = (name: string) =>
  invoke<void>("api_delete_environment", { name });

export const apiGetEnvVars = (environment: string) =>
  invoke<ApiEnvVar[]>("api_get_env_vars", { environment });

export const apiSetEnvVar = (opts: {
  environment: string;
  key: string;
  value: string;
  isSecret: boolean;
}) =>
  invoke<void>("api_set_env_var", {
    environment: opts.environment,
    key: opts.key,
    value: opts.value,
    isSecret: opts.isSecret,
  });

export const apiDeleteEnvVar = (environment: string, key: string) =>
  invoke<void>("api_delete_env_var", { environment, key });

/**
 * Get scrollback buffer for a tab.
 *
 * @param tabId - Tab ID
 * @returns Promise resolving to raw byte array of scrollback
 */
export const tabScrollback = (tabId: string) =>
  invoke<number[]>("tab_scrollback", { tabId });

/** Export the bounded backend scrollback ring as redacted UTF-8 text. */
export const terminalExportScrollback = (tabId: string, targetPath: string) =>
  invoke<void>("terminal_export_scrollback", { tabId, targetPath });

/**
 * Get output for a specific command block.
 *
 * @param blockId - Command block ID
 * @returns Promise resolving to raw byte array of output
 */
export const blockOutput = (blockId: string) =>
  invoke<number[]>("block_output", { blockId });

/**
 * Install shell integration scripts.
 *
 * @returns Promise resolving to installation path
 */
export const installShellIntegration = () =>
  invoke<string>("install_shell_integration");

/**
 * Events emitted during AI chat streaming.
 */
export type AgentChatEvent =
  | { type: "token"; text: string }
  | {
      type: "tool_proposed";
      tool_call_id: string;
      kind: "shell" | "mcp" | string;
      payload: Record<string, unknown>;
      allowed: boolean;
    }
  | {
      type: "tool_result";
      tool_call_id: string;
      exit_code: number | null;
      output_preview: string;
    }
  /** Plan 12 Phase 5 — RAG-retrieved chunks for this turn. Emitted
   *  BEFORE the first `token` event. */
  | { type: "sources"; chunks: import("./rag").RetrievedChunk[] }
  | { type: "done" }
  | { type: "error"; message: string };

export const agentApproveTool = (opts: {
  toolCallId: string;
  action: "run" | "reject";
  editedPayload?: Record<string, unknown> | null;
}) =>
  invoke<void>("agent_approve_tool", {
    toolCallId: opts.toolCallId,
    action: opts.action,
    editedPayload: opts.editedPayload ?? null,
  });

/** Cancel any in-flight agent turn on the given tab. */
export const agentChatCancel = (tabId: string) =>
  invoke<void>("agent_chat_cancel", { tabId });

/**
 * Stream AI chat responses.
 *
 * Sends a message to the AI agent and streams the response
 * token-by-token via the provided callback.
 *
 * @param opts - Chat options
 * @param opts.tabId - Associated tab ID for context
 * @param opts.message - User message
 * @param opts.onEvent - Callback for streaming events
 * @returns Promise resolving when stream completes
 *
 * @example
 * ```typescript
 * await agentChatStream({
 *   tabId: currentTabId,
 *   message: "Explain OSPF routing",
 *   onEvent: (event) => {
 *     if (event.type === 'token') {
 *       appendToChat(event.text);
 *     } else if (event.type === 'error') {
 *       showError(event.message);
 *     }
 *   }
 * });
 * ```
 */
export async function agentChatStream(opts: {
  tabId: string;
  message: string;
  onEvent: (e: AgentChatEvent) => void;
  /** Plan 12 Phase 5 — active tab vendor (e.g. "cisco"). Pass with
   *  `platform` to enable RAG retrieval for this turn. Both must be
   *  set; a missing value disables RAG entirely. */
  vendor?: string;
  /** Plan 12 Phase 5 — active tab platform (e.g. "iosxe"). */
  platform?: string;
  /** Active user tags from ragStore.activeUserTagsByTab[tabId]. */
  userTags?: string[];
}): Promise<void> {
  const channel = new Channel<AgentChatEvent>();
  channel.onmessage = opts.onEvent;
  return invoke<void>("agent_chat_stream", {
    tabId: opts.tabId,
    message: opts.message,
    onEvent: channel,
    vendor: opts.vendor ?? null,
    platform: opts.platform ?? null,
    userTags: opts.userTags ?? null,
  });
}

/**
 * Convert natural language to a shell command.
 *
 * Uses AI to translate natural language queries into executable
 * shell commands appropriate for the given shell and context.
 *
 * @param opts - Command generation options
 * @param opts.nlQuery - Natural language description (e.g., "list large files")
 * @param opts.shell - Shell type (bash, zsh, etc.)
 * @param opts.cwd - Current working directory for context
 * @returns Promise resolving to generated shell command
 *
 * @example
 * ```typescript
 * const cmd = await agentNLToCommand({
 *   nlQuery: "show all python files modified today",
 *   shell: "bash",
 *   cwd: "/home/user/project"
 * });
 * // cmd: "find . -name '*.py' -mtime -1"
 * ```
 */
export async function agentNLToCommand(opts: {
  nlQuery: string;
  shell: string;
  cwd: string;
}): Promise<string> {
  return invoke<string>("agent_nl_to_command", {
    nlQuery: opts.nlQuery,
    shell: opts.shell,
    cwd: opts.cwd,
  });
}

/**
 * Result from error explanation request.
 */
export type ExplainErrorResult = {
  /** AI-generated explanation of why the command failed */
  explanation: string;
  /** Suggested fix or alternative command */
  suggested_command: string;
};

/**
 * Get AI explanation for a failed command.
 *
 * Analyzes a command failure and provides an explanation
 * along with a suggested fix.
 *
 * @param opts - Error explanation options
 * @param opts.cmd - Command that failed
 * @param opts.output - Command output (stdout/stderr)
 * @param opts.exitCode - Exit code (non-zero)
 * @param opts.cwd - Working directory
 * @returns Promise resolving to explanation and suggestion
 *
 * @example
 * ```typescript
 * const result = await agentExplainError({
 *   cmd: "git push",
 *   output: "fatal: No upstream branch...",
 *   exitCode: 1,
 *   cwd: "/project"
 * });
 * console.log(result.explanation);
 * console.log(result.suggested_command);
 * ```
 */
export async function agentExplainError(opts: {
  cmd: string;
  output: string;
  exitCode: number;
  cwd: string;
}): Promise<ExplainErrorResult> {
  return invoke<ExplainErrorResult>("agent_explain_error", {
    cmd: opts.cmd,
    output: opts.output,
    exitCode: opts.exitCode,
    cwd: opts.cwd,
  });
}

/**
 * ReACT agent event types emitted during agent execution.
 */
/**
 * A draw.io diagram produced by an agent. `xml` is non-null only for native
 * mxGraph XML (the bundled offline viewer can render it inline); for
 * mermaid/csv it is null and `source` carries the original text. `url` opens
 * the diagram in the draw.io editor.
 */
export type DiagramEvent = {
  type: "diagram";
  title: string;
  format: "xml" | "csv" | "mermaid" | "image" | "markmap";
  xml: string | null;
  source?: string | null;
  url: string;
  // For format "image" (e.g. Kroki SVG render): a remote image URL to show
  // inline. For "markmap": the markmap viewer URL to embed.
  image_url?: string | null;
};

export type IaCClassification = {
  tier: "low" | "medium" | "high" | "critical" | "destructive";
  create?: number;
  update?: number;
  destroy?: number;
  params?: unknown;
  rationale?: string;
  source?: string;
  note?: string;
};

export type TerminalInvestigationPlan = {
  objective: string;
  hypotheses: string[];
  steps: string[];
  success_criteria: string[];
};

export type TerminalFixBatch = {
  summary: string;
  commands: string[];
  verification_commands: string[];
  rollback_commands: string[];
};

export type TerminalFixPreview = TerminalFixBatch & {
  lease_id: string;
  digest: string;
  target: import("./terminalAgentAttachment").TerminalAttachment;
  highest_tier: string;
  per_command_tiers: Array<{ command: string; tier: string }>;
};

export type ReactEvent =
  | { type: "thought_start"; thought: string; step: number }
  | { type: "tool_call"; name: string; args: unknown; blast_radius: string }
  | { type: "tool_result"; success: boolean; result: string }
  | { type: "token"; text: string }
  | { type: "final"; response: string }
  | DiagramEvent
  | { type: "error"; message: string }
  | { type: "continuation_available"; thread_id: string; reason: "step_limit" }
  | {
      type: "iac_approval_request";
      thread_id: string;
      command: string;
      working_dir: string;
      tool: string;
      classification: IaCClassification;
    }
  | {
      type: "terminal_control_started";
      lease_id: string;
      target: import("./terminalAgentAttachment").TerminalAttachment;
    }
  | { type: "terminal_investigation_plan"; plan: TerminalInvestigationPlan; updated: boolean }
  | {
      type: "terminal_command_start";
      plan_step_id: string;
      command: string;
      purpose: string;
    }
  | {
      type: "terminal_command_result";
      plan_step_id: string;
      command: string;
      success: boolean;
      result: Record<string, unknown>;
    }
  | { type: "terminal_fix_approval_request"; thread_id: string; preview: TerminalFixPreview }
  | { type: "terminal_lease_ended"; reason: string };

/**
 * Resume an agent paused on a gated iac_apply (IaC Phase 2).
 * Called after the user approves/denies in the IaCApprovalModal.
 */
export async function agentReactResume(opts: {
  threadId: string;
  decision: "approve" | "deny" | "edit" | "continue";
  editedAction?: { name: string; args: TerminalFixBatch };
  streamOutput?: boolean;
  onEvent: (e: ReactEvent) => void;
}): Promise<void> {
  const channel = new Channel<ReactEvent>();
  channel.onmessage = opts.onEvent;
  return invoke<void>("agent_react_resume", {
    threadId: opts.threadId,
    decision: opts.decision,
    editedAction: opts.editedAction ?? null,
    streamOutput: opts.streamOutput ?? false,
    onEvent: channel,
  });
}

/** Continue an exact DeepAgents checkpoint without resending the user prompt. */
export async function agentReactContinue(opts: {
  threadId: string;
  streamOutput?: boolean;
  onEvent: (e: ReactEvent) => void;
}): Promise<void> {
  return agentReactResume({
    threadId: opts.threadId,
    decision: "continue",
    streamOutput: opts.streamOutput,
    onEvent: opts.onEvent,
  });
}

export const agentTerminalPreviewFixEdit = (opts: {
  leaseId: string;
  batch: TerminalFixBatch;
}) => invoke<TerminalFixPreview>("agent_terminal_preview_fix_edit", {
  leaseId: opts.leaseId,
  batch: opts.batch,
});

export const agentTerminalApproveFix = (opts: {
  leaseId: string;
  digest: string;
  batch: TerminalFixBatch;
}) => invoke<void>("agent_terminal_approve_fix", {
  leaseId: opts.leaseId,
  digest: opts.digest,
  batch: opts.batch,
});

export const agentTerminalCancel = (leaseId: string) =>
  invoke<void>("agent_terminal_cancel", { leaseId });

/**
 * Run a ReACT agent with attached tools (e.g., Meraki CLI).
 *
 * Executes a ReACT (Reasoning + Acting) agent loop where the agent
 * can think, call tools, and observe results to complete tasks.
 * Events stream back to show the agent's reasoning process.
 *
 * @param opts - Agent execution options
 * @param opts.agentId - Agent identifier from agents store
 * @param opts.message - User's task/question for the agent
 * @param opts.onEvent - Callback for each agent event
 * @returns Promise that resolves when agent completes or errors
 *
 * @example
 * ```typescript
 * await agentReactRun({
 *   agentId: "meraki-readonly-expert",
 *   message: "List my organizations",
 *   onEvent: (event) => {
 *     if (event.type === "thought_start") {
 *       console.log("Thinking:", event.thought);
 *     } else if (event.type === "tool_call") {
 *       console.log(`Calling ${event.name}:`, event.args);
 *     } else if (event.type === "final") {
 *       console.log("Response:", event.response);
 *     }
 *   }
 * });
 * ```
 */
/**
 * One prior conversation turn passed to an agent for multi-turn context.
 * Only user/assistant turns are sent (tool lifecycle messages are excluded).
 */
export type ChatTurn = { role: "user" | "assistant"; content: string };

export async function agentReactRun(opts: {
  agentId: string;
  message: string;
  history?: ChatTurn[];
  streamOutput?: boolean;
  onEvent: (e: ReactEvent) => void;
}): Promise<void> {
  const channel = new Channel<ReactEvent>();
  channel.onmessage = opts.onEvent;
  return invoke<void>("agent_react_run", {
    agentId: opts.agentId,
    message: opts.message,
    history: opts.history ?? [],
    streamOutput: opts.streamOutput ?? false,
    onEvent: channel,
  });
}

/**
 * Code execution agent event types emitted during agent execution.
 */
export type CodeExecEvent =
  | { type: "code_start"; code: string }
  | { type: "code_executing" }
  | { type: "code_result"; success: boolean; output: string }
  | { type: "code_error"; error: string; attempt: number }
  | { type: "final"; response: string }
  | DiagramEvent
  | { type: "error"; message: string };

/**
 * Run code execution agent loop.
 *
 * Executes a code execution agent where the agent can write and run code,
 * observe results, and iterate to complete tasks. Events stream back to
 * show the agent's code execution process.
 *
 * @param agentId - Agent identifier from agents store
 * @param message - User's task/question for the agent
 * @param onEvent - Callback for each agent event
 * @returns Promise that resolves when agent completes or errors
 *
 * @remarks
 * Agent must have execution-mode: code in AGENT.md.
 *
 * @example
 * ```typescript
 * await agentCodeExecRun(
 *   "python-scientist",
 *   "Analyze the data in results.csv",
 *   (event) => {
 *     if (event.type === "code_start") {
 *       console.log("Code:", event.code);
 *     } else if (event.type === "code_result") {
 *       console.log("Result:", event.output);
 *     } else if (event.type === "final") {
 *       console.log("Response:", event.response);
 *     }
 *   }
 * );
 * ```
 */
export async function agentCodeExecRun(
  agentId: string,
  message: string,
  onEvent: (event: CodeExecEvent) => void,
  history?: ChatTurn[],
): Promise<void> {
  const channel = new Channel<CodeExecEvent>();
  channel.onmessage = onEvent;

  return invoke<void>("agent_code_exec_run", {
    agentId,
    message,
    history: history ?? [],
    onEvent: channel,
  });
}

/**
 * Run ReACT loop with code execution as the tool.
 *
 * Hybrid mode: agent reasons about what to do, writes Python code to execute,
 * observes results, and iterates. Combines ReACT reasoning with code execution.
 *
 * @param agentId - Agent identifier (must have execution-mode: react-code)
 * @param message - User's task/question
 * @param onEvent - Callback for events (thought_start, tool_call, tool_result, final, error)
 *
 * @remarks
 * This mode uses the ReACT loop but with only ONE tool: execute_python_code.
 * The agent reasons, plans, writes code, observes results, and iterates until
 * it has enough information to answer the user's question.
 */
export async function agentReactCodeRun(opts: {
  agentId: string;
  message: string;
  history?: ChatTurn[];
  streamOutput?: boolean;
  terminalAttachment?: import("./terminalAgentAttachment").TerminalAttachment | null;
  onEvent: (e: ReactEvent) => void;
}): Promise<void> {
  const channel = new Channel<ReactEvent>();
  channel.onmessage = opts.onEvent;
  return invoke<void>("agent_react_code_run", {
    agentId: opts.agentId,
    message: opts.message,
    history: opts.history ?? [],
    streamOutput: opts.streamOutput ?? false,
    terminalAttachment: opts.terminalAttachment ?? null,
    onEvent: channel,
  });
}

// Phase 4 MCP Server Management API.
export type McpServer = {
  id: string;
  name: string;
  transport: string;
  command_json: string | null;
  url: string | null;
  env_json: string | null;
  enabled: boolean;
  created_at: number;
};

export type McpTool = {
  name: string;
  description: string | null;
};

export type McpPolicy = {
  server_name: string;
  tool_name: string;
  policy: string;
  scope: string;
  created_at: number;
  updated_at: number;
};

export const mcpListServers = () => invoke<McpServer[]>("mcp_list_servers");

export const mcpAddServer = (opts: {
  name: string;
  transport: string;
  commandJson: string | null;
  url: string | null;
  envJson: string | null;
}) =>
  invoke<string>("mcp_add_server", {
    name: opts.name,
    transport: opts.transport,
    commandJson: opts.commandJson,
    url: opts.url,
    envJson: opts.envJson,
  });

export const mcpRemoveServer = (id: string) =>
  invoke<void>("mcp_remove_server", { id });

export const mcpUpdateServerEnabled = (id: string, enabled: boolean) =>
  invoke<void>("mcp_update_server_enabled", { id, enabled });

export const mcpTestConnection = (id: string) =>
  invoke<McpTool[]>("mcp_test_connection", { id });

export const mcpListPolicies = (serverName: string) =>
  invoke<McpPolicy[]>("mcp_list_policies", { serverName });

export const mcpSetPolicy = (
  serverName: string,
  toolName: string,
  policy: string,
) => invoke<void>("mcp_set_policy", { serverName, toolName, policy });

// Phase 4 MCP Tool Approval API.
export const approveToolCall = (opts: {
  requestId: string;
  approved: boolean;
  remember: boolean;
}) =>
  invoke<void>("approve_tool_call", {
    requestId: opts.requestId,
    approved: opts.approved,
    remember: opts.remember,
  });

// Phase 5 Skills Management API.
export type Skill = {
  id: string;
  name: string;
  description: string;
  when_to_use: string;
  scripts: string[];
  allowed_commands: string[];
  body: string; // markdown playbook
  path: string;
};

export const skillsList = () => invoke<Skill[]>("skills_list");

export const skillsGet = (id: string) => invoke<Skill>("skills_get", { id });

export const skillsReload = () => invoke<void>("skills_reload");

export type SkillScript = {
  name: string;
  content: string;
};

export const skillsCreate = (opts: {
  name: string;
  skillMdContent: string;
  scripts: SkillScript[];
}) =>
  invoke<string>("skills_create", {
    name: opts.name,
    skillMdContent: opts.skillMdContent,
    scripts: opts.scripts,
  });

export type GenerateSkillResult = {
  skill_md: string;
  scripts: SkillScript[];
};

export const agentGenerateSkill = (opts: {
  description: string;
  examples?: string;
  profile?: string;
}) =>
  invoke<GenerateSkillResult>("agent_generate_skill", {
    description: opts.description,
    examples: opts.examples,
    profile: opts.profile,
  });

// Phase 5 Skill Invocation API.
export type InvokeSkillResult = {
  response: string;
};

export async function agentInvokeSkill(opts: {
  skillName: string;
  args: string;
  cwd: string;
  shell: string;
}): Promise<InvokeSkillResult> {
  return invoke<InvokeSkillResult>("agent_invoke_skill", {
    skillName: opts.skillName,
    args: opts.args,
    cwd: opts.cwd,
    shell: opts.shell,
  });
}

/**
 * Search across commands, AI messages, and skills.
 *
 * Performs full-text search using SQLite FTS5 across all
 * terminal data including command history, AI conversations,
 * and skill definitions.
 *
 * @param query - Search query (supports FTS5 syntax)
 * @param limit - Optional maximum results per category (default: 50)
 * @returns Promise resolving to categorized search results
 *
 * @example
 * ```typescript
 * const results = await searchAll("ping google", 10);
 * console.log(`Found ${results.commands.length} commands`);
 * console.log(`Found ${results.ai_messages.length} AI messages`);
 * console.log(`Found ${results.skills.length} skills`);
 * ```
 */
export async function searchAll(
  query: string,
  limit?: number,
): Promise<SearchResults> {
  return invoke<SearchResults>("search_all", { query, limit });
}

/**
 * Command search result.
 */
export type CommandBlockResult = {
  id: string;
  tab_id: string;
  cmd: string;
  output_snippet: string;
  started_at: number;
  rank: number;
};

export type AiMessageSearchResult = {
  id: string;
  tab_id: string | null;
  role: string;
  content_snippet: string;
  created_at: number;
  rank: number;
};

export type SkillSearchResult = {
  id: string;
  name: string;
  description: string;
  when_to_use: string;
  rank: number;
};

export type SearchResults = {
  commands: CommandBlockResult[];
  ai_messages: AiMessageSearchResult[];
  skills: SkillSearchResult[];
};

// Phase 6 Session Restoration API.
export type AiMessage = {
  id: string;
  tab_id: string;
  role: string;
  content: string;
  timestamp: number;
  /** Agent that produced the message; null = general chat. */
  agentId?: string | null;
};

export type TabSnapshot = {
  id: string;
  title: string;
  shell_cmd: string;
  cwd: string;
  created_at: number;
  scrollback: number[];
  ai_messages: AiMessage[];
};

export type SessionSnapshot = {
  id: string;
  name: string;
  active_tab_id: string | null;
  tabs: TabSnapshot[];
  created_at: number;
};

export const restoreLastSession = () =>
  invoke<SessionSnapshot | null>("restore_last_session");

export const saveCurrentSession = (
  activeTabId: string | null,
  tabIds?: string[],
) => invoke<string>("save_current_session", { activeTabId, tabIds });

export const aiMessagesByTab = (tabId: string) =>
  invoke<AiMessage[]>("ai_messages_by_tab", { tabId });

/** Get messages for a specific (tab, agent) pair. `agentId: null` = general. */
export const aiMessagesByTabAgent = (tabId: string, agentId: string | null) =>
  invoke<AiMessage[]>("ai_messages_by_tab_agent", { tabId, agentId });

/** Delete all messages for a (tab, agent) pair. Returns rows deleted. */
export const aiClearMessages = (tabId: string, agentId: string | null) =>
  invoke<number>("ai_clear_messages", { tabId, agentId });

export type ConversationSummary = {
  tabId: string;
  agentId: string | null;
  messageCount: number;
  lastTimestamp: number;
  preview: string;
  tabExists: boolean;
  tabTitle: string | null;
};

/** List all distinct (tab, agent) conversations for the global history browser. */
export const aiConversationsList = () =>
  invoke<ConversationSummary[]>("ai_conversations_list");

export const saveAiMessage = (opts: {
  tabId: string;
  role: string;
  content: string;
  timestamp: number;
  agentId?: string | null;
}) =>
  invoke<string>("save_ai_message", {
    tabId: opts.tabId,
    role: opts.role,
    content: opts.content,
    timestamp: opts.timestamp,
    agentId: opts.agentId ?? null,
  });

// Phase 6 Named Session Management API.
export type SavedSession = {
  id: string;
  name: string;
  description: string | null;
  tab_count: number;
  created_at: number;
};

export const sessionSaveNamed = (name: string, description: string | null) =>
  invoke<string>("session_save_named", { name, description });

export const sessionListSaved = () =>
  invoke<SavedSession[]>("session_list_saved");

export const sessionLoadSaved = (sessionId: string) =>
  invoke<SessionSnapshot>("session_load_saved", { sessionId });

export const sessionDeleteSaved = (sessionId: string) =>
  invoke<void>("session_delete_saved", { sessionId });

export const sessionExportJson = (sessionId: string) =>
  invoke<string>("session_export_json", { sessionId });

export const sessionImportJson = (jsonData: string) =>
  invoke<string>("session_import_json", { jsonData });

/**
 * Fetch available models from AI provider
 */
export const aiListModels = (opts: {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}) =>
  invoke<string[]>("ai_list_models", {
    provider: opts.provider,
    apiKey: opts.apiKey || null,
    baseUrl: opts.baseUrl || null,
  });

/**
 * AI Provider Configuration
 */
export type AIProviderConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
};

export const aiSaveConfig = (config: AIProviderConfig) =>
  invoke<void>("ai_save_config", { config });

export const aiGetConfig = () =>
  invoke<AIProviderConfig | null>("ai_get_config");

export const aiTestConnection = (config: AIProviderConfig) =>
  invoke<string>("ai_test_connection", { config });

export type EditorMode = "monaco" | "zed";

export const editorModeGet = () => invoke<EditorMode>("editor_mode_get");

export const editorModeSet = (mode: EditorMode) =>
  invoke<void>("editor_mode_set", { mode });

export type AuthoritativeAppearanceSettings = AppearanceSettingsV1 & {
  revision: number;
};

/** Authoritative, versioned appearance preferences stored in app_flags. */
export const appearanceSettingsGet = () =>
  invoke<AuthoritativeAppearanceSettings>("appearance_settings_get");

/** Persists and returns the backend-normalized appearance snapshot. */
export const appearanceSettingsSet = (settings: AppearanceSettingsV1) =>
  invoke<AuthoritativeAppearanceSettings>("appearance_settings_set", { settings });

export type AppearanceSettingsPatchRequest =
  | {
    scope: "application";
    appTheme: AppearanceSettingsV1["appTheme"];
    effects: AppearanceSettingsV1["effects"];
  }
  | {
    scope: "editor";
    editorTheme: AppearanceSettingsV1["editorTheme"];
  }
  | {
    scope: "terminal";
    terminal: AppearanceSettingsV1["terminal"];
  };

/** Atomically merge one appearance scope into the backend-authoritative snapshot. */
export const appearanceSettingsPatch = (patch: AppearanceSettingsPatchRequest) =>
  invoke<AuthoritativeAppearanceSettings>("appearance_settings_patch", { patch });

// Master context-graph feature flag (agent graph helper, temporal memory,
// graph-compact serialization). Persisted in app_flags; the sidecar reads the
// same key. Default OFF — the instant, no-rebuild rollback lever.
export const contextGraphGetEnabled = () =>
  invoke<boolean>("context_graph_get_enabled");

export const contextGraphSetEnabled = (enabled: boolean) =>
  invoke<void>("context_graph_set_enabled", { enabled });

// Staleness window (seconds) for remembered graph facts. Default 7200 (2h).
export const contextGraphGetStaleness = () =>
  invoke<number>("context_graph_get_staleness");

export const contextGraphSetStaleness = (seconds: number) =>
  invoke<void>("context_graph_set_staleness", { seconds });

// Network Architect per-vendor routing keyword overrides. Stored in app_flags
// (key ccie_vendor_keywords); the sidecar merges them over built-in defaults at
// agent-turn time. Defaults come from the sidecar (Python is source of truth).
export type VendorKeywordDefault = {
  id: string;
  display: string;
  keywords: string[];
};

// Saved diagrams (agent-generated draw.io/mermaid, persisted to sessions.db so
// they survive reload). Shape mirrors the Rust `SavedDiagram`.
export type SavedDiagram = {
  id: string;
  title: string;
  format: string;
  xml: string | null;
  source: string | null;
  url: string;
  image_url: string | null;
  agent_id: string | null;
  tab_id: string | null;
  created_at: number;
};

export const diagramSave = (diagram: SavedDiagram) =>
  invoke<void>("diagram_save", { diagram });

export const diagramList = () => invoke<SavedDiagram[]>("diagram_list");

export const diagramDelete = (id: string) =>
  invoke<void>("diagram_delete", { id });

export const vendorKeywordsGet = () => invoke<string>("vendor_keywords_get");

export const vendorKeywordsSet = (keywords: string) =>
  invoke<void>("vendor_keywords_set", { keywords });

export const vendorKeywordDefaults = () =>
  invoke<{ vendors: VendorKeywordDefault[] }>("vendor_keyword_defaults");

// Git / CI defaults for the IaC Studio push flow. Persisted as one JSON blob in
// app_flags under `ccie_git_config`; the Push-to-Git modal prefills from it.
// GitHub credentials are backend-only and deliberately absent from this type.
export type GitConfig = {
  remote?: string;
  branch?: string;
  authorName?: string;
  authorEmail?: string;
  /** An older plaintext token remains quarantined until secure migration works. */
  legacyTokenNeedsReconnect?: boolean;
};

/** One GitHub Actions workflow run, for the IaC Studio Runs panel. */
export type GhWorkflowRun = {
  id: number;
  name: string;
  status: string; // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | "cancelled" | null
  branch: string;
  event: string;
  title: string;
  created_at: string;
  html_url: string;
};

/** List recent GitHub Actions runs for the workspace's origin remote. */
export const githubListRuns = (cwd: string, limit?: number) =>
  invoke<GhWorkflowRun[]>("github_list_runs", {
    cwd,
    limit: limit ?? null,
  });

export const gitConfigGet = async (): Promise<GitConfig> => {
  const raw = await invoke<string>("git_config_get");
  try {
    return JSON.parse(raw) as GitConfig;
  } catch {
    return {};
  }
};

export const gitConfigSet = (config: GitConfig) =>
  invoke<void>("git_config_set", { config: JSON.stringify(config) });

export type ProxmoxConfig = {
  host: string;
  port: number;
  user: string;
  tokenName?: string;
  tokenValue?: string;
  password?: string;
  verifySsl?: boolean;
};

export const proxmoxSaveConfig = (config: ProxmoxConfig) =>
  invoke<void>("proxmox_save_config", { config });

export const proxmoxGetConfig = () =>
  invoke<ProxmoxConfig | null>("proxmox_get_config");

export type ProxmoxTestResult = { ok: boolean; message: string };
export type ProxmoxInventoryNode = { node: string; status?: string };
export type ProxmoxTemplate = { node: string; vmid: string; name?: string };
export type ProxmoxInventory = { nodes: ProxmoxInventoryNode[]; templates: ProxmoxTemplate[] };

export const proxmoxTestConnection = (config: ProxmoxConfig) =>
  invoke<ProxmoxTestResult>("proxmox_test_connection", { config });

export const proxmoxListInventory = () =>
  invoke<ProxmoxInventory>("proxmox_list_inventory");

export type AgentComputerEntry = {
  name: string;
  node: string;
  vmid: string;
  templateVmid?: string;
  baseUrl: string;
  token: string;
};

export type AgentComputerConfig = { computers: AgentComputerEntry[] };
export type AgentComputerTestResult = { ok: boolean; message: string };
export type AgentComputerProvisionResult = AgentComputerTestResult & { computer?: AgentComputerEntry };

export const agentComputersGetConfig = () =>
  invoke<AgentComputerConfig>("agent_computers_get_config");

export const agentComputersSaveConfig = (config: AgentComputerConfig) =>
  invoke<void>("agent_computers_save_config", { config });

export const agentComputerTest = (computer: AgentComputerEntry) =>
  invoke<AgentComputerTestResult>("agent_computer_test", { computer });

export const agentComputerProvision = (computer: AgentComputerEntry) =>
  invoke<AgentComputerProvisionResult>("agent_computer_provision", { computer });

export const agentComputerStart = (computer: AgentComputerEntry) =>
  invoke<AgentComputerTestResult>("agent_computer_start", { computer });

export const agentComputerStop = (computer: AgentComputerEntry) =>
  invoke<AgentComputerTestResult>("agent_computer_stop", { computer });

export type StealthwatchConfig = {
  host: string;
  username: string;
  password: string;
  verifySsl: boolean;
};

export type StealthwatchTestResult = {
  ok: boolean;
  message: string;
};

export const stealthwatchGetConfig = () =>
  invoke<StealthwatchConfig | null>("stealthwatch_get_config");

export const stealthwatchSaveConfig = (config: StealthwatchConfig) =>
  invoke<void>("stealthwatch_save_config", { config });

export const stealthwatchTestConnection = (config: StealthwatchConfig) =>
  invoke<StealthwatchTestResult>("stealthwatch_test_connection", { config });

export type IseConfig = {
  host: string;
  username: string;
  password: string;
  verifySsl: boolean;
};

export type IseTestResult = {
  ok: boolean;
  message: string;
};

export const iseGetConfig = () => invoke<IseConfig | null>("ise_get_config");

export const iseSaveConfig = (config: IseConfig) =>
  invoke<void>("ise_save_config", { config });

export const iseTestConnection = (config: IseConfig) =>
  invoke<IseTestResult>("ise_test_connection", { config });

// ---- Netclaw-inspired integrations (Grafana / Prometheus / NetBox / Sketchfab)
// Shared test-result shape returned by all four test_connection commands.
export type VendorTestResult = { ok: boolean; message: string };

export type GrafanaConfig = {
  url: string;
  token: string;
  verifySsl: boolean;
};
export const grafanaGetConfig = () =>
  invoke<GrafanaConfig | null>("grafana_get_config");
export const grafanaSaveConfig = (config: GrafanaConfig) =>
  invoke<void>("grafana_save_config", { config });
export const grafanaTestConnection = (config: GrafanaConfig) =>
  invoke<VendorTestResult>("grafana_test_connection", { config });

export type ZabbixConfig = { url: string; authMode: "token" | "password"; token: string; username: string; password: string; verifySsl: boolean };
export const zabbixGetConfig = () => invoke<ZabbixConfig | null>("zabbix_get_config");
export const zabbixSaveConfig = (config: ZabbixConfig) => invoke<void>("zabbix_save_config", { config });
export const zabbixTestConnection = (config: ZabbixConfig) => invoke<VendorTestResult>("zabbix_test_connection", { config });

export type PrometheusConfig = {
  url: string;
  username: string;
  password: string;
  token: string;
  orgId: string;
  verifySsl: boolean;
};
export const prometheusGetConfig = () =>
  invoke<PrometheusConfig | null>("prometheus_get_config");
export const prometheusSaveConfig = (config: PrometheusConfig) =>
  invoke<void>("prometheus_save_config", { config });
export const prometheusTestConnection = (config: PrometheusConfig) =>
  invoke<VendorTestResult>("prometheus_test_connection", { config });

export type NetboxConfig = {
  url: string;
  token: string;
  verifySsl: boolean;
};
export const netboxGetConfig = () =>
  invoke<NetboxConfig | null>("netbox_get_config");
export const netboxSaveConfig = (config: NetboxConfig) =>
  invoke<void>("netbox_save_config", { config });
export const netboxTestConnection = (config: NetboxConfig) =>
  invoke<VendorTestResult>("netbox_test_connection", { config });

export type SketchfabConfig = {
  apiKey: string;
};
export const sketchfabGetConfig = () =>
  invoke<SketchfabConfig | null>("sketchfab_get_config");
export const sketchfabSaveConfig = (config: SketchfabConfig) =>
  invoke<void>("sketchfab_save_config", { config });
export const sketchfabTestConnection = (config: SketchfabConfig) =>
  invoke<VendorTestResult>("sketchfab_test_connection", { config });

export type CmlConfig = {
  host: string;
  username: string;
  password: string;
  verifySsl: boolean;
};

export type CmlTestResult = {
  ok: boolean;
  message: string;
};

export const cmlGetConfig = () => invoke<CmlConfig | null>("cml_get_config");

export const cmlSaveConfig = (config: CmlConfig) =>
  invoke<void>("cml_save_config", { config });

export const cmlTestConnection = (config: CmlConfig) =>
  invoke<CmlTestResult>("cml_test_connection", { config });

export type CatalystCenterConfig = {
  host: string;
  username: string;
  password: string;
  verifySsl: boolean;
};

export type CatalystCenterTestResult = {
  ok: boolean;
  message: string;
};

export const catalystCenterGetConfig = () =>
  invoke<CatalystCenterConfig | null>("catalyst_center_get_config");

export const catalystCenterSaveConfig = (config: CatalystCenterConfig) =>
  invoke<void>("catalyst_center_save_config", { config });

export const catalystCenterTestConnection = (config: CatalystCenterConfig) =>
  invoke<CatalystCenterTestResult>("catalyst_center_test_connection", {
    config,
  });

export type SplunkConfig = {
  host: string;
  port: number;
  token: string;
  username: string;
  password: string;
  verifySsl: boolean;
};

export type SplunkTestResult = {
  ok: boolean;
  message: string;
};

export const splunkGetConfig = () =>
  invoke<SplunkConfig | null>("splunk_get_config");

export const splunkSaveConfig = (config: SplunkConfig) =>
  invoke<void>("splunk_save_config", { config });

export const splunkTestConnection = (config: SplunkConfig) =>
  invoke<SplunkTestResult>("splunk_test_connection", { config });

export type AciConfig = {
  host: string;
  username: string;
  password: string;
  verifySsl: boolean;
};

export type AciTestResult = {
  ok: boolean;
  message: string;
};

export const aciGetConfig = () => invoke<AciConfig | null>("aci_get_config");

export const aciSaveConfig = (config: AciConfig) =>
  invoke<void>("aci_save_config", { config });

export const aciTestConnection = (config: AciConfig) =>
  invoke<AciTestResult>("aci_test_connection", { config });

export type GnmiTarget = {
  name: string;
  host: string;
  port?: number | null;
  username: string;
  password: string;
  vendor: string;
  skipVerify: boolean;
};

export type GnmiConfig = {
  targets: GnmiTarget[];
};

export type GnmiTestResult = {
  ok: boolean;
  message: string;
};

export const gnmiGetConfig = () => invoke<GnmiConfig>("gnmi_get_config");

export const gnmiSaveConfig = (config: GnmiConfig) =>
  invoke<void>("gnmi_save_config", { config });

export const gnmiTestConnection = (config: GnmiConfig) =>
  invoke<GnmiTestResult>("gnmi_test_connection", { config });

export type FmcConfig = {
  host: string;
  username: string;
  password: string;
  domainUuid: string;
  verifySsl: boolean;
};

export type FmcTestResult = {
  ok: boolean;
  message: string;
};

export const fmcGetConfig = () => invoke<FmcConfig | null>("fmc_get_config");

export const fmcSaveConfig = (config: FmcConfig) =>
  invoke<void>("fmc_save_config", { config });

export const fmcTestConnection = (config: FmcConfig) =>
  invoke<FmcTestResult>("fmc_test_connection", { config });

export type ThousandEyesConfig = {
  token: string;
  accountGroupId: string;
};

export type ThousandEyesTestResult = {
  ok: boolean;
  message: string;
};

export const thousandeyesGetConfig = () =>
  invoke<ThousandEyesConfig | null>("thousandeyes_get_config");

export const thousandeyesSaveConfig = (config: ThousandEyesConfig) =>
  invoke<void>("thousandeyes_save_config", { config });

export const thousandeyesTestConnection = (config: ThousandEyesConfig) =>
  invoke<ThousandEyesTestResult>("thousandeyes_test_connection", { config });

export type MerakiConfig = {
  apiKey: string;
  orgId: string;
};

export type MerakiTestResult = {
  ok: boolean;
  message: string;
};

export const merakiGetConfig = () =>
  invoke<MerakiConfig | null>("meraki_get_config");

export const merakiSaveConfig = (config: MerakiConfig) =>
  invoke<void>("meraki_save_config", { config });

export const merakiTestConnection = (config: MerakiConfig) =>
  invoke<MerakiTestResult>("meraki_test_connection", { config });

export type SecureEndpointConfig = {
  region: string;
  authMode: string;
  clientId: string;
  apiKey: string;
  verifySsl: boolean;
};

export type SecureEndpointTestResult = {
  ok: boolean;
  message: string;
};

export const secureEndpointGetConfig = () =>
  invoke<SecureEndpointConfig | null>("secure_endpoint_get_config");

export const secureEndpointSaveConfig = (config: SecureEndpointConfig) =>
  invoke<void>("secure_endpoint_save_config", { config });

export const secureEndpointTestConnection = (config: SecureEndpointConfig) =>
  invoke<SecureEndpointTestResult>("secure_endpoint_test_connection", {
    config,
  });

export type CiscoXdrConfig = {
  region: string;
  clientId: string;
  clientPassword: string;
  verifySsl: boolean;
};

export type CiscoXdrTestResult = {
  ok: boolean;
  message: string;
};

export const ciscoXdrGetConfig = () =>
  invoke<CiscoXdrConfig | null>("cisco_xdr_get_config");

export const ciscoXdrSaveConfig = (config: CiscoXdrConfig) =>
  invoke<void>("cisco_xdr_save_config", { config });

export const ciscoXdrTestConnection = (config: CiscoXdrConfig) =>
  invoke<CiscoXdrTestResult>("cisco_xdr_test_connection", { config });

export type MistConfig = {
  region: string;
  apiToken: string;
  verifySsl: boolean;
};

export type MistTestResult = {
  ok: boolean;
  message: string;
};

export const mistGetConfig = () => invoke<MistConfig | null>("mist_get_config");

export const mistSaveConfig = (config: MistConfig) =>
  invoke<void>("mist_save_config", { config });

export const mistTestConnection = (config: MistConfig) =>
  invoke<MistTestResult>("mist_test_connection", { config });

// ---- WhatsApp bridge (personal linked-device transport) --------------------

export type WhatsAppConfig = {
  enabled: boolean;
  defaultAgentId: string;
  /** E.164 numbers permitted to drive agents (the only full-trust guardrail). */
  allowlist: string[];
  /** Heartbeat severities that push a WhatsApp alert. */
  notifySeverities: string[];
  /** neonize device-session directory (empty => sidecar default). */
  sessionDir: string;
  /** Word a message must start with for CCIE to act (empty => respond to all).
   *  Lets CCIE coexist with another bot on the same number. */
  triggerKeyword: string;
  /** Full JID (…@g.us group or …@s.whatsapp.net) CCIE is scoped to. Alerts go
   *  here and only messages in this chat are handled. Empty => any chat. */
  boundChatJid: string;
};

export type WhatsAppGroup = { jid: string; name: string };

export type WhatsAppGroupsResult = {
  ok: boolean;
  message?: string;
  groups: WhatsAppGroup[];
};

/** Link/QR state returned by whatsapp_link / whatsapp_status. */
export type WhatsAppStatus = {
  /** "idle" | "starting" | "qr" | "linked" | "error" */
  state: string;
  /** A `data:image/png;base64,…` QR (or `raw:<payload>`) while pairing. */
  qr: string | null;
  /** The linked number (user part) once connected. */
  me: string | null;
  error: string | null;
};

export const whatsappGetConfig = () =>
  invoke<WhatsAppConfig>("whatsapp_get_config");

export const whatsappSaveConfig = (config: WhatsAppConfig) =>
  invoke<void>("whatsapp_save_config", { config });

export const whatsappLink = () => invoke<WhatsAppStatus>("whatsapp_link");

export const whatsappUnlink = () => invoke<WhatsAppStatus>("whatsapp_unlink");

export const whatsappStatus = () => invoke<WhatsAppStatus>("whatsapp_status");

export const whatsappListGroups = () =>
  invoke<WhatsAppGroupsResult>("whatsapp_list_groups");

// ============================================================================
// Agents - Warp-style specialized personas
// ============================================================================

export type ModelOverride = {
  provider: string;
  model: string;
};

export type AttachedTool = {
  id: string;
  catalog: string;
  defaultBlastRadiusAllowed: string;
  vaultEntry: string;
};

export type Agent = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelOverride?: ModelOverride | null;
  attachedSkills: string[];
  attachedMcpServers: string[];
  attachedTools: AttachedTool[];
  allowedCommands: string[];
  body: string;
  path: string;
  executionMode?: "react" | "code" | "react-code";
  engine?: "deepagents" | "legacy" | null;
};

export type CreateAgentInput = {
  name: string;
  description: string;
  systemPrompt: string;
  modelOverride?: ModelOverride | null;
  attachedSkills?: string[];
  attachedMcpServers?: string[];
  allowedCommands?: string[];
  body?: string;
  executionMode?: "react" | "code" | "react-code";
  engine?: "deepagents" | "legacy" | null;
};

export type AgentSessionRow = {
  tabId: string;
  agentId: string;
  updatedAt: number;
};

export const agentsList = () => invoke<Agent[]>("agents_list");

export const agentsGet = (id: string) => invoke<Agent>("agents_get", { id });

export const agentsCreate = (input: CreateAgentInput) =>
  invoke<Agent>("agents_create", { input });

export const agentsUpdate = (id: string, input: CreateAgentInput) =>
  invoke<Agent>("agents_update", { id, input });

export const agentsDelete = (id: string) =>
  invoke<void>("agents_delete", { id });

export const agentsReload = () => invoke<void>("agents_reload");

export type NetworkArchitectSoulFile = {
  fileName: string;
  content: string;
};

export const networkArchitectSoulList = () =>
  invoke<NetworkArchitectSoulFile[]>("network_architect_soul_list");

export const networkArchitectSoulSave = (fileName: string, content: string) =>
  invoke<NetworkArchitectSoulFile>("network_architect_soul_save", { fileName, content });

export const agentSessionGet = (tabId: string) =>
  invoke<AgentSessionRow | null>("agent_session_get", { tabId });

export const agentSessionSet = (tabId: string, agentId: string) =>
  invoke<void>("agent_session_set", { tabId, agentId });

export const agentSessionListAll = () =>
  invoke<AgentSessionRow[]>("agent_session_list_all");

// ============================================================================
// FTP server
// ============================================================================

export type FtpConfig = {
  bindHost: string;
  bindPort: number;
  passiveMin: number;
  passiveMax: number;
  greeting: string;
  autoStart: boolean;
};

export type FtpUser = {
  id: string;
  username: string;
  password: string;
  homeDir: string;
  readOnly: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type CreateFtpUserInput = {
  username: string;
  password: string;
  homeDir?: string | null;
  readOnly?: boolean;
};

export type UpdateFtpUserInput = {
  id: string;
  username?: string | null;
  password?: string | null;
  homeDir?: string | null;
  readOnly?: boolean | null;
  enabled?: boolean | null;
};

export type FtpStatus = {
  running: boolean;
  bindAddress: string | null;
  startedAt: number | null;
  lastError: string | null;
};

export type FtpEvent = {
  id: number;
  ts: number;
  kind: string;
  username: string | null;
  clientIp: string | null;
  path: string | null;
  detail: string | null;
};

export const ftpConfigGet = () => invoke<FtpConfig>("ftp_config_get");
export const ftpConfigSet = (config: FtpConfig) =>
  invoke<void>("ftp_config_set", { config });

export const ftpStatus = () => invoke<FtpStatus>("ftp_status");
export const ftpStart = () => invoke<FtpStatus>("ftp_start");
export const ftpStop = () => invoke<FtpStatus>("ftp_stop");

export const ftpUsersList = () => invoke<FtpUser[]>("ftp_users_list");
export const ftpUsersCreate = (input: CreateFtpUserInput) =>
  invoke<FtpUser>("ftp_users_create", { input });
export const ftpUsersUpdate = (input: UpdateFtpUserInput) =>
  invoke<void>("ftp_users_update", { input });
export const ftpUsersDelete = (id: string) =>
  invoke<void>("ftp_users_delete", { id });

export const ftpEventsTail = (limit?: number) =>
  invoke<FtpEvent[]>("ftp_events_tail", { limit: limit ?? null });

export async function ftpEventsStream(
  onEvent: (e: FtpEvent) => void,
): Promise<void> {
  const channel = new Channel<FtpEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("ftp_events_stream", { onEvent: channel });
}

// ============================================================================
// TFTP server (anonymous; no users)
// ============================================================================

export type TftpConfig = {
  bindHost: string;
  bindPort: number;
  rootDir: string;
  readOnly: boolean;
  autoStart: boolean;
};

export type TftpStatus = {
  running: boolean;
  bindAddress: string | null;
  startedAt: number | null;
  lastError: string | null;
  elevated: boolean;
};

export type TftpEvent = {
  id: number;
  ts: number;
  kind: string;
  clientIp: string | null;
  path: string | null;
  detail: string | null;
};

export const tftpConfigGet = () => invoke<TftpConfig>("tftp_config_get");
export const tftpConfigSet = (config: TftpConfig) =>
  invoke<void>("tftp_config_set", { config });

export const tftpStatus = () => invoke<TftpStatus>("tftp_status");
export const tftpStart = () => invoke<TftpStatus>("tftp_start");
export const tftpStop = () => invoke<TftpStatus>("tftp_stop");

export const tftpEventsTail = (limit?: number) =>
  invoke<TftpEvent[]>("tftp_events_tail", { limit: limit ?? null });

// ============================================================================
// EDITOR COMMANDS
// ============================================================================

export type EditorFile = {
  id: string;
  tab_id: string;
  file_path: string;
  content: string;
  language: string;
  is_dirty: boolean;
  cursor_position: string | null;
  created_at: number;
  updated_at: number;
};

export const editorOpenFile = (tabId: string, filePath: string) =>
  invoke<EditorFile>("editor_open_file", { tabId, filePath });

export const editorSaveFile = (
  tabId: string,
  filePath: string,
  content: string,
) => invoke<void>("editor_save_file", { tabId, filePath, content });

export type EditorBufferSeed = {
  bufferId: string;
  filePath: string | null;
  content: string;
  language: string;
  ciscoPlatform: CiscoPlatform | null;
  dirty: boolean;
  sourceId: string;
};

export type EditorBufferSnapshot = EditorBufferSeed & {
  revision: number;
};

export type EditorBufferUpdateResult =
  | { status: "applied"; snapshot: EditorBufferSnapshot }
  | { status: "conflict"; snapshot: EditorBufferSnapshot };

export type EditorBufferUpdateRequest = {
  bufferId: string;
  baseRevision: number;
  content: string;
  language: string;
  ciscoPlatform: CiscoPlatform | null;
  dirty: boolean;
  sourceId: string;
};

export type EditorBufferMarkSavedRequest = {
  bufferId: string;
  revision: number;
  sourceId: string;
};

export const editorBufferRegister = (seed: EditorBufferSeed) =>
  invoke<EditorBufferSnapshot>("editor_buffer_register", { seed });

export const editorBufferGet = (bufferId: string) =>
  invoke<EditorBufferSnapshot>("editor_buffer_get", { bufferId });

export const editorBufferUpdate = (request: EditorBufferUpdateRequest) =>
  invoke<EditorBufferUpdateResult>("editor_buffer_update", request);

export const editorBufferMarkSaved = (request: EditorBufferMarkSavedRequest) =>
  invoke<EditorBufferUpdateResult>("editor_buffer_mark_saved", request);

export type DetachedEditorWindowInfo = {
  windowId: string;
  tabId: string;
  paneId: string;
  bufferId: string;
  title: string;
  workspaceRoot: string | null;
};

export type DetachedEditorWindowClosed = Pick<
  DetachedEditorWindowInfo,
  "windowId" | "tabId" | "paneId"
>;

export const editorDetachPane = (
  tabId: string,
  paneId: string,
  bufferId: string,
  title: string,
  workspaceRoot: string | null,
) =>
  invoke<DetachedEditorWindowInfo>("editor_detach_pane", {
    tabId,
    paneId,
    bufferId,
    title,
    workspaceRoot,
  });

export const editorDetachedWindowList = () =>
  invoke<DetachedEditorWindowInfo[]>("editor_detached_window_list");

export const editorDetachedWindowGetCurrent = () =>
  invoke<DetachedEditorWindowInfo>("editor_detached_window_get_current");

export const editorDetachedWindowFocus = (windowId: string) =>
  invoke<void>("editor_detached_window_focus", { windowId });

export const editorDetachedWindowClose = (windowId: string) =>
  invoke<void>("editor_detached_window_close", { windowId });

export const editorSourceWindowFocus = () =>
  invoke<void>("editor_source_window_focus");

/** IaC Studio file (DB-free; no tab_id / FK coupling). */
export type IacStudioFile = {
  file_path: string;
  content: string;
  language: string;
};

/** Read a file for the IaC Studio, scoped to the workspace root. */
export const iacStudioReadFile = (
  filePath: string,
  workspaceRoot: string | null,
) => invoke<IacStudioFile>("iac_studio_read_file", { filePath, workspaceRoot });

/** Write a file for the IaC Studio, scoped to the workspace root. */
export const iacStudioWriteFile = (
  filePath: string,
  content: string,
  workspaceRoot: string | null,
) =>
  invoke<void>("iac_studio_write_file", { filePath, content, workspaceRoot });

/** One lint finding from the IaC Studio linter (mirrors sidecar iac_lint schema). */
export type LintDiagnostic = {
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
};

/** Per-linter run status — surfaces honest "skipped/unavailable + reason". */
export type LinterStatus = {
  name: string;
  ran: boolean;
  available: boolean;
  reason: string | null;
};

export type LintResult = {
  diagnostics: LintDiagnostic[];
  linters: LinterStatus[];
};

/** Lint a buffer (terraform/ansible) via the sidecar. Throws if sidecar down. */
export const iacLintFile = (
  filePath: string,
  content: string,
  language: string,
) => invoke<LintResult>("iac_lint_file", { filePath, content, language });

/** Result of an IaC Studio codegen RPC (mirrors sidecar iac_codegen schema). */
export type CodegenResult = {
  tool: "terraform" | "ansible" | "pipeline";
  code: string;
  filename: string;
  explanation: string;
  estimated_apply_time_seconds: number;
  validation: { valid: boolean | null; skipped: boolean; error: string | null };
  /** True when the LLM was unavailable or returned no usable code. */
  unavailable: boolean;
};

/** Generate Terraform HCL from NL intent via the Settings-page LLM. */
export const iacGenerateTerraform = (
  intent: string,
  workingDir: string,
  gitBranch?: string,
  existingCode?: string,
) =>
  invoke<CodegenResult>("iac_generate_terraform", {
    intent,
    workingDir,
    gitBranch: gitBranch ?? "",
    existingCode: existingCode ?? "",
  });

/** Generate an Ansible playbook from NL intent via the Settings-page LLM. */
export const iacGenerateAnsible = (
  intent: string,
  workingDir: string,
  gitBranch?: string,
  existingCode?: string,
) =>
  invoke<CodegenResult>("iac_generate_ansible", {
    intent,
    workingDir,
    gitBranch: gitBranch ?? "",
    existingCode: existingCode ?? "",
  });

/**
 * Generate a CI/CD pipeline (GitHub Actions / GitLab CI) from structured inputs
 * via the Settings-page LLM. Output is validated as plain YAML, never as
 * HCL/playbook — so a pipeline file is not falsely flagged by terraform/ansible
 * validators. `tool` is the IaC tool the pipeline drives (terraform|ansible).
 */
export const iacGeneratePipeline = (
  platform: "github" | "gitlab",
  tool: "terraform" | "ansible",
  flow: string,
  auth?: string,
  intent?: string,
) =>
  invoke<CodegenResult>("iac_generate_pipeline", {
    platform,
    tool,
    flow,
    auth: auth ?? "",
    intent: intent ?? "",
  });

export const editorGetState = (tabId: string) =>
  invoke<EditorFile | null>("editor_get_state", { tabId });

export const editorListRecent = (limit: number) =>
  invoke<string[]>("editor_list_recent", { limit });

export type FileNodeType = "file" | "directory";

export type FileNode = {
  path: string;
  name: string;
  node_type: FileNodeType;
  children?: FileNode[];
};

export const editorListDirectory = (path: string) =>
  invoke<FileNode[]>("editor_list_directory", { path });

export type EditorSearchMatch = {
  file_path: string;
  line: number;
  column: number;
  preview: string;
};

export type EditorFindInFilesRequest = {
  workspaceRoot: string;
  query: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  filePattern?: string | null;
  maxResults: number;
};

export const editorFindInFiles = (request: EditorFindInFilesRequest) =>
  invoke<EditorSearchMatch[]>("editor_find_in_files", {
    workspace_root: request.workspaceRoot,
    query: request.query,
    regex: request.regex,
    match_case: request.matchCase,
    whole_word: request.wholeWord,
    file_pattern: request.filePattern ?? null,
    max_results: request.maxResults,
  });

export const editorGetHomeDirectory = () =>
  invoke<string>("editor_get_home_directory");

// `workspaceRoot` is the editor tab's `root_path` (the directory the user
// opened). The backend uses it as a containment boundary — paths that
// canonicalize outside it are rejected. When omitted, the backend falls
// back to the user's home directory.
export const editorCreateFile = (path: string, workspaceRoot?: string | null) =>
  invoke<void>("editor_create_file", {
    path,
    workspaceRoot: workspaceRoot ?? null,
  });

export const editorDeleteFile = (path: string, workspaceRoot?: string | null) =>
  invoke<void>("editor_delete_file", {
    path,
    workspaceRoot: workspaceRoot ?? null,
  });

export const editorRenameFile = (
  oldPath: string,
  newPath: string,
  workspaceRoot?: string | null,
) =>
  invoke<void>("editor_rename_file", {
    oldPath,
    newPath,
    workspaceRoot: workspaceRoot ?? null,
  });

export const editorFileExists = (path: string) =>
  invoke<boolean>("editor_file_exists", { path });

export const editorCreateDirectory = (
  path: string,
  workspaceRoot?: string | null,
) =>
  invoke<void>("editor_create_directory", {
    path,
    workspaceRoot: workspaceRoot ?? null,
  });

// ---------------------------------------------------------------------------
// Language Server Protocol (LSP)
// ---------------------------------------------------------------------------

export type LspSessionInfo = {
  language: string;
  workspaceRoot: string;
  serverName: string;
};

export const lspStart = (
  language: string,
  workspaceRoot: string,
  clientId: string,
) =>
  invoke<LspSessionInfo>("lsp_start", {
    language,
    workspaceRoot,
    clientId,
  });

export const lspStop = (
  language: string,
  workspaceRoot: string,
  clientId: string,
) =>
  invoke<void>("lsp_stop", {
    language,
    workspaceRoot,
    clientId,
  });

export const lspRequest = <T = unknown>(
  language: string,
  workspaceRoot: string,
  method: string,
  params: unknown,
) =>
  invoke<T>("lsp_request", {
    language,
    workspaceRoot,
    method,
    params,
  });

export const lspDocumentOpen = (
  language: string,
  workspaceRoot: string,
  clientId: string,
  uri: string,
  languageId: string,
  text: string,
) =>
  invoke<void>("lsp_document_open", {
    language,
    workspaceRoot,
    clientId,
    uri,
    languageId,
    text,
  });

export const lspDocumentChange = (
  language: string,
  workspaceRoot: string,
  clientId: string,
  uri: string,
  text: string,
) =>
  invoke<void>("lsp_document_change", {
    language,
    workspaceRoot,
    clientId,
    uri,
    text,
  });

export const lspDocumentClose = (
  language: string,
  workspaceRoot: string,
  clientId: string,
  uri: string,
) =>
  invoke<void>("lsp_document_close", {
    language,
    workspaceRoot,
    clientId,
    uri,
  });

export const lspIsRunning = (language: string, workspaceRoot: string) =>
  invoke<boolean>("lsp_is_running", { language, workspaceRoot });

export const lspCheckAvailable = (workspaceRoot: string) =>
  invoke<string[]>("lsp_check_available", { workspaceRoot });

// ---------------------------------------------------------------------------
// Debug Adapter Protocol (DAP)
// ---------------------------------------------------------------------------

export const DAP_EVENT = "dap://event";
export const DAP_BREAKPOINTS_CHANGED_EVENT = "dap://breakpoints-changed";

export type DapSessionStatus =
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "error";

export type DapSessionInfo = {
  sessionId: string;
  tabId: string;
  workspaceRoot: string;
  program: string;
  interpreter: string;
  adapterName: string;
  status: DapSessionStatus;
};

export type DapAvailability = {
  available: boolean;
  adapterPython: string;
  interpreter: string | null;
  message: string | null;
};

export type DapBreakpoint = {
  id: number | null;
  line: number;
  verified: boolean;
  message: string | null;
};

export type DapBreakpointSet = {
  tabId: string;
  filePath: string;
  breakpoints: DapBreakpoint[];
};

export type DapEventEnvelope = {
  sessionId: string;
  tabId: string;
  event: string;
  body: Record<string, unknown> | null;
};

export type DapSource = {
  name?: string;
  path?: string;
  sourceReference?: number;
};

export type DapThread = {
  id: number;
  name: string;
};

export type DapStackFrame = {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  presentationHint?: string;
};

export type DapScope = {
  name: string;
  variablesReference: number;
  expensive: boolean;
  namedVariables?: number;
  indexedVariables?: number;
  source?: DapSource;
  line?: number;
  column?: number;
};

export type DapVariable = {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
};

export type DapEvaluateResult = {
  result: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
};

export type DapLaunchOptions = {
  tabId: string;
  workspaceRoot: string;
  program: string;
  interpreter?: string | null;
  args?: string[];
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  justMyCode?: boolean;
};

export const dapCheckAvailable = (workspaceRoot: string) =>
  invoke<DapAvailability>("dap_check_available", { workspaceRoot });

export const dapResolveInterpreter = (
  workspaceRoot: string,
  explicit?: string | null,
) =>
  invoke<string>("dap_resolve_interpreter", {
    workspaceRoot,
    explicit: explicit ?? null,
  });

export const dapStart = (options: DapLaunchOptions) =>
  invoke<DapSessionInfo>("dap_start", {
    tabId: options.tabId,
    workspaceRoot: options.workspaceRoot,
    program: options.program,
    interpreter: options.interpreter ?? null,
    args: options.args ?? [],
    env: options.env ?? {},
    stopOnEntry: options.stopOnEntry ?? false,
    justMyCode: options.justMyCode ?? true,
  });

export const dapRestart = (sessionId: string) =>
  invoke<DapSessionInfo>("dap_restart", { sessionId });

export const dapStop = (sessionId: string) =>
  invoke<void>("dap_stop", { sessionId });

export const dapClearTab = (tabId: string) =>
  invoke<void>("dap_clear_tab", { tabId });

export const dapSessionForTab = (tabId: string) =>
  invoke<DapSessionInfo | null>("dap_session_for_tab", { tabId });

export const dapBreakpointsGet = (
  tabId: string,
  workspaceRoot: string,
  filePath: string,
) =>
  invoke<DapBreakpointSet>("dap_breakpoints_get", {
    tabId,
    workspaceRoot,
    filePath,
  });

export const dapBreakpointsSet = (
  tabId: string,
  workspaceRoot: string,
  filePath: string,
  lines: number[],
) =>
  invoke<DapBreakpointSet>("dap_breakpoints_set", {
    tabId,
    workspaceRoot,
    filePath,
    lines,
  });

export const dapThreads = (sessionId: string) =>
  invoke<{ threads: DapThread[] }>("dap_threads", { sessionId });

export const dapStackTrace = (sessionId: string, threadId: number) =>
  invoke<{ stackFrames: DapStackFrame[]; totalFrames?: number }>(
    "dap_stack_trace",
    { sessionId, threadId },
  );

export const dapScopes = (sessionId: string, frameId: number) =>
  invoke<{ scopes: DapScope[] }>("dap_scopes", { sessionId, frameId });

export const dapVariables = (
  sessionId: string,
  variablesReference: number,
) =>
  invoke<{ variables: DapVariable[] }>("dap_variables", {
    sessionId,
    variablesReference,
  });

export const dapEvaluate = (
  sessionId: string,
  expression: string,
  frameId?: number | null,
) =>
  invoke<DapEvaluateResult>("dap_evaluate", {
    sessionId,
    expression,
    frameId: frameId ?? null,
  });

export const dapContinue = (sessionId: string, threadId: number) =>
  invoke<unknown>("dap_continue", { sessionId, threadId });

export const dapPause = (sessionId: string, threadId: number) =>
  invoke<unknown>("dap_pause", { sessionId, threadId });

export const dapNext = (sessionId: string, threadId: number) =>
  invoke<unknown>("dap_next", { sessionId, threadId });

export const dapStepIn = (sessionId: string, threadId: number) =>
  invoke<unknown>("dap_step_in", { sessionId, threadId });

export const dapStepOut = (sessionId: string, threadId: number) =>
  invoke<unknown>("dap_step_out", { sessionId, threadId });

// ---------------------------------------------------------------------------
// Git integration
// ---------------------------------------------------------------------------

export type GitStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed";

export type GitFileStatus = {
  /** Repo-root-relative path. */
  path: string;
  status: GitStatusKind;
};

export const gitGetStatus = (repoPath: string) =>
  invoke<GitFileStatus[]>("git_get_status", { repoPath });

export const gitGetDiff = (repoPath: string, filePath: string) =>
  invoke<string>("git_get_diff", { repoPath, filePath });

export type GitLineChangeKind = "added" | "modified" | "deleted";

export type GitLineChange = {
  /** One-based line number in the current editor buffer. */
  lineNumber: number;
  kind: GitLineChangeKind;
  /** Non-zero for deletion markers anchored to a surviving line. */
  deletedLines: number;
};

export type GitFileChanges = {
  repoRoot: string;
  relativePath: string;
  binary: boolean;
  changes: GitLineChange[];
};

export type GitLineBlame = {
  lineNumber: number;
  commit: string | null;
  author: string;
  authorEmail: string | null;
  /** Unix seconds from the commit author's signature. */
  timestamp: number | null;
  summary: string | null;
  uncommitted: boolean;
};

export type GitRepositorySummary = {
  repoRoot: string;
  branch: string | null;
  headOid: string | null;
  dirty: boolean;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
};

/** Structured HEAD-to-current-buffer changes, including unsaved Monaco edits. */
export const gitGetFileChanges = (filePath: string, contents: string) =>
  invoke<GitFileChanges | null>("git_get_file_changes", {
    filePath,
    contents,
  });

/** Blame one current-buffer line, including honest uncommitted-line handling. */
export const gitGetLineBlame = (
  filePath: string,
  contents: string,
  lineNumber: number,
) =>
  invoke<GitLineBlame | null>("git_get_line_blame", {
    filePath,
    contents,
    lineNumber,
  });

/** Lightweight branch and dirty summary from either a directory or file path. */
export const gitGetRepositorySummary = (path: string) =>
  invoke<GitRepositorySummary | null>("git_get_repository_summary", { path });

export const gitIsRepo = (path: string) =>
  invoke<boolean>("git_is_repo", { path });

/** Result of a shelled-out git write command. `ok=false` carries stderr. */
export type GitCmdResult = { ok: boolean; stdout: string; stderr: string };

/** `git init` (idempotent). */
export const gitInit = (cwd: string) =>
  invoke<GitCmdResult>("git_init", { cwd });

/** Stage `paths` (or all when empty) and commit; no-ops cleanly if nothing staged. */
export const gitCommitPaths = (cwd: string, paths: string[], message: string) =>
  invoke<GitCmdResult>("git_commit_paths", { cwd, paths, message });

/** URL of the named remote (default origin), or null if unset. */
export const gitGetRemote = (cwd: string, name?: string) =>
  invoke<string | null>("git_get_remote", { cwd, name: name ?? null });

/** Set (or add) the named remote's URL. */
export const gitSetRemote = (cwd: string, url: string, name?: string) =>
  invoke<GitCmdResult>("git_set_remote", { cwd, url, name: name ?? null });

/** Push the current branch to the remote (sets upstream). Uses ambient creds. */
export const gitPush = (cwd: string, name?: string) =>
  invoke<GitCmdResult>("git_push", { cwd, name: name ?? null });

/** Current branch name, or null in an empty repo / detached HEAD. */
export const gitCurrentBranch = (cwd: string) =>
  invoke<string | null>("git_current_branch", { cwd });

export type GitRemote = {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
};

export type GitRepositoryDescriptor = {
  root: string;
  name: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  remotes: GitRemote[];
};

export type GitChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "typechange";

export type GitChangeEntry = {
  path: string;
  previousPath: string | null;
  indexStatus: GitChangeStatus | null;
  worktreeStatus: GitChangeStatus | null;
  conflict: boolean;
};

export type GitRepositoryState = {
  repository: GitRepositoryDescriptor;
  changes: GitChangeEntry[];
};

export type GitBranch = {
  name: string;
  fullName: string;
  kind: "local" | "remote";
  current: boolean;
  target: string | null;
  upstream: string | null;
};

export type GitCommitSummary = {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  authorEmail: string | null;
  /** Unix seconds. */
  timestamp: number;
  parents: string[];
};

export type GitCommitFile = {
  path: string;
  previousPath: string | null;
  status: GitChangeStatus | "copied";
};

export type GitCommitDetail = {
  commit: GitCommitSummary;
  files: GitCommitFile[];
};

export type GitDiffPayload = {
  originalLabel: string;
  modifiedLabel: string;
  original: string | null;
  modified: string | null;
  language: string;
  binary: boolean;
  oversized: boolean;
  originalSize: number;
  modifiedSize: number;
};

export type GitOperationResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  repository: GitRepositoryState | null;
};

export type GitHubAccount = {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  storage: "keyring" | "session";
  storageWarning: string | null;
};

export type GitHubRepository = {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  updatedAt: string | null;
};

export type GitHubRepositoryPage = {
  repositories: GitHubRepository[];
  page: number;
  hasMore: boolean;
};

export type GitHubDeviceAuthorization = {
  authorizationId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type GitHubAuthPollResult = {
  status:
    | "pending"
    | "slowDown"
    | "connected"
    | "denied"
    | "expired"
    | "cancelled";
  account: GitHubAccount | null;
  retryAfter: number | null;
  message: string | null;
};

export const gitDiscoverRepositories = (
  workspacePath: string,
  additionalPaths: string[] = [],
) =>
  invoke<GitRepositoryDescriptor[]>("git_discover_repositories", {
    workspacePath,
    additionalPaths,
  });

export const gitGetRepositoryState = (repoPath: string) =>
  invoke<GitRepositoryState>("git_get_repository_state", { repoPath });

export const gitWatchRepositories = (roots: string[]) =>
  invoke<void>("git_watch_repositories", { roots });

export const gitStagePaths = (repoPath: string, paths: string[]) =>
  invoke<GitOperationResult>("git_stage_paths", { repoPath, paths });

export const gitUnstagePaths = (repoPath: string, paths: string[]) =>
  invoke<GitOperationResult>("git_unstage_paths", { repoPath, paths });

export const gitRepositoryCommit = (repoPath: string, message: string) =>
  invoke<GitOperationResult>("git_repository_commit", { repoPath, message });

export const gitInitializeRepository = (workspacePath: string) =>
  invoke<GitOperationResult>("git_initialize_repository", { workspacePath });

export const gitCloneRepository = (
  url: string,
  target: string,
  intoExisting: boolean,
) =>
  invoke<GitOperationResult>("git_clone_repository", {
    url,
    target,
    intoExisting,
  });

export const gitListBranches = (repoPath: string) =>
  invoke<GitBranch[]>("git_list_branches", { repoPath });

export const gitSwitchBranch = (repoPath: string, branch: GitBranch) =>
  invoke<GitOperationResult>("git_switch_branch", { repoPath, branch });

export const gitRepositoryFetch = (repoPath: string, remote?: string) =>
  invoke<GitOperationResult>("git_repository_fetch", {
    repoPath,
    remote: remote ?? null,
  });

export const gitRepositoryPull = (repoPath: string, remote?: string) =>
  invoke<GitOperationResult>("git_repository_pull", {
    repoPath,
    remote: remote ?? null,
  });

export const gitRepositoryPush = (repoPath: string, remote?: string) =>
  invoke<GitOperationResult>("git_repository_push", {
    repoPath,
    remote: remote ?? null,
  });

export const gitAddRemote = (repoPath: string, name: string, url: string) =>
  invoke<GitOperationResult>("git_add_remote", { repoPath, name, url });

export const gitUpdateRemote = (repoPath: string, name: string, url: string) =>
  invoke<GitOperationResult>("git_update_remote", { repoPath, name, url });

export const gitRemoveRemote = (repoPath: string, name: string) =>
  invoke<GitOperationResult>("git_remove_remote", { repoPath, name });

export const gitRepositoryHistory = (
  repoPath: string,
  filePath: string | null,
  skip: number,
  limit = 100,
) =>
  invoke<GitCommitSummary[]>("git_repository_history", {
    repoPath,
    filePath,
    skip,
    limit,
  });

export const gitCommitDetail = (repoPath: string, sha: string) =>
  invoke<GitCommitDetail>("git_commit_detail", { repoPath, sha });

export const gitStagedDiff = (repoPath: string, filePath: string) =>
  invoke<GitDiffPayload>("git_staged_diff", { repoPath, filePath });

export const gitUnstagedDiff = (
  repoPath: string,
  filePath: string,
  bufferContents?: string,
) =>
  invoke<GitDiffPayload>("git_unstaged_diff", {
    repoPath,
    filePath,
    bufferContents: bufferContents ?? null,
  });

export const gitHistoricalDiff = (
  repoPath: string,
  sha: string,
  filePath: string,
  previousPath?: string | null,
) =>
  invoke<GitDiffPayload>("git_historical_diff", {
    repoPath,
    sha,
    filePath,
    previousPath: previousPath ?? null,
  });

export const githubAuthStart = (sessionOnly: boolean) =>
  invoke<GitHubDeviceAuthorization>("github_auth_start", { sessionOnly });

export const githubAuthPoll = (authorizationId: string) =>
  invoke<GitHubAuthPollResult>("github_auth_poll", { authorizationId });

export const githubAuthCancel = (authorizationId: string) =>
  invoke<void>("github_auth_cancel", { authorizationId });

export const githubAccountStatus = () =>
  invoke<GitHubAccount | null>("github_account_status");

export const githubDisconnect = () => invoke<void>("github_disconnect");

export const githubListRepositories = (page: number, query?: string) =>
  invoke<GitHubRepositoryPage>("github_list_repositories", {
    page,
    query: query?.trim() || null,
  });

export const tabNewEditor = (opts: {
  title: string;
  filePath?: string | null;
}) => invoke<Tab>("tab_new_editor", opts);

export const tabCloseEditor = (tabId: string) =>
  invoke<void>("tab_close_editor", { tabId });

// ============================================================================
// Heartbeat Monitoring
// ============================================================================

export type CheckInput = {
  checkGroupName: string;
  agentId: string;
  agentPrompt: string;
  sortOrder: number;
};

// Plan returned from Python sidecar (snake_case)
export type HeartbeatPlanCheck = {
  check_group_name: string;
  agent_id: string;
  agent_prompt: string;
  sort_order: number;
};

export type HeartbeatPlan = {
  name: string;
  description: string;
  interval_minutes: number;
  checks: HeartbeatPlanCheck[];
};

export type HeartbeatPlanResult = {
  status: "success" | "error";
  plan: HeartbeatPlan | null;
  error: string | null;
};

/**
 * Convert natural language input to a structured heartbeat check plan.
 * Used by CreateHeartbeatModal to generate plans from user descriptions.
 *
 * @param nlInput - Natural language description (e.g., "Check my Meraki network every 30 minutes")
 * @param context - Optional context with available networks, testbeds, etc.
 * @returns Plan result with status, plan object, or error message
 */
export async function planHeartbeat(
  nlInput: string,
  context?: Record<string, any>,
): Promise<HeartbeatPlanResult> {
  return invoke("heartbeat_plan", {
    nlInput,
    context: context || {},
  });
}

export async function createHeartbeat(
  name: string,
  description: string,
  interval_minutes: number,
  retention_days: number,
  checks: CheckInput[],
): Promise<import("../state/heartbeatStore").Heartbeat> {
  return invoke("heartbeat_create", {
    name,
    description,
    intervalMinutes: interval_minutes,
    retentionDays: retention_days,
    checks,
  });
}

export interface HeartbeatDetail {
  heartbeat: import("../state/heartbeatStore").Heartbeat;
  checks: Array<{
    id: string;
    heartbeatId: string;
    checkGroupName: string;
    agentId: string;
    agentPrompt: string;
    sortOrder: number;
    createdAt: number;
  }>;
}

/** Fetch a heartbeat with its checks (for editing). */
export async function getHeartbeat(id: string): Promise<HeartbeatDetail> {
  return invoke("heartbeat_get", { id });
}

/** Update a heartbeat's metadata (name, description, interval, retention). */
export async function updateHeartbeat(
  id: string,
  name: string,
  description: string,
  interval_minutes: number,
  retention_days: number,
): Promise<import("../state/heartbeatStore").Heartbeat> {
  return invoke("heartbeat_update", {
    id,
    name,
    description,
    intervalMinutes: interval_minutes,
    retentionDays: retention_days,
  });
}

/** Replace a heartbeat's checks. */
export async function updateHeartbeatChecks(
  id: string,
  checks: CheckInput[],
): Promise<void> {
  return invoke("heartbeat_update_checks", { id, checks });
}

export async function pauseHeartbeat(id: string): Promise<void> {
  return invoke("heartbeat_pause", { id });
}

export async function resumeHeartbeat(id: string): Promise<void> {
  return invoke("heartbeat_resume", { id });
}

export async function deleteHeartbeat(id: string): Promise<void> {
  return invoke("heartbeat_delete", { id });
}

export async function triggerHeartbeatNow(id: string): Promise<string> {
  return invoke("heartbeat_trigger_now", { id });
}

export async function exportHeartbeat(id: string): Promise<string> {
  return invoke("heartbeat_export", { id });
}

export async function importHeartbeat(
  json: string,
): Promise<import("../state/heartbeatStore").Heartbeat> {
  return invoke("heartbeat_import", { json });
}

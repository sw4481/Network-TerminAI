import { create } from "zustand";
import type {
  ApiAuth,
  ApiEndpoint,
  ApiHistoryDetail,
  ApiRequest,
  ApiResponse,
  ApiSavedRequest,
  ApiTargetManifest,
  BodyKind,
  HttpMethod,
} from "../lib/tauri";
import {
  extractEnvPlaceholders,
  extractVarPlaceholders,
  manifestAuthToApiAuth,
} from "../lib/tauri";

/** Mutable per-tab state for an API Runner tab. */
export type ApiTabState = {
  method: HttpMethod;
  url: string;
  headers: Array<{ key: string; value: string }>;
  query: Array<{ key: string; value: string }>;
  body_kind: BodyKind;
  body_text: string;
  auth: ApiAuth;
  insecure_skip_verify: boolean;
  /** Latest response (including error-shape responses). null = never sent. */
  response: ApiResponse | null;
  /** In-flight flag used to disable Send and show a spinner. */
  sending: boolean;
  /** The last wall-clock the user hit Send — used for timing display. */
  last_error: string | null;
};

const emptyTabState = (): ApiTabState => ({
  method: "GET",
  url: "",
  headers: [],
  query: [],
  body_kind: "none",
  body_text: "",
  auth: { type: "none" },
  insecure_skip_verify: false,
  response: null,
  sending: false,
  last_error: null,
});

type Store = {
  /** Keyed by tab_id. Created lazily on first access. */
  tabs: Record<string, ApiTabState>;
  ensure: (tabId: string) => ApiTabState;
  patch: (tabId: string, partial: Partial<ApiTabState>) => void;
  setHeaders: (tabId: string, headers: ApiTabState["headers"]) => void;
  setQuery: (tabId: string, query: ApiTabState["query"]) => void;
  setResponse: (tabId: string, resp: ApiResponse | null) => void;
  setSending: (tabId: string, sending: boolean) => void;
  setError: (tabId: string, err: string | null) => void;
  reset: (tabId: string) => void;
};

export const useApiRunner = create<Store>((set, get) => ({
  tabs: {},
  ensure: (tabId) => {
    const existing = get().tabs[tabId];
    if (existing) return existing;
    const next = emptyTabState();
    set((s) => ({ tabs: { ...s.tabs, [tabId]: next } }));
    return next;
  },
  patch: (tabId, partial) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, ...partial } } };
    }),
  setHeaders: (tabId, headers) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, headers } } };
    }),
  setQuery: (tabId, query) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, query } } };
    }),
  setResponse: (tabId, response) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, response } } };
    }),
  setSending: (tabId, sending) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, sending } } };
    }),
  setError: (tabId, last_error) =>
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTabState();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, last_error } } };
    }),
  reset: (tabId) =>
    set((s) => {
      const next = { ...s.tabs };
      delete next[tabId];
      return { tabs: next };
    }),
}));

/**
 * Project a tab's state into an `ApiRequest` wire payload.
 * Converts header/query arrays into the Record shape the backend expects,
 * dropping rows with empty keys.
 */
export function stateToRequest(s: ApiTabState): ApiRequest {
  const headers: Record<string, string> = {};
  for (const { key, value } of s.headers) {
    const k = key.trim();
    if (k) headers[k] = value;
  }
  const query: Record<string, string> = {};
  for (const { key, value } of s.query) {
    const k = key.trim();
    if (k) query[k] = value;
  }
  return {
    method: s.method,
    url: s.url.trim(),
    headers,
    query,
    body_kind: s.body_kind,
    body_text: s.body_kind === "none" || s.body_kind === "binary" ? null : s.body_text,
    body_bytes: null,
    auth: s.auth,
    timeout_secs: null,
    insecure_skip_verify: s.insecure_skip_verify,
    tls_ca_bundle: null,
    tls_client_cert: null,
  };
}

/**
 * Every placeholder referenced by a tab's current state — URL, headers,
 * query, body, and auth. Returns both `env` and `var` names since the
 * UI treats them equivalently (both live in the `<env>.env` file).
 *
 * This is what the CredentialsPanel banner uses to show "missing
 * required variables" — the set is computed from WHAT THE USER IS ABOUT
 * TO SEND, not just the manifest, so path-param placeholders written
 * into the URL bar get flagged the same way as auth placeholders.
 */
export function stateRequiredKeys(s: ApiTabState): string[] {
  const out = new Set<string>();
  const pick = (text: string | null | undefined) => {
    for (const n of extractEnvPlaceholders(text)) out.add(n);
    for (const n of extractVarPlaceholders(text)) out.add(n);
  };
  pick(s.url);
  for (const { key, value } of s.headers) {
    pick(key);
    pick(value);
  }
  for (const { key, value } of s.query) {
    pick(key);
    pick(value);
  }
  if (s.body_kind !== "none" && s.body_kind !== "binary") {
    pick(s.body_text);
  }
  const a = s.auth;
  switch (a.type) {
    case "header":
      pick(a.name);
      pick(a.value);
      break;
    case "basic":
      pick(a.username);
      pick(a.password);
      break;
    case "bearer":
      pick(a.token);
      break;
    case "token_login":
      pick(a.login.url);
      pick(a.login.token_jsonpath);
      if (a.login.credentials.type === "basic") {
        pick(a.login.credentials.username);
        pick(a.login.credentials.password);
      } else {
        pick(a.login.credentials.body);
      }
      if (a.apply.mode === "header") pick(a.apply.name);
      break;
    case "session_cookie":
      pick(a.login.url);
      if (a.login.credentials.type === "basic") {
        pick(a.login.credentials.username);
        pick(a.login.credentials.password);
      } else {
        pick(a.login.credentials.body);
      }
      break;
    case "hook":
      pick(a.module);
      pick(a.function);
      break;
    case "none":
      break;
  }
  return Array.from(out);
}

/**
 * Rewrite OpenAPI-style path params `{organizationId}` into the resolver's
 * placeholder syntax `${var:organizationId}` so the backend substitutes
 * them from the currently-active environment.
 *
 * Operates on ONE path string (not base_url) so it can't clobber the
 * manifest's `${env:...}` placeholders. Only replaces occurrences whose
 * name looks like an identifier — defensive against weird query strings
 * that happen to contain braces.
 */
export function rewritePathParams(path: string): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "${var:$1}");
}

/**
 * Apply a selected endpoint (in context of its manifest) onto a tab's state.
 *
 * Copies method/url/default-headers/endpoint-query AND the manifest's auth
 * declaration (with `${env:...}` placeholders intact — the backend resolver
 * substitutes them using the currently-active environment at send time).
 * Path params `{foo}` in the endpoint path are rewritten to `${var:foo}`.
 */
export function applyEndpointToState(
  current: ApiTabState,
  manifest: ApiTargetManifest,
  endpoint: ApiEndpoint,
): ApiTabState {
  const url = `${manifest.base_url}${rewritePathParams(endpoint.path)}`;
  const headers: Array<{ key: string; value: string }> = Object.entries(
    manifest.defaults.headers,
  ).map(([key, value]) => ({ key, value }));
  const query: Array<{ key: string; value: string }> = Object.entries(
    endpoint.query_params,
  ).map(([key, value]) => ({ key, value }));
  return {
    ...current,
    method: endpoint.method,
    url,
    headers,
    query,
    // Adopt the manifest's auth strategy. Placeholders stay unresolved —
    // the backend substitutes them from the selected environment.
    auth: manifestAuthToApiAuth(manifest.auth),
    // TLS options also come from the manifest.
    insecure_skip_verify: !manifest.tls.verify,
    response: null,
    last_error: null,
  };
}

/**
 * Hydrate tab state from a saved request row. Headers / query are stored
 * as JSON-serialized records on the DB side; we parse them back into the
 * array-of-{key,value} shape used by the editor.
 */
export function applySavedRequestToState(
  current: ApiTabState,
  saved: ApiSavedRequest,
): ApiTabState {
  const headers = recordToPairs(safeParseRecord(saved.headers_json));
  const query = recordToPairs(safeParseRecord(saved.query_json));
  const auth = safeParseAuth(saved.auth_json);
  return {
    ...current,
    method: saved.method as HttpMethod,
    url: saved.url,
    headers,
    query,
    body_kind: (saved.body_kind as BodyKind) ?? "none",
    body_text: saved.body_text ?? "",
    auth,
    response: null,
    last_error: null,
  };
}

function safeParseAuth(raw: string | null | undefined): ApiAuth {
  if (!raw) return { type: "none" };
  try {
    const value = JSON.parse(raw) as ApiAuth;
    if (value && typeof value === "object" && typeof value.type === "string") {
      return value;
    }
  } catch {
    // Imported/auth metadata must never prevent loading the raw request.
  }
  return { type: "none" };
}

/**
 * Hydrate tab state from a history detail row (i.e. re-open a past send).
 * The response is also restored so the user can inspect it without re-firing.
 */
export function applyHistoryDetailToState(
  current: ApiTabState,
  detail: ApiHistoryDetail,
): ApiTabState {
  const headers = recordToPairs(safeParseRecord(detail.request_headers_json));
  const response: ApiResponse | null =
    detail.status_code === null
      ? null
      : {
          status_code: detail.status_code,
          status_text: "",
          headers: safeParseRecord(detail.response_headers_json ?? "{}"),
          body: detail.response_body ?? "",
          body_truncated: detail.response_body_truncated,
          duration_ms: detail.duration_ms ?? 0,
          final_url: detail.url,
          error: detail.error,
        };
  return {
    ...current,
    method: detail.method as HttpMethod,
    url: detail.url,
    headers,
    query: [],
    response,
    last_error: null,
  };
}

function safeParseRecord(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = typeof val === "string" ? val : JSON.stringify(val);
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

function recordToPairs(r: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(r).map(([key, value]) => ({ key, value }));
}

/**
 * Project the on-screen headers/query arrays into the JSON strings the
 * `api_save_request` backend expects.
 */
export function stateToSavedJson(s: ApiTabState): {
  headersJson: string;
  queryJson: string;
} {
  const h: Record<string, string> = {};
  for (const { key, value } of s.headers) {
    const k = key.trim();
    if (k) h[k] = value;
  }
  const q: Record<string, string> = {};
  for (const { key, value } of s.query) {
    const k = key.trim();
    if (k) q[k] = value;
  }
  return { headersJson: JSON.stringify(h), queryJson: JSON.stringify(q) };
}

/**
 * URL validation check used by the Send button. Must catch obvious mistakes
 * (empty, no scheme) before firing an IPC call. Keep light — reqwest will
 * do the real validation.
 */
export function isSendable(s: ApiTabState): boolean {
  if (s.sending) return false;
  const u = s.url.trim();
  if (!u) return false;
  return /^(?:https?:\/\/|\$\{env:[A-Za-z0-9_-]+\}(?:[/:?#]|$))/i.test(u);
}

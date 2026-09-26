import { describe, it, expect, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import type {
  ApiEndpoint,
  ApiHistoryDetail,
  ApiSavedRequest,
  ApiTargetManifest,
} from "../lib/tauri";
import {
  applyEndpointToState,
  applyHistoryDetailToState,
  applySavedRequestToState,
  isSendable,
  rewritePathParams,
  stateRequiredKeys,
  stateToRequest,
  stateToSavedJson,
  useApiRunner,
} from "./apiRunnerStore";

function reset() {
  act(() => {
    useApiRunner.setState({ tabs: {} });
  });
}

describe("apiRunnerStore", () => {
  beforeEach(reset);

  it("ensure() creates a default slot keyed by tab id", () => {
    const state = useApiRunner.getState().ensure("t1");
    expect(state.method).toBe("GET");
    expect(state.url).toBe("");
    expect(state.auth).toEqual({ type: "none" });
    expect(state.response).toBeNull();
  });

  it("two tabs keep isolated state", () => {
    useApiRunner.getState().ensure("t1");
    useApiRunner.getState().ensure("t2");
    useApiRunner.getState().patch("t1", { url: "https://a.example" });
    useApiRunner.getState().patch("t2", { url: "https://b.example" });
    const tabs = useApiRunner.getState().tabs;
    expect(tabs.t1.url).toBe("https://a.example");
    expect(tabs.t2.url).toBe("https://b.example");
  });

  it("patch() merges without touching other fields", () => {
    useApiRunner.getState().ensure("t1");
    useApiRunner.getState().patch("t1", {
      method: "POST",
      body_kind: "json",
      body_text: '{"a":1}',
    });
    const s = useApiRunner.getState().tabs.t1;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("");
    expect(s.body_text).toBe('{"a":1}');
  });

  it("setHeaders/setQuery store arrays as-is", () => {
    useApiRunner.getState().ensure("t1");
    useApiRunner
      .getState()
      .setHeaders("t1", [{ key: "X-Test", value: "v" }]);
    expect(useApiRunner.getState().tabs.t1.headers).toEqual([
      { key: "X-Test", value: "v" },
    ]);
  });

  it("setSending / setResponse / setError mutate only the target slot", () => {
    useApiRunner.getState().ensure("t1");
    useApiRunner.getState().ensure("t2");
    useApiRunner.getState().setSending("t1", true);
    useApiRunner.getState().setError("t1", "boom");
    expect(useApiRunner.getState().tabs.t1.sending).toBe(true);
    expect(useApiRunner.getState().tabs.t1.last_error).toBe("boom");
    expect(useApiRunner.getState().tabs.t2.sending).toBe(false);
  });

  it("reset() removes a tab slot", () => {
    useApiRunner.getState().ensure("t1");
    useApiRunner.getState().reset("t1");
    expect(useApiRunner.getState().tabs.t1).toBeUndefined();
  });

  describe("stateToRequest", () => {
    it("converts header/query arrays to records, dropping blank keys", () => {
      useApiRunner.getState().ensure("t1");
      useApiRunner.getState().patch("t1", {
        method: "POST",
        url: "  https://api.example/x  ",
      });
      useApiRunner.getState().setHeaders("t1", [
        { key: "X-A", value: "1" },
        { key: "", value: "ignored" },
        { key: "  X-B  ", value: "2" },
      ]);
      useApiRunner.getState().setQuery("t1", [
        { key: "q", value: "cisco" },
        { key: "", value: "nope" },
      ]);
      const req = stateToRequest(useApiRunner.getState().tabs.t1);
      expect(req.method).toBe("POST");
      expect(req.url).toBe("https://api.example/x");
      expect(req.headers).toEqual({ "X-A": "1", "X-B": "2" });
      expect(req.query).toEqual({ q: "cisco" });
    });

    it("body_text is null when body_kind is none", () => {
      useApiRunner.getState().ensure("t1");
      useApiRunner.getState().patch("t1", {
        url: "https://e.x",
        body_kind: "none",
        body_text: "leftover",
      });
      const req = stateToRequest(useApiRunner.getState().tabs.t1);
      expect(req.body_text).toBeNull();
    });

    it("body_text is passed through for json/form/text", () => {
      useApiRunner.getState().ensure("t1");
      for (const k of ["json", "form", "text"] as const) {
        useApiRunner.getState().patch("t1", {
          url: "https://e.x",
          body_kind: k,
          body_text: `payload-${k}`,
        });
        const req = stateToRequest(useApiRunner.getState().tabs.t1);
        expect(req.body_text).toBe(`payload-${k}`);
      }
    });
  });

  describe("applyEndpointToState", () => {
    const manifest: ApiTargetManifest = {
      id: "meraki",
      display_name: "Meraki",
      schema_version: 1,
      base_url: "https://api.meraki.com/api/v1",
      auth: {
        type: "header",
        header_name: "X-Cisco-Meraki-API-Key",
        value: "${env:MERAKI_API_KEY}",
      },
      tls: { verify: true, ca_bundle: null, client_cert: null },
      defaults: { headers: { Accept: "application/json" } },
      openapi_url: null,
      endpoints: [],
    };
    const endpoint: ApiEndpoint = {
      id: "list_networks",
      name: "List Networks",
      description: null,
      method: "GET",
      path: "/organizations/{orgId}/networks",
      path_params: ["orgId"],
      query_params: { timespan: "86400" },
    };

    it("sets method/url from manifest base_url + endpoint path (rewriting path params)", () => {
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applyEndpointToState(cur, manifest, endpoint);
      expect(next.method).toBe("GET");
      // Path params `{orgId}` get rewritten to resolver syntax so the
      // backend substitutes them from the active environment.
      expect(next.url).toBe(
        "https://api.meraki.com/api/v1/organizations/${var:orgId}/networks",
      );
    });

    it("copies manifest default headers and endpoint query into arrays", () => {
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applyEndpointToState(cur, manifest, endpoint);
      expect(next.headers).toContainEqual({ key: "Accept", value: "application/json" });
      expect(next.query).toContainEqual({ key: "timespan", value: "86400" });
    });

    it("clears the previous response when loading an endpoint", () => {
      useApiRunner.getState().ensure("t1");
      useApiRunner.getState().setResponse("t1", {
        status_code: 200,
        status_text: "OK",
        headers: {},
        body: "",
        body_truncated: false,
        duration_ms: 1,
        final_url: "x",
        error: null,
      });
      const cur = useApiRunner.getState().tabs.t1;
      expect(cur.response).not.toBeNull();
      const next = applyEndpointToState(cur, manifest, endpoint);
      expect(next.response).toBeNull();
    });

    it("adopts the manifest's auth so ${env:X} placeholders reach the backend", () => {
      // Regression guard: picking a Meraki endpoint must set
      // state.auth to the manifest's header auth with the env-var
      // placeholder intact, so the backend resolver substitutes
      // MERAKI_API_KEY from the active environment at send time.
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applyEndpointToState(cur, manifest, endpoint);
      expect(next.auth.type).toBe("header");
      if (next.auth.type === "header") {
        expect(next.auth.name).toBe("X-Cisco-Meraki-API-Key");
        expect(next.auth.value).toBe("${env:MERAKI_API_KEY}");
      }
    });

    it("propagates manifest TLS verify=false into insecure_skip_verify", () => {
      const selfSigned: ApiTargetManifest = {
        ...manifest,
        tls: { verify: false, ca_bundle: null, client_cert: null },
      };
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applyEndpointToState(cur, selfSigned, endpoint);
      expect(next.insecure_skip_verify).toBe(true);
    });

    it("maps token_login manifest auth through to executor shape", () => {
      const dnac: ApiTargetManifest = {
        ...manifest,
        auth: {
          type: "token_login",
          login: {
            method: "POST",
            url: "/dna/system/api/v1/auth/token",
            credentials: {
              type: "basic",
              username: "${env:DNAC_USER}",
              password: "${env:DNAC_PASS}",
            },
            token_jsonpath: "$.Token",
          },
          apply: { mode: "header", name: "X-Auth-Token" },
          refresh_on_status: [401],
        },
      };
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applyEndpointToState(cur, dnac, endpoint);
      expect(next.auth.type).toBe("token_login");
      if (next.auth.type === "token_login") {
        expect(next.auth.login.url).toBe("/dna/system/api/v1/auth/token");
        expect(next.auth.apply).toEqual({
          mode: "header",
          name: "X-Auth-Token",
        });
        expect(next.auth.refresh_on_status).toEqual([401]);
      }
    });
  });

  describe("stateToSavedJson", () => {
    it("serializes header + query arrays with blank-key skip", () => {
      useApiRunner.getState().ensure("t1");
      useApiRunner.getState().setHeaders("t1", [
        { key: "X-A", value: "1" },
        { key: "", value: "ignored" },
        { key: "X-B", value: "2" },
      ]);
      useApiRunner.getState().setQuery("t1", [
        { key: "q", value: "cisco" },
        { key: "", value: "nope" },
      ]);
      const out = stateToSavedJson(useApiRunner.getState().tabs.t1);
      const h = JSON.parse(out.headersJson);
      const q = JSON.parse(out.queryJson);
      expect(h).toEqual({ "X-A": "1", "X-B": "2" });
      expect(q).toEqual({ q: "cisco" });
    });
  });

  describe("applySavedRequestToState", () => {
    const saved: ApiSavedRequest = {
      id: "s1",
      name: "probe",
      target_id: null,
      environment: null,
      method: "POST",
      url: "https://api.example/probe",
      headers_json: '{"X-A":"1","X-B":"2"}',
      query_json: '{"limit":"5"}',
      body_kind: "json",
      body_text: '{"x":1}',
      collection_id: null,
      collection_name: null,
      folder_path: "",
      display_name: "probe",
      auth_json: '{"type":"none"}',
      created_at: 0,
      updated_at: 0,
    };

    it("hydrates method / url / body from the saved row", () => {
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applySavedRequestToState(cur, saved);
      expect(next.method).toBe("POST");
      expect(next.url).toBe("https://api.example/probe");
      expect(next.body_kind).toBe("json");
      expect(next.body_text).toBe('{"x":1}');
    });

    it("parses headers + query JSON into key/value arrays", () => {
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applySavedRequestToState(cur, saved);
      expect(next.headers).toContainEqual({ key: "X-A", value: "1" });
      expect(next.headers).toContainEqual({ key: "X-B", value: "2" });
      expect(next.query).toContainEqual({ key: "limit", value: "5" });
    });

    it("clears any previous response when loading a saved request", () => {
      useApiRunner.getState().ensure("t1");
      useApiRunner.getState().setResponse("t1", {
        status_code: 200,
        status_text: "OK",
        headers: {},
        body: "",
        body_truncated: false,
        duration_ms: 1,
        final_url: "",
        error: null,
      });
      const cur = useApiRunner.getState().tabs.t1;
      const next = applySavedRequestToState(cur, saved);
      expect(next.response).toBeNull();
    });

    it("restores placeholder-backed imported auth", () => {
      const cur = useApiRunner.getState().ensure("t1");
      const next = applySavedRequestToState(cur, {
        ...saved,
        auth_json: '{"type":"bearer","token":"${env:API_TOKEN}"}',
      });
      expect(next.auth).toEqual({ type: "bearer", token: "${env:API_TOKEN}" });
    });
  });

  describe("applyHistoryDetailToState", () => {
    const detail: ApiHistoryDetail = {
      id: "h1",
      tab_id: "t1",
      saved_request_id: null,
      target_id: null,
      environment: null,
      method: "GET",
      url: "/orgs",
      status_code: 200,
      duration_ms: 25,
      error: null,
      sent_at: 0,
      request_headers_json: '{"X-Req":"1"}',
      request_body: null,
      response_headers_json: '{"content-type":"application/json"}',
      response_body: "aGVsbG8=", // "hello"
      response_body_truncated: false,
    };

    it("restores the method + URL and the response payload", () => {
      useApiRunner.getState().ensure("t1");
      const next = applyHistoryDetailToState(
        useApiRunner.getState().tabs.t1,
        detail,
      );
      expect(next.method).toBe("GET");
      expect(next.url).toBe("/orgs");
      expect(next.response?.status_code).toBe(200);
      expect(next.response?.body).toBe("aGVsbG8=");
      expect(next.response?.headers).toEqual({
        "content-type": "application/json",
      });
    });

    it("handles missing response headers gracefully", () => {
      useApiRunner.getState().ensure("t1");
      const next = applyHistoryDetailToState(
        useApiRunner.getState().tabs.t1,
        { ...detail, response_headers_json: null },
      );
      expect(next.response?.headers).toEqual({});
    });

    it("status_code=null produces a null response (transport failure)", () => {
      useApiRunner.getState().ensure("t1");
      const next = applyHistoryDetailToState(
        useApiRunner.getState().tabs.t1,
        { ...detail, status_code: null, response_body: null },
      );
      expect(next.response).toBeNull();
    });
  });

  describe("rewritePathParams", () => {
    it("rewrites a single path param", () => {
      expect(
        rewritePathParams("/organizations/{organizationId}"),
      ).toBe("/organizations/${var:organizationId}");
    });

    it("rewrites multiple path params in a single URL", () => {
      expect(
        rewritePathParams(
          "/organizations/{organizationId}/networks/{networkId}/devices/{serial}",
        ),
      ).toBe(
        "/organizations/${var:organizationId}/networks/${var:networkId}/devices/${var:serial}",
      );
    });

    it("leaves literal braces alone when the content is not an identifier", () => {
      expect(rewritePathParams("/x?q={bad value}")).toBe("/x?q={bad value}");
      expect(rewritePathParams("/x?q={}")).toBe("/x?q={}");
      expect(rewritePathParams("/x?q={1two}")).toBe("/x?q={1two}");
    });

    it("leaves paths without braces untouched", () => {
      expect(rewritePathParams("/organizations")).toBe("/organizations");
    });

    it("applyEndpointToState rewrites path params in the URL bar", () => {
      const manifest: ApiTargetManifest = {
        id: "meraki",
        display_name: "Meraki",
        schema_version: 1,
        base_url: "https://api.meraki.com/api/v1",
        auth: { type: "none" },
        tls: { verify: true, ca_bundle: null, client_cert: null },
        defaults: { headers: {} },
        openapi_url: null,
        endpoints: [],
      };
      const endpoint: ApiEndpoint = {
        id: "get_org",
        name: "Get Organization",
        description: null,
        method: "GET",
        path: "/organizations/{organizationId}",
        path_params: ["organizationId"],
        query_params: {},
      };
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applyEndpointToState(cur, manifest, endpoint);
      expect(next.url).toBe(
        "https://api.meraki.com/api/v1/organizations/${var:organizationId}",
      );
    });

    it("applyEndpointToState does NOT rewrite placeholders in base_url", () => {
      const manifest: ApiTargetManifest = {
        id: "dnac",
        display_name: "DNA-C",
        schema_version: 1,
        base_url: "https://${env:DNAC_HOST}",
        auth: { type: "none" },
        tls: { verify: true, ca_bundle: null, client_cert: null },
        defaults: { headers: {} },
        openapi_url: null,
        endpoints: [],
      };
      const endpoint: ApiEndpoint = {
        id: "get_dev",
        name: "Get Device",
        description: null,
        method: "GET",
        path: "/dna/intent/api/v1/network-device/{id}",
        path_params: ["id"],
        query_params: {},
      };
      useApiRunner.getState().ensure("t1");
      const cur = useApiRunner.getState().tabs.t1;
      const next = applyEndpointToState(cur, manifest, endpoint);
      expect(next.url).toBe(
        "https://${env:DNAC_HOST}/dna/intent/api/v1/network-device/${var:id}",
      );
    });
  });

  describe("stateRequiredKeys", () => {
    function baseState() {
      useApiRunner.getState().ensure("t1");
      return useApiRunner.getState().tabs.t1;
    }

    it("empty state has no required keys", () => {
      expect(stateRequiredKeys(baseState())).toEqual([]);
    });

    it("picks up ${var:X} from the URL (path-param case)", () => {
      const s = {
        ...baseState(),
        url: "https://api.meraki.com/api/v1/organizations/${var:organizationId}",
      };
      expect(stateRequiredKeys(s)).toEqual(["organizationId"]);
    });

    it("picks up ${env:X} from a header auth value", () => {
      const s = {
        ...baseState(),
        url: "https://api.meraki.com/api/v1/organizations",
        auth: {
          type: "header" as const,
          name: "X-Cisco-Meraki-API-Key",
          value: "${env:MERAKI_API_KEY}",
        },
      };
      expect(stateRequiredKeys(s)).toEqual(["MERAKI_API_KEY"]);
    });

    it("combines env + var placeholders (realistic Meraki flow)", () => {
      const s = {
        ...baseState(),
        url: "https://api.meraki.com/api/v1/organizations/${var:organizationId}/networks",
        auth: {
          type: "header" as const,
          name: "X-Cisco-Meraki-API-Key",
          value: "${env:MERAKI_API_KEY}",
        },
      };
      expect(stateRequiredKeys(s).sort()).toEqual([
        "MERAKI_API_KEY",
        "organizationId",
      ]);
    });

    it("picks up placeholders in headers, query, body", () => {
      const s = {
        ...baseState(),
        url: "https://x",
        headers: [{ key: "X-Extra", value: "${var:widget}" }],
        query: [{ key: "q", value: "${env:QUERY_TOKEN}" }],
        body_kind: "json" as const,
        body_text: '{"org":"${var:organizationId}"}',
      };
      expect(stateRequiredKeys(s).sort()).toEqual([
        "QUERY_TOKEN",
        "organizationId",
        "widget",
      ]);
    });
  });

  describe("isSendable", () => {
    it("blocks empty URL", () => {
      const s = useApiRunner.getState().ensure("t1");
      expect(isSendable({ ...s, url: "" })).toBe(false);
    });
    it("blocks non-http URL", () => {
      const s = useApiRunner.getState().ensure("t1");
      expect(isSendable({ ...s, url: "not a url" })).toBe(false);
      expect(isSendable({ ...s, url: "ftp://x" })).toBe(false);
    });
    it("allows http/https URL", () => {
      const s = useApiRunner.getState().ensure("t1");
      expect(isSendable({ ...s, url: "https://a.example" })).toBe(true);
      expect(isSendable({ ...s, url: "http://a.example" })).toBe(true);
      expect(isSendable({ ...s, url: "${env:BASE_URL}/v1/devices" })).toBe(true);
    });
    it("blocks while sending", () => {
      const s = useApiRunner.getState().ensure("t1");
      expect(
        isSendable({ ...s, url: "https://a.example", sending: true }),
      ).toBe(false);
    });
  });
});

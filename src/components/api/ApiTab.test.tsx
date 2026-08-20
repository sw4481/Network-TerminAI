/**
 * ApiTab integration test.
 *
 * Mocks `apiSendRequest` so we can assert the exact wire payload built from
 * the store state, and that the response flows back into the store and
 * renders in the viewer. No real HTTP — the executor is tested in Rust.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { ApiTab } from "./ApiTab";
import type { Tab } from "../../lib/types";
import { useApiRunner } from "../../state/apiRunnerStore";

const apiSendRequestMock = vi.fn();
const apiListTargetsMock = vi.fn();
const apiListPostmanCollectionsMock = vi.fn();
const apiGetTargetMock = vi.fn();
const apiGetPostmanCollectionMock = vi.fn();
const apiDeletePostmanCollectionMock = vi.fn();
const apiPreviewPostmanImportMock = vi.fn();
const apiCommitPostmanImportMock = vi.fn();
const apiListEnvironmentsMock = vi.fn();
const apiSaveRequestMock = vi.fn();
const apiListSavedRequestsMock = vi.fn();
const apiListHistoryMock = vi.fn();
const apiImportOpenApiMock = vi.fn();
const openDialogMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialogMock(...args),
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiSendRequest: (...args: unknown[]) => apiSendRequestMock(...args),
    apiListTargets: (...args: unknown[]) => apiListTargetsMock(...args),
    apiListPostmanCollections: (...args: unknown[]) =>
      apiListPostmanCollectionsMock(...args),
    apiGetTarget: (...args: unknown[]) => apiGetTargetMock(...args),
    apiGetPostmanCollection: (...args: unknown[]) =>
      apiGetPostmanCollectionMock(...args),
    apiDeletePostmanCollection: (...args: unknown[]) =>
      apiDeletePostmanCollectionMock(...args),
    apiPreviewPostmanImport: (...args: unknown[]) =>
      apiPreviewPostmanImportMock(...args),
    apiCommitPostmanImport: (...args: unknown[]) =>
      apiCommitPostmanImportMock(...args),
    apiListEnvironments: (...args: unknown[]) =>
      apiListEnvironmentsMock(...args),
    apiSaveRequest: (...args: unknown[]) => apiSaveRequestMock(...args),
    apiListSavedRequests: (...args: unknown[]) =>
      apiListSavedRequestsMock(...args),
    apiListHistory: (...args: unknown[]) => apiListHistoryMock(...args),
    apiImportOpenApi: (...args: unknown[]) => apiImportOpenApiMock(...args),
  };
});

function b64(s: string) {
  if (typeof Buffer !== "undefined") return Buffer.from(s).toString("base64");
  return btoa(s);
}

const tab: Tab = {
  id: "tab-1",
  title: "API 1",
  shell_cmd: "",
  cwd: "",
  created_at: 0,
  tab_type: "api",
};

const postmanCollection = {
  id: "collection-1",
  name: "Network API",
  environment: "network_api",
  request_count: 1,
};

const importedRequest = {
  id: "request-1",
  name: "pm_network_api_request_1",
  target_id: null,
  environment: "network_api",
  method: "POST",
  url: "${env:BASE_URL}/devices",
  headers_json: '{"X-Request":"${env:REQUEST_HEADER}"}',
  query_json: '{"limit":"25"}',
  body_kind: "json",
  body_text: '{"enabled":true}',
  collection_id: "collection-1",
  folder_path: "Sites / Devices",
  display_name: "Create Device",
  auth_json: '{"type":"bearer","token":"${env:API_TOKEN}"}',
  collection_name: "Network API",
  created_at: 0,
  updated_at: 0,
};

const postmanDetail = {
  collection: postmanCollection,
  requests: [importedRequest],
};

function resetAll() {
  vi.restoreAllMocks();
  act(() => {
    useApiRunner.setState({ tabs: {} });
  });
  apiSendRequestMock.mockReset();
  apiListTargetsMock.mockReset();
  apiListPostmanCollectionsMock.mockReset();
  apiGetTargetMock.mockReset();
  apiGetPostmanCollectionMock.mockReset();
  apiDeletePostmanCollectionMock.mockReset();
  apiPreviewPostmanImportMock.mockReset();
  apiCommitPostmanImportMock.mockReset();
  apiListEnvironmentsMock.mockReset();
  apiSaveRequestMock.mockReset();
  apiListSavedRequestsMock.mockReset();
  apiListHistoryMock.mockReset();
  apiImportOpenApiMock.mockReset();
  openDialogMock.mockReset();
  // Default: no targets / envs loaded.
  apiListTargetsMock.mockResolvedValue([]);
  apiListPostmanCollectionsMock.mockResolvedValue([]);
  apiListEnvironmentsMock.mockResolvedValue([]);
  apiListSavedRequestsMock.mockResolvedValue([]);
  apiListHistoryMock.mockResolvedValue([]);
}

describe("ApiTab integration", () => {
  beforeEach(resetAll);

  it("Send fires apiSendRequest with the built ApiRequest and renders response", async () => {
    apiSendRequestMock.mockResolvedValue({
      status_code: 200,
      status_text: "OK",
      headers: { "content-type": "application/json" },
      body: b64('{"ok":true}'),
      body_truncated: false,
      duration_ms: 12,
      final_url: "https://api.example/orgs",
      error: null,
    });

    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/orgs" },
    });
    fireEvent.click(screen.getByTestId("api-send"));

    await waitFor(() => {
      expect(apiSendRequestMock).toHaveBeenCalledOnce();
    });
    const call = apiSendRequestMock.mock.calls[0][0];
    expect(call.tabId).toBe("tab-1");
    expect(call.request.method).toBe("GET");
    expect(call.request.url).toBe("https://api.example/orgs");
    expect(call.request.auth).toEqual({ type: "none" });

    await waitFor(() => {
      expect(screen.getByTestId("api-response-status").textContent).toContain(
        "200",
      );
    });
    expect(screen.getByTestId("api-response-body").textContent).toMatch(
      /"ok":\s*true/,
    );
  });

  it("Bearer auth flows into the request payload", async () => {
    apiSendRequestMock.mockResolvedValue({
      status_code: 200,
      status_text: "OK",
      headers: {},
      body: "",
      body_truncated: false,
      duration_ms: 1,
      final_url: "",
      error: null,
    });

    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/me" },
    });
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "bearer" },
    });
    fireEvent.change(screen.getByTestId("api-auth-bearer-token"), {
      target: { value: "secret-123" },
    });
    fireEvent.click(screen.getByTestId("api-send"));

    await waitFor(() => {
      expect(apiSendRequestMock).toHaveBeenCalledOnce();
    });
    expect(apiSendRequestMock.mock.calls[0][0].request.auth).toEqual({
      type: "bearer",
      token: "secret-123",
    });
  });

  it("JSON body flows with correct body_kind/body_text", async () => {
    apiSendRequestMock.mockResolvedValue({
      status_code: 201,
      status_text: "Created",
      headers: {},
      body: "",
      body_truncated: false,
      duration_ms: 1,
      final_url: "",
      error: null,
    });

    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/widgets" },
    });
    const method = screen.getByTestId("api-method") as HTMLSelectElement;
    fireEvent.change(method, { target: { value: "POST" } });
    fireEvent.click(screen.getByTestId("api-panel-body"));
    fireEvent.change(screen.getByTestId("api-body-kind"), {
      target: { value: "json" },
    });
    fireEvent.change(screen.getByTestId("api-body-text"), {
      target: { value: '{"name":"w1"}' },
    });
    fireEvent.click(screen.getByTestId("api-send"));

    await waitFor(() => {
      expect(apiSendRequestMock).toHaveBeenCalledOnce();
    });
    const req = apiSendRequestMock.mock.calls[0][0].request;
    expect(req.method).toBe("POST");
    expect(req.body_kind).toBe("json");
    expect(req.body_text).toBe('{"name":"w1"}');
  });

  it("network-error response renders the error banner", async () => {
    apiSendRequestMock.mockResolvedValue({
      status_code: 0,
      status_text: "",
      headers: {},
      body: "",
      body_truncated: false,
      duration_ms: 500,
      final_url: "https://api.example/x",
      error: "connection failed: DNS",
    });

    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/x" },
    });
    fireEvent.click(screen.getByTestId("api-send"));

    await waitFor(() => {
      expect(screen.getByTestId("api-response-error")).toBeDefined();
    });
    expect(screen.getByTestId("api-response-error").textContent).toContain(
      "DNS",
    );
  });

  it("picking a target + endpoint pre-fills method and URL", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "meraki",
        display_name: "Meraki",
        base_url: "https://api.meraki.com/api/v1",
        builtin: true,
        has_openapi: false,
        endpoint_count: 1,
      },
    ]);
    apiGetTargetMock.mockResolvedValue({
      builtin: true,
      manifest: {
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
      },
      endpoints: [
        {
          id: "list_organizations",
          name: "List Organizations",
          description: null,
          method: "GET",
          path: "/organizations",
          path_params: [],
          query_params: {},
        },
      ],
    });

    render(<ApiTab tab={tab} />);
    await waitFor(() => {
      const sel = screen.getByTestId("api-target-select") as HTMLSelectElement;
      expect(
        Array.from(sel.options).some((o) => o.value === "manifest:meraki"),
      ).toBe(true);
    });
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "manifest:meraki" },
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("api-endpoint-row-list_organizations"),
      ).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("api-endpoint-row-list_organizations"));
    const url = screen.getByTestId("api-url") as HTMLInputElement;
    expect(url.value).toBe("https://api.meraki.com/api/v1/organizations");
    const method = screen.getByTestId("api-method") as HTMLSelectElement;
    expect(method.value).toBe("GET");
  });

  it("manifest default headers flow into the header editor", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "meraki",
        display_name: "Meraki",
        base_url: "x",
        builtin: true,
        has_openapi: false,
        endpoint_count: 1,
      },
    ]);
    apiGetTargetMock.mockResolvedValue({
      builtin: true,
      manifest: {
        id: "meraki",
        display_name: "Meraki",
        schema_version: 1,
        base_url: "https://api.meraki.com/api/v1",
        auth: { type: "none" },
        tls: { verify: true, ca_bundle: null, client_cert: null },
        defaults: { headers: { Accept: "application/json", "X-Custom": "1" } },
        openapi_url: null,
        endpoints: [],
      },
      endpoints: [
        {
          id: "probe",
          name: "Probe",
          description: null,
          method: "GET",
          path: "/probe",
          path_params: [],
          query_params: {},
        },
      ],
    });
    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(apiListTargetsMock).toHaveBeenCalled(),
    );
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "manifest:meraki" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("api-endpoint-row-probe")).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId("api-endpoint-row-probe"));
    // Switch to headers panel and count rows.
    fireEvent.click(screen.getByTestId("api-panel-headers"));
    // Two default headers should be materialized as rows.
    expect(screen.getByTestId("api-header-row-0")).toBeDefined();
    expect(screen.getByTestId("api-header-row-1")).toBeDefined();
  });

  it("switching back to Custom target hides the endpoint picker", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "meraki",
        display_name: "Meraki",
        base_url: "x",
        builtin: true,
        has_openapi: false,
        endpoint_count: 1,
      },
    ]);
    apiGetTargetMock.mockResolvedValue({
      builtin: true,
      manifest: {
        id: "meraki",
        display_name: "Meraki",
        schema_version: 1,
        base_url: "https://api.meraki.com/api/v1",
        auth: { type: "none" },
        tls: { verify: true, ca_bundle: null, client_cert: null },
        defaults: { headers: {} },
        openapi_url: null,
        endpoints: [],
      },
      endpoints: [
        {
          id: "probe",
          name: "Probe",
          description: null,
          method: "GET",
          path: "/probe",
          path_params: [],
          query_params: {},
        },
      ],
    });
    render(<ApiTab tab={tab} />);
    await waitFor(() => expect(apiListTargetsMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "manifest:meraki" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("api-endpoint-picker")).toBeDefined(),
    );
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "__custom__" },
    });
    await waitFor(() =>
      expect(screen.queryByTestId("api-endpoint-picker")).toBeNull(),
    );
  });

  it("selecting a Postman target selects its environment and hydrates the complete saved request", async () => {
    apiListPostmanCollectionsMock.mockResolvedValue([postmanCollection]);
    apiGetPostmanCollectionMock.mockResolvedValue(postmanDetail);
    apiListEnvironmentsMock.mockResolvedValue(["network_api"]);

    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(
        Array.from(
          (screen.getByTestId("api-target-select") as HTMLSelectElement).options,
        ).some((option) => option.value === "postman:collection-1"),
      ).toBe(true),
    );
    expect(screen.queryByTestId("api-delete-postman-target")).toBeNull();
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "postman:collection-1" },
    });

    const endpoint = await screen.findByTestId("api-endpoint-row-request-1");
    expect(endpoint).toHaveTextContent("Sites / Devices / Create Device");
    expect(endpoint).toHaveTextContent("${env:BASE_URL}/devices");
    expect(screen.getByTestId("api-delete-postman-target")).toBeDefined();
    expect((screen.getByTestId("api-env-select") as HTMLSelectElement).value).toBe(
      "network_api",
    );

    fireEvent.click(endpoint);
    const stored = useApiRunner.getState().tabs[tab.id];
    expect(stored.method).toBe("POST");
    expect(stored.url).toBe("${env:BASE_URL}/devices");
    expect(stored.headers).toEqual([
      { key: "X-Request", value: "${env:REQUEST_HEADER}" },
    ]);
    expect(stored.query).toEqual([{ key: "limit", value: "25" }]);
    expect(stored.body_kind).toBe("json");
    expect(stored.body_text).toBe('{"enabled":true}');
    expect(stored.auth).toEqual({
      type: "bearer",
      token: "${env:API_TOKEN}",
    });
  });

  it("loading an imported Saved Request selects its collection target", async () => {
    apiListPostmanCollectionsMock.mockResolvedValue([postmanCollection]);
    apiGetPostmanCollectionMock.mockResolvedValue(postmanDetail);
    apiListEnvironmentsMock.mockResolvedValue(["network_api"]);
    apiListSavedRequestsMock.mockResolvedValue([importedRequest]);

    render(<ApiTab tab={tab} />);
    fireEvent.click(screen.getByTestId("api-drawer-saved"));
    const savedRow = await screen.findByTestId("api-saved-row-request-1");
    fireEvent.click(savedRow);

    await waitFor(() => {
      expect((screen.getByTestId("api-target-select") as HTMLSelectElement).value).toBe(
        "postman:collection-1",
      );
      expect(apiGetPostmanCollectionMock).toHaveBeenCalledWith("collection-1");
    });
    expect((screen.getByTestId("api-env-select") as HTMLSelectElement).value).toBe(
      "network_api",
    );
    expect(useApiRunner.getState().tabs[tab.id].url).toBe(
      "${env:BASE_URL}/devices",
    );
  });

  it("refreshes and selects the new target and environment after import without loading its first request", async () => {
    apiListPostmanCollectionsMock
      .mockResolvedValueOnce([])
      .mockResolvedValue([postmanCollection]);
    apiListEnvironmentsMock
      .mockResolvedValueOnce([])
      .mockResolvedValue(["network_api"]);
    apiGetPostmanCollectionMock.mockResolvedValue(postmanDetail);
    openDialogMock.mockResolvedValue("/tmp/network.postman_collection.json");
    apiPreviewPostmanImportMock.mockResolvedValue({
      fingerprint: "fingerprint",
      collection_name: "Network API",
      request_count: 1,
      folder_count: 1,
      variable_keys: [],
      skipped_items: [],
      warnings: [],
    });
    apiCommitPostmanImportMock.mockResolvedValue({
      collection_id: "collection-1",
      collection_name: "Network API",
      environment: "network_api",
      imported_count: 1,
      skipped_count: 0,
      warnings: [],
    });

    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://before-import.example/request" },
    });
    fireEvent.click(screen.getByTestId("api-drawer-saved"));
    fireEvent.click(screen.getByRole("button", { name: "Import Postman…" }));
    await screen.findByTestId("postman-import-preview");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect((screen.getByTestId("api-target-select") as HTMLSelectElement).value).toBe(
        "postman:collection-1",
      );
      expect((screen.getByTestId("api-env-select") as HTMLSelectElement).value).toBe(
        "network_api",
      );
    });
    expect(apiListPostmanCollectionsMock.mock.calls.length).toBeGreaterThan(1);
    expect(apiListEnvironmentsMock.mock.calls.length).toBeGreaterThan(1);
    expect((screen.getByTestId("api-url") as HTMLInputElement).value).toBe(
      "https://before-import.example/request",
    );
  });

  it("confirmed collection deletion resets the tab and refreshes target resources", async () => {
    apiListPostmanCollectionsMock
      .mockResolvedValueOnce([postmanCollection])
      .mockResolvedValue([]);
    apiGetPostmanCollectionMock.mockResolvedValue(postmanDetail);
    apiListEnvironmentsMock
      .mockResolvedValueOnce(["network_api"])
      .mockResolvedValue([]);
    apiDeletePostmanCollectionMock.mockResolvedValue(postmanCollection);
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(
        Array.from(
          (screen.getByTestId("api-target-select") as HTMLSelectElement).options,
        ).some((option) => option.value === "postman:collection-1"),
      ).toBe(true),
    );
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "postman:collection-1" },
    });
    fireEvent.click(await screen.findByTestId("api-endpoint-row-request-1"));
    expect(useApiRunner.getState().tabs[tab.id].url).not.toBe("");
    fireEvent.click(screen.getByTestId("api-delete-postman-target"));

    await waitFor(() =>
      expect(apiDeletePostmanCollectionMock).toHaveBeenCalledWith("collection-1"),
    );
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Network API"));
    await waitFor(() => {
      expect((screen.getByTestId("api-target-select") as HTMLSelectElement).value).toBe(
        "__custom__",
      );
      expect((screen.getByTestId("api-env-select") as HTMLSelectElement).value).toBe("");
      expect((screen.getByTestId("api-url") as HTMLInputElement).value).toBe("");
    });
    expect(screen.queryByTestId("api-delete-postman-target")).toBeNull();
    expect(screen.queryByTestId("api-endpoint-picker")).toBeNull();
  });

  it("keeps the Postman target and request intact when collection deletion fails", async () => {
    apiListPostmanCollectionsMock.mockResolvedValue([postmanCollection]);
    apiGetPostmanCollectionMock.mockResolvedValue(postmanDetail);
    apiListEnvironmentsMock.mockResolvedValue(["network_api"]);
    apiDeletePostmanCollectionMock.mockRejectedValue(
      new Error("environment is referenced outside the collection"),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(
        Array.from(
          (screen.getByTestId("api-target-select") as HTMLSelectElement).options,
        ).some((option) => option.value === "postman:collection-1"),
      ).toBe(true),
    );
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "postman:collection-1" },
    });
    fireEvent.click(await screen.findByTestId("api-endpoint-row-request-1"));
    fireEvent.click(screen.getByTestId("api-delete-postman-target"));

    await waitFor(() =>
      expect(screen.getByTestId("api-target-detail-error")).toHaveTextContent(
        "referenced outside",
      ),
    );
    expect((screen.getByTestId("api-target-select") as HTMLSelectElement).value).toBe(
      "postman:collection-1",
    );
    expect((screen.getByTestId("api-env-select") as HTMLSelectElement).value).toBe(
      "network_api",
    );
    expect(useApiRunner.getState().tabs[tab.id].url).toBe(
      "${env:BASE_URL}/devices",
    );
  });

  it("sends environment=null when no env is selected", async () => {
    apiSendRequestMock.mockResolvedValue({
      status_code: 200,
      status_text: "OK",
      headers: {},
      body: "",
      body_truncated: false,
      duration_ms: 1,
      final_url: "",
      error: null,
    });
    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/x" },
    });
    fireEvent.click(screen.getByTestId("api-send"));
    await waitFor(() => expect(apiSendRequestMock).toHaveBeenCalledOnce());
    expect(apiSendRequestMock.mock.calls[0][0].environment).toBeNull();
  });

  it("selecting an environment flows into the apiSendRequest payload", async () => {
    apiListEnvironmentsMock.mockResolvedValue(["lab", "prod"]);
    apiSendRequestMock.mockResolvedValue({
      status_code: 200,
      status_text: "OK",
      headers: {},
      body: "",
      body_truncated: false,
      duration_ms: 1,
      final_url: "",
      error: null,
    });
    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("api-env-select") as HTMLSelectElement).options
          .length,
      ).toBeGreaterThan(1),
    );
    fireEvent.change(screen.getByTestId("api-env-select"), {
      target: { value: "prod" },
    });
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/x" },
    });
    fireEvent.click(screen.getByTestId("api-send"));
    await waitFor(() => expect(apiSendRequestMock).toHaveBeenCalledOnce());
    expect(apiSendRequestMock.mock.calls[0][0].environment).toBe("prod");
  });

  it("targetId is passed to apiSendRequest when a target is selected", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "meraki",
        display_name: "Meraki",
        base_url: "https://api.meraki.com/api/v1",
        builtin: true,
        has_openapi: false,
        endpoint_count: 0,
      },
    ]);
    apiGetTargetMock.mockResolvedValue({
      builtin: true,
      manifest: {
        id: "meraki",
        display_name: "Meraki",
        schema_version: 1,
        base_url: "https://api.meraki.com/api/v1",
        auth: { type: "none" },
        tls: { verify: true, ca_bundle: null, client_cert: null },
        defaults: { headers: {} },
        openapi_url: null,
        endpoints: [],
      },
      endpoints: [],
    });
    apiSendRequestMock.mockResolvedValue({
      status_code: 200,
      status_text: "OK",
      headers: {},
      body: "",
      body_truncated: false,
      duration_ms: 1,
      final_url: "",
      error: null,
    });
    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("api-target-select") as HTMLSelectElement).options
          .length,
      ).toBeGreaterThan(1),
    );
    // NOTE: ApiTab doesn't yet pass targetId — this test will fail until we
    // wire that through. Placeholder: current behavior passes undefined →
    // tauri wrapper resolves it to null. The Rust side already accepts null.
    // We simply assert the key exists as a property of the call so future
    // wiring can't silently drop it.
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "manifest:meraki" },
    });
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.meraki.com/v1/orgs" },
    });
    fireEvent.click(screen.getByTestId("api-send"));
    await waitFor(() => expect(apiSendRequestMock).toHaveBeenCalledOnce());
    const arg = apiSendRequestMock.mock.calls[0][0];
    expect(arg.targetId).toBe("meraki");
  });

  it("targetId is null when the tab is on Custom", async () => {
    apiSendRequestMock.mockResolvedValue({
      status_code: 200,
      status_text: "OK",
      headers: {},
      body: "",
      body_truncated: false,
      duration_ms: 1,
      final_url: "",
      error: null,
    });
    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/x" },
    });
    fireEvent.click(screen.getByTestId("api-send"));
    await waitFor(() => expect(apiSendRequestMock).toHaveBeenCalledOnce());
    expect(apiSendRequestMock.mock.calls[0][0].targetId).toBeNull();
  });

  it("Cmd-K opens the command palette", async () => {
    render(<ApiTab tab={tab} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByTestId("api-cmdk")).toBeDefined());
  });

  it("Ctrl-K also opens the command palette (non-mac)", async () => {
    render(<ApiTab tab={tab} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("api-cmdk")).toBeDefined());
  });

  it("star button opens save prompt; commit writes through apiSaveRequest", async () => {
    apiSaveRequestMock.mockResolvedValue({
      id: "s1",
      name: "list-orgs",
      target_id: null,
      environment: null,
      method: "GET",
      url: "https://api.example/orgs",
      headers_json: "{}",
      query_json: "{}",
      body_kind: "none",
      body_text: null,
      created_at: 0,
      updated_at: 0,
    });
    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/orgs" },
    });
    // Star should be visible + enabled once URL is valid.
    const star = screen.getByTestId("api-save-request") as HTMLButtonElement;
    expect(star.disabled).toBe(false);
    fireEvent.click(star);
    await waitFor(() =>
      expect(screen.getByTestId("api-save-prompt")).toBeDefined(),
    );
    fireEvent.change(screen.getByTestId("api-save-name"), {
      target: { value: "list-orgs" },
    });
    fireEvent.click(screen.getByTestId("api-save-commit"));
    await waitFor(() => expect(apiSaveRequestMock).toHaveBeenCalledOnce());
    const input = apiSaveRequestMock.mock.calls[0][0];
    expect(input.name).toBe("list-orgs");
    expect(input.method).toBe("GET");
    expect(input.url).toBe("https://api.example/orgs");
  });

  it("history drawer toggle calls apiListHistory scoped to this tab", async () => {
    render(<ApiTab tab={tab} />);
    fireEvent.click(screen.getByTestId("api-drawer-history"));
    await waitFor(() => {
      expect(apiListHistoryMock).toHaveBeenCalled();
    });
    const args = apiListHistoryMock.mock.calls[0][0];
    expect(args.tabId).toBe("tab-1");
  });

  it("Import OpenAPI button only shows when target declares openapi_url", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "custom-nospec",
        display_name: "No Spec",
        base_url: "https://x",
        builtin: false,
        has_openapi: false,
        endpoint_count: 0,
      },
    ]);
    apiGetTargetMock.mockResolvedValue({
      builtin: false,
      manifest: {
        id: "custom-nospec",
        display_name: "No Spec",
        schema_version: 1,
        base_url: "https://x",
        auth: { type: "none" },
        tls: { verify: true, ca_bundle: null, client_cert: null },
        defaults: { headers: {} },
        openapi_url: null,
        endpoints: [],
      },
      endpoints: [],
    });
    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("api-target-select") as HTMLSelectElement).options
          .length,
      ).toBeGreaterThan(1),
    );
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "manifest:custom-nospec" },
    });
    await waitFor(() => expect(apiGetTargetMock).toHaveBeenCalled());
    // Button must NOT be present when no openapi_url is set.
    expect(screen.queryByTestId("api-import-openapi")).toBeNull();
  });

  it("Import OpenAPI fetches + merges endpoints into the picker", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "meraki",
        display_name: "Meraki",
        base_url: "https://api.meraki.com/api/v1",
        builtin: true,
        has_openapi: true,
        endpoint_count: 1,
      },
    ]);
    apiGetTargetMock.mockResolvedValue({
      builtin: true,
      manifest: {
        id: "meraki",
        display_name: "Meraki",
        schema_version: 1,
        base_url: "https://api.meraki.com/api/v1",
        auth: { type: "none" },
        tls: { verify: true, ca_bundle: null, client_cert: null },
        defaults: { headers: {} },
        openapi_url: "https://raw.example/spec.json",
        endpoints: [
          {
            id: "seed",
            name: "Starter endpoint",
            description: null,
            method: "GET",
            path: "/seed",
            path_params: [],
            query_params: {},
          },
        ],
      },
      endpoints: [
        {
          id: "seed",
          name: "Starter endpoint",
          description: null,
          method: "GET",
          path: "/seed",
          path_params: [],
          query_params: {},
        },
      ],
    });
    apiImportOpenApiMock.mockResolvedValue([
      {
        id: "list_orgs",
        name: "List Organizations",
        description: null,
        method: "GET",
        path: "/organizations",
        path_params: [],
        query_params: {},
      },
      {
        id: "get_device",
        name: "Get Device",
        description: null,
        method: "GET",
        path: "/devices/{serial}",
        path_params: ["serial"],
        query_params: {},
      },
    ]);

    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("api-target-select") as HTMLSelectElement).options
          .length,
      ).toBeGreaterThan(1),
    );
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "manifest:meraki" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("api-import-openapi")).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId("api-import-openapi"));
    await waitFor(() =>
      expect(apiImportOpenApiMock).toHaveBeenCalledWith(
        "https://raw.example/spec.json",
      ),
    );
    // After import, imported endpoints should appear in the EndpointPicker.
    await waitFor(() =>
      expect(screen.getByTestId("api-endpoint-row-list_orgs")).toBeDefined(),
    );
    expect(screen.getByTestId("api-endpoint-row-get_device")).toBeDefined();
    // Starter endpoint preserved (dedup-by-id merge).
    expect(screen.getByTestId("api-endpoint-row-seed")).toBeDefined();
    // Success banner.
    await waitFor(() =>
      expect(screen.getByTestId("api-import-status").textContent).toContain(
        "Imported 2",
      ),
    );
  });

  it("Import OpenAPI surfaces backend errors inline", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "meraki",
        display_name: "Meraki",
        base_url: "x",
        builtin: true,
        has_openapi: true,
        endpoint_count: 0,
      },
    ]);
    apiGetTargetMock.mockResolvedValue({
      builtin: true,
      manifest: {
        id: "meraki",
        display_name: "Meraki",
        schema_version: 1,
        base_url: "x",
        auth: { type: "none" },
        tls: { verify: true, ca_bundle: null, client_cert: null },
        defaults: { headers: {} },
        openapi_url: "https://raw.example/spec.json",
        endpoints: [],
      },
      endpoints: [],
    });
    apiImportOpenApiMock.mockRejectedValue(new Error("404 not found"));
    render(<ApiTab tab={tab} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("api-target-select") as HTMLSelectElement).options
          .length,
      ).toBeGreaterThan(1),
    );
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "manifest:meraki" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("api-import-openapi")).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId("api-import-openapi"));
    await waitFor(() =>
      expect(screen.getByTestId("api-import-status").textContent).toContain(
        "404",
      ),
    );
  });

  it("IPC rejection leaves the sending flag cleared", async () => {
    apiSendRequestMock.mockRejectedValue(new Error("ipc failure"));

    render(<ApiTab tab={tab} />);
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://api.example/x" },
    });
    fireEvent.click(screen.getByTestId("api-send"));

    await waitFor(() => {
      expect(useApiRunner.getState().tabs["tab-1"].sending).toBe(false);
    });
    expect(useApiRunner.getState().tabs["tab-1"].last_error).toContain(
      "ipc failure",
    );
  });
});

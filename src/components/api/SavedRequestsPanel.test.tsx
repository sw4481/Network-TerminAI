import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { SavedRequestsPanel } from "./SavedRequestsPanel";
import { useApiRunner } from "../../state/apiRunnerStore";

const apiListSavedRequestsMock = vi.fn();
const apiDeleteSavedRequestMock = vi.fn();
const apiPreviewPostmanImportMock = vi.fn();
const apiCommitPostmanImportMock = vi.fn();
const openDialogMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openDialogMock(...args) }));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiListSavedRequests: (...args: unknown[]) =>
      apiListSavedRequestsMock(...args),
    apiDeleteSavedRequest: (...args: unknown[]) =>
      apiDeleteSavedRequestMock(...args),
    apiPreviewPostmanImport: (...args: unknown[]) =>
      apiPreviewPostmanImportMock(...args),
    apiCommitPostmanImport: (...args: unknown[]) =>
      apiCommitPostmanImportMock(...args),
  };
});

function reset() {
  act(() => {
    useApiRunner.setState({ tabs: {} });
  });
  apiListSavedRequestsMock.mockReset();
  apiDeleteSavedRequestMock.mockReset();
  apiDeleteSavedRequestMock.mockResolvedValue(undefined);
  apiPreviewPostmanImportMock.mockReset();
  apiCommitPostmanImportMock.mockReset();
  openDialogMock.mockReset();
}

describe("SavedRequestsPanel", () => {
  beforeEach(reset);

  it("shows the empty state when no saved requests exist", async () => {
    apiListSavedRequestsMock.mockResolvedValue([]);
    render(<SavedRequestsPanel tabId="t1" />);
    await waitFor(() =>
      expect(screen.getByTestId("api-saved-empty")).toBeDefined(),
    );
  });

  it("lists saved requests with method and url", async () => {
    apiListSavedRequestsMock.mockResolvedValue([
      {
        id: "s1",
        name: "list-orgs",
        target_id: "meraki",
        environment: "lab",
        method: "GET",
        url: "/organizations",
        headers_json: "{}",
        query_json: "{}",
        body_kind: "none",
        body_text: null,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    render(<SavedRequestsPanel tabId="t1" />);
    await waitFor(() =>
      expect(screen.getByTestId("api-saved-row-s1")).toBeDefined(),
    );
    const row = screen.getByTestId("api-saved-row-s1");
    expect(row.textContent).toContain("GET");
    expect(row.textContent).toContain("list-orgs");
    expect(row.textContent).toContain("/organizations");
  });

  it("clicking a row rehydrates the tab's state", async () => {
    apiListSavedRequestsMock.mockResolvedValue([
      {
        id: "s1",
        name: "audit",
        target_id: null,
        environment: null,
        method: "POST",
        url: "/audit",
        headers_json: '{"X-Test":"v"}',
        query_json: '{"q":"v"}',
        body_kind: "json",
        body_text: '{"x":1}',
        created_at: 0,
        updated_at: 0,
      },
    ]);
    useApiRunner.getState().ensure("t1");
    const onLoad = vi.fn();
    render(<SavedRequestsPanel tabId="t1" onLoad={onLoad} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-saved-row-s1")).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId("api-saved-row-s1"));
    const stored = useApiRunner.getState().tabs.t1;
    expect(stored.method).toBe("POST");
    expect(stored.url).toBe("/audit");
    expect(stored.body_kind).toBe("json");
    expect(stored.body_text).toBe('{"x":1}');
    expect(stored.headers).toContainEqual({ key: "X-Test", value: "v" });
    expect(stored.query).toContainEqual({ key: "q", value: "v" });
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("delete button calls apiDeleteSavedRequest and does not re-hydrate", async () => {
    apiListSavedRequestsMock.mockResolvedValue([
      {
        id: "s1",
        name: "gone",
        target_id: null,
        environment: null,
        method: "GET",
        url: "/x",
        headers_json: "{}",
        query_json: "{}",
        body_kind: "none",
        body_text: null,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    useApiRunner.getState().ensure("t1");
    const onLoad = vi.fn();
    render(<SavedRequestsPanel tabId="t1" onLoad={onLoad} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-saved-delete-s1")).toBeDefined(),
    );
    apiListSavedRequestsMock.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByTestId("api-saved-delete-s1"));
    await waitFor(() =>
      expect(apiDeleteSavedRequestMock).toHaveBeenCalledWith("s1"),
    );
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("refreshKey prop re-runs list", async () => {
    apiListSavedRequestsMock.mockResolvedValue([]);
    const { rerender } = render(<SavedRequestsPanel tabId="t1" refreshKey={0} />);
    await waitFor(() => expect(apiListSavedRequestsMock).toHaveBeenCalled());
    const n = apiListSavedRequestsMock.mock.calls.length;
    rerender(<SavedRequestsPanel tabId="t1" refreshKey={1} />);
    await waitFor(() =>
      expect(apiListSavedRequestsMock.mock.calls.length).toBeGreaterThan(n),
    );
  });

  it("surfaces errors without crashing", async () => {
    apiListSavedRequestsMock.mockRejectedValue(new Error("perm denied"));
    render(<SavedRequestsPanel tabId="t1" />);
    await waitFor(() =>
      expect(screen.getByTestId("api-saved-error").textContent).toContain(
        "perm denied",
      ),
    );
  });

  it("previews explicitly before committing a Postman import", async () => {
    apiListSavedRequestsMock.mockResolvedValue([]);
    openDialogMock.mockResolvedValue("/tmp/network.postman_collection.json");
    apiPreviewPostmanImportMock.mockResolvedValue({
      fingerprint: "abc123",
      collection_name: "Network API",
      request_count: 2,
      folder_count: 1,
      variable_keys: [{ key: "API_TOKEN", is_secret: true }],
      skipped_items: [{ path: "Upload", reason: "Binary body is not supported." }],
      warnings: [],
    });
    apiCommitPostmanImportMock.mockResolvedValue({
      collection_id: "collection-1",
      collection_name: "Network API",
      environment: "network_api",
      imported_count: 2,
      skipped_count: 1,
      warnings: [],
    });
    const onImportComplete = vi.fn();
    render(<SavedRequestsPanel tabId="t1" onImportComplete={onImportComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Postman…" }));
    await waitFor(() => expect(apiPreviewPostmanImportMock).toHaveBeenCalledWith(
      "/tmp/network.postman_collection.json",
    ));
    expect(screen.getByTestId("postman-import-preview")).toHaveTextContent("API_TOKEN (secret)");
    expect(apiCommitPostmanImportMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(apiCommitPostmanImportMock).toHaveBeenCalledWith(
      "/tmp/network.postman_collection.json",
      "abc123",
    ));
    expect(screen.getByTestId("postman-import-success")).toHaveTextContent("Imported 2 requests");
    expect(onImportComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_id: "collection-1",
        environment: "network_api",
      }),
    );
  });

  it("keeps confirmation actions visible before large collapsed preview details", async () => {
    apiListSavedRequestsMock.mockResolvedValue([]);
    openDialogMock.mockResolvedValue("/tmp/amp.postman_collection.json");
    apiPreviewPostmanImportMock.mockResolvedValue({
      fingerprint: "amp-fingerprint",
      collection_name: "Secure Endpoint",
      request_count: 136,
      folder_count: 53,
      variable_keys: Array.from({ length: 66 }, (_, index) => ({
        key: `AMP_KEY_${index + 1}`,
        is_secret: index < 8,
      })),
      skipped_items: Array.from({ length: 192 }, (_, index) => ({
        path: `Unsupported ${index + 1}`,
        reason: "Postman feature is not supported.",
      })),
      warnings: ["Scripts are skipped and never executed."],
    });
    const onImportStart = vi.fn();

    render(<SavedRequestsPanel tabId="t1" onImportStart={onImportStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Postman…" }));

    const preview = await screen.findByTestId("postman-import-preview");
    expect(onImportStart).toHaveBeenCalledOnce();
    expect(within(preview).getByText("Preview only — nothing has been imported yet.")).toBeVisible();
    expect(within(preview).getByRole("button", { name: "Import" })).toBeVisible();
    expect(within(preview).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(within(preview).getByText("66 environment keys · 8 marked secret").closest("details")).not.toHaveAttribute("open");
    expect(within(preview).getByText("192 skipped items").closest("details")).not.toHaveAttribute("open");
  });

  it("groups imported rows by collection and nested folder while showing display names", async () => {
    apiListSavedRequestsMock.mockResolvedValue([
      {
        id: "imported-1", name: "pm_internal", display_name: "Get Device",
        collection_id: "collection-1", collection_name: "Network API", folder_path: "Sites / Devices",
        target_id: null, environment: "network_api", method: "GET", url: "${env:BASE_URL}/devices",
        headers_json: "{}", query_json: "{}", body_kind: "none", body_text: null,
        auth_json: '{"type":"bearer","token":"${env:API_TOKEN}"}', created_at: 0, updated_at: 0,
      },
    ]);
    render(<SavedRequestsPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("api-saved-group-collection-1")).toHaveTextContent("Network API"));
    expect(screen.getByText(/Sites \/ Devices/)).toBeInTheDocument();
    expect(screen.getByText("Get Device")).toBeInTheDocument();
    expect(screen.queryByText("pm_internal")).not.toBeInTheDocument();
  });
});

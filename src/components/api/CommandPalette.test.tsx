import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { useApiRunner } from "../../state/apiRunnerStore";

const apiListTargetsMock = vi.fn();
const apiGetTargetMock = vi.fn();
const apiListSavedRequestsMock = vi.fn();

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiListTargets: (...args: unknown[]) => apiListTargetsMock(...args),
    apiGetTarget: (...args: unknown[]) => apiGetTargetMock(...args),
    apiListSavedRequests: (...args: unknown[]) =>
      apiListSavedRequestsMock(...args),
  };
});

function reset() {
  act(() => {
    useApiRunner.setState({ tabs: {} });
  });
  apiListTargetsMock.mockReset();
  apiGetTargetMock.mockReset();
  apiListSavedRequestsMock.mockReset();
}

const merakiTarget = {
  id: "meraki",
  display_name: "Meraki",
  base_url: "https://api.meraki.com/api/v1",
  builtin: true,
  has_openapi: false,
  endpoint_count: 2,
};

function merakiDetail() {
  return {
    builtin: true,
    manifest: {
      id: "meraki",
      display_name: "Meraki",
      schema_version: 1,
      base_url: "https://api.meraki.com/api/v1",
      auth: { type: "none" as const },
      tls: { verify: true, ca_bundle: null, client_cert: null },
      defaults: { headers: {} },
      openapi_url: null,
      endpoints: [],
    },
    endpoints: [
      {
        id: "list_orgs",
        name: "List Organizations",
        description: null,
        method: "GET" as const,
        path: "/organizations",
        path_params: [],
        query_params: {},
      },
      {
        id: "get_org",
        name: "Get Organization",
        description: null,
        method: "GET" as const,
        path: "/organizations/{orgId}",
        path_params: ["orgId"],
        query_params: {},
      },
    ],
  };
}

describe("CommandPalette", () => {
  beforeEach(reset);

  it("returns nothing when closed", () => {
    const { container } = render(
      <CommandPalette tabId="t1" open={false} onClose={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("loads endpoints + saved requests when opened", async () => {
    apiListTargetsMock.mockResolvedValue([merakiTarget]);
    apiGetTargetMock.mockResolvedValue(merakiDetail());
    apiListSavedRequestsMock.mockResolvedValue([
      {
        id: "s1",
        name: "probe",
        target_id: null,
        environment: null,
        method: "POST",
        url: "/probe",
        headers_json: "{}",
        query_json: "{}",
        body_kind: "none",
        body_text: null,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    render(<CommandPalette tabId="t1" open onClose={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("api-cmdk-row-meraki:list_orgs"),
      ).toBeDefined(),
    );
    expect(screen.getByTestId("api-cmdk-row-meraki:get_org")).toBeDefined();
    expect(screen.getByTestId("api-cmdk-row-saved:s1")).toBeDefined();
  });

  it("fuzzy search narrows to matches", async () => {
    apiListTargetsMock.mockResolvedValue([merakiTarget]);
    apiGetTargetMock.mockResolvedValue(merakiDetail());
    apiListSavedRequestsMock.mockResolvedValue([]);
    render(<CommandPalette tabId="t1" open onClose={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("api-cmdk-row-meraki:list_orgs"),
      ).toBeDefined(),
    );
    fireEvent.change(screen.getByTestId("api-cmdk-input"), {
      target: { value: "{orgId}" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("api-cmdk-row-meraki:get_org")).toBeDefined(),
    );
    // `{orgId}` only appears in the Get Organization path, so List
    // Organizations shouldn't match at all.
    expect(screen.queryByTestId("api-cmdk-row-meraki:list_orgs")).toBeNull();
  });

  it("Escape closes", async () => {
    apiListTargetsMock.mockResolvedValue([]);
    apiListSavedRequestsMock.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<CommandPalette tabId="t1" open onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("api-cmdk-input")).toBeDefined());
    fireEvent.keyDown(screen.getByTestId("api-cmdk-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Enter selects the highlighted row and applies it to the tab", async () => {
    apiListTargetsMock.mockResolvedValue([merakiTarget]);
    apiGetTargetMock.mockResolvedValue(merakiDetail());
    apiListSavedRequestsMock.mockResolvedValue([]);
    useApiRunner.getState().ensure("t1");
    const onClose = vi.fn();
    render(<CommandPalette tabId="t1" open onClose={onClose} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("api-cmdk-row-meraki:list_orgs"),
      ).toBeDefined(),
    );
    fireEvent.change(screen.getByTestId("api-cmdk-input"), {
      target: { value: "list orgs" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("api-cmdk-row-meraki:list_orgs")).toBeDefined(),
    );
    fireEvent.keyDown(screen.getByTestId("api-cmdk-input"), { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const stored = useApiRunner.getState().tabs.t1;
    expect(stored.method).toBe("GET");
    expect(stored.url).toBe("https://api.meraki.com/api/v1/organizations");
  });

  it("shows 'No matches' for a nonsense query", async () => {
    apiListTargetsMock.mockResolvedValue([]);
    apiListSavedRequestsMock.mockResolvedValue([]);
    render(<CommandPalette tabId="t1" open onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-cmdk-empty")).toBeDefined(),
    );
  });
});

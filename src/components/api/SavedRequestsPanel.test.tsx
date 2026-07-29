import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SavedRequestsPanel } from "./SavedRequestsPanel";
import { useApiRunner } from "../../state/apiRunnerStore";

const apiListSavedRequestsMock = vi.fn();
const apiDeleteSavedRequestMock = vi.fn();

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiListSavedRequests: (...args: unknown[]) =>
      apiListSavedRequestsMock(...args),
    apiDeleteSavedRequest: (...args: unknown[]) =>
      apiDeleteSavedRequestMock(...args),
  };
});

function reset() {
  act(() => {
    useApiRunner.setState({ tabs: {} });
  });
  apiListSavedRequestsMock.mockReset();
  apiDeleteSavedRequestMock.mockReset();
  apiDeleteSavedRequestMock.mockResolvedValue(undefined);
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
});

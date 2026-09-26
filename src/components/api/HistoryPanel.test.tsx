import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { HistoryPanel } from "./HistoryPanel";
import { useApiRunner } from "../../state/apiRunnerStore";

const apiListHistoryMock = vi.fn();
const apiGetHistoryDetailMock = vi.fn();

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiListHistory: (...args: unknown[]) => apiListHistoryMock(...args),
    apiGetHistoryDetail: (...args: unknown[]) => apiGetHistoryDetailMock(...args),
  };
});

function reset() {
  act(() => {
    useApiRunner.setState({ tabs: {} });
  });
  apiListHistoryMock.mockReset();
  apiGetHistoryDetailMock.mockReset();
}

function b64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s).toString("base64");
  return btoa(s);
}

describe("HistoryPanel", () => {
  beforeEach(reset);

  it("renders the empty state when there are no rows", async () => {
    apiListHistoryMock.mockResolvedValue([]);
    render(<HistoryPanel tabId="t1" />);
    await waitFor(() =>
      expect(screen.getByTestId("api-history-empty")).toBeDefined(),
    );
  });

  it("filters history by the given tabId", async () => {
    apiListHistoryMock.mockResolvedValue([]);
    render(<HistoryPanel tabId="tab-x" />);
    await waitFor(() => expect(apiListHistoryMock).toHaveBeenCalled());
    expect(apiListHistoryMock.mock.calls[0][0]).toMatchObject({
      tabId: "tab-x",
    });
  });

  it("lists rows with method / status / url", async () => {
    apiListHistoryMock.mockResolvedValue([
      {
        id: "h1",
        tab_id: "t1",
        saved_request_id: null,
        target_id: null,
        environment: null,
        method: "GET",
        url: "/orgs",
        status_code: 200,
        duration_ms: 42,
        error: null,
        sent_at: Math.floor(Date.now() / 1000),
      },
    ]);
    render(<HistoryPanel tabId="t1" />);
    await waitFor(() =>
      expect(screen.getByTestId("api-history-row-h1")).toBeDefined(),
    );
    const row = screen.getByTestId("api-history-row-h1");
    expect(row.textContent).toContain("GET");
    expect(row.textContent).toContain("200");
    expect(row.textContent).toContain("/orgs");
  });

  it("status=0 renders as ERR", async () => {
    apiListHistoryMock.mockResolvedValue([
      {
        id: "h2",
        tab_id: "t1",
        saved_request_id: null,
        target_id: null,
        environment: null,
        method: "GET",
        url: "/broken",
        status_code: 0,
        duration_ms: 500,
        error: "timeout",
        sent_at: 0,
      },
    ]);
    render(<HistoryPanel tabId="t1" />);
    await waitFor(() =>
      expect(screen.getByTestId("api-history-row-h2")).toBeDefined(),
    );
    expect(screen.getByTestId("api-history-row-h2").textContent).toContain(
      "ERR",
    );
  });

  it("clicking a row loads detail and rehydrates the store", async () => {
    apiListHistoryMock.mockResolvedValue([
      {
        id: "h1",
        tab_id: "t1",
        saved_request_id: null,
        target_id: null,
        environment: null,
        method: "POST",
        url: "/x",
        status_code: 201,
        duration_ms: 10,
        error: null,
        sent_at: 0,
      },
    ]);
    apiGetHistoryDetailMock.mockResolvedValue({
      id: "h1",
      tab_id: "t1",
      saved_request_id: null,
      target_id: null,
      environment: null,
      method: "POST",
      url: "/x",
      status_code: 201,
      duration_ms: 10,
      error: null,
      sent_at: 0,
      request_headers_json: '{"X-Req":"1"}',
      request_body: null,
      response_headers_json: "{}",
      response_body: b64('{"ok":true}'),
      response_body_truncated: false,
    });
    useApiRunner.getState().ensure("t1");
    const onLoad = vi.fn();
    render(<HistoryPanel tabId="t1" onLoad={onLoad} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-history-row-h1")).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId("api-history-row-h1"));
    await waitFor(() => expect(apiGetHistoryDetailMock).toHaveBeenCalledWith("h1"));
    await waitFor(() => {
      const stored = useApiRunner.getState().tabs.t1;
      expect(stored.method).toBe("POST");
      expect(stored.url).toBe("/x");
      expect(stored.response?.status_code).toBe(201);
      expect(stored.headers).toContainEqual({ key: "X-Req", value: "1" });
    });
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("refresh button reissues the listHistory call", async () => {
    apiListHistoryMock.mockResolvedValue([]);
    render(<HistoryPanel tabId="t1" />);
    await waitFor(() => expect(apiListHistoryMock).toHaveBeenCalled());
    const callsBefore = apiListHistoryMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("api-history-refresh"));
    await waitFor(() =>
      expect(apiListHistoryMock.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("surfaces list errors without crashing", async () => {
    apiListHistoryMock.mockRejectedValue(new Error("db locked"));
    render(<HistoryPanel tabId="t1" />);
    await waitFor(() =>
      expect(screen.getByTestId("api-history-error").textContent).toContain(
        "db locked",
      ),
    );
  });
});

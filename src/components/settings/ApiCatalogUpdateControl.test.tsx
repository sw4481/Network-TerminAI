import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri", () => ({
  agentCatalogUpdateStart: vi.fn(),
  agentCatalogUpdateStatus: vi.fn(),
}));

import { agentCatalogUpdateStart, agentCatalogUpdateStatus, type ApiCatalogUpdateResult } from "../../lib/tauri";
import { ApiCatalogUpdateControl } from "./ApiCatalogUpdateControl";

const idle: ApiCatalogUpdateResult = {
  agent_id: "ise", catalog_id: "ise", job_id: null, state: "idle",
  phase: null, added: 0, already_known: 0, skipped: 0, warnings: [],
  source_urls: [], checked_at: null, error: null,
};
const running: ApiCatalogUpdateResult = { ...idle, job_id: "job-1", state: "running", phase: "fetching" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentCatalogUpdateStatus).mockResolvedValue(idle);
  vi.mocked(agentCatalogUpdateStart).mockResolvedValue(running);
});

describe("product-local API updates", () => {
  it("checks only the selected product and adds via that product's button", async () => {
    render(<ApiCatalogUpdateControl agentId="ise" label="ISE" />);
    await waitFor(() => expect(agentCatalogUpdateStatus).toHaveBeenCalledWith("ise"));
    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Update APIs for ISE" }));
    await waitFor(() => expect(agentCatalogUpdateStart).toHaveBeenCalledExactlyOnceWith("ise"));
    expect(screen.getByRole("button", { name: /Update APIs for ISE/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("ISE: fetching");
  });

  it("recovers a running job on remount and stops polling at completion", async () => {
    vi.mocked(agentCatalogUpdateStatus).mockResolvedValueOnce(running).mockResolvedValue({
      ...running, state: "completed", phase: null, added: 3, already_known: 8, skipped: 2,
      checked_at: "2026-10-16T12:00:00+00:00", warnings: ["Incomplete coverage: document limit reached."],
    });
    const view = render(<ApiCatalogUpdateControl agentId="ise" label="ISE" />);
    await screen.findByText("ISE: fetching");
    await waitFor(() => expect(agentCatalogUpdateStatus).toHaveBeenCalledWith("ise", "job-1"), { timeout: 2000 });
    expect(await screen.findByText(/3 added.*8 already known.*2 skipped/)).toBeInTheDocument();
    expect(screen.getByText(/Incomplete coverage/)).toBeInTheDocument();
    expect(screen.getByText(/new agent run/i)).toBeInTheDocument();
    expect(screen.getByText(/Last check/)).toBeInTheDocument();
    const count = vi.mocked(agentCatalogUpdateStatus).mock.calls.length;
    view.unmount();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    expect(agentCatalogUpdateStatus).toHaveBeenCalledTimes(count);
  });

  it.each(["failed", "busy"] as const)("shows a product-labelled %s result without polling", async state => {
    vi.mocked(agentCatalogUpdateStart).mockResolvedValue({ ...idle, state, error: "Published source unavailable." });
    const view = render(<ApiCatalogUpdateControl agentId="ise" label="ISE" />);
    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("ISE: Published source unavailable.");
    view.unmount();
  });

  it("reports a lost job/sidecar error and permits a new explicit attempt", async () => {
    vi.mocked(agentCatalogUpdateStatus).mockRejectedValue("Unknown or expired API update job");
    render(<ApiCatalogUpdateControl agentId="ise" label="ISE" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("ISE: Unknown or expired");
    expect(screen.getByRole("button")).toBeEnabled();
    expect(agentCatalogUpdateStart).not.toHaveBeenCalled();
  });

  it("ignores an old page response after switching products", async () => {
    let finish!: (value: ApiCatalogUpdateResult) => void;
    vi.mocked(agentCatalogUpdateStatus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<ApiCatalogUpdateControl agentId="ise" label="ISE" />);
    view.rerender(<ApiCatalogUpdateControl agentId="splunk" label="Splunk" />);
    await waitFor(() => expect(agentCatalogUpdateStatus).toHaveBeenCalledWith("splunk"));
    await act(async () => finish({ ...idle, state: "failed", error: "Stale ISE error" }));
    expect(screen.queryByText(/Stale ISE error/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(agentCatalogUpdateStart).toHaveBeenCalledWith("splunk"));
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NotebookLibrary } from "./NotebookLibrary";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const sampleSummaries = [
  {
    id: "nb-1",
    title: "BGP Peer Bringup",
    description: "Bring up an IBGP peer",
    vendor: "cisco",
    platform: "iosxe",
    cell_count: 5,
    updated_at: 1700000000,
  },
  {
    id: "nb-2",
    title: "Junos OSPF Add",
    description: null,
    vendor: "juniper",
    platform: "junos",
    cell_count: 4,
    updated_at: 1700000001,
  },
  {
    id: "nb-3",
    title: "Generic check",
    description: null,
    vendor: "generic",
    platform: null,
    cell_count: 2,
    updated_at: 1700000002,
  },
];

beforeEach(() => mocks.invoke.mockReset());

describe("NotebookLibrary", () => {
  it("does not render when closed", () => {
    render(<NotebookLibrary open={false} onClose={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByTestId("notebook-library")).toBeNull();
  });

  it("loads and renders rows when opened", async () => {
    mocks.invoke.mockResolvedValueOnce(sampleSummaries);
    render(<NotebookLibrary open={true} onClose={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("library-row-nb-1")).toBeInTheDocument();
    });
    expect(screen.getByText("BGP Peer Bringup")).toBeInTheDocument();
    expect(screen.getByText("Junos OSPF Add")).toBeInTheDocument();
  });

  it("filters by vendor when a chip is clicked", async () => {
    mocks.invoke.mockResolvedValueOnce(sampleSummaries);
    render(<NotebookLibrary open={true} onClose={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => screen.getByTestId("library-row-nb-1"));

    fireEvent.click(screen.getByTestId("filter-cisco"));
    expect(screen.getByTestId("library-row-nb-1")).toBeInTheDocument();
    expect(screen.queryByTestId("library-row-nb-2")).toBeNull();
    expect(screen.queryByTestId("library-row-nb-3")).toBeNull();
  });

  it("Open button calls onOpen with the notebook id", async () => {
    mocks.invoke.mockResolvedValueOnce(sampleSummaries);
    const onOpen = vi.fn();
    render(<NotebookLibrary open={true} onClose={vi.fn()} onOpen={onOpen} />);
    await waitFor(() => screen.getByTestId("library-row-nb-1"));
    fireEvent.click(screen.getByTestId("open-nb-1"));
    expect(onOpen).toHaveBeenCalledWith("nb-1");
  });

  it("Delete invokes notebook_delete_runnable then refreshes", async () => {
    mocks.invoke
      .mockResolvedValueOnce(sampleSummaries) // initial list
      .mockResolvedValueOnce(undefined) // delete
      .mockResolvedValueOnce([sampleSummaries[1]!, sampleSummaries[2]!]); // refresh

    render(<NotebookLibrary open={true} onClose={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => screen.getByTestId("library-row-nb-1"));
    fireEvent.click(screen.getByTestId("delete-nb-1"));
    await waitFor(() => {
      const calls = mocks.invoke.mock.calls.map((c) => c[0]);
      expect(calls).toContain("notebook_delete_runnable");
    });
  });

  it("Import URL invokes the URL command and refreshes", async () => {
    mocks.invoke
      .mockResolvedValueOnce([]) // initial empty list
      .mockResolvedValueOnce("nb-imported") // import_url returns id
      .mockResolvedValueOnce(sampleSummaries); // refresh after import

    render(<NotebookLibrary open={true} onClose={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => screen.getByTestId("library-list"));

    const input = screen.getByTestId("import-url-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com/n.mop.md" } });
    fireEvent.click(screen.getByTestId("import-url-go"));

    await waitFor(() => {
      const calls = mocks.invoke.mock.calls.map((c) => c[0]);
      expect(calls).toContain("notebook_import_url");
    });
  });

  it("Close button calls onClose", async () => {
    mocks.invoke.mockResolvedValueOnce([]);
    const onClose = vi.fn();
    render(<NotebookLibrary open={true} onClose={onClose} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByTestId("library-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows empty state when there are no notebooks", async () => {
    mocks.invoke.mockResolvedValueOnce([]);
    render(<NotebookLibrary open={true} onClose={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No notebooks/i)).toBeInTheDocument();
    });
  });

  it("Export invokes notebook_export_markdown", async () => {
    mocks.invoke
      .mockResolvedValueOnce(sampleSummaries) // list
      .mockResolvedValueOnce("---\ntitle: t\n---\n"); // export
    render(<NotebookLibrary open={true} onClose={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => screen.getByTestId("library-row-nb-1"));
    fireEvent.click(screen.getByTestId("export-nb-1"));
    await waitFor(() => {
      const calls = mocks.invoke.mock.calls.map((c) => c[0]);
      expect(calls).toContain("notebook_export_markdown");
    });
  });
});

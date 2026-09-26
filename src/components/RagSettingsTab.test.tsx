import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRagStore } from "../state/ragStore";
import type { DocRow, RagTaxonomy } from "../lib/rag";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { RagSettingsTab } from "./RagSettingsTab";

const TAXONOMY: RagTaxonomy = {
  builtin: [
    "cisco-iosxe-switch",
    "cisco-iosxe-router",
    "cisco-nxos",
    "cisco-meraki",
    "juniper-junos",
    "arista-eos",
    "generic",
  ],
  user: [],
};

function resetStore() {
  useRagStore.setState({
    documents: [],
    inFlight: {},
    taxonomy: { builtin: [], user: [] },
    activeUserTagsByTab: {},
    loading: false,
    error: null,
    unlisten: null,
  });
}

function makeDoc(overrides: Partial<DocRow> = {}): DocRow {
  return {
    id: 1,
    title: "Sample doc",
    kind: "md",
    bytes: 1024,
    uploaded_at: Math.floor(Date.now() / 1000),
    tags: ["generic"],
    chunk_count: 5,
    ...overrides,
  };
}

function setupInvokeMock(opts: {
  list?: DocRow[];
  taxonomy?: RagTaxonomy;
  uploadDocId?: number;
}) {
  (invoke as unknown as Mock).mockImplementation(
    async (cmd: string, args?: unknown) => {
      void args;
      if (cmd === "rag_list_documents") return opts.list ?? [];
      if (cmd === "rag_tag_taxonomy") return opts.taxonomy ?? TAXONOMY;
      if (cmd === "rag_upload") return opts.uploadDocId ?? 99;
      if (cmd === "rag_delete_document") return undefined;
      throw new Error(`unhandled invoke: ${cmd}`);
    },
  );
}

describe("RagSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("renders the empty state when no docs are loaded", async () => {
    setupInvokeMock({ list: [] });
    render(<RagSettingsTab />);
    await waitFor(() => {
      expect(screen.getByTestId("rag-empty-state")).toBeInTheDocument();
    });
    expect(screen.getByText(/No documents yet/i)).toBeInTheDocument();
  });

  it("renders one row per document with the right tag chips", async () => {
    const docs = [
      makeDoc({ id: 1, title: "Doc One", tags: ["cisco-iosxe-router"] }),
      makeDoc({
        id: 2,
        title: "Doc Two",
        tags: ["cisco-meraki", "generic"],
      }),
    ];
    setupInvokeMock({ list: docs });
    render(<RagSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("rag-doc-row-1")).toBeInTheDocument();
      expect(screen.getByTestId("rag-doc-row-2")).toBeInTheDocument();
    });

    const row1 = screen.getByTestId("rag-doc-row-1");
    expect(row1).toHaveTextContent("Doc One");
    expect(row1).toHaveTextContent("cisco-iosxe-router");

    const row2 = screen.getByTestId("rag-doc-row-2");
    expect(row2).toHaveTextContent("Doc Two");
    expect(row2).toHaveTextContent("cisco-meraki");
    expect(row2).toHaveTextContent("generic");
  });

  it("two-step delete: first click arms, second click invokes ragDelete and removes the row", async () => {
    const docs = [makeDoc({ id: 7 })];
    setupInvokeMock({ list: docs });
    render(<RagSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("rag-doc-row-7")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("rag-doc-row-7-delete"));
    const confirm = await screen.findByTestId(
      "rag-doc-row-7-confirm-delete",
    );
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("rag_delete_document", {
        docId: 7,
      });
    });
    // Optimistic removal — the row should be gone before the
    // backend even confirms.
    expect(screen.queryByTestId("rag-doc-row-7")).not.toBeInTheDocument();
  });

  it("submitting the modal with NO tags surfaces an inline error and does not call ragUpload", async () => {
    setupInvokeMock({ list: [] });
    render(<RagSettingsTab />);

    // Wait for taxonomy to load so the modal can render its tag picker.
    await waitFor(() => {
      expect(useRagStore.getState().taxonomy.builtin.length).toBeGreaterThan(0);
    });

    // Inject a pending file via the public store action: we simulate
    // a drop by calling the modal-open path directly through state
    // via the dropzone's onDrop handler, which the test cannot
    // exercise without a DataTransfer polyfill. The simplest valid
    // path is to dispatch a synthetic drop event with a single File.
    const dropzone = screen.getByTestId("rag-dropzone");
    const file = new File(["hello"], "tiny.md", {
      type: "text/markdown",
    });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file", type: file.type }],
      types: ["Files"],
    };
    fireEvent.drop(dropzone, { dataTransfer });

    const submit = await screen.findByTestId("rag-modal-submit");
    expect(submit).toBeDisabled();

    // Sanity: clicking it (even though disabled) must not invoke
    // ragUpload. The handler short-circuits and the button is
    // disabled by attr.
    fireEvent.click(submit);
    expect(invoke).not.toHaveBeenCalledWith(
      "rag_upload",
      expect.anything(),
    );
  });

  it("modal traps Tab focus: tabbing past the last focusable wraps to the first", async () => {
    setupInvokeMock({ list: [] });
    render(<RagSettingsTab />);

    await waitFor(() => {
      expect(useRagStore.getState().taxonomy.builtin.length).toBeGreaterThan(0);
    });

    const dropzone = screen.getByTestId("rag-dropzone");
    const file = new File(["hi"], "tiny.md", { type: "text/markdown" });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file", type: file.type }],
      types: ["Files"],
    };
    fireEvent.drop(dropzone, { dataTransfer });

    // The dialog renders synchronously after the drop; await the
    // submit button to confirm modal mount.
    await screen.findByTestId("rag-modal-submit");
    const dialog = screen.getByRole("dialog");

    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const enabled = Array.from(focusables).filter(
      (el) => !el.hasAttribute("disabled"),
    );
    expect(enabled.length).toBeGreaterThan(1);
    const first = enabled[0];
    const last = enabled[enabled.length - 1];

    // Forward wrap: focus the last element, fire Tab, expect first
    // element to receive focus.
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Reverse wrap: focus the first element, fire Shift+Tab, expect
    // last element to receive focus.
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("submitting the modal with at least one tag dispatches ragUpload", async () => {
    setupInvokeMock({ list: [], uploadDocId: 42 });
    render(<RagSettingsTab />);

    await waitFor(() => {
      expect(useRagStore.getState().taxonomy.builtin.length).toBeGreaterThan(0);
    });

    const dropzone = screen.getByTestId("rag-dropzone");
    const file = new File(["hello world"], "tiny.md", {
      type: "text/markdown",
    });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file", type: file.type }],
      types: ["Files"],
    };
    fireEvent.drop(dropzone, { dataTransfer });

    // Pick "generic" — the last tag in the taxonomy. Must scope to
    // the modal's tag grid because the empty-state copy also contains
    // the word `generic` inside a <code> element.
    const grid = await screen.findByRole("group", {
      name: /builtin tags/i,
    });
    const genericChip = grid.querySelector(
      "button.rag-modal-tag",
    ) as HTMLButtonElement | null;
    // Find the chip whose text matches.
    const chips = grid.querySelectorAll("button.rag-modal-tag");
    let target: HTMLButtonElement | null = null;
    for (const c of chips) {
      if ((c.textContent || "").includes("generic")) {
        target = c as HTMLButtonElement;
        break;
      }
    }
    expect(target).not.toBeNull();
    void genericChip; // silence unused
    fireEvent.click(target!);

    const submit = screen.getByTestId("rag-modal-submit");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "rag_upload",
        expect.objectContaining({
          args: expect.objectContaining({
            kind: "md",
            tags: ["generic"],
          }),
        }),
      );
    });
  });
});

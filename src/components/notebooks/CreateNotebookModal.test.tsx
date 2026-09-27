import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateNotebookModal } from "./CreateNotebookModal";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

beforeEach(() => mocks.invoke.mockReset());

describe("CreateNotebookModal", () => {
  it("does not render when closed", () => {
    render(
      <CreateNotebookModal open={false} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(screen.queryByTestId("create-mop-modal")).toBeNull();
  });

  it("starts in wizard mode with a default cell", () => {
    render(
      <CreateNotebookModal open={true} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(screen.getByTestId("create-mop-modal")).toBeInTheDocument();
    expect(screen.getByTestId("mode-wizard")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Default draft has one markdown cell.
    expect(screen.getByTestId("wizard-cell-0")).toBeInTheDocument();
  });

  it("requires a title before save", async () => {
    render(
      <CreateNotebookModal open={true} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("create-mop-save"));
    // mocks.invoke must NOT be called because validation gates save.
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("save button is disabled when validation errors exist", () => {
    render(
      <CreateNotebookModal open={true} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(screen.getByTestId("create-mop-save")).toBeDisabled();
  });

  it("typing a title enables save and emits markdown to import", async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mocks.invoke.mockResolvedValueOnce("nb-new-1");

    render(
      <CreateNotebookModal
        open={true}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );
    fireEvent.change(screen.getByTestId("wizard-title"), {
      target: { value: "Custom MOP" },
    });

    const save = screen.getByTestId("create-mop-save");
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });
    const [name, args] = mocks.invoke.mock.calls[0];
    expect(name).toBe("notebook_import_markdown");
    expect((args as { markdown: string }).markdown).toContain("title: Custom MOP");
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("nb-new-1");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("adds and removes parameters", () => {
    render(
      <CreateNotebookModal open={true} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("wizard-add-param"));
    expect(screen.getByTestId("wizard-param-row-0")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("wizard-param-name-0"), {
      target: { value: "peer_ip" },
    });
    expect(
      (screen.getByTestId("wizard-param-name-0") as HTMLInputElement).value,
    ).toBe("peer_ip");
    fireEvent.click(screen.getByTestId("wizard-remove-param-0"));
    expect(screen.queryByTestId("wizard-param-row-0")).toBeNull();
  });

  it("adds command/approval/assertion cells", () => {
    render(
      <CreateNotebookModal open={true} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("wizard-add-command"));
    fireEvent.click(screen.getByTestId("wizard-add-approval"));
    fireEvent.click(screen.getByTestId("wizard-add-assertion"));
    // Default markdown cell + three new cells = 4
    expect(screen.getByTestId("wizard-cell-0")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-cell-1")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-cell-2")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-cell-3")).toBeInTheDocument();
    // Assertion cell exposes its sub-fields.
    expect(screen.getByTestId("wizard-assertion-command-3")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-assertion-jsonpath-3")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-assertion-op-3")).toBeInTheDocument();
  });

  it("switches to raw markdown and back", () => {
    render(
      <CreateNotebookModal open={true} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("mode-raw"));
    expect(screen.getByTestId("raw-md-textarea")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mode-wizard"));
    expect(screen.getByTestId("wizard-title")).toBeInTheDocument();
  });

  it("raw mode saves the textarea contents verbatim", async () => {
    const onCreated = vi.fn();
    mocks.invoke.mockResolvedValueOnce("nb-raw-1");
    render(
      <CreateNotebookModal
        open={true}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );
    fireEvent.click(screen.getByTestId("mode-raw"));
    const ta = screen.getByTestId("raw-md-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, {
      target: { value: "---\ntitle: Custom Raw\n---\n\n# hello\n" },
    });
    fireEvent.click(screen.getByTestId("create-mop-save"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    const [name, args] = mocks.invoke.mock.calls[0];
    expect(name).toBe("notebook_import_markdown");
    expect((args as { markdown: string }).markdown).toContain("title: Custom Raw");
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <CreateNotebookModal
        open={true}
        onClose={onClose}
        onCreated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("create-mop-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces backend errors", async () => {
    mocks.invoke.mockRejectedValueOnce("backend went boom");
    render(
      <CreateNotebookModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("wizard-title"), {
      target: { value: "T" },
    });
    fireEvent.click(screen.getByTestId("create-mop-save"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/boom/);
    });
  });
});

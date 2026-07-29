import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IacFileChooser } from "./IacFileChooser";

const listDirectory = vi.fn();
const deleteFile = vi.fn();
vi.mock("../../lib/tauri", () => ({
  editorListDirectory: (...a: unknown[]) => listDirectory(...a),
  editorDeleteFile: (...a: unknown[]) => deleteFile(...a),
}));

function fileNode(name: string, path: string) {
  return { name, path, node_type: "file" as const };
}

describe("IacFileChooser", () => {
  beforeEach(() => {
    listDirectory.mockReset();
    deleteFile.mockReset();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("lists existing .tf/.yml resources at the workspace root", async () => {
    listDirectory.mockResolvedValue([
      fileNode("main.tf", "/root/main.tf"),
      fileNode("playbook.yml", "/root/playbook.yml"),
      fileNode("README.md", "/root/README.md"), // filtered out
    ]);
    render(
      <IacFileChooser
        kind="resource"
        rootPath="/root"
        onCreateNew={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId("iac-chooser-row")).toHaveLength(2));
    expect(screen.getByText("main.tf")).toBeInTheDocument();
    expect(screen.getByText("playbook.yml")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });

  it("fires onCreateNew when the create button is clicked", async () => {
    listDirectory.mockResolvedValue([]);
    const onCreateNew = vi.fn();
    render(
      <IacFileChooser
        kind="resource"
        rootPath="/root"
        onCreateNew={onCreateNew}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(listDirectory).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("iac-chooser-create"));
    expect(onCreateNew).toHaveBeenCalled();
  });

  it("fires onEdit with the file path when Edit is clicked", async () => {
    listDirectory.mockResolvedValue([fileNode("main.tf", "/root/main.tf")]);
    const onEdit = vi.fn();
    render(
      <IacFileChooser
        kind="resource"
        rootPath="/root"
        onCreateNew={vi.fn()}
        onEdit={onEdit}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("iac-chooser-edit")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("iac-chooser-edit"));
    expect(onEdit).toHaveBeenCalledWith("/root/main.tf");
  });

  it("deletes a file (after confirm) and rescans", async () => {
    listDirectory
      .mockResolvedValueOnce([fileNode("main.tf", "/root/main.tf")])
      .mockResolvedValueOnce([]); // after delete
    deleteFile.mockResolvedValue(undefined);
    render(
      <IacFileChooser
        kind="resource"
        rootPath="/root"
        onCreateNew={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("iac-chooser-delete")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("iac-chooser-delete"));
    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith("/root/main.tf", "/root"));
    // list rescanned → row gone
    await waitFor(() => expect(screen.queryByTestId("iac-chooser-row")).not.toBeInTheDocument());
  });

  it("scans .github/workflows for pipelines", async () => {
    // root listing (has .gitlab-ci.yml) then the workflows dir listing.
    listDirectory
      .mockResolvedValueOnce([fileNode(".gitlab-ci.yml", "/root/.gitlab-ci.yml")])
      .mockResolvedValueOnce([fileNode("ansible.yml", "/root/.github/workflows/ansible.yml")]);
    render(
      <IacFileChooser
        kind="pipeline"
        rootPath="/root"
        onCreateNew={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId("iac-chooser-row")).toHaveLength(2));
    expect(screen.getByText(".gitlab-ci.yml")).toBeInTheDocument();
    expect(screen.getByText(".github/workflows/ansible.yml")).toBeInTheDocument();
  });
});

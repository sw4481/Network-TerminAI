import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/tauri", () => ({
  editorListDirectory: vi.fn(async () => []),
  editorCreateFile: vi.fn(async () => {}),
  editorCreateDirectory: vi.fn(async () => {}),
}));

import * as tauri from "../../lib/tauri";
import { FileExplorer } from "./FileExplorer";

const baseProps = {
  rootPath: "/proj",
  expandedDirs: new Set<string>(),
  onSelectFile: vi.fn(),
  onToggleDir: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe("FileExplorer inline create", () => {
  it("reloads the workspace root when its refresh key changes", async () => {
    vi.mocked(tauri.editorListDirectory)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          path: "/proj/cloned-repository",
          name: "cloned-repository",
          node_type: "directory",
        },
      ]);

    const { rerender } = render(<FileExplorer {...baseProps} refreshKey={0} />);
    await waitFor(() =>
      expect(tauri.editorListDirectory).toHaveBeenCalledTimes(1),
    );

    rerender(<FileExplorer {...baseProps} refreshKey={1} />);

    expect(await screen.findByText("cloned-repository")).toBeTruthy();
    expect(tauri.editorListDirectory).toHaveBeenLastCalledWith("/proj");
  });

  it("offers a workspace folder selector when no root is open", () => {
    const onSelectWorkspace = vi.fn();
    render(
      <FileExplorer
        {...baseProps}
        rootPath={null}
        onSelectWorkspace={onSelectWorkspace}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Select Workspace Folder" }),
    );
    expect(onSelectWorkspace).toHaveBeenCalledOnce();
  });

  it("shows an inline input (not window.prompt) when New File is clicked", async () => {
    const { getByTestId, queryByTestId, findByTestId } = render(
      <FileExplorer {...baseProps} />,
    );
    await findByTestId("explorer-new-file");
    expect(queryByTestId("explorer-create-row")).toBeNull();
    fireEvent.click(getByTestId("explorer-new-file"));
    expect(getByTestId("explorer-create-input")).toBeTruthy();
  });

  it("creates a file at the workspace root on Enter", async () => {
    const { getByTestId, findByTestId } = render(
      <FileExplorer {...baseProps} />,
    );
    fireEvent.click(await findByTestId("explorer-new-file"));
    const input = getByTestId("explorer-create-input");
    fireEvent.change(input, { target: { value: "notes.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(tauri.editorCreateFile).toHaveBeenCalledWith(
        "/proj/notes.txt",
        "/proj",
      ),
    );
    await waitFor(() =>
      expect(baseProps.onSelectFile).toHaveBeenCalledWith("/proj/notes.txt"),
    );
  });

  it("creates a file in the selected directory and opens it automatically", async () => {
    vi.mocked(tauri.editorListDirectory).mockImplementation(async (path) =>
      path === "/proj"
        ? [
            {
              path: "/proj/src",
              name: "src",
              node_type: "directory",
            },
          ]
        : [],
    );
    const onSelectFile = vi.fn();
    const { getByTestId, findByTestId, findByText } = render(
      <FileExplorer {...baseProps} onSelectFile={onSelectFile} />,
    );

    const selectedDirectory = (await findByText("src")).closest(".file-node")!;
    fireEvent.click(selectedDirectory);
    expect(selectedDirectory.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(await findByTestId("explorer-new-file"));
    const input = getByTestId("explorer-create-input");
    fireEvent.change(input, { target: { value: "main.py" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(tauri.editorCreateFile).toHaveBeenCalledWith(
        "/proj/src/main.py",
        "/proj",
      ),
    );
    await waitFor(() =>
      expect(tauri.editorListDirectory).toHaveBeenCalledWith("/proj/src"),
    );
    expect(onSelectFile).toHaveBeenCalledWith("/proj/src/main.py");
  });

  it("creates a folder at the workspace root on Enter", async () => {
    const { getByTestId, findByTestId } = render(
      <FileExplorer {...baseProps} />,
    );
    fireEvent.click(await findByTestId("explorer-new-folder"));
    const input = getByTestId("explorer-create-input");
    fireEvent.change(input, { target: { value: "configs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(tauri.editorCreateDirectory).toHaveBeenCalledWith(
        "/proj/configs",
        "/proj",
      ),
    );
  });

  it("cancels on Escape without creating anything", async () => {
    const { getByTestId, queryByTestId, findByTestId } = render(
      <FileExplorer {...baseProps} />,
    );
    fireEvent.click(await findByTestId("explorer-new-file"));
    const input = getByTestId("explorer-create-input");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(queryByTestId("explorer-create-row")).toBeNull();
    expect(tauri.editorCreateFile).not.toHaveBeenCalled();
  });
});

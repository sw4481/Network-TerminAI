import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

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
    const { getByTestId, findByTestId } = render(<FileExplorer {...baseProps} />);
    fireEvent.click(await findByTestId("explorer-new-file"));
    const input = getByTestId("explorer-create-input");
    fireEvent.change(input, { target: { value: "notes.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(tauri.editorCreateFile).toHaveBeenCalledWith("/proj/notes.txt", "/proj"),
    );
  });

  it("creates a folder at the workspace root on Enter", async () => {
    const { getByTestId, findByTestId } = render(<FileExplorer {...baseProps} />);
    fireEvent.click(await findByTestId("explorer-new-folder"));
    const input = getByTestId("explorer-create-input");
    fireEvent.change(input, { target: { value: "configs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(tauri.editorCreateDirectory).toHaveBeenCalledWith("/proj/configs", "/proj"),
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

import { beforeEach, describe, expect, it, vi } from "vitest";

const openDialog = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

import { pickWorkspaceFolder } from "./workspaceFolderPicker";

describe("pickWorkspaceFolder", () => {
  beforeEach(() => openDialog.mockReset());

  it("opens a native directory-only selector and returns the chosen root", async () => {
    openDialog.mockResolvedValue("/repo/project");

    await expect(pickWorkspaceFolder("/repo")).resolves.toBe("/repo/project");
    expect(openDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Select Workspace Folder",
      defaultPath: "/repo",
    });
  });

  it("returns null when selection is cancelled", async () => {
    openDialog.mockResolvedValue(null);
    await expect(pickWorkspaceFolder(null)).resolves.toBeNull();
  });
});

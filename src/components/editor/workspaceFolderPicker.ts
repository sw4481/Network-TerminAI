export async function pickWorkspaceFolder(
  defaultPath: string | null,
): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: true,
    multiple: false,
    title: "Select Workspace Folder",
    ...(defaultPath ? { defaultPath } : {}),
  });
  return typeof picked === "string" && picked.length > 0 ? picked : null;
}

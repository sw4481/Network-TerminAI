import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: invokeMock,
}));

import {
  gitGetFileChanges,
  gitGetLineBlame,
  gitGetRepositorySummary,
} from "./tauri";

describe("Zed Git-awareness Tauri bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(null);
  });

  it("requests structured changes for the current in-memory buffer", async () => {
    await gitGetFileChanges("/repo/src/app.ts", "const answer = 42;\n");

    expect(invokeMock).toHaveBeenCalledWith("git_get_file_changes", {
      filePath: "/repo/src/app.ts",
      contents: "const answer = 42;\n",
    });
  });

  it("requests blame with Monaco's one-based cursor line", async () => {
    await gitGetLineBlame("/repo/src/app.ts", "one\ntwo\n", 2);

    expect(invokeMock).toHaveBeenCalledWith("git_get_line_blame", {
      filePath: "/repo/src/app.ts",
      contents: "one\ntwo\n",
      lineNumber: 2,
    });
  });

  it("summarizes a repository from either a workspace or file path", async () => {
    await gitGetRepositorySummary("/repo");

    expect(invokeMock).toHaveBeenCalledWith("git_get_repository_summary", {
      path: "/repo",
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: invokeMock,
}));

import {
  lspCheckAvailable,
  lspDocumentChange,
  lspDocumentClose,
  lspDocumentOpen,
  lspIsRunning,
  lspRequest,
  lspStart,
  lspStop,
} from "./tauri";

describe("workspace LSP Tauri bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  it("scopes lifecycle and requests to a workspace", async () => {
    await lspStart("python", "/repo", "pane-1");
    await lspRequest("python", "/repo", "workspace/symbol", {
      query: "Router",
    });
    await lspIsRunning("python", "/repo");
    await lspCheckAvailable("/repo");
    await lspStop("python", "/repo", "pane-1");

    expect(invokeMock.mock.calls).toEqual([
      [
        "lsp_start",
        { language: "python", workspaceRoot: "/repo", clientId: "pane-1" },
      ],
      [
        "lsp_request",
        {
          language: "python",
          workspaceRoot: "/repo",
          method: "workspace/symbol",
          params: { query: "Router" },
        },
      ],
      ["lsp_is_running", { language: "python", workspaceRoot: "/repo" }],
      ["lsp_check_available", { workspaceRoot: "/repo" }],
      [
        "lsp_stop",
        { language: "python", workspaceRoot: "/repo", clientId: "pane-1" },
      ],
    ]);
  });

  it("sends high-level document ownership commands", async () => {
    await lspDocumentOpen(
      "python",
      "/repo",
      "pane-1",
      "file:///repo/main.py",
      "python",
      "value = 1\n",
    );
    await lspDocumentChange(
      "python",
      "/repo",
      "pane-1",
      "file:///repo/main.py",
      "value = 2\n",
    );
    await lspDocumentClose(
      "python",
      "/repo",
      "pane-1",
      "file:///repo/main.py",
    );

    expect(invokeMock.mock.calls).toEqual([
      [
        "lsp_document_open",
        {
          language: "python",
          workspaceRoot: "/repo",
          clientId: "pane-1",
          uri: "file:///repo/main.py",
          languageId: "python",
          text: "value = 1\n",
        },
      ],
      [
        "lsp_document_change",
        {
          language: "python",
          workspaceRoot: "/repo",
          clientId: "pane-1",
          uri: "file:///repo/main.py",
          text: "value = 2\n",
        },
      ],
      [
        "lsp_document_close",
        {
          language: "python",
          workspaceRoot: "/repo",
          clientId: "pane-1",
          uri: "file:///repo/main.py",
        },
      ],
    ]);
  });
});

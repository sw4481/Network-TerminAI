import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  lspStart: vi.fn(),
  lspStop: vi.fn(),
  lspRequest: vi.fn(),
  lspCheckAvailable: vi.fn(),
  lspDocumentOpen: vi.fn(),
  lspDocumentChange: vi.fn(),
  lspDocumentClose: vi.fn(),
}));

vi.mock("../lib/tauri", () => tauri);

import { normalizeLspLanguage, useLspClient } from "./useLspClient";

describe("useLspClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.lspCheckAvailable.mockResolvedValue(["python", "yaml"]);
    tauri.lspStart.mockResolvedValue({
      language: "python",
      workspaceRoot: "/repo",
      serverName: "Pyright",
    });
    tauri.lspStop.mockResolvedValue(undefined);
    tauri.lspRequest.mockResolvedValue([{ name: "Router" }]);
    tauri.lspDocumentOpen.mockResolvedValue(undefined);
    tauri.lspDocumentChange.mockResolvedValue(undefined);
    tauri.lspDocumentClose.mockResolvedValue(undefined);
  });

  it("normalizes only supported project languages", () => {
    expect(normalizeLspLanguage("Python")).toBe("python");
    expect(normalizeLspLanguage("yml")).toBe("yaml");
    expect(normalizeLspLanguage("typescript")).toBeNull();
  });

  it("acquires one workspace lease and releases it on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useLspClient("python", "/repo", true),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.serverName).toBe("Pyright");
    const [, , clientId] = tauri.lspStart.mock.calls[0];
    expect(tauri.lspStart).toHaveBeenCalledWith("python", "/repo", clientId);

    unmount();
    await waitFor(() =>
      expect(tauri.lspStop).toHaveBeenCalledWith(
        "python",
        "/repo",
        clientId,
      ),
    );
  });

  it("routes raw results and document ownership through the active session", async () => {
    const { result } = renderHook(() =>
      useLspClient("python", "/repo", true),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const clientId = tauri.lspStart.mock.calls[0][2];

    await act(async () => {
      expect(
        await result.current.sendRequest("workspace/symbol", {
          query: "Router",
        }),
      ).toEqual([{ name: "Router" }]);
      await result.current.openDocument(
        "file:///repo/main.py",
        "python",
        "value = 1\n",
      );
      await result.current.changeDocument(
        "file:///repo/main.py",
        "value = 2\n",
      );
      await result.current.closeDocument("file:///repo/main.py");
    });

    expect(tauri.lspRequest).toHaveBeenCalledWith(
      "python",
      "/repo",
      "workspace/symbol",
      { query: "Router" },
    );
    expect(tauri.lspDocumentOpen).toHaveBeenCalledWith(
      "python",
      "/repo",
      clientId,
      "file:///repo/main.py",
      "python",
      "value = 1\n",
    );
    expect(tauri.lspDocumentChange).toHaveBeenCalledWith(
      "python",
      "/repo",
      clientId,
      "file:///repo/main.py",
      "value = 2\n",
    );
    expect(tauri.lspDocumentClose).toHaveBeenCalledWith(
      "python",
      "/repo",
      clientId,
      "file:///repo/main.py",
    );
  });

  it("keeps a new lease when a cancelled startup resolves late", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    tauri.lspStart
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const { result, rerender } = renderHook(
      ({ enabled }) => useLspClient("python", "/repo", enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(tauri.lspStart).toHaveBeenCalledTimes(1));
    const firstClientId = tauri.lspStart.mock.calls[0][2];

    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(tauri.lspStart).toHaveBeenCalledTimes(2));
    const secondClientId = tauri.lspStart.mock.calls[1][2];
    expect(secondClientId).not.toBe(firstClientId);

    await act(async () => {
      resolveSecond?.({
        language: "python",
        workspaceRoot: "/repo",
        serverName: "Pyright",
      });
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      resolveFirst?.({
        language: "python",
        workspaceRoot: "/repo",
        serverName: "Pyright",
      });
    });
    await waitFor(() =>
      expect(tauri.lspStop).toHaveBeenCalledWith(
        "python",
        "/repo",
        firstClientId,
      ),
    );
    expect(tauri.lspStop).not.toHaveBeenCalledWith(
      "python",
      "/repo",
      secondClientId,
    );
    expect(result.current.ready).toBe(true);
  });

  it("does not start for unsupported or disabled editors", async () => {
    const { result } = renderHook(() =>
      useLspClient("hcl", "/repo", true),
    );
    expect(result.current.ready).toBe(false);
    expect(tauri.lspCheckAvailable).not.toHaveBeenCalled();
    expect(tauri.lspStart).not.toHaveBeenCalled();
  });
});

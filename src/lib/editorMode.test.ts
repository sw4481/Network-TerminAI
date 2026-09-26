import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { editorModeGet, editorModeSet } from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

const invokeMock = vi.mocked(invoke);

describe("editor mode Tauri bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("reads the persisted editor mode", async () => {
    invokeMock.mockResolvedValueOnce("zed");
    await expect(editorModeGet()).resolves.toBe("zed");
    expect(invokeMock).toHaveBeenCalledWith("editor_mode_get");
  });

  it("writes the selected editor mode", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await editorModeSet("monaco");
    expect(invokeMock).toHaveBeenCalledWith("editor_mode_set", {
      mode: "monaco",
    });
  });
});

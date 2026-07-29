import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: invokeMock,
}));

import {
  editorDetachedWindowClose,
  editorDetachedWindowFocus,
  editorDetachedWindowGetCurrent,
  editorDetachedWindowList,
  editorDetachPane,
  editorSourceWindowFocus,
} from "./tauri";

describe("detached editor Tauri commands", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  it("sends identity metadata without raw content or a separate file path", async () => {
    await editorDetachPane(
      "editor-tab-1",
      "pane-1",
      "file:/repo/a.ts",
      "a.ts",
      "/repo",
    );

    const expected = {
      tabId: "editor-tab-1",
      paneId: "pane-1",
      bufferId: "file:/repo/a.ts",
      title: "a.ts",
      workspaceRoot: "/repo",
    };
    expect(invokeMock).toHaveBeenCalledWith("editor_detach_pane", expected);
    expect(expected).not.toHaveProperty("content");
    expect(expected).not.toHaveProperty("filePath");
  });

  it("routes metadata, list, focus, close, and source focus commands", async () => {
    await editorDetachedWindowGetCurrent();
    await editorDetachedWindowList();
    await editorDetachedWindowFocus("editor-window-1");
    await editorDetachedWindowClose("editor-window-1");
    await editorSourceWindowFocus();

    expect(invokeMock.mock.calls).toEqual([
      ["editor_detached_window_get_current"],
      ["editor_detached_window_list"],
      ["editor_detached_window_focus", { windowId: "editor-window-1" }],
      ["editor_detached_window_close", { windowId: "editor-window-1" }],
      ["editor_source_window_focus"],
    ]);
  });
});

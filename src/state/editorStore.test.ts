import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  bufferIdForFile,
  createEditorBuffer,
  useEditorStore,
} from "./editorStore";
import {
  findEditorPane,
  getEditorPaneLeaves,
} from "../components/editor/editorPaneLayout";

describe("editorStore normalized editor state", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useEditorStore.getState().resetAll();
  });

  it("initializes a workspace and untitled buffer once", () => {
    const first = useEditorStore
      .getState()
      .initializeWorkspace("editor-tab-1", {
        bufferId: "untitled:seed",
        paneId: "pane-seed",
      });
    const second = useEditorStore
      .getState()
      .initializeWorkspace("editor-tab-1");

    expect(second).toBe(first);
    expect(first.focusedPaneId).toBe("pane-seed");
    expect(getEditorPaneLeaves(first.layout)).toHaveLength(1);
    expect(useEditorStore.getState().buffers["untitled:seed"]).toMatchObject({
      content: "",
      language: "plaintext",
      cisco_platform: null,
      is_dirty: false,
      revision: 0,
    });
  });

  it("patches only the active buffer Cisco profile", () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-seed",
    });
    const before = useEditorStore.getState().buffers["untitled:seed"];

    store.patchBuffer("untitled:seed", { cisco_platform: "iosxe" });

    expect(useEditorStore.getState().buffers["untitled:seed"]).toEqual({
      ...before,
      cisco_platform: "iosxe",
    });
  });

  it("deduplicates file-backed buffers by normalized path", () => {
    const first = createEditorBuffer({
      file_path: "/repo/src/../src/main.ts",
      content: "first",
      language: "typescript",
    });
    const second = createEditorBuffer({
      file_path: "\\repo\\src\\main.ts",
      content: "second",
      language: "typescript",
    });

    expect(first.id).toBe("file:/repo/src/main.ts");
    expect(second.id).toBe(first.id);
    expect(bufferIdForFile("/repo//src/./main.ts")).toBe(first.id);
  });

  it("opens a deduplicated file only in the focused pane", () => {
    const store = useEditorStore.getState();
    const workspace = store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-left",
    });
    store.splitPane("editor-tab-1", workspace.focusedPaneId, "horizontal", {
      paneId: "pane-right",
      splitId: "split-root",
    });
    store.focusPane("editor-tab-1", "pane-right");
    const bufferId = store.openFileInPane("editor-tab-1", "pane-right", {
      file_path: "/repo/a.ts",
      content: "const a = 1;",
      language: "typescript",
    });
    const duplicateId = store.openFileInPane("editor-tab-1", "pane-left", {
      file_path: "/repo/./a.ts",
      content: "stale disk content",
      language: "typescript",
    });

    const state = useEditorStore.getState();
    expect(duplicateId).toBe(bufferId);
    expect(Object.keys(state.buffers)).toHaveLength(2);
    expect(state.buffers[bufferId].content).toBe("const a = 1;");
    expect(
      getEditorPaneLeaves(state.workspaces["editor-tab-1"].layout).map(
        (pane) => pane.bufferId,
      ),
    ).toEqual([bufferId, bufferId]);
    expect(state.workspaces["editor-tab-1"].openBufferIds).toEqual([
      "untitled:seed",
      bufferId,
    ]);
  });

  it("closes an inactive file tab without changing the visible pane", () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-seed",
    });
    const first = store.openFileInPane("editor-tab-1", "pane-seed", {
      file_path: "/repo/first.py",
      content: "first = 1",
      language: "python",
    });
    const second = store.openFileInPane("editor-tab-1", "pane-seed", {
      file_path: "/repo/second.py",
      content: "second = 2",
      language: "python",
    });

    store.closeBuffer("editor-tab-1", first);

    const state = useEditorStore.getState();
    expect(state.workspaces["editor-tab-1"].openBufferIds).toEqual([
      "untitled:seed",
      second,
    ]);
    expect(
      getEditorPaneLeaves(state.workspaces["editor-tab-1"].layout)[0],
    ).toHaveProperty("bufferId", second);
    expect(state.buffers[first]).toBeUndefined();
  });

  it("moves every visible pane to the nearest tab when its active tab closes", () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-left",
    });
    const first = store.openFileInPane("editor-tab-1", "pane-left", {
      file_path: "/repo/first.py",
      content: "first = 1",
      language: "python",
    });
    const second = store.openFileInPane("editor-tab-1", "pane-left", {
      file_path: "/repo/second.py",
      content: "second = 2",
      language: "python",
    });
    store.splitPane("editor-tab-1", "pane-left", "horizontal", {
      paneId: "pane-right",
      splitId: "split-root",
    });

    store.closeBuffer("editor-tab-1", second);

    const state = useEditorStore.getState();
    expect(state.workspaces["editor-tab-1"].openBufferIds).toEqual([
      "untitled:seed",
      first,
    ]);
    expect(
      getEditorPaneLeaves(state.workspaces["editor-tab-1"].layout).map(
        (pane) => pane.bufferId,
      ),
    ).toEqual([first, first]);
    expect(state.buffers[second]).toBeUndefined();
  });

  it("leaves a fresh untitled tab when the final tab closes", () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-seed",
    });

    store.closeBuffer("editor-tab-1", "untitled:seed");

    const state = useEditorStore.getState();
    const [replacementId] = state.workspaces["editor-tab-1"].openBufferIds;
    expect(replacementId).toMatch(/^untitled:/);
    expect(replacementId).not.toBe("untitled:seed");
    expect(state.buffers[replacementId]).toMatchObject({
      file_path: null,
      content: "",
      is_dirty: false,
    });
    expect(
      getEditorPaneLeaves(state.workspaces["editor-tab-1"].layout)[0],
    ).toHaveProperty("bufferId", replacementId);
    expect(state.buffers["untitled:seed"]).toBeUndefined();
  });

  it("resets explorer-only state when a different workspace root is selected", () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-seed",
    });
    store.setFileTree("editor-tab-1", [], "/repo/old");
    store.toggleDirectory("editor-tab-1", "/repo/old/src");
    store.setGitStatus(
      "editor-tab-1",
      [{ path: "main.py", status: "modified" }],
      true,
    );

    store.setFileTree("editor-tab-1", [], "/repo/new");

    expect(useEditorStore.getState().workspaces["editor-tab-1"]).toMatchObject({
      root_path: "/repo/new",
      expanded_dirs: new Set(),
      git_status: [],
      is_git_repo: false,
      error: null,
    });
  });

  it("does not publish a store update when buffer text is unchanged", () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-seed",
    });
    const initialBuffers = useEditorStore.getState().buffers;
    const listener = vi.fn();
    const unsubscribe = useEditorStore.subscribe(listener);

    store.setBufferContent("untitled:seed", "");

    expect(useEditorStore.getState().buffers).toBe(initialBuffers);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("updates layout focus, size, view state, detach marker, and close state", () => {
    const store = useEditorStore.getState();
    const workspace = store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-left",
    });
    store.splitPane("editor-tab-1", workspace.focusedPaneId, "vertical", {
      paneId: "pane-right",
      splitId: "split-root",
    });
    store.resizePane("editor-tab-1", "split-root", [40, 60]);
    store.updatePaneView("editor-tab-1", "pane-right", {
      cursor_position: { line: 7, column: 2 },
      scroll_position: 50,
    });
    store.markPaneDetached("editor-tab-1", "pane-right", "editor-window-1");
    store.reconcileDetachedPanes("editor-tab-1", new Set());

    let current = useEditorStore.getState().workspaces["editor-tab-1"];
    expect(current.focusedPaneId).toBe("pane-right");
    expect(findEditorPane(current.layout, "pane-right")).toMatchObject({
      size: 60,
      cursor_position: { line: 7, column: 2 },
      scroll_position: 50,
      detachedWindowId: null,
    });

    store.closePane("editor-tab-1", "pane-left");
    current = useEditorStore.getState().workspaces["editor-tab-1"];
    expect(current.layout).toMatchObject({ type: "leaf", id: "pane-right" });
    store.closePane("editor-tab-1", "pane-right");
    expect(useEditorStore.getState().workspaces["editor-tab-1"].layout).toEqual(
      current.layout,
    );
  });

  it("persists versioned editor JSON through the generic pane commands", async () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-seed",
    });
    invokeMock.mockResolvedValueOnce(undefined);

    await store.saveWorkspaceLayout("editor-tab-1");

    expect(invokeMock).toHaveBeenCalledWith("panes_save_layout", {
      tabId: "editor-tab-1",
      layoutJson: expect.stringContaining('"version":1'),
    });
    expect(invokeMock.mock.calls[0][1].layoutJson).not.toContain("content");
  });

  it("hydrates valid layout JSON and falls back safely for corrupt data", async () => {
    const savedBuffer = createEditorBuffer({
      file_path: "/repo/a.ts",
      content: "",
      language: "typescript",
    });
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        focusedPaneId: "pane-file",
        root: {
          type: "leaf",
          id: "pane-file",
          size: 100,
          buffer: { kind: "file", path: "/repo/a.ts" },
          detachedWindowId: "dead-window",
        },
      }),
    );

    const hydrated = await useEditorStore
      .getState()
      .loadWorkspaceLayout("editor-tab-1", new Set());

    expect(hydrated.focusedPaneId).toBe("pane-file");
    expect(hydrated.layout).toMatchObject({
      bufferId: savedBuffer.id,
      detachedWindowId: null,
    });
    expect(useEditorStore.getState().buffers[savedBuffer.id]).toBeDefined();

    invokeMock.mockResolvedValueOnce("{not-json");
    const fallback = await useEditorStore
      .getState()
      .loadWorkspaceLayout("editor-tab-2", new Set());
    expect(getEditorPaneLeaves(fallback.layout)).toHaveLength(1);
  });

  it("preserves detached markers when the live-window registry is unavailable", async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        focusedPaneId: "pane-file",
        root: {
          type: "leaf",
          id: "pane-file",
          size: 100,
          buffer: { kind: "file", path: "/repo/a.ts" },
          detachedWindowId: "window-status-unknown",
        },
      }),
    );

    const hydrated = await useEditorStore
      .getState()
      .loadWorkspaceLayout("editor-tab-1");

    expect(hydrated.layout).toMatchObject({
      detachedWindowId: "window-status-unknown",
    });
  });
});

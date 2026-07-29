import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useEditorStore } from "../../state/editorStore";
import { findEditorPane } from "./editorPaneLayout";
import { applyDetachedEditorWindowClosed } from "./editorWindowLifecycle";

describe("detached editor window close lifecycle", () => {
  beforeEach(() => {
    useEditorStore.getState().resetAll();
  });

  it("reattaches the matching placeholder without losing buffer state", () => {
    const store = useEditorStore.getState();
    const workspace = store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-1",
    });
    store.patchBuffer("untitled:seed", {
      content: "unsaved",
      is_dirty: true,
      revision: 7,
    });
    store.markPaneDetached(workspace.tabId, "pane-1", "editor-window-1");

    expect(
      applyDetachedEditorWindowClosed({
        windowId: "editor-window-1",
        tabId: workspace.tabId,
        paneId: "pane-1",
      }),
    ).toBe(true);

    const current = useEditorStore.getState();
    expect(
      findEditorPane(current.workspaces[workspace.tabId].layout, "pane-1"),
    ).toMatchObject({ detachedWindowId: null });
    expect(current.buffers["untitled:seed"]).toMatchObject({
      content: "unsaved",
      is_dirty: true,
      revision: 7,
    });
  });

  it("ignores a stale close event for an older native window", () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-1",
    });
    store.markPaneDetached("editor-tab-1", "pane-1", "editor-window-new");

    expect(
      applyDetachedEditorWindowClosed({
        windowId: "editor-window-old",
        tabId: "editor-tab-1",
        paneId: "pane-1",
      }),
    ).toBe(false);
    expect(
      findEditorPane(
        useEditorStore.getState().workspaces["editor-tab-1"].layout,
        "pane-1",
      ),
    ).toMatchObject({ detachedWindowId: "editor-window-new" });
  });

  it("does not resurrect a workspace after its editor tab was removed", () => {
    const store = useEditorStore.getState();
    store.initializeWorkspace("editor-tab-1", {
      bufferId: "untitled:seed",
      paneId: "pane-1",
    });
    store.resetWorkspace("editor-tab-1");

    expect(
      applyDetachedEditorWindowClosed({
        windowId: "editor-window-1",
        tabId: "editor-tab-1",
        paneId: "pane-1",
      }),
    ).toBe(false);
    expect(
      useEditorStore.getState().workspaces["editor-tab-1"],
    ).toBeUndefined();
  });
});

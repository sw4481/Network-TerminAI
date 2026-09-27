import { describe, expect, it } from "vitest";
import {
  closeEditorPane,
  createEditorPaneLayout,
  deserializeEditorLayout,
  findEditorPane,
  getEditorPaneLeaves,
  markEditorPaneDetached,
  reattachEditorPane,
  reconcileDetachedEditorPanes,
  resizeEditorSplit,
  serializeEditorLayout,
  splitEditorPane,
  updateEditorPaneView,
  type EditorBufferIdentity,
} from "./editorPaneLayout";

const ids = {
  root: "pane-root",
  right: "pane-right",
  down: "pane-down",
  splitHorizontal: "split-horizontal",
  splitVertical: "split-vertical",
};

describe("editorPaneLayout", () => {
  it("initializes one attached pane for the supplied buffer", () => {
    const layout = createEditorPaneLayout("file:/repo/a.ts", ids.root);

    expect(layout).toEqual({
      type: "leaf",
      id: ids.root,
      size: 100,
      bufferId: "file:/repo/a.ts",
      detachedWindowId: null,
      cursor_position: { line: 1, column: 1 },
      scroll_position: 0,
    });
  });

  it("splits a pane while retaining the original pane identity", () => {
    const layout = createEditorPaneLayout("file:/repo/a.ts", ids.root);
    const split = splitEditorPane(
      layout,
      ids.root,
      "horizontal",
      ids.right,
      ids.splitHorizontal,
    );

    expect(split.type).toBe("split");
    if (split.type !== "split") throw new Error("expected a split");
    expect(split.direction).toBe("horizontal");
    expect(split.children.map((child) => child.id)).toEqual([
      ids.root,
      ids.right,
    ]);
    expect(split.children.map((child) => child.size)).toEqual([50, 50]);
    expect(getEditorPaneLeaves(split).map((pane) => pane.bufferId)).toEqual([
      "file:/repo/a.ts",
      "file:/repo/a.ts",
    ]);
  });

  it("supports nested split-down, resize, and independent view state", () => {
    const horizontal = splitEditorPane(
      createEditorPaneLayout("file:/repo/a.ts", ids.root),
      ids.root,
      "horizontal",
      ids.right,
      ids.splitHorizontal,
    );
    const nested = splitEditorPane(
      horizontal,
      ids.right,
      "vertical",
      ids.down,
      ids.splitVertical,
    );
    const resized = resizeEditorSplit(
      nested,
      ids.splitHorizontal,
      [35, 65],
    );
    const viewed = updateEditorPaneView(resized, ids.down, {
      cursor_position: { line: 9, column: 4 },
      scroll_position: 120,
    });

    expect(findEditorPane(viewed, ids.splitHorizontal)?.size).toBe(100);
    const topSplit = findEditorPane(viewed, ids.splitHorizontal);
    expect(topSplit?.type).toBe("split");
    if (topSplit?.type !== "split") throw new Error("expected top split");
    expect(topSplit.children.map((child) => child.size)).toEqual([35, 65]);
    expect(findEditorPane(viewed, ids.down)).toMatchObject({
      cursor_position: { line: 9, column: 4 },
      scroll_position: 120,
    });
    expect(findEditorPane(viewed, ids.root)).toMatchObject({
      cursor_position: { line: 1, column: 1 },
      scroll_position: 0,
    });
  });

  it("collapses and rebalances after close but protects the last attached pane", () => {
    const split = splitEditorPane(
      createEditorPaneLayout("file:/repo/a.ts", ids.root),
      ids.root,
      "horizontal",
      ids.right,
      ids.splitHorizontal,
    );

    const closed = closeEditorPane(split, ids.root);
    expect(closed.changed).toBe(true);
    expect(closed.layout).toMatchObject({
      type: "leaf",
      id: ids.right,
      size: 100,
    });

    const refused = closeEditorPane(closed.layout, ids.right);
    expect(refused).toEqual({ changed: false, layout: closed.layout });
  });

  it("marks, reattaches, and reconciles detached window placeholders", () => {
    const split = splitEditorPane(
      createEditorPaneLayout("file:/repo/a.ts", ids.root),
      ids.root,
      "horizontal",
      ids.right,
      ids.splitHorizontal,
    );
    const detached = markEditorPaneDetached(
      split,
      ids.right,
      "editor-window-live",
    );

    expect(findEditorPane(detached, ids.right)).toMatchObject({
      detachedWindowId: "editor-window-live",
    });
    expect(
      findEditorPane(
        reconcileDetachedEditorPanes(
          detached,
          new Set(["editor-window-live"]),
        ),
        ids.right,
      ),
    ).toMatchObject({ detachedWindowId: "editor-window-live" });
    expect(
      findEditorPane(
        reconcileDetachedEditorPanes(detached, new Set()),
        ids.right,
      ),
    ).toMatchObject({ detachedWindowId: null });
    expect(findEditorPane(reattachEditorPane(detached, ids.right), ids.right))
      .toMatchObject({ detachedWindowId: null });
  });

  it("round-trips a versioned document without persisting buffer content", () => {
    const layout = markEditorPaneDetached(
      splitEditorPane(
        createEditorPaneLayout("file:/repo/a.ts", ids.root),
        ids.root,
        "horizontal",
        ids.right,
        ids.splitHorizontal,
      ),
      ids.right,
      "editor-window-1",
    );
    const identities: Record<string, EditorBufferIdentity> = {
      "file:/repo/a.ts": { kind: "file", path: "/repo/a.ts" },
    };

    const serialized = serializeEditorLayout(
      layout,
      ids.right,
      identities,
    );
    expect(serialized).not.toContain("secret file content");

    const restored = deserializeEditorLayout(serialized, () => "fallback");
    expect(restored?.focusedPaneId).toBe(ids.right);
    expect(restored?.layout).toEqual(layout);
    expect(restored?.bufferIdentities).toEqual(identities);
  });

  it("tolerates invalid, old, and partially corrupt persisted layouts", () => {
    expect(deserializeEditorLayout("{", () => "fallback")).toBeNull();
    expect(
      deserializeEditorLayout(
        JSON.stringify({ version: 99, root: {} }),
        () => "fallback",
      ),
    ).toBeNull();

    const restored = deserializeEditorLayout(
      JSON.stringify({
        version: 1,
        focusedPaneId: "missing-pane",
        root: {
          type: "split",
          id: "split",
          size: 100,
          direction: "horizontal",
          children: [
            {
              type: "leaf",
              id: "valid",
              size: 0,
              buffer: { kind: "file", path: "/repo/../repo/a.ts" },
              detachedWindowId: 42,
            },
            { type: "broken" },
          ],
        },
      }),
      () => "fallback",
    );

    expect(restored?.focusedPaneId).toBe("valid");
    expect(restored?.layout).toMatchObject({
      type: "leaf",
      id: "valid",
      size: 100,
      bufferId: "file:/repo/a.ts",
      detachedWindowId: null,
    });
  });
});

import type { DetachedEditorWindowClosed } from "../../lib/tauri";
import { useEditorStore } from "../../state/editorStore";
import { findEditorPane } from "./editorPaneLayout";

export const EDITOR_DETACHED_WINDOW_CLOSED_EVENT =
  "editor-detached-window-closed";

export function applyDetachedEditorWindowClosed(
  payload: DetachedEditorWindowClosed,
): boolean {
  const state = useEditorStore.getState();
  const workspace = state.workspaces[payload.tabId];
  if (!workspace) return false;
  const pane = findEditorPane(workspace.layout, payload.paneId);
  if (pane?.type !== "leaf" || pane.detachedWindowId !== payload.windowId) {
    return false;
  }
  state.reattachPane(payload.tabId, payload.paneId);
  return true;
}

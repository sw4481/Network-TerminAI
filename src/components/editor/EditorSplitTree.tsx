import { Fragment, useCallback, useRef } from "react";
import type * as Monaco from "monaco-editor";
import type { CiscoDiagnostic } from "../../lib/ciscoLint";
import type {
  CiscoGuardrailStatus,
  CiscoLintView,
} from "../../hooks/useCiscoLint";
import { PaneHandle } from "../PaneHandle";
import type {
  EditorBufferState,
} from "../../state/editorStore";
import type { EditorSettings } from "./MonacoEditor";
import { EditorPane } from "./EditorPane";
import {
  getAttachedEditorPanes,
  getEditorPaneLeaves,
  type EditorPaneDirection,
  type EditorPaneNode,
} from "./editorPaneLayout";
import "./editor-splits.css";

export type EditorSplitTreeProps = {
  node: EditorPaneNode;
  buffers: Readonly<Record<string, EditorBufferState>>;
  tabId: string;
  rootPath: string | null;
  focusedPaneId: string;
  ciscoDiagnostics?: readonly CiscoDiagnostic[];
  ciscoGuardrailStatus?: CiscoGuardrailStatus;
  onCiscoLintResult?: (result: CiscoLintView) => void;
  settings: EditorSettings;
  onFocus: (paneId: string) => void;
  onSplit: (paneId: string, direction: EditorPaneDirection) => void;
  onDetach: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  onReattach: (paneId: string) => void;
  onFocusWindow: (paneId: string, windowId: string) => void;
  onChange: (bufferId: string, content: string) => void;
  onCursorChange: (
    paneId: string,
    position: { line: number; column: number },
  ) => void;
  onScrollChange: (paneId: string, scrollTop: number) => void;
  onSave: (bufferId: string) => void;
  onEditorReady: (
    paneId: string,
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
  ) => void;
  onOpenResource: (
    paneId: string,
    uri: string,
    position: { line: number; column: number },
  ) => boolean | Promise<boolean>;
};

type BranchProps = EditorSplitTreeProps & {
  canClose: boolean;
};

function EditorSplitBranch(props: BranchProps) {
  const { node } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  const resize = useCallback(
    (index: number, delta: number) => {
      if (node.type !== "split" || !containerRef.current) return;
      const extent =
        node.direction === "horizontal"
          ? containerRef.current.offsetWidth
          : containerRef.current.offsetHeight;
      if (extent <= 0) return;
      const deltaPercent = (delta / extent) * 100;
      const sizes = node.children.map((child) => child.size);
      const combined = sizes[index] + sizes[index + 1];
      const minimum = Math.min(20, combined / 2);
      sizes[index] = Math.max(
        minimum,
        Math.min(combined - minimum, sizes[index] + deltaPercent),
      );
      sizes[index + 1] = combined - sizes[index];
      props.onResize(node.id, sizes);
    },
    [node, props],
  );

  if (node.type === "leaf") {
    const buffer = props.buffers[node.bufferId];
    const focused = props.focusedPaneId === node.id;
    if (!buffer) {
      return (
        <div
          className="editor-pane editor-pane--missing"
          data-testid={`editor-pane-${node.id}`}
        >
          Buffer unavailable
        </div>
      );
    }
    return (
      <EditorPane
        tabId={props.tabId}
        pane={node}
        buffer={buffer}
        rootPath={props.rootPath}
        focused={focused}
        showControls
        canClose={props.canClose}
        ciscoPlatform={buffer.cisco_platform}
        ciscoDiagnostics={focused ? props.ciscoDiagnostics : undefined}
        ciscoGuardrailStatus={focused ? props.ciscoGuardrailStatus : undefined}
        onCiscoLintResult={focused ? props.onCiscoLintResult : undefined}
        settings={props.settings}
        onFocus={() => props.onFocus(node.id)}
        onSplit={(direction) => props.onSplit(node.id, direction)}
        onDetach={() => props.onDetach(node.id)}
        onClose={() => props.onClose(node.id)}
        onReattach={() => props.onReattach(node.id)}
        onFocusWindow={() => {
          if (node.detachedWindowId) {
            props.onFocusWindow(node.id, node.detachedWindowId);
          }
        }}
        onChange={(content) => props.onChange(node.bufferId, content)}
        onCursorChange={(position) =>
          props.onCursorChange(node.id, position)
        }
        onScrollChange={(scrollTop) =>
          props.onScrollChange(node.id, scrollTop)
        }
        onSave={() => props.onSave(node.bufferId)}
        onEditorReady={(editor, monaco) =>
          props.onEditorReady(node.id, editor, monaco)
        }
        onOpenResource={(uri, position) =>
          props.onOpenResource(node.id, uri, position)
        }
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className={`editor-split editor-split--${node.direction}`}
      data-testid={`editor-split-${node.id}`}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          <div
            className="editor-split-child"
            style={{ flex: `${child.size} 1 0%` }}
          >
            <EditorSplitBranch {...props} node={child} />
          </div>
          {index < node.children.length - 1 && (
            <PaneHandle
              direction={node.direction}
              onResize={(delta) => resize(index, delta)}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

export function EditorSplitTree(props: EditorSplitTreeProps) {
  const leaves = getEditorPaneLeaves(props.node);
  const canClose = getAttachedEditorPanes(props.node).length > 1;

  return (
    <div
      className="editor-split-tree"
      data-testid="editor-split-tree"
      onKeyDown={(event) => {
        if (
          !event.altKey ||
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        ) {
          return;
        }
        event.preventDefault();
        const current = leaves.findIndex(
          (pane) => pane.id === props.focusedPaneId,
        );
        const forward =
          event.key === "ArrowRight" || event.key === "ArrowDown";
        const offset = forward ? 1 : -1;
        const next =
          leaves[(Math.max(0, current) + offset + leaves.length) % leaves.length];
        if (next) props.onFocus(next.id);
      }}
    >
      <EditorSplitBranch {...props} canClose={canClose} />
    </div>
  );
}

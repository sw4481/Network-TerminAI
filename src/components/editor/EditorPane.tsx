import type * as Monaco from "monaco-editor";
import type { CiscoDiagnostic, CiscoPlatform } from "../../lib/ciscoLint";
import type {
  CiscoGuardrailStatus,
  CiscoLintView,
} from "../../hooks/useCiscoLint";
import type { EditorBufferState } from "../../state/editorStore";
import type { EditorSettings } from "./MonacoEditor";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { MonacoEditor } from "./MonacoEditor";
import type {
  EditorPaneDirection,
  EditorPaneLeaf,
} from "./editorPaneLayout";

export type EditorPaneProps = {
  tabId: string;
  pane: EditorPaneLeaf;
  buffer: EditorBufferState;
  rootPath: string | null;
  focused: boolean;
  showControls: boolean;
  canClose: boolean;
  forceAttached?: boolean;
  ciscoPlatform?: CiscoPlatform | null;
  ciscoDiagnostics?: readonly CiscoDiagnostic[];
  ciscoGuardrailStatus?: CiscoGuardrailStatus;
  onCiscoLintResult?: (result: CiscoLintView) => void;
  settings: EditorSettings;
  onFocus: () => void;
  onSplit: (direction: EditorPaneDirection) => void;
  onDetach: () => void;
  onClose: () => void;
  onReattach: () => void;
  onFocusWindow: () => void;
  onChange: (content: string) => void;
  onCursorChange: (position: { line: number; column: number }) => void;
  onScrollChange: (scrollTop: number) => void;
  onSave: () => void;
  onEditorReady: (
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
  ) => void;
  onOpenResource?: (
    uri: string,
    position: { line: number; column: number },
  ) => boolean | Promise<boolean>;
};

export function EditorPane({
  tabId,
  pane,
  buffer,
  rootPath,
  focused,
  showControls,
  canClose,
  forceAttached = false,
  ciscoPlatform = null,
  ciscoDiagnostics,
  ciscoGuardrailStatus,
  onCiscoLintResult,
  settings,
  onFocus,
  onSplit,
  onDetach,
  onClose,
  onReattach,
  onFocusWindow,
  onChange,
  onCursorChange,
  onScrollChange,
  onSave,
  onEditorReady,
  onOpenResource,
}: EditorPaneProps) {
  const detached = pane.detachedWindowId !== null && !forceAttached;
  const fileName = buffer.file_path?.split("/").pop() ?? "Untitled";

  return (
    <section
      className={`editor-pane${focused ? " editor-pane--focused" : ""}`}
      data-testid={`editor-pane-${pane.id}`}
      data-pane-id={pane.id}
      data-focused={String(focused)}
      onMouseDown={onFocus}
      onFocusCapture={onFocus}
      tabIndex={-1}
      aria-label={`Editor pane ${fileName}`}
    >
      {showControls && (
        <header
          className="editor-pane-header"
          data-testid={`editor-pane-header-${pane.id}`}
        >
          <div className="editor-pane-title">
            <span>{fileName}</span>
            {buffer.is_dirty && (
              <span className="dirty-marker" aria-label="Unsaved changes">
                ●
              </span>
            )}
          </div>
          <div className="editor-pane-actions">
            <button
              type="button"
              aria-label="Split pane right"
              title="Split Right"
              onClick={() => onSplit("horizontal")}
              disabled={detached}
            >
              ⇥
            </button>
            <button
              type="button"
              aria-label="Split pane down"
              title="Split Down"
              onClick={() => onSplit("vertical")}
              disabled={detached}
            >
              ⇩
            </button>
            <button
              type="button"
              aria-label="Detach pane"
              title="Detach Pane"
              onClick={onDetach}
              disabled={detached}
            >
              ↗
            </button>
            <button
              type="button"
              aria-label="Close pane"
              title="Close Pane"
              onClick={onClose}
              disabled={!canClose || detached}
            >
              ×
            </button>
          </div>
        </header>
      )}

      {showControls && buffer.file_path && !detached && (
        <EditorBreadcrumbs
          filePath={buffer.file_path}
          rootPath={rootPath}
        />
      )}

      <div className="editor-pane-canvas">
        {detached ? (
          <div
            className="editor-pane-detached"
            data-testid={`editor-pane-detached-${pane.id}`}
          >
            <span>This pane is open in a detached window.</span>
            <div>
              <button
                type="button"
                aria-label="Focus detached window"
                onClick={onFocusWindow}
              >
                Focus window
              </button>
              <button
                type="button"
                aria-label="Bring pane back"
                onClick={onReattach}
              >
                Bring back
              </button>
            </div>
          </div>
        ) : (
          <MonacoEditor
            bufferId={buffer.id}
            value={buffer.content}
            language={buffer.language}
            onChange={onChange}
            onCursorChange={onCursorChange}
            onScrollChange={onScrollChange}
            onSave={onSave}
            settings={settings}
            tabId={tabId}
            filePath={buffer.file_path}
            workspaceRoot={rootPath}
            onOpenResource={onOpenResource}
            ciscoPlatform={ciscoPlatform}
            ciscoDiagnostics={ciscoDiagnostics}
            ciscoGuardrailStatus={ciscoGuardrailStatus}
            onCiscoLintResult={onCiscoLintResult}
            onEditorReady={(editor, monaco) => {
              editor.setPosition({
                lineNumber: Math.max(1, pane.cursor_position.line),
                column: Math.max(1, pane.cursor_position.column),
              });
              editor.setScrollTop(Math.max(0, pane.scroll_position));
              onEditorReady(editor, monaco);
            }}
          />
        )}
      </div>
    </section>
  );
}

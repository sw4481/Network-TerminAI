import type { EditorBufferState } from "../../state/editorStore";

type EditorBufferTabsProps = {
  buffers: EditorBufferState[];
  activeBufferId: string | null;
  onSelect: (bufferId: string) => void;
  onClose: (bufferId: string) => void;
};

function bufferLabel(buffer: EditorBufferState): string {
  if (!buffer.file_path) return "Untitled";
  return buffer.file_path.split(/[\\/]/).pop() || buffer.file_path;
}

export function confirmEditorBufferClose(
  buffer: EditorBufferState,
  confirmDiscard: (message: string) => boolean = window.confirm,
): boolean {
  if (!buffer.is_dirty) return true;
  return confirmDiscard(
    `Close "${bufferLabel(buffer)}" without saving your changes?`,
  );
}

export function EditorBufferTabs({
  buffers,
  activeBufferId,
  onSelect,
  onClose,
}: EditorBufferTabsProps) {
  if (buffers.length === 0) return null;

  return (
    <div className="editor-buffer-tabs" role="tablist" aria-label="Open files">
      {buffers.map((buffer) => {
        const label = bufferLabel(buffer);
        const active = buffer.id === activeBufferId;
        return (
          <div
            key={buffer.id}
            className={`editor-buffer-tab${active ? " active" : ""}`}
            role="presentation"
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={buffer.is_dirty ? `${label}, unsaved` : label}
              className="editor-buffer-tab-select"
              title={buffer.file_path ?? label}
              onClick={() => onSelect(buffer.id)}
            >
              <span>{label}</span>
              {buffer.is_dirty && (
                <span className="editor-buffer-tab-dirty" aria-hidden="true">
                  ●
                </span>
              )}
            </button>
            <button
              type="button"
              className="editor-buffer-tab-close"
              aria-label={`Close ${label}`}
              title={`Close ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(buffer.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

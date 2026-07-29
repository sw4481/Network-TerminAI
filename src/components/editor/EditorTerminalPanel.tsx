import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalSlot } from "../TerminalSlot";
import * as terminalRegistry from "../../lib/terminalRegistry";

export type EditorTerminalMode = "opencode" | "shell";

type EditorTerminalPanelProps = {
  tabId: string;
  cwd: string | null;
  /** Which session to show. `opencode` auto-launches the CLI; `shell` is a
   *  plain zsh session (run claude/codex/etc. by hand). */
  mode: EditorTerminalMode;
  onModeChange: (mode: EditorTerminalMode) => void;
  onClose: () => void;
};

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 280;

/**
 * A VSCode-style integrated terminal docked at the bottom of the editor.
 * Hosts two registry-backed PTYs — one auto-launching `opencode`, one a plain
 * shell — both keyed per editor tab so they survive mode switches and tab
 * changes. The panel is drag-resizable from its top edge.
 */
export function EditorTerminalPanel({
  tabId,
  cwd,
  mode,
  onModeChange,
  onClose,
}: EditorTerminalPanelProps) {
  const opencodeId = `editor-term-${tabId}`;
  const shellId = `editor-shell-${tabId}`;
  const opencodeLaunched = useRef(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);

  // Auto-run `opencode` once, when its PTY first goes live.
  const handleOpencodeReady = () => {
    if (opencodeLaunched.current) return;
    opencodeLaunched.current = true;
    terminalRegistry.runWhenReady(opencodeId, "opencode");
  };

  // Drag-to-resize from the top edge.
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const onDragMove = useCallback((e: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Dragging up (smaller clientY) grows the panel.
    const next = drag.startHeight + (drag.startY - e.clientY);
    setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, next)));
  }, []);
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }, [onDragMove]);
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: height };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  };
  useEffect(
    () => () => {
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
    },
    [onDragMove, onDragEnd],
  );

  return (
    <div
      className="editor-terminal-panel"
      style={{ height }}
      data-testid="editor-terminal-panel"
    >
      <div
        className="editor-terminal-resize-handle"
        onMouseDown={onDragStart}
        data-testid="editor-terminal-resize"
      />
      <div className="editor-terminal-header">
        <div className="editor-terminal-tabs">
          <button
            className={mode === "opencode" ? "active" : ""}
            onClick={() => onModeChange("opencode")}
            data-testid="editor-terminal-tab-opencode"
          >
            opencode
          </button>
          <button
            className={mode === "shell" ? "active" : ""}
            onClick={() => onModeChange("shell")}
            data-testid="editor-terminal-tab-shell"
          >
            terminal
          </button>
        </div>
        <button
          className="editor-terminal-close-btn"
          onClick={onClose}
          title="Close terminal panel"
          data-testid="editor-terminal-close"
        >
          ✕
        </button>
      </div>
      <div className="editor-terminal-slot-area">
        {/* Only the active slot is mounted. The registry keeps each PTY +
            xterm alive across unmount (detach keeps the entry), so switching
            modes preserves scrollback and any running process (opencode /
            claude / codex). Mounting only when visible also avoids xterm's
            blank-renderer bug when open() runs against a 0×0 (hidden) node. */}
        {mode === "opencode" ? (
          <TerminalSlot
            terminalId={opencodeId}
            shell="/bin/zsh"
            cwd={cwd ?? ""}
            skipTabRegistration
            onRegistered={handleOpencodeReady}
          />
        ) : (
          <TerminalSlot
            terminalId={shellId}
            shell="/bin/zsh"
            cwd={cwd ?? ""}
            skipTabRegistration
          />
        )}
      </div>
    </div>
  );
}

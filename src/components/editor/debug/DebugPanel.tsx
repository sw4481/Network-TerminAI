import { useCallback, useEffect, useRef, useState } from "react";
import type { DapStackFrame, DapVariable } from "../../../lib/tauri";
import type {
  DebugSessionController,
  DebugWatch,
} from "../../../hooks/useDebugSession";
import "./DebugPanel.css";

type DebugPanelProps = {
  controller: DebugSessionController;
  onClose: () => void;
  onFrameSelect: (frame: DapStackFrame) => void | Promise<void>;
};

const MIN_PANEL_HEIGHT = 190;
const MAX_PANEL_HEIGHT = 800;
const DEFAULT_PANEL_HEIGHT = 300;

function VariableNode({
  variable,
  loadVariables,
  depth = 0,
}: {
  variable: DapVariable;
  loadVariables: (reference: number) => Promise<DapVariable[]>;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DapVariable[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expandable = variable.variablesReference > 0;

  const toggle = async () => {
    if (!expandable) return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children) return;
    setLoading(true);
    setError(null);
    try {
      setChildren(await loadVariables(variable.variablesReference));
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <li className="debug-variable" style={{ paddingLeft: depth * 12 }}>
      <button
        type="button"
        className="debug-tree-toggle"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${variable.name}`}
        disabled={!expandable}
        onClick={() => void toggle()}
      >
        {expandable ? (expanded ? "▾" : "▸") : "·"}
      </button>
      <span className="debug-variable-name">{variable.name}</span>
      <span className="debug-variable-separator"> = </span>
      <span className="debug-variable-value">{variable.value}</span>
      {variable.type && (
        <span className="debug-variable-type"> {variable.type}</span>
      )}
      {expanded && (
        <>
          {loading && <span className="debug-muted"> loading…</span>}
          {error && <span className="debug-error"> {error}</span>}
          {children && (
            <ul>
              {children.map((child, index) => (
                <VariableNode
                  key={`${child.name}:${index}`}
                  variable={child}
                  loadVariables={loadVariables}
                  depth={depth + 1}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function WatchRow({
  watch,
  controller,
}: {
  watch: DebugWatch;
  controller: DebugSessionController;
}) {
  const syntheticVariable: DapVariable = {
    name: watch.expression,
    value: watch.error ?? watch.value ?? "not evaluated",
    type: watch.type ?? undefined,
    variablesReference: watch.variablesReference,
  };
  return (
    <div className="debug-watch-row">
      <ul>
        <VariableNode
          variable={syntheticVariable}
          loadVariables={controller.loadVariables}
        />
      </ul>
      <button
        type="button"
        aria-label={`Remove watch ${watch.expression}`}
        onClick={() => controller.removeWatch(watch.id)}
      >
        ×
      </button>
    </div>
  );
}

export function DebugPanel({
  controller,
  onClose,
  onFrameSelect,
}: DebugPanelProps) {
  const [watchExpression, setWatchExpression] = useState("");
  const [height, setHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const paused = controller.status === "paused";
  const running = controller.status === "running";
  const active =
    controller.status === "starting" || running || paused;

  const addWatch = async () => {
    const expression = watchExpression.trim();
    if (!expression) return;
    setWatchExpression("");
    await controller.addWatch(expression);
  };

  const onDragMove = useCallback((event: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = drag.startHeight + (drag.startY - event.clientY);
    setHeight(
      Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, next)),
    );
  }, []);
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }, [onDragMove]);
  useEffect(
    () => () => {
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
    },
    [onDragEnd, onDragMove],
  );

  return (
    <section
      className="debug-panel"
      style={{ height, flexBasis: height }}
      data-testid="debug-panel"
      aria-label="Python debugger"
    >
      <div
        className="debug-panel-resize-handle"
        data-testid="debug-panel-resize"
        onMouseDown={(event) => {
          event.preventDefault();
          dragRef.current = {
            startY: event.clientY,
            startHeight: height,
          };
          document.addEventListener("mousemove", onDragMove);
          document.addEventListener("mouseup", onDragEnd);
        }}
      />
      <header className="debug-panel-header">
        <div className="debug-panel-title">
          <strong>Python Debugger</strong>
          <span
            className={`debug-status debug-status--${controller.status}`}
            data-testid="debug-status"
          >
            {controller.status}
          </span>
          {controller.session && (
            <span className="debug-session-summary" title={controller.session.interpreter}>
              {controller.session.program.split("/").pop()} ·{" "}
              {controller.session.adapterName}
            </span>
          )}
        </div>
        <div className="debug-panel-controls">
          <button
            type="button"
            title="Continue (F5)"
            aria-label="Continue debugging"
            disabled={!paused}
            onClick={() => void controller.continueExecution()}
          >
            ▶
          </button>
          <button
            type="button"
            title="Pause"
            aria-label="Pause debugging"
            disabled={!running}
            onClick={() => void controller.pause()}
          >
            ⏸
          </button>
          <button
            type="button"
            title="Step Over (F10)"
            aria-label="Step over"
            disabled={!paused}
            onClick={() => void controller.stepOver()}
          >
            ↷
          </button>
          <button
            type="button"
            title="Step Into (F11)"
            aria-label="Step into"
            disabled={!paused}
            onClick={() => void controller.stepInto()}
          >
            ↓
          </button>
          <button
            type="button"
            title="Step Out (Shift+F11)"
            aria-label="Step out"
            disabled={!paused}
            onClick={() => void controller.stepOut()}
          >
            ↑
          </button>
          <button
            type="button"
            title="Restart (Cmd/Ctrl+Shift+F5)"
            aria-label="Restart debugging"
            disabled={
              controller.status === "idle" ||
              controller.status === "starting"
            }
            onClick={() => void controller.restart()}
          >
            ↻
          </button>
          <button
            type="button"
            title="Stop (Shift+F5)"
            aria-label="Stop debugging"
            disabled={!active}
            onClick={() => void controller.stop()}
          >
            ■
          </button>
          <button type="button" aria-label="Close debugger" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      {controller.error && (
        <div className="debug-panel-error" role="alert">
          {controller.error}
        </div>
      )}

      <div className="debug-panel-body">
        <div className="debug-panel-column debug-panel-navigation">
          <section>
            <h3>Threads</h3>
            {controller.threads.length === 0 ? (
              <p className="debug-empty">No paused threads</p>
            ) : (
              <ul className="debug-list">
                {controller.threads.map((thread) => (
                  <li key={thread.id}>
                    <button
                      type="button"
                      className={
                        controller.selectedThreadId === thread.id
                          ? "selected"
                          : ""
                      }
                      onClick={() => void controller.selectThread(thread.id)}
                    >
                      {thread.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>Call Stack</h3>
            {controller.frames.length === 0 ? (
              <p className="debug-empty">Pause to inspect the stack</p>
            ) : (
              <ul className="debug-list">
                {controller.frames.map((frame) => (
                  <li key={frame.id}>
                    <button
                      type="button"
                      className={
                        controller.selectedFrameId === frame.id
                          ? "selected"
                          : ""
                      }
                      title={frame.source?.path}
                      onClick={() => {
                        void controller.selectFrame(frame);
                        void onFrameSelect(frame);
                      }}
                    >
                      <span>{frame.name}</span>
                      <small>
                        {frame.source?.name ??
                          frame.source?.path?.split("/").pop() ??
                          "unknown"}
                        :{frame.line}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="debug-panel-column debug-panel-inspection">
          <section>
            <h3>Variables</h3>
            {controller.scopes.length === 0 ? (
              <p className="debug-empty">Pause to inspect variables</p>
            ) : (
              controller.scopes.map((scope) => (
                <details key={scope.name} open={!scope.expensive}>
                  <summary>{scope.name}</summary>
                  {scope.loading && <p className="debug-muted">Loading…</p>}
                  {scope.error && <p className="debug-error">{scope.error}</p>}
                  <ul>
                    {scope.variables.map((variable, index) => (
                      <VariableNode
                        key={`${variable.name}:${index}`}
                        variable={variable}
                        loadVariables={controller.loadVariables}
                      />
                    ))}
                  </ul>
                </details>
              ))
            )}
          </section>
          <section>
            <h3>Watch</h3>
            <form
              className="debug-watch-form"
              onSubmit={(event) => {
                event.preventDefault();
                void addWatch();
              }}
            >
              <input
                aria-label="Watch expression"
                value={watchExpression}
                onChange={(event) => setWatchExpression(event.target.value)}
                placeholder="expression"
              />
              <button type="submit" disabled={!watchExpression.trim()}>
                Add
              </button>
            </form>
            {controller.watches.map((watch) => (
              <WatchRow
                key={watch.id}
                watch={watch}
                controller={controller}
              />
            ))}
          </section>
        </div>

        <div className="debug-panel-column debug-panel-console">
          <div className="debug-console-heading">
            <h3>Debug Console</h3>
            <button
              type="button"
              disabled={controller.output.length === 0}
              onClick={controller.clearOutput}
            >
              Clear
            </button>
          </div>
          <pre aria-label="Debug output">
            {controller.output.length === 0
              ? "Program output will appear here."
              : controller.output.map((entry, index) => (
                  <span
                    key={`${entry.category}:${index}`}
                    className={`debug-output debug-output--${entry.category}`}
                  >
                    {entry.output}
                  </span>
                ))}
          </pre>
        </div>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { ResolvedCoachStep } from "./coachMarkAnchors";
import "./EditorCoachMarks.css";

interface EditorCoachMarksProps {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  steps: ResolvedCoachStep[];
  index: number;
  onNext: () => void;
  onBack: () => void;
  onDismiss: () => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Screen rect (viewport coordinates) for a line range in the editor. Returns
 * null when the editor DOM isn't laid out yet. The overlay is position:fixed,
 * so getBoundingClientRect values are used directly.
 */
function rectForLines(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  startLine: number,
  endLine: number,
): Rect | null {
  const dom = editor.getDomNode();
  if (!dom) return null;
  const editorRect = dom.getBoundingClientRect();
  if (editorRect.width === 0 && editorRect.height === 0) return null;

  const scrollTop = editor.getScrollTop();
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  const topInEditor = editor.getTopForLineNumber(startLine) - scrollTop;
  const bottomInEditor =
    editor.getTopForLineNumber(endLine) - scrollTop + lineHeight;

  return {
    top: editorRect.top + topInEditor,
    left: editorRect.left,
    width: editorRect.width,
    height: Math.max(lineHeight, bottomInEditor - topInEditor),
  };
}

/**
 * Interactive coach-marks overlaid on the Monaco editor. Spotlights the line
 * range for the active step (scrim with a bright cutout) and floats a callout
 * bubble beside it. Self-contained: receives the live editor/monaco refs as
 * props and never imports Monaco itself, so it stays decoupled from the editor
 * wrapper.
 */
export function EditorCoachMarks({
  editor,
  monaco,
  steps,
  index,
  onNext,
  onBack,
  onDismiss,
}: EditorCoachMarksProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  const step = steps[index];

  const recompute = useCallback(() => {
    if (!step) return;
    setRect(rectForLines(editor, monaco, step.startLine, step.endLine));
  }, [editor, monaco, step]);

  // Reveal the target line, then measure on the next frame so the reveal's
  // scroll has settled before we position the spotlight.
  useLayoutEffect(() => {
    if (!step) return;
    editor.revealLineInCenterIfOutsideViewport(step.startLine);
    const raf = requestAnimationFrame(recompute);
    return () => cancelAnimationFrame(raf);
  }, [editor, step, recompute]);

  // Keep the spotlight glued to the code while the user scrolls or the layout
  // changes (window resize, panel toggles).
  useEffect(() => {
    const disposables = [
      editor.onDidScrollChange(recompute),
      editor.onDidLayoutChange(recompute),
    ];
    window.addEventListener("resize", recompute);
    return () => {
      disposables.forEach((d) => d.dispose());
      window.removeEventListener("resize", recompute);
    };
  }, [editor, recompute]);

  // Keyboard: →/Enter = next, ← = back, Esc = dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        onBack();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onNext, onBack, onDismiss]);

  if (!step) return null;

  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  // Position the bubble below the highlight when there's room, else above.
  let bubbleStyle: React.CSSProperties = { visibility: "hidden" };
  if (rect) {
    const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
    const spaceBelow = viewportH - (rect.top + rect.height);
    const below = spaceBelow > 180;
    bubbleStyle = below
      ? { top: rect.top + rect.height + 12, left: rect.left + 24 }
      : { bottom: viewportH - rect.top + 12, left: rect.left + 24 };
  }

  return (
    <div className="coach-overlay" data-testid="coach-mark">
      {rect && (
        <div
          className="coach-spotlight"
          data-testid="coach-spotlight"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
        />
      )}
      <div className="coach-bubble" style={bubbleStyle} data-testid="coach-bubble">
        <div className="coach-bubble-step">
          Step {index + 1} of {steps.length}
        </div>
        <div className="coach-bubble-title">{step.title}</div>
        <div className="coach-bubble-body">{step.body}</div>
        <div className="coach-bubble-actions">
          <button
            className="coach-btn coach-btn-dismiss"
            onClick={onDismiss}
            data-testid="coach-dismiss"
          >
            Dismiss
          </button>
          <div className="coach-bubble-nav">
            {!isFirst && (
              <button
                className="coach-btn coach-btn-back"
                onClick={onBack}
                data-testid="coach-back"
              >
                Back
              </button>
            )}
            <button
              className="coach-btn coach-btn-next"
              onClick={onNext}
              data-testid="coach-next"
            >
              {isLast ? "Got it" : "Next ▸"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

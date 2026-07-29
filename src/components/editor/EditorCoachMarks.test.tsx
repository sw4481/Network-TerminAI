import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import { EditorCoachMarks } from "./EditorCoachMarks";
import type { ResolvedCoachStep } from "./coachMarkAnchors";

const LINE_HEIGHT = 18;

/** Minimal editor stub exposing only the members EditorCoachMarks touches. */
function makeEditor(scrollTop = 0) {
  const scrollHandlers: Array<() => void> = [];
  const layoutHandlers: Array<() => void> = [];
  const dom = document.createElement("div");
  dom.getBoundingClientRect = () =>
    ({ top: 100, left: 50, width: 800, height: 600, right: 850, bottom: 700, x: 50, y: 100, toJSON: () => ({}) }) as DOMRect;
  const editor = {
    getDomNode: () => dom,
    getScrollTop: () => scrollTop,
    getTopForLineNumber: (line: number) => (line - 1) * LINE_HEIGHT,
    getOption: () => LINE_HEIGHT,
    revealLineInCenterIfOutsideViewport: vi.fn(),
    onDidScrollChange: (cb: () => void) => {
      scrollHandlers.push(cb);
      return { dispose: vi.fn() };
    },
    onDidLayoutChange: (cb: () => void) => {
      layoutHandlers.push(cb);
      return { dispose: vi.fn() };
    },
    _fireScroll: () => scrollHandlers.forEach((h) => h()),
  };
  return editor as unknown as Monaco.editor.IStandaloneCodeEditor & { _fireScroll: () => void };
}

const monaco = {
  editor: { EditorOption: { lineHeight: 0 } },
} as unknown as typeof Monaco;

const STEPS: ResolvedCoachStep[] = [
  { section: "triggers", startLine: 3, endLine: 6, title: "The trigger", body: "trigger copy" },
  { section: "plan", startLine: 10, endLine: 12, title: "Plan", body: "plan copy" },
  { section: "apply", startLine: 15, endLine: 18, title: "Apply", body: "apply copy" },
];

describe("EditorCoachMarks", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("positions the spotlight from the line number and scroll offset", async () => {
    const editor = makeEditor(0);
    render(
      <EditorCoachMarks
        editor={editor}
        monaco={monaco}
        steps={STEPS}
        index={0}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    // rAF-driven measure needs a frame to run.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const spotlight = screen.getByTestId("coach-spotlight");
    // top = editorRect.top(100) + (startLine-1)*lh - scrollTop = 100 + 2*18 = 136
    expect(spotlight.style.top).toBe("136px");
    expect(spotlight.style.left).toBe("50px");
    // height spans lines 3..6: (endLine-startLine)*lh + lh = 3*18 + 18 = 72
    expect(spotlight.style.height).toBe("72px");
  });

  it("shifts the spotlight when the editor is scrolled", async () => {
    const editor = makeEditor(36); // scrolled down two lines
    render(
      <EditorCoachMarks
        editor={editor}
        monaco={monaco}
        steps={STEPS}
        index={0}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const spotlight = screen.getByTestId("coach-spotlight");
    // top = 100 + 2*18 - 36 = 100
    expect(spotlight.style.top).toBe("100px");
  });

  it("renders the step copy and progress counter", async () => {
    const editor = makeEditor();
    render(
      <EditorCoachMarks
        editor={editor}
        monaco={monaco}
        steps={STEPS}
        index={1}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("plan copy")).toBeTruthy();
  });

  it("hides the Back button on the first step and shows 'Got it' on the last", () => {
    const editor = makeEditor();
    const { rerender } = render(
      <EditorCoachMarks editor={editor} monaco={monaco} steps={STEPS} index={0}
        onNext={vi.fn()} onBack={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByTestId("coach-back")).toBeNull();
    expect(screen.getByTestId("coach-next").textContent).toMatch(/Next/);

    rerender(
      <EditorCoachMarks editor={editor} monaco={monaco} steps={STEPS} index={2}
        onNext={vi.fn()} onBack={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByTestId("coach-back")).toBeTruthy();
    expect(screen.getByTestId("coach-next").textContent).toMatch(/Got it/);
  });

  it("fires callbacks on button clicks and keyboard", () => {
    const editor = makeEditor();
    const onNext = vi.fn();
    const onBack = vi.fn();
    const onDismiss = vi.fn();
    render(
      <EditorCoachMarks editor={editor} monaco={monaco} steps={STEPS} index={1}
        onNext={onNext} onBack={onBack} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByTestId("coach-next"));
    expect(onNext).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("coach-back"));
    expect(onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("coach-dismiss"));
    expect(onDismiss).toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(onBack).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("recomputes on editor scroll events", async () => {
    const editor = makeEditor(0);
    render(
      <EditorCoachMarks editor={editor} monaco={monaco} steps={STEPS} index={0}
        onNext={vi.fn()} onBack={vi.fn()} onDismiss={vi.fn()} />,
    );
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    // No throw when a scroll event fires → recompute path is wired.
    act(() => editor._fireScroll());
    expect(screen.getByTestId("coach-spotlight")).toBeTruthy();
  });
});

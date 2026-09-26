import { render, renderHook } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("monaco-vim", () => ({
  initVimMode: mocks.init,
}));

import { useVimMode } from "./useVimMode";

describe("useVimMode", () => {
  beforeEach(() => {
    mocks.init.mockReset();
    mocks.dispose.mockReset();
    mocks.init.mockReturnValue({ dispose: mocks.dispose });
  });

  it("attaches once when enabled and disposes when disabled", () => {
    const editor = {} as Monaco.editor.IStandaloneCodeEditor;
    const status = document.createElement("span");
    const statusRef = { current: status };
    const view = renderHook(
      ({ enabled }) => useVimMode(editor, statusRef, enabled),
      { initialProps: { enabled: false } },
    );
    expect(mocks.init).not.toHaveBeenCalled();

    view.rerender({ enabled: true });
    view.rerender({ enabled: true });
    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.init).toHaveBeenCalledWith(editor, status);

    status.textContent = "-- NORMAL --";
    view.rerender({ enabled: false });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(status).toHaveTextContent("");

    view.unmount();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("disposes an active Vim handle on unmount", () => {
    const editor = {} as Monaco.editor.IStandaloneCodeEditor;
    const status = document.createElement("span");
    const statusRef = { current: status };
    const view = renderHook(() => useVimMode(editor, statusRef, true));

    status.textContent = "-- INSERT --";
    view.unmount();

    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(status).toHaveTextContent("");
  });

  it("disposes the previous handle before attaching to a changed editor", () => {
    const firstEditor = {} as Monaco.editor.IStandaloneCodeEditor;
    const secondEditor = {} as Monaco.editor.IStandaloneCodeEditor;
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    mocks.init
      .mockReturnValueOnce({ dispose: firstDispose })
      .mockReturnValueOnce({ dispose: secondDispose });
    const status = document.createElement("span");
    const statusRef = { current: status };
    const view = renderHook(
      ({ editor }) => useVimMode(editor, statusRef, true),
      { initialProps: { editor: firstEditor } },
    );

    status.textContent = "-- NORMAL --";
    view.rerender({ editor: secondEditor });

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(mocks.init).toHaveBeenCalledTimes(2);
    expect(mocks.init).toHaveBeenNthCalledWith(2, secondEditor, status);
    expect(status).toHaveTextContent("");

    status.textContent = "-- VISUAL --";
    view.unmount();
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(status).toHaveTextContent("");
  });

  it("detaches before a later editor cleanup on editor replacement", () => {
    const events: string[] = [];
    const firstEditor = {} as Monaco.editor.IStandaloneCodeEditor;
    const secondEditor = {} as Monaco.editor.IStandaloneCodeEditor;
    mocks.init.mockReturnValue({
      dispose: () => events.push("vim"),
    });
    const statusRef = { current: document.createElement("span") };
    const view = renderHook(
      ({ editor }) => {
        useVimMode(editor, statusRef, true);
        useEffect(
          () => () => {
            events.push("editor");
          },
          [editor],
        );
      },
      { initialProps: { editor: firstEditor } },
    );

    view.rerender({ editor: secondEditor });

    expect(events.slice(0, 2)).toEqual(["vim", "editor"]);
  });

  it("does not attach without both an editor and a status element", () => {
    const editor = {} as Monaco.editor.IStandaloneCodeEditor;
    const statusRef = { current: null as HTMLElement | null };
    const view = renderHook(
      ({ currentEditor }) => useVimMode(currentEditor, statusRef, true),
      {
        initialProps: {
          currentEditor: null as Monaco.editor.IStandaloneCodeEditor | null,
        },
      },
    );

    view.rerender({ currentEditor: editor });

    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("reattaches when the status element changes under the same ref", () => {
    const editor = {} as Monaco.editor.IStandaloneCodeEditor;
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    mocks.init
      .mockReturnValueOnce({ dispose: firstDispose })
      .mockReturnValueOnce({ dispose: secondDispose });

    function Harness({ statusKey }: { statusKey: string }) {
      const statusRef = useRef<HTMLSpanElement | null>(null);
      useVimMode(editor, statusRef, true);
      return <span key={statusKey} ref={statusRef} data-testid="vim-status" />;
    }

    const view = render(<Harness statusKey="first" />);
    view.rerender(<Harness statusKey="first" />);
    const firstStatus = view.getByTestId("vim-status");
    expect(mocks.init).toHaveBeenCalledOnce();

    firstStatus.textContent = "-- NORMAL --";
    view.rerender(<Harness statusKey="second" />);
    const secondStatus = view.getByTestId("vim-status");

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(firstStatus).toHaveTextContent("");
    expect(mocks.init).toHaveBeenCalledTimes(2);
    expect(mocks.init).toHaveBeenNthCalledWith(2, editor, secondStatus);
    expect(secondDispose).not.toHaveBeenCalled();

    view.unmount();
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
  });
});

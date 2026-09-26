import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { acquireLspDocument } from "./lspDocumentSync";

function fixture() {
  let value = "value = 1\n";
  let change: (() => void) | null = null;
  let disposed = false;
  const listener = { dispose: vi.fn() };
  const model = {
    uri: { toString: () => "file:///repo/main.py" },
    getValue: vi.fn(() => {
      if (disposed) throw new Error("Model is disposed!");
      return value;
    }),
    isDisposed: () => disposed,
    onDidChangeContent: vi.fn((callback: () => void) => {
      change = callback;
      return listener;
    }),
  } as unknown as Monaco.editor.ITextModel;
  const monaco = {} as typeof Monaco;
  const transport = {
    clientId: "pane-1",
    openDocument: vi.fn().mockResolvedValue(undefined),
    changeDocument: vi.fn().mockResolvedValue(undefined),
    closeDocument: vi.fn().mockResolvedValue(undefined),
  };
  return {
    monaco,
    model,
    transport,
    listener,
    setValue(next: string) {
      value = next;
      change?.();
    },
    disposeModel() {
      disposed = true;
    },
  };
}

describe("LSP document synchronization", () => {
  it("opens once per owner, debounces changes, and closes on final release", async () => {
    vi.useFakeTimers();
    const item = fixture();
    const first = acquireLspDocument({
      monaco: item.monaco,
      model: item.model,
      sessionKey: "python:/repo",
      languageId: "python",
      transport: item.transport,
      debounceMs: 50,
    });
    const second = acquireLspDocument({
      monaco: item.monaco,
      model: item.model,
      sessionKey: "python:/repo",
      languageId: "python",
      transport: item.transport,
      debounceMs: 50,
    });

    await first.ready;
    expect(item.transport.openDocument).toHaveBeenCalledOnce();
    item.setValue("value = 2\n");
    await vi.advanceTimersByTimeAsync(50);
    expect(item.transport.changeDocument).toHaveBeenCalledWith(
      "file:///repo/main.py",
      "value = 2\n",
    );

    first.dispose();
    expect(item.transport.closeDocument).not.toHaveBeenCalled();
    second.dispose();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(item.listener.dispose).toHaveBeenCalledOnce();
    expect(item.transport.closeDocument).toHaveBeenCalledWith(
      "file:///repo/main.py",
    );
    vi.useRealTimers();
  });

  it("keeps separate backend owners while sharing one Monaco listener", async () => {
    const item = fixture();
    const other = {
      ...item.transport,
      clientId: "pane-2",
      openDocument: vi.fn().mockResolvedValue(undefined),
      closeDocument: vi.fn().mockResolvedValue(undefined),
    };
    const first = acquireLspDocument({
      monaco: item.monaco,
      model: item.model,
      sessionKey: "python:/repo",
      languageId: "python",
      transport: item.transport,
    });
    const second = acquireLspDocument({
      monaco: item.monaco,
      model: item.model,
      sessionKey: "python:/repo",
      languageId: "python",
      transport: other,
    });

    await Promise.all([first.ready, second.ready]);
    expect(item.model.onDidChangeContent).toHaveBeenCalledOnce();
    expect(item.transport.openDocument).toHaveBeenCalledOnce();
    expect(other.openDocument).toHaveBeenCalledOnce();
    first.dispose();
    await Promise.resolve();
    expect(item.listener.dispose).not.toHaveBeenCalled();
    second.dispose();
  });

  it("releases a document safely when Monaco disposed the model first", async () => {
    const item = fixture();
    const lease = acquireLspDocument({
      monaco: item.monaco,
      model: item.model,
      sessionKey: "python:/repo",
      languageId: "python",
      transport: item.transport,
    });
    await lease.ready;

    item.disposeModel();

    expect(() => lease.dispose()).not.toThrow();
    await vi.waitFor(() =>
      expect(item.transport.closeDocument).toHaveBeenCalledWith(
        "file:///repo/main.py",
      ),
    );
    expect(item.listener.dispose).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  MonacoModelRegistry,
  MonacoPaneModelController,
} from "./monacoModelRegistry";

function fakeMonaco() {
  const models = new Map<string, ReturnType<typeof createModel>>();

  function createModel(value: string, language: string, uri: { toString(): string }) {
    let content = value;
    let languageId = language;
    const model = {
      uri,
      dispose: vi.fn(() => models.delete(uri.toString())),
      getValue: vi.fn(() => content),
      getLanguageId: vi.fn(() => languageId),
      getFullModelRange: vi.fn(() => ({ start: 1, end: content.length })),
      pushEditOperations: vi.fn(
        (
          _selections: unknown[],
          edits: Array<{ text: string }>,
          _cursorStateComputer: unknown,
        ) => {
          content = edits[0].text;
          return null;
        },
      ),
      setLanguage(value: string) {
        languageId = value;
      },
    };
    models.set(uri.toString(), model);
    return model;
  }

  const monaco = {
    Uri: {
      file(value: string) {
        const normalized = value.replace(/\\/g, "/");
        return {
          toString: () =>
            normalized.startsWith("/")
              ? `file://${normalized}`
              : `file:///${normalized}`,
        };
      },
      parse(value: string) {
        return { toString: () => value };
      },
    },
    editor: {
      createModel: vi.fn(createModel),
      getModel: vi.fn((uri: { toString(): string }) =>
        models.get(uri.toString()) ?? null
      ),
      setModelLanguage: vi.fn(
        (model: ReturnType<typeof createModel>, language: string) =>
          model.setLanguage(language),
      ),
    },
  };

  return {
    monaco: monaco as unknown as typeof Monaco,
    createModel: monaco.editor.createModel,
    setModelLanguage: monaco.editor.setModelLanguage,
  };
}

describe("MonacoModelRegistry", () => {
  it("reuses one model per buffer and reference-counts releases", () => {
    const fake = fakeMonaco();
    const registry = new MonacoModelRegistry(fake.monaco);

    const first = registry.acquire("file:/repo/a.ts", "const a = 1;", "typescript");
    const second = registry.acquire("file:/repo/a.ts", "ignored", "typescript");

    expect(second.model).toBe(first.model);
    expect(fake.createModel).toHaveBeenCalledOnce();
    expect(registry.referenceCount("file:/repo/a.ts")).toBe(2);

    first.release();
    first.release();
    expect(registry.referenceCount("file:/repo/a.ts")).toBe(1);
    expect(first.model.dispose).not.toHaveBeenCalled();

    second.release();
    expect(registry.referenceCount("file:/repo/a.ts")).toBe(0);
    expect(first.model.dispose).toHaveBeenCalledOnce();
  });

  it("uses real file URIs for file buffers and stable distinct models", () => {
    const fake = fakeMonaco();
    const registry = new MonacoModelRegistry(fake.monaco);

    const first = registry.acquire("file:/repo/a.ts", "a", "typescript");
    const second = registry.acquire("file:/repo/b.ts", "b", "typescript");

    expect(first.model).not.toBe(second.model);
    expect(first.model.uri.toString()).toBe("file:///repo/a.ts");
    expect(second.model.uri.toString()).toBe("file:///repo/b.ts");
  });

  it("updates language on reuse without replacing the shared model", () => {
    const fake = fakeMonaco();
    const registry = new MonacoModelRegistry(fake.monaco);
    const first = registry.acquire("untitled:1", "{}", "plaintext");

    const second = registry.acquire("untitled:1", "{}", "json");

    expect(second.model).toBe(first.model);
    expect(fake.setModelLanguage).toHaveBeenCalledWith(first.model, "json");
  });

  it("applies changed snapshots with a guarded full-range edit", () => {
    const fake = fakeMonaco();
    const registry = new MonacoModelRegistry(fake.monaco);
    const lease = registry.acquire("file:/repo/a.ts", "old", "typescript");

    expect(registry.applyContent("file:/repo/a.ts", "old")).toBe(false);
    expect(registry.applyContent("file:/repo/a.ts", "new")).toBe(true);
    expect(lease.model.pushEditOperations).toHaveBeenCalledOnce();
    expect(lease.model.getValue()).toBe("new");
  });
});

describe("MonacoPaneModelController", () => {
  it("saves and restores view state independently while switching models", () => {
    const viewA = { cursor: "a" };
    const viewB = { cursor: "b" };
    const modelA = { id: "a" } as unknown as Monaco.editor.ITextModel;
    const modelB = { id: "b" } as unknown as Monaco.editor.ITextModel;
    const editor = {
      saveViewState: vi.fn()
        .mockReturnValueOnce(viewA)
        .mockReturnValueOnce(viewB),
      restoreViewState: vi.fn(),
      setModel: vi.fn(),
    } as unknown as Monaco.editor.IStandaloneCodeEditor;
    const controller = new MonacoPaneModelController(
      editor,
      "buffer-a",
    );

    controller.switchTo("buffer-b", modelB);
    controller.switchTo("buffer-a", modelA);

    expect(editor.setModel).toHaveBeenNthCalledWith(1, modelB);
    expect(editor.setModel).toHaveBeenNthCalledWith(2, modelA);
    expect(editor.restoreViewState).toHaveBeenCalledOnce();
    expect(editor.restoreViewState).toHaveBeenCalledWith(viewA);
  });
});

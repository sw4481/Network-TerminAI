import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  lspLocationsToMonaco,
  lspRangeToMonaco,
  registerDefinitionProvider,
  registerReferenceProvider,
} from "./NavigationProviders";

function fakeMonaco() {
  let definitionProvider: Monaco.languages.DefinitionProvider | null = null;
  let referenceProvider: Monaco.languages.ReferenceProvider | null = null;
  const monaco = {
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
    },
    languages: {
      registerDefinitionProvider: vi.fn(
        (_language: string, provider: Monaco.languages.DefinitionProvider) => {
          definitionProvider = provider;
          return { dispose: vi.fn() };
        },
      ),
      registerReferenceProvider: vi.fn(
        (_language: string, provider: Monaco.languages.ReferenceProvider) => {
          referenceProvider = provider;
          return { dispose: vi.fn() };
        },
      ),
    },
  } as unknown as typeof Monaco;
  return {
    monaco,
    definition: () => definitionProvider!,
    references: () => referenceProvider!,
  };
}

const range = {
  start: { line: 2, character: 4 },
  end: { line: 3, character: 8 },
};

describe("LSP navigation providers", () => {
  it("converts zero-based LSP ranges and location links", () => {
    expect(lspRangeToMonaco(range)).toEqual({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 4,
      endColumn: 9,
    });
    const fake = fakeMonaco();
    expect(
      lspLocationsToMonaco(fake.monaco, [
        {
          targetUri: "file:///repo/target.py",
          targetRange: range,
          targetSelectionRange: range,
        },
      ]),
    ).toEqual([
      {
        uri: expect.objectContaining({ toString: expect.any(Function) }),
        range: {
          startLineNumber: 3,
          startColumn: 5,
          endLineNumber: 4,
          endColumn: 9,
        },
      },
    ]);
  });

  it("requests definitions only for the active model", async () => {
    const fake = fakeMonaco();
    const sendRequest = vi.fn().mockResolvedValue([
      { uri: "file:///repo/target.py", range },
    ]);
    const activeModel = {
      uri: { toString: () => "file:///repo/main.py" },
    } as Monaco.editor.ITextModel;
    registerDefinitionProvider(
      fake.monaco,
      "python",
      sendRequest,
      (model) => model === activeModel,
    );
    const token = { isCancellationRequested: false } as Monaco.CancellationToken;

    expect(
      await fake.definition().provideDefinition(
        {} as Monaco.editor.ITextModel,
        { lineNumber: 1, column: 1 } as Monaco.Position,
        token,
      ),
    ).toBeNull();
    await fake.definition().provideDefinition(
      activeModel,
      { lineNumber: 5, column: 3 } as Monaco.Position,
      token,
    );
    expect(sendRequest).toHaveBeenCalledWith("textDocument/definition", {
      textDocument: { uri: "file:///repo/main.py" },
      position: { line: 4, character: 2 },
    });
  });

  it("passes includeDeclaration through reference requests", async () => {
    const fake = fakeMonaco();
    const sendRequest = vi.fn().mockResolvedValue([
      { uri: "file:///repo/main.py", range },
    ]);
    const model = {
      uri: { toString: () => "file:///repo/main.py" },
    } as Monaco.editor.ITextModel;
    registerReferenceProvider(fake.monaco, "python", sendRequest);

    await fake.references().provideReferences(
      model,
      { lineNumber: 1, column: 2 } as Monaco.Position,
      { includeDeclaration: true },
      { isCancellationRequested: false } as Monaco.CancellationToken,
    );
    expect(sendRequest).toHaveBeenCalledWith("textDocument/references", {
      textDocument: { uri: "file:///repo/main.py" },
      position: { line: 0, character: 1 },
      context: { includeDeclaration: true },
    });
  });
});

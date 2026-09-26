import type * as Monaco from "monaco-editor";

type SendRequest = <T = unknown>(
  method: string,
  params: unknown,
) => Promise<T | null>;

type LspCompletionItem = {
  label: string;
  kind?: number;
  insertText?: string;
  detail?: string;
  documentation?: string | { kind: string; value: string };
};

type LspCompletionResult =
  | LspCompletionItem[]
  | { items: LspCompletionItem[]; isIncomplete?: boolean }
  | null;

export function registerCompletionProvider(
  monaco: typeof Monaco,
  language: string,
  sendRequest: SendRequest,
  acceptModel: (model: Monaco.editor.ITextModel) => boolean = () => true,
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: [".", ":", "/", "@", " "],
    async provideCompletionItems(model, position, _context, token) {
      if (!acceptModel(model) || token.isCancellationRequested) {
        return { suggestions: [] };
      }
      const result = await sendRequest<LspCompletionResult>(
        "textDocument/completion",
        {
          textDocument: { uri: model.uri.toString() },
          position: {
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
        },
      );

      if (!result || token.isCancellationRequested) return { suggestions: [] };

      const items = Array.isArray(result) ? result : result.items ?? [];

      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };

      const suggestions: Monaco.languages.CompletionItem[] = items.map(
        (item) => ({
          label: item.label,
          kind: mapCompletionKind(monaco, item.kind),
          insertText: item.insertText ?? item.label,
          detail: item.detail,
          documentation:
            typeof item.documentation === "string"
              ? item.documentation
              : item.documentation?.value,
          range,
        }),
      );

      return { suggestions };
    },
  });
}

function mapCompletionKind(
  monaco: typeof Monaco,
  lspKind: number | undefined,
): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (lspKind) {
    case 1: return K.Text;
    case 2: return K.Method;
    case 3: return K.Function;
    case 4: return K.Constructor;
    case 5: return K.Field;
    case 6: return K.Variable;
    case 7: return K.Class;
    case 8: return K.Interface;
    case 9: return K.Module;
    case 10: return K.Property;
    case 11: return K.Unit;
    case 12: return K.Value;
    case 13: return K.Enum;
    case 14: return K.Keyword;
    case 15: return K.Snippet;
    case 16: return K.Color;
    case 17: return K.File;
    case 18: return K.Reference;
    case 19: return K.Folder;
    case 20: return K.EnumMember;
    case 21: return K.Constant;
    case 22: return K.Struct;
    case 23: return K.Event;
    case 24: return K.Operator;
    case 25: return K.TypeParameter;
    default: return K.Text;
  }
}

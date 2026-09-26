import type * as Monaco from "monaco-editor";

type SendRequest = <T = unknown>(
  method: string,
  params: unknown,
) => Promise<T | null>;

type MarkedString = string | { language?: string; value: string; kind?: string };

type LspHoverResult = {
  contents: MarkedString | MarkedString[];
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
} | null;

export function registerHoverProvider(
  monaco: typeof Monaco,
  language: string,
  sendRequest: SendRequest,
  acceptModel: (model: Monaco.editor.ITextModel) => boolean = () => true,
): Monaco.IDisposable {
  return monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position, token) {
      if (!acceptModel(model) || token.isCancellationRequested) return null;
      const result = await sendRequest<LspHoverResult>("textDocument/hover", {
        textDocument: { uri: model.uri.toString() },
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1,
        },
      });

      if (!result || !result.contents || token.isCancellationRequested) {
        return null;
      }

      const raw = Array.isArray(result.contents)
        ? result.contents
        : [result.contents];

      const contents: Monaco.IMarkdownString[] = raw
        .map((c) => toMarkdown(c))
        .filter((m): m is Monaco.IMarkdownString => m !== null);

      if (contents.length === 0) return null;

      return {
        contents,
        range: result.range
          ? {
              startLineNumber: result.range.start.line + 1,
              startColumn: result.range.start.character + 1,
              endLineNumber: result.range.end.line + 1,
              endColumn: result.range.end.character + 1,
            }
          : undefined,
      };
    },
  });
}

function toMarkdown(c: MarkedString): Monaco.IMarkdownString | null {
  if (typeof c === "string") {
    return c ? { value: c } : null;
  }
  if (c.language && c.value) {
    return { value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` };
  }
  if (c.value) return { value: c.value };
  return null;
}

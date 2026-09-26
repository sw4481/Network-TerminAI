import type * as Monaco from "monaco-editor";

type SendRequest = <T = unknown>(
  method: string,
  params: unknown,
) => Promise<T | null>;

type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

type LspLocation = {
  uri: string;
  range: LspRange;
};

type LspLocationLink = {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
};

type LspDefinitionResult =
  | LspLocation
  | LspLocation[]
  | LspLocationLink[]
  | null;

export function lspRangeToMonaco(range: LspRange): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function isLocationLink(
  location: LspLocation | LspLocationLink,
): location is LspLocationLink {
  return "targetUri" in location;
}

export function lspLocationsToMonaco(
  monaco: typeof Monaco,
  result: LspDefinitionResult,
): Monaco.languages.Location[] {
  if (!result) return [];
  const locations = Array.isArray(result) ? result : [result];
  return locations.flatMap((location) => {
    const uri = isLocationLink(location) ? location.targetUri : location.uri;
    const range = isLocationLink(location)
      ? (location.targetSelectionRange ?? location.targetRange)
      : location.range;
    if (!uri || !range) return [];
    try {
      return [{ uri: monaco.Uri.parse(uri), range: lspRangeToMonaco(range) }];
    } catch {
      return [];
    }
  });
}

function textDocumentPosition(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
) {
  return {
    textDocument: { uri: model.uri.toString() },
    position: {
      line: position.lineNumber - 1,
      character: position.column - 1,
    },
  };
}

export function registerDefinitionProvider(
  monaco: typeof Monaco,
  language: string,
  sendRequest: SendRequest,
  acceptModel: (model: Monaco.editor.ITextModel) => boolean = () => true,
): Monaco.IDisposable {
  return monaco.languages.registerDefinitionProvider(language, {
    async provideDefinition(model, position, token) {
      if (!acceptModel(model) || token.isCancellationRequested) return null;
      const result = await sendRequest<LspDefinitionResult>(
        "textDocument/definition",
        textDocumentPosition(model, position),
      );
      if (token.isCancellationRequested) return null;
      const locations = lspLocationsToMonaco(monaco, result);
      return locations.length > 0 ? locations : null;
    },
  });
}

export function registerReferenceProvider(
  monaco: typeof Monaco,
  language: string,
  sendRequest: SendRequest,
  acceptModel: (model: Monaco.editor.ITextModel) => boolean = () => true,
): Monaco.IDisposable {
  return monaco.languages.registerReferenceProvider(language, {
    async provideReferences(model, position, context, token) {
      if (!acceptModel(model) || token.isCancellationRequested) return null;
      const result = await sendRequest<LspLocation[]>(
        "textDocument/references",
        {
          ...textDocumentPosition(model, position),
          context: { includeDeclaration: context.includeDeclaration },
        },
      );
      if (token.isCancellationRequested) return null;
      const locations = lspLocationsToMonaco(monaco, result);
      return locations.length > 0 ? locations : null;
    },
  });
}

import type * as Monaco from "monaco-editor";
import type {
  CiscoDiagnostic,
  CiscoDiagnosticSeverity,
} from "../../lib/ciscoLint";

const CISCO_MARKER_OWNER = "cisco-lint";

function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

export function setCiscoMarkers(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  diagnostics: readonly CiscoDiagnostic[],
): void {
  const severity: Record<CiscoDiagnosticSeverity, Monaco.MarkerSeverity> = {
    error: monaco.MarkerSeverity.Error,
    warning: monaco.MarkerSeverity.Warning,
    info: monaco.MarkerSeverity.Info,
  };

  monaco.editor.setModelMarkers(
    model,
    CISCO_MARKER_OWNER,
    diagnostics.map((diagnostic) => {
      const line = positiveInteger(diagnostic.line);
      const column = positiveInteger(diagnostic.column);
      return {
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: Math.max(column, positiveInteger(diagnostic.endColumn)),
        message: `${diagnostic.message} (${diagnostic.source})`,
        severity: severity[diagnostic.severity],
      };
    }),
  );
}

export function clearCiscoMarkers(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
): void {
  monaco.editor.setModelMarkers(model, CISCO_MARKER_OWNER, []);
}

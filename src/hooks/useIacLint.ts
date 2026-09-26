import { useEffect, useRef, useState } from "react";
import { iacLintFile, type LintDiagnostic, type LinterStatus } from "../lib/tauri";

type UseIacLintArgs = {
  filePath: string | null;
  content: string;
  language: string;
  debounceMs?: number;
};

type UseIacLintResult = {
  diagnostics: LintDiagnostic[];
  linters: LinterStatus[];
  linting: boolean;
  error: string | null;
};

/**
 * Debounced linting for the IaC Studio. Re-lints whenever content/file/language
 * change, after `debounceMs` of quiet. Linting is best-effort: a sidecar error
 * clears diagnostics and surfaces `error` (the editor keeps working regardless).
 */
export function useIacLint({
  filePath,
  content,
  language,
  debounceMs = 600,
}: UseIacLintArgs): UseIacLintResult {
  const [diagnostics, setDiagnostics] = useState<LintDiagnostic[]>([]);
  const [linters, setLinters] = useState<LinterStatus[]>([]);
  const [linting, setLinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a stale in-flight request overwriting a newer result.
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!filePath) {
      setDiagnostics([]);
      setLinters([]);
      return;
    }
    const myReq = ++reqIdRef.current;
    const handle = window.setTimeout(async () => {
      setLinting(true);
      try {
        const result = await iacLintFile(filePath, content, language);
        if (reqIdRef.current !== myReq) return; // superseded
        setDiagnostics(result.diagnostics);
        setLinters(result.linters);
        setError(null);
      } catch (e) {
        if (reqIdRef.current !== myReq) return;
        setDiagnostics([]);
        setLinters([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (reqIdRef.current === myReq) setLinting(false);
      }
    }, debounceMs);
    return () => window.clearTimeout(handle);
  }, [filePath, content, language, debounceMs]);

  return { diagnostics, linters, linting, error };
}

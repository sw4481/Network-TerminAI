/**
 * Plan 15 Phase 6 — Monaco + monaco-yaml host.
 *
 * Lazy-loaded by `PlaybookEditor.tsx` so jsdom unit tests can fall
 * back to a `<textarea>` without paying the 3MB Monaco load cost.
 *
 * Each document owns one exact URI in the shared YAML language service.
 *
 * The component exposes a global `__tbEditorJumpTo(line, col)` so the
 * diagnostics panel rows can position the cursor when clicked.
 */
import { Editor, loader, type OnMount } from "@monaco-editor/react";
import * as localMonaco from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";
import { yamlSchemaRegistry } from "../../components/editor/yamlSchemaRegistry";

loader.config({ monaco: localMonaco });

interface MonacoYamlSchema {
  $schema?: string;
  [k: string]: unknown;
}

export interface PlaybookEditorMonacoProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  schema: MonacoYamlSchema;
}

export default function PlaybookEditorMonaco({
  value,
  onChange,
  readOnly,
  schema,
}: PlaybookEditorMonacoProps) {
  const uri = useRef(`inmemory://ccie-playbook/${crypto.randomUUID()}.yaml`);
  const lease = useRef<{ release(): void } | null>(null);
  const host = useRef<{
    editor: Parameters<OnMount>[0];
    monaco: Parameters<OnMount>[1];
  } | null>(null);
  const jump = useRef<((line: number, col: number) => void) | null>(null);
  useEffect(() => {
    const mounted = host.current;
    if (mounted) {
      lease.current?.release();
      lease.current = yamlSchemaRegistry.acquire(
        mounted.monaco,
        uri.current,
        schema,
      );
    }
  }, [schema]);
  useEffect(
    () => () => {
      lease.current?.release();
      lease.current = null;
      host.current = null;
      const target = window as {
        __tbEditorJumpTo?: (line: number, col: number) => void;
      };
      if (target.__tbEditorJumpTo === jump.current)
        delete target.__tbEditorJumpTo;
    },
    [],
  );
  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      host.current = { editor, monaco };
      lease.current?.release();
      lease.current = yamlSchemaRegistry.acquire(monaco, uri.current, schema);

      // Expose a jump-to-line setter for the diagnostics panel.
      jump.current = (line: number, col: number) => {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: col });
        editor.focus();
      };
      (
        window as { __tbEditorJumpTo?: (line: number, col: number) => void }
      ).__tbEditorJumpTo = jump.current;
    },
    [schema],
  );

  return (
    <Editor
      height="100%"
      defaultLanguage="yaml"
      path={uri.current}
      language="yaml"
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        readOnly,
        fontSize: 12,
        minimap: { enabled: false },
        tabSize: 2,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: "on",
      }}
    />
  );
}

/**
 * Plan 15 Phase 6 — Monaco + monaco-yaml host.
 *
 * Lazy-loaded by `PlaybookEditor.tsx` so jsdom unit tests can fall
 * back to a `<textarea>` without paying the 3MB Monaco load cost.
 *
 * monaco-yaml configuration is applied exactly once per `monaco`
 * module instance — the module is a singleton, so we set a guard on
 * `globalThis` to make the call idempotent across editor mounts.
 *
 * The component exposes a global `__tbEditorJumpTo(line, col)` so the
 * diagnostics panel rows can position the cursor when clicked.
 */
import { Editor, type OnMount } from "@monaco-editor/react";
import { useCallback } from "react";

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
  const handleMount: OnMount = useCallback(
    async (editor, monaco) => {
      // Configure monaco-yaml once. The module mutates monaco's
      // language registry globally, so re-running it on every mount
      // wastes work and can race; guard with a global flag.
      const flagKey = "__ccieMonacoYamlConfigured";
      const g = globalThis as Record<string, unknown>;
      if (!g[flagKey]) {
        try {
          const { configureMonacoYaml } = await import("monaco-yaml");
          configureMonacoYaml(monaco, {
            validate: true,
            enableSchemaRequest: false,
            schemas: [
              {
                uri: "in-memory://ccie-playbook-schema.json",
                fileMatch: ["*"],
                schema: schema as Record<string, unknown>,
              },
            ],
          });
          g[flagKey] = true;
        } catch (e) {
          console.warn("[troubleshoot] monaco-yaml configure failed", e);
        }
      }

      // Expose a jump-to-line setter for the diagnostics panel.
      (window as { __tbEditorJumpTo?: (line: number, col: number) => void })
        .__tbEditorJumpTo = (line: number, col: number) => {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: col });
        editor.focus();
      };
    },
    [schema],
  );

  return (
    <Editor
      height="100%"
      defaultLanguage="yaml"
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

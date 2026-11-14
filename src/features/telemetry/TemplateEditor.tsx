import { useRef } from "react";
import {
  MonacoEditor,
  DEFAULT_EDITOR_SETTINGS,
} from "../../components/editor/MonacoEditor";
import type { Capture, ParsedInterpretation, TemplateAsset } from "./types";

export function TemplateEditor({
  draft,
  sample,
  onChange,
  onTest,
  result,
  readOnly = false,
  busy = false,
}: {
  draft: TemplateAsset;
  sample: Capture | null;
  onChange(text: string): void;
  onTest(captureId: string, template: TemplateAsset): void;
  result?: ParsedInterpretation | null;
  readOnly?: boolean;
  busy?: boolean;
}) {
  const identity = useRef(`telemetry-template:${crypto.randomUUID()}`);
  const matching =
    sample?.platform === draft.platform && sample.command === draft.command;
  return (
    <section aria-label="TextFSM lab" className="telemetry-template-lab">
      <p>
        {draft.platform.toUpperCase()} · {draft.command}
      </p>
      <div className="telemetry-source-editor">
        <MonacoEditor
          bufferId={`${identity.current}:${draft.id}`}
          value={draft.text}
          language="plaintext"
          onChange={onChange}
          readOnly={readOnly}
          enableLsp={false}
          // shortcut: Monaco 0.52.2 rejects pending word-highlight delays on disposal; remove after a verified upgrade.
          onEditorReady={(editor) =>
            editor.updateOptions({ occurrencesHighlight: "off" })
          }
          settings={{
            ...DEFAULT_EDITOR_SETTINGS,
            fontSize: 12,
            minimap: false,
          }}
        />
      </div>
      <button
        disabled={
          readOnly ||
          busy ||
          !matching ||
          new TextEncoder().encode(draft.text).length > 65536
        }
        onClick={() => {
          if (sample && matching) onTest(sample.capture_id, draft);
        }}
      >
        Test template
      </button>
      {!matching && (
        <p>
          A retained capture with this exact platform and command is required.
          Capture explicitly or Preview existing samples.
        </p>
      )}
      {sample && (
        <details open>
          <summary>Retained raw sample · {sample.command}</summary>
          <pre>{sample.raw}</pre>
        </details>
      )}
      {result &&
        result.capture_id === sample?.capture_id &&
        result.parser_id === draft.id && (
          <details open>
            <summary>
              Actual TextFSM records · {result.rows.length} rows
            </summary>
            <pre>{JSON.stringify(result.rows, null, 2)}</pre>
          </details>
        )}
    </section>
  );
}

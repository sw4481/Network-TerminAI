import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { Workflow, workflowUpsert } from "../lib/workflows";
import { workflowToYaml, yamlToWorkflow } from "../lib/workflowsYaml";

export interface WorkflowExportImportProps {
  workflow: Workflow | null;
  onExported: (path: string) => void;
  onImported: (wf: Workflow) => void;
  onError?: (msg: string) => void;
}

export function WorkflowExportImport({
  workflow,
  onExported,
  onImported,
  onError,
}: WorkflowExportImportProps) {
  const handleExport = async () => {
    if (!workflow) return;
    try {
      const path = await save({
        defaultPath: `${workflow.name.replace(/[^A-Za-z0-9_-]/g, "_")}.yaml`,
        filters: [{ name: "Workflow YAML", extensions: ["yaml", "yml"] }],
      });
      if (!path) return;
      await writeTextFile(path as string, workflowToYaml(workflow));
      onExported(path as string);
    } catch (e) {
      onError?.(String(e));
    }
  };

  const handleImport = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Workflow YAML", extensions: ["yaml", "yml"] }],
      });
      if (!path) return;
      const text = await readTextFile(path as string);
      const parsed = yamlToWorkflow(text);
      // Generate a new id on import to avoid overwriting builtins.
      parsed.id = "";
      const id = await workflowUpsert(parsed);
      onImported({ ...parsed, id });
    } catch (e) {
      onError?.(String(e));
    }
  };

  return (
    <div className="wf-export-import">
      {workflow && (
        <button type="button" onClick={handleExport}>
          Export YAML
        </button>
      )}
      <button type="button" onClick={handleImport}>
        Import YAML
      </button>
    </div>
  );
}

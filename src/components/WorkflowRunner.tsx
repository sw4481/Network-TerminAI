import { useCallback, useState } from "react";
import {
  Workflow,
  workflowRun,
  workflowRunComplete,
  Vendor,
} from "../lib/workflows";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowParamForm } from "./WorkflowParamForm";

export interface WorkflowRunnerProps {
  open: boolean;
  vendor: Vendor;
  platform: string;
  tabId: string;
  /** Single-step, no-param: inject the rendered command into the active editor. */
  onInjectCommand: (rendered: string) => void;
  /** Multi-step: dispatch each command sequentially through pty_write with newline. */
  onDispatchGroup: (
    runId: string,
    workflowName: string,
    commands: string[],
  ) => Promise<void>;
  /** Live typeahead for single-step workflow with params. */
  onTypeahead?: (wf: Workflow, values: Record<string, string>) => void;
  onClose: () => void;
}

export function WorkflowRunner(props: WorkflowRunnerProps) {
  const [picked, setPicked] = useState<Workflow | null>(null);

  const handlePick = useCallback(
    async (wf: Workflow, editParamsFirst: boolean) => {
      // No-param, single-step → run immediately.
      if (
        wf.params.length === 0 &&
        wf.steps.length === 1 &&
        !editParamsFirst
      ) {
        props.onInjectCommand(wf.steps[0].command_template);
        props.onClose();
        return;
      }
      // No-param, multi-step → dispatch as group without a form.
      if (
        wf.params.length === 0 &&
        wf.steps.length > 1 &&
        !editParamsFirst
      ) {
        const res = await workflowRun(wf.id, props.tabId, {});
        await props.onDispatchGroup(res.run_id, res.workflow_name, res.commands);
        await workflowRunComplete(res.run_id);
        props.onClose();
        return;
      }
      // Has params → open form.
      setPicked(wf);
    },
    [props],
  );

  const handleSubmit = useCallback(
    async (values: Record<string, string>) => {
      if (!picked) return;
      const res = await workflowRun(picked.id, props.tabId, values);
      if (picked.steps.length === 1) {
        props.onInjectCommand(res.commands[0]);
      } else {
        await props.onDispatchGroup(
          res.run_id,
          res.workflow_name,
          res.commands,
        );
      }
      await workflowRunComplete(res.run_id);
      setPicked(null);
      props.onClose();
    },
    [picked, props],
  );

  if (!props.open) return null;
  if (picked) {
    return (
      <WorkflowParamForm
        workflow={picked}
        onSubmit={handleSubmit}
        onCancel={() => {
          setPicked(null);
          props.onClose();
        }}
        onValuesChange={(vs) => {
          if (picked.steps.length === 1) props.onTypeahead?.(picked, vs);
        }}
      />
    );
  }
  return (
    <WorkflowPicker
      vendor={props.vendor}
      platform={props.platform}
      onSelect={handlePick}
      onClose={props.onClose}
    />
  );
}

import { useCallback, useState } from "react";
import { Workflow, Vendor } from "../lib/workflows";
import { runWorkflowOnTerminal } from "../lib/workflowDispatcher";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowParamForm } from "./WorkflowParamForm";

export interface WorkflowRunnerProps {
  open: boolean;
  vendor: Vendor;
  platform: string;
  tabId: string;
  /** Live typeahead for single-step workflow with params. */
  onTypeahead?: (wf: Workflow, values: Record<string, string>) => void;
  onClose: () => void;
}

export function WorkflowRunner(props: WorkflowRunnerProps) {
  const [picked, setPicked] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (workflow: Workflow, values: Record<string, string>) => {
      setError(null);
      try {
        await runWorkflowOnTerminal(workflow, props.tabId, values);
        setPicked(null);
        props.onClose();
      } catch (cause) {
        setError(String(cause));
      }
    },
    [props.tabId, props.onClose],
  );

  const handlePick = useCallback(
    async (wf: Workflow, editParamsFirst: boolean) => {
      // No-param, single-step → run immediately.
      if (
        wf.params.length === 0 &&
        !editParamsFirst
      ) {
        await run(wf, {});
        return;
      }
      // Has params → open form.
      setPicked(wf);
    },
    [run],
  );

  const handleSubmit = useCallback(
    async (values: Record<string, string>) => {
      if (!picked) return;
      await run(picked, values);
    },
    [picked, run],
  );

  if (!props.open) return null;
  if (picked) {
    return (
      <>
        {error && <div className="wf-run-error" role="alert">{error}</div>}
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
      </>
    );
  }
  return (
    <>
      {error && <div className="wf-run-error" role="alert">{error}</div>}
      <WorkflowPicker
        vendor={props.vendor}
        platform={props.platform}
        onSelect={handlePick}
        onClose={props.onClose}
      />
    </>
  );
}

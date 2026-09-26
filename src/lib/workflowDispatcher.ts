import { ptyWrite } from "./tauri";
import { ptyTabIdFor } from "./terminalRegistry";
import { usePanesStore } from "../state/panesStore";
import {
  workflowRun,
  workflowRunComplete,
  type Workflow,
  type WorkflowRunResult,
} from "./workflows";

export interface WorkflowTerminalTarget {
  terminalId: string;
  backendPtyId: string;
}

export function resolveWorkflowTerminalTarget(tabId: string): WorkflowTerminalTarget {
  const terminalId = usePanesStore.getState().resolveRecordingTerminalId(tabId);
  return {
    terminalId,
    backendPtyId: ptyTabIdFor(terminalId) ?? terminalId,
  };
}

export async function dispatchWorkflowToTerminal(
  target: WorkflowTerminalTarget,
  commands: string[],
): Promise<void> {
  if (commands.length === 0) {
    throw new Error("workflow rendered no commands");
  }
  const encoder = new TextEncoder();
  for (let index = 0; index < commands.length; index += 1) {
    await ptyWrite(target.backendPtyId, encoder.encode(`${commands[index]}\n`));
  }
}

export async function runWorkflowOnTerminal(
  workflow: Workflow,
  tabId: string,
  values: Record<string, string>,
): Promise<WorkflowRunResult> {
  // Resolve once so a focus change while the backend renders a workflow does
  // not redirect its commands into a different split pane.
  const target = resolveWorkflowTerminalTarget(tabId);
  const run = await workflowRun(workflow.id, target.backendPtyId, values);
  await dispatchWorkflowToTerminal(target, run.commands);
  // Deliberately last: a failed PTY write leaves the run incomplete and the
  // caller can surface the failure without recording a false success.
  await workflowRunComplete(run.run_id);
  return run;
}
